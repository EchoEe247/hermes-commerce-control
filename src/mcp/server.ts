#!/usr/bin/env node
/**
 * The strict Hermes stdio MCP server.
 *
 * This is the surface Hermes actually drives, so it is the real security
 * boundary. Three decisions define it:
 *
 *  1. The tool list is a closed set of eleven tools. There is no live pay,
 *     purchase, claim, submit, settle, transfer, withdraw, fund, production
 *     publish or raw PipRail payment tool, and an action verb may appear only
 *     behind the `commerce_prepare_` prefix. A contract test asserts both the
 *     exact set and the prefix rule, so a live sibling cannot be added quietly.
 *
 *  2. Every tool delegates to the CLI command layer rather than reimplementing
 *     it. One implementation means the MCP surface and the CLI cannot drift, and
 *     it means every policy check, schema validation and persistence rule
 *     already proven for the CLI applies here unchanged.
 *
 *  3. stdout belongs exclusively to the MCP protocol. The CLI writes its JSON
 *     document into an in-memory buffer, and diagnostics are forwarded to
 *     stderr. Nothing in this module writes to stdout directly.
 *
 * A blocked preparation is a SUCCESSFUL tool call: the policy decision travels
 * inside the returned document. Only a genuine failure sets `isError`.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { APP_NAME, APP_VERSION } from "../app.js";
import { PUBLISH_TARGETS, runCli, type CliDeps } from "../cli.js";
import { PRODUCT_NAME } from "../products/data-quality-profiler.js";

/** The exact, closed tool set. */
export const MCP_TOOL_NAMES = Object.freeze([
  "commerce_sources",
  "commerce_status",
  "commerce_discover_services",
  "commerce_discover_work",
  "commerce_inspect",
  "commerce_quote",
  "commerce_prepare_purchase",
  "commerce_prepare_claim",
  "commerce_prepare_publish",
  "commerce_probe",
  "commerce_export_evidence",
] as const);

export interface CommerceMcpDeps extends CliDeps {
  /** Diagnostic sink. Defaults to stderr; never stdout. */
  readonly log?: ((chunk: string) => void) | undefined;
}

interface ToolTextResult {
  /** The SDK's CallToolResult permits extra top-level fields. */
  [key: string]: unknown;
  /** Mutable by SDK contract; the transport owns the array once returned. */
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Runs one CLI command and returns its single JSON document.
 *
 * `--json` is always appended, so the CLI's one-document stdout contract is what
 * this function parses. Diagnostics are routed to the log sink.
 */
async function invoke(
  deps: CommerceMcpDeps,
  argv: readonly string[],
): Promise<ToolTextResult> {
  const log =
    deps.log ??
    ((chunk: string): void => {
      process.stderr.write(chunk);
    });

  let out = "";
  let err = "";
  await runCli(
    [...argv, "--json"],
    {
      stdout: (chunk: string): void => {
        out += chunk;
      },
      stderr: (chunk: string): void => {
        err += chunk;
      },
    },
    deps,
  );
  if (err !== "") log(err);

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(out.trim()) as Record<string, unknown>;
  } catch {
    envelope = {
      ok: false,
      command: argv.join(" "),
      mode: "A",
      version: APP_VERSION,
      financialActionExecuted: false,
      externalMutationExecuted: false,
      error: {
        code: "STATE_ERROR",
        message: "the command produced no parseable JSON document",
      },
    };
  }

  const ok = envelope.ok === true;
  return {
    content: [{ type: "text", text: JSON.stringify(envelope) }],
    structuredContent: envelope,
    ...(ok ? {} : { isError: true }),
  };
}

/** Appends `--flag value` when the value is present. */
function flag(name: string, value: string | number | undefined): string[] {
  return value === undefined ? [] : [`--${name}`, String(value)];
}

const discoverServicesInput = {
  query: z.string().min(1).max(200).optional().describe("free-text search, e.g. \"profiler\""),
  network: z.string().min(1).max(64).optional().describe("preferred network, e.g. eip155:84532"),
  protocol: z.string().min(1).max(32).optional().describe("preferred protocol, e.g. x402"),
  maxUsdPrice: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional()
    .describe("hard filter: exclude services with a known price above this USD amount"),
  limit: z.number().int().positive().max(200).optional().describe("maximum results per source"),
};

