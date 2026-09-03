import { CommerceError } from "../core/errors.js";
import {
  buildOpportunityEvaluationPrompt,
  type OpportunityEvaluationPacket,
  type OpportunityEvaluator,
} from "./evaluation.js";

export interface LocalOpenAiEvaluatorOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs?: number | undefined;
  readonly maxResponseBytes?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024;

function normalizeLoopbackBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CommerceError("INVALID_URL", "local evaluator base URL is invalid");
  }
  if (url.protocol !== "http:") {
    throw new CommerceError("INVALID_URL", "local evaluator requires an http loopback URL");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new CommerceError("INVALID_URL", "local evaluator URL may not contain credentials, query, or fragment");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new CommerceError(
      "SSRF_BLOCKED",
      "local evaluator endpoint must use a literal loopback address (127.0.0.1 or ::1)",
      { hostname: url.hostname },
    );
  }
  if (url.port === "") {
    throw new CommerceError("INVALID_URL", "local evaluator URL must include an explicit port");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number.parseInt(declared, 10) > maxBytes) {
    throw new CommerceError("RESPONSE_TOO_LARGE", `local evaluator response exceeds ${String(maxBytes)} bytes`);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CommerceError("RESPONSE_TOO_LARGE", `local evaluator response exceeds ${String(maxBytes)} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function extractAssistantJson(envelope: unknown): unknown {
  if (typeof envelope !== "object" || envelope === null) {
    throw new CommerceError("UPSTREAM_MALFORMED", "local evaluator returned a non-object response");
  }
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new CommerceError("UPSTREAM_MALFORMED", "local evaluator response has no choices");
  }
  const first = choices[0];
  if (typeof first !== "object" || first === null) {
    throw new CommerceError("UPSTREAM_MALFORMED", "local evaluator first choice is malformed");
  }
  const message = (first as { message?: unknown }).message;
  if (typeof message !== "object" || message === null) {
    throw new CommerceError("UPSTREAM_MALFORMED", "local evaluator choice has no message");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new CommerceError("UPSTREAM_MALFORMED", "local evaluator assistant content is empty or non-text");
  }
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new CommerceError(
      "UPSTREAM_MALFORMED",
      "local evaluator assistant content is not strict JSON; markdown/code-fence repair is intentionally disabled",
    );
  }
}

/**
 * OpenAI-compatible evaluator restricted to an explicit literal loopback HTTP endpoint.
 *
 * It carries no API key and sends no Authorization/Cookie headers. This adapter
 * is intentionally local-only so a provider change cannot silently turn a free
 * local evaluation path into a metered remote call.
 */
export class LocalOpenAiOpportunityEvaluator implements OpportunityEvaluator {
  readonly id: string;
  readonly #endpoint: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #maxResponseBytes: number;
  readonly #fetch: typeof fetch;

  constructor(options: LocalOpenAiEvaluatorOptions) {
    const base = normalizeLoopbackBaseUrl(options.baseUrl);
    const model = options.model.trim();
    if (model === "" || model.length > 200) {
      throw new CommerceError("INVALID_INPUT", "local evaluator model must be a non-empty bounded string");
    }
    const timeoutMs = Math.max(1_000, Math.min(300_000, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    const maxResponseBytes = Math.max(
      4_096,
      Math.min(1_048_576, Math.trunc(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES)),
    );
    this.#endpoint = `${base.toString().replace(/\/$/, "")}/chat/completions`;
    this.#model = model;
    this.#timeoutMs = timeoutMs;
    this.#maxResponseBytes = maxResponseBytes;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.id = `local-openai:${model}`;
  }

  async evaluate(packet: OpportunityEvaluationPacket): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.#model,
          messages: [{ role: "user", content: buildOpportunityEvaluationPrompt(packet) }],
          stream: false,
        }),
        signal: controller.signal,
      });
      const text = await readBoundedText(response, this.#maxResponseBytes);
      if (!response.ok) {
        if (response.status === 429) {
          throw new CommerceError("UPSTREAM_RATE_LIMITED", "local evaluator rate limited the request", {
            status: response.status,
          });
        }
        throw new CommerceError("UPSTREAM_UNAVAILABLE", `local evaluator returned HTTP ${String(response.status)}`, {
          status: response.status,
        });
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(text) as unknown;
      } catch {
        throw new CommerceError("UPSTREAM_MALFORMED", "local evaluator response envelope is not valid JSON");
      }
      return extractAssistantJson(envelope);
    } catch (error) {
      if (error instanceof CommerceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|timeout/i.test(message)) {
        throw new CommerceError("UPSTREAM_TIMEOUT", "local evaluator request timed out");
      }
      throw new CommerceError("UPSTREAM_UNAVAILABLE", `local evaluator request failed: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