const discoverWorkInput = {
  query: z.string().min(1).max(200).optional(),
  network: z.string().min(1).max(64).optional(),
  minReward: z
    .string()
    .regex(/^\d+(\.\d+)?$/)
    .optional()
    .describe("hard filter: exclude work rewarding less than this"),
  capabilities: z
    .array(z.string().min(1).max(64))
    .max(32)
    .optional()
    .describe("solver capabilities used for requirement-fit scoring"),
  includeUnearnable: z
    .boolean()
    .optional()
    .describe("keep closed or unfunded work in the result set"),
  limit: z.number().int().positive().max(200).optional(),
};

const targetInput = {
  target: z
    .string()
    .min(3)
    .max(256)
    .describe("platform:externalId, or a canonical svc_<hash> / wrk_<hash> already in local state"),
};

const preparePublishInput = {
  product: z.literal(PRODUCT_NAME).describe("the only publishable product in this control plane"),
  target: z.enum(PUBLISH_TARGETS).optional().describe("restrict preparation to one target"),
};

/**
 * Builds the MCP server with its closed tool set.
 *
 * Descriptions carry an explicit `read-only`, `local-write` or
 * `preparation-only` label so an operator reading a tool list can see the blast
 * radius without consulting the source.
 */
export function createCommerceMcpServer(deps: CommerceMcpDeps = {}): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    { capabilities: { tools: {} } },
  );

  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  const localWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
  const preparation = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };

  server.registerTool(
    "commerce_sources",
    {
      title: "List commerce sources",
      description:
        "read-only. Lists every supported marketplace platform with its enabled state, " +
        "declared capabilities and last recorded health. Touches no network.",
      inputSchema: {},
      annotations: { ...readOnly, openWorldHint: false },
    },
    async () => invoke(deps, ["sources"]),
  );

  server.registerTool(
    "commerce_status",
    {
      title: "Control-plane status",
      description:
        "read-only. Reports Mode A, both activation gates, wallet-secret absence, state " +
        "paths, schema version and local record counts. Touches no network.",
      inputSchema: {},
      annotations: { ...readOnly, openWorldHint: false },
    },
    async () => invoke(deps, ["status"]),
  );

  server.registerTool(
    "commerce_discover_services",
    {
      title: "Discover paid services",
      description:
        "local-write. Performs read-only public discovery across every enabled platform, " +
        "deduplicates to canonical services, ranks deterministically and persists the " +
        "snapshot to local state. Never pays for anything; a failing platform degrades " +
        "its own source status only.",
      inputSchema: discoverServicesInput,
      annotations: { ...localWrite, openWorldHint: true },
    },
    async (args) => {
      const input = args as z.infer<z.ZodObject<typeof discoverServicesInput>>;
      return invoke(deps, [
        "discover",
        "services",
        ...(input.query === undefined ? [] : [input.query]),
        ...flag("network", input.network),
        ...flag("protocol", input.protocol),
        ...flag("max-usd-price", input.maxUsdPrice),
        ...flag("limit", input.limit),
      ]);
    },
  );

  server.registerTool(
    "commerce_discover_work",
    {
      title: "Discover earnable work",
      description:
        "local-write. Performs read-only public discovery of bounties and paid tasks, " +
        "excludes work that cannot be earned, ranks deterministically and persists the " +
        "snapshot. Never claims or submits anything.",
      inputSchema: discoverWorkInput,
      annotations: { ...localWrite, openWorldHint: true },
    },
    async (args) => {
      const input = args as z.infer<z.ZodObject<typeof discoverWorkInput>>;
      return invoke(deps, [
        "discover",
        "work",
        ...(input.query === undefined ? [] : [input.query]),
        ...flag("network", input.network),
        ...flag("min-reward", input.minReward),
        ...flag("limit", input.limit),
        ...(input.capabilities ?? []).flatMap((capability) => ["--capability", capability]),
        ...(input.includeUnearnable === true ? ["--include-unearnable"] : []),
      ]);
    },
  );

  server.registerTool(
    "commerce_inspect",
    {
      title: "Inspect a service or work item",
      description:
        "local-write. Fetches one target's public detail through the read-only network " +
        "boundary and persists the normalized snapshot with its evidence.",
      inputSchema: targetInput,
      annotations: { ...localWrite, openWorldHint: true },
    },
    async (args) => {
      const input = args as { target: string };
      return invoke(deps, ["inspect", input.target]);
    },
  );

  server.registerTool(
    "commerce_quote",
    {
      title: "Quote a service",
      description:
        "local-write. Returns the current published price and payment requirements for a " +
        "service. The quote is always marked executable:false; Mode A cannot settle it.",
      inputSchema: targetInput,
      annotations: { ...localWrite, openWorldHint: true },
    },
    async (args) => {
      const input = args as { target: string };
      return invoke(deps, ["quote", input.target]);
    },
  );

  server.registerTool(
    "commerce_prepare_purchase",
    {
      title: "Prepare a purchase",
      description:
        "preparation-only. Builds a complete payment intent for a service and returns it " +
        "together with the policy decision that blocked it. No payment is signed, sent or " +
        "settled, no wallet or key is read, and financialActionExecuted is always false. " +
        "Activating a real purchase would require Stage B2, which is not implemented.",
      inputSchema: targetInput,
      annotations: { ...preparation, openWorldHint: true },
    },
    async (args) => {
      const input = args as { target: string };
      return invoke(deps, ["prepare", "purchase", input.target]);
    },
  );

  server.registerTool(
    "commerce_prepare_claim",
    {
      title: "Prepare a work claim",
      description:
        "preparation-only. Builds a claim intent for a bounty, including the external steps " +
        "a human operator would have to perform, and returns the policy decision that " +
        "blocked it. Nothing is claimed and nothing is submitted. Activating a real claim " +
        "would require Stage B1, which is not implemented.",
      inputSchema: targetInput,
      annotations: { ...preparation, openWorldHint: true },
    },
    async (args) => {
      const input = args as { target: string };
      return invoke(deps, ["prepare", "claim", input.target]);
    },
  );

  server.registerTool(
    "commerce_prepare_publish",
    {
      title: "Prepare a product publication",
      description:
        "preparation-only. Assesses the Data Quality Profiler's publication readiness from " +
        "the actual product tree and builds a publication intent per target. No marketplace " +
        "registration or production publication is performed; publicationExecuted is always " +
        "false. Activating a real publication would require Stage B1, which is not implemented.",
      inputSchema: preparePublishInput,
      annotations: { ...preparation, openWorldHint: false },
    },
    async (args) => {
      const input = args as { product: string; target?: string | undefined };
      return invoke(deps, [
        "prepare",
        "publish",
        input.product,
        ...flag("target", input.target),
      ]);
    },
  );

  server.registerTool(
    "commerce_probe",
    {
      title: "Probe platform health",
      description:
        "local-write. Runs a bounded read-only health probe against every enabled platform " +
        "and records the result. An outage is reported as degraded or unreachable rather " +
        "than failing the call.",
      inputSchema: {},
      annotations: { ...localWrite, openWorldHint: true },
    },
    async () => invoke(deps, ["probe"]),
  );

  server.registerTool(
    "commerce_export_evidence",
    {
      title: "Export normalized evidence",
      description:
        "local-write. Writes the sanitized normalized services, work, source health and " +
        "status artifacts into the repository and returns each path with its real SHA-256 " +
        "checksum and byte count. Writes to the local filesystem only.",
      inputSchema: {},
      annotations: { ...localWrite, openWorldHint: false },
    },
    async () => invoke(deps, ["export"]),
  );

  return server;
}

/** Serves the control plane over stdio. */
export async function serveStdio(deps: CommerceMcpDeps = {}): Promise<void> {
  const server = createCommerceMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** True when this module is the process entrypoint rather than an import. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  await serveStdio();
}
