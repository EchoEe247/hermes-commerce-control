/**
 * Permanent-free Reddit RSS/Atom adapter.
 *
 * This adapter deliberately uses Reddit's public Atom feeds rather than OAuth,
 * signup credits, or a paid proxy. It is read-only and consumes no API key.
 * RSS availability is not treated as guaranteed infrastructure, so the adapter
 * remains isolated behind the generic OpportunitySourceAdapter contract.
 */
import {
  canonicalOpportunityId,
  type OpportunityCandidate,
  type OpportunityQuery,
} from "../models.js";
import type { OpportunityAdapterContext, OpportunitySourceAdapter } from "./interface.js";

const SUBREDDIT_RE = /^[A-Za-z0-9_]{2,21}$/;
const MAX_COMBINED_SUBREDDITS = 25;

export interface RedditRssAdapterOptions {
  readonly subreddits: readonly string[];
  readonly baseUrl?: string | undefined;
  readonly feedLimit?: number | undefined;
}

export interface ParseRedditAtomOptions {
  readonly observedAt: string;
  readonly feedUrl: string;
}

export function normalizeSubreddit(raw: string): string {
  const value = raw.trim().replace(/^r\//i, "");
  if (!SUBREDDIT_RE.test(value)) {
    throw new Error(`invalid subreddit name: ${JSON.stringify(raw)}`);
  }
  return value;
}

export function buildRedditAtomUrl(
  subreddits: readonly string[],
  baseUrl = "https://www.reddit.com",
  limit = 100,
): string {
  const normalized = [...new Set(subreddits.map(normalizeSubreddit))];
  if (normalized.length === 0) throw new Error("at least one subreddit is required");
  if (normalized.length > MAX_COMBINED_SUBREDDITS) {
    throw new Error(`at most ${String(MAX_COMBINED_SUBREDDITS)} subreddits may share one feed`);
  }

  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const url = new URL(`/r/${normalized.join("+")}/new/.rss`, baseUrl);
  url.searchParams.set("limit", String(safeLimit));
  return url.toString();
}

function decodeCodePoint(raw: string, radix: 10 | 16): string | undefined {
  const code = Number.parseInt(raw, radix);
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
  return String.fromCodePoint(code);
}

function decodeEntities(input: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return decodeCodePoint(lower.slice(2), 16) ?? full;
    if (lower.startsWith("#")) return decodeCodePoint(lower.slice(1), 10) ?? full;
    return named[lower] ?? full;
  });
}

function unwrapCdata(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

function normalizeText(input: string): string {
  return input
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

/** Plain Atom text: decode XML entities but never reinterpret escaped literals as markup. */
function decodePlainAtomText(input: string): string {
  return normalizeText(decodeEntities(unwrapCdata(input)));
}

/**
 * Atom `type=html` contains an XML-escaped HTML string. Decode one XML layer to
 * reveal the HTML tags, remove those tags, then decode the remaining text layer.
 * A displayed literal such as `<T>` is commonly represented as `&amp;lt;T&amp;gt;`;
 * after one decode it is still `&lt;T&gt;`, so it survives tag removal correctly.
 */
function decodeEscapedHtmlAtomText(input: string): string {
  const html = decodeEntities(unwrapCdata(input))
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeText(decodeEntities(html));
}

/** Atom `type=xhtml` carries real XML markup, so strip actual tags before entity decoding. */
function decodeXhtmlAtomText(input: string): string {
  const text = unwrapCdata(input)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return normalizeText(decodeEntities(text));
}

function tagInner(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1];
}

function attrValue(xml: string, tag: string, attr: string): string | undefined {
  const tagMatch = new RegExp(`<${tag}\\b([^>]*)\\/?\\s*>`, "i").exec(xml);
  const attrs = tagMatch?.[1];
  if (attrs === undefined) return undefined;
  const attrMatch = new RegExp(`${attr}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(attrs);
  const value = attrMatch?.[2];
  return value === undefined ? undefined : decodeEntities(value.trim());
}

/** Decode an Atom text construct according to its declared `type`. */
function tagValue(xml: string, tag: string): string | undefined {
  const raw = tagInner(xml, tag);
  if (raw === undefined) return undefined;
  const type = (attrValue(xml, tag, "type") ?? "text").trim().toLowerCase();
  const value =
    type === "html"
      ? decodeEscapedHtmlAtomText(raw)
      : type === "xhtml"
        ? decodeXhtmlAtomText(raw)
        : decodePlainAtomText(raw);
  return value === "" ? undefined : value;
}

function normalizeIso(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

function communityFromEntry(entry: string): string | undefined {
  const label = attrValue(entry, "category", "label");
  const term = attrValue(entry, "category", "term");
  for (const value of [label, term]) {
    if (value === undefined) continue;
    const match = /(?:^|\b)r\/([A-Za-z0-9_]{2,21})\b/i.exec(value);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

/** Parse the bounded Atom shape emitted by Reddit's public .rss endpoints. */
export function parseRedditAtom(xml: string, options: ParseRedditAtomOptions): OpportunityCandidate[] {
  const out: OpportunityCandidate[] = [];
  for (const match of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const entry = match[1];
    if (entry === undefined) continue;

    const externalId = tagValue(entry, "id");
    const title = tagValue(entry, "title");
    if (externalId === undefined || title === undefined) continue;

    const url = attrValue(entry, "link", "href");
    const authorBlock = /<author\b[^>]*>([\s\S]*?)<\/author>/i.exec(entry)?.[1];
    const author = authorBlock === undefined ? undefined : tagValue(authorBlock, "name");
    const body = tagValue(entry, "content") ?? tagValue(entry, "summary");
    const community = communityFromEntry(entry);
    const postedAt = normalizeIso(tagValue(entry, "published") ?? tagValue(entry, "updated"));

    const tags = ["reddit", ...(community === undefined ? [] : [`r/${community}`])];
    const metadata: Record<string, string> = { feedUrl: options.feedUrl };
    if (community !== undefined) metadata.subreddit = community;

    out.push({
      id: canonicalOpportunityId({
        source: "reddit_rss",
        externalId,
        ...(url === undefined ? {} : { url }),
      }),
      source: "reddit_rss",
      externalId,
      title,
      ...(body === undefined ? {} : { body }),
      ...(url === undefined ? {} : { url }),
      ...(author === undefined ? {} : { author }),
      ...(community === undefined ? {} : { community }),
      ...(postedAt === undefined ? {} : { postedAt }),
      observedAt: options.observedAt,
      tags: Object.freeze(tags),
      metadata: Object.freeze(metadata),
    });
  }
  return out;
}

function normalizedCommunityFilter(query: OpportunityQuery): ReadonlySet<string> | undefined {
  if (query.communities === undefined || query.communities.length === 0) return undefined;
  return new Set(query.communities.map((value) => normalizeSubreddit(value).toLowerCase()));
}

function matchesQuery(
  candidate: OpportunityCandidate,
  query: OpportunityQuery,
  communities: ReadonlySet<string> | undefined,
): boolean {
  if (
    communities !== undefined &&
    (candidate.community === undefined || !communities.has(candidate.community.toLowerCase()))
  ) {
    return false;
  }
  if (query.q !== undefined && query.q.trim() !== "") {
    const needle = query.q.trim().toLowerCase();
    const haystack = `${candidate.title}\n${candidate.body ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export class RedditRssOpportunityAdapter implements OpportunitySourceAdapter {
  public readonly id = "reddit_rss" as const;
  private readonly subreddits: readonly string[];
  private readonly baseUrl: string;
  private readonly feedLimit: number;

  public constructor(options: RedditRssAdapterOptions) {
    this.subreddits = Object.freeze([...new Set(options.subreddits.map(normalizeSubreddit))]);
    if (this.subreddits.length === 0) throw new Error("Reddit RSS adapter requires a subreddit");
    this.baseUrl = options.baseUrl ?? "https://www.reddit.com";
    this.feedLimit = options.feedLimit ?? 100;
  }

  public async discover(
    query: OpportunityQuery,
    context: OpportunityAdapterContext,
  ): Promise<readonly OpportunityCandidate[]> {
    const communityFilter = normalizedCommunityFilter(query);
    const requested =
      communityFilter === undefined
        ? this.subreddits
        : this.subreddits.filter((subreddit) => communityFilter.has(subreddit.toLowerCase()));
    if (requested.length === 0) return [];

    const feedUrl = buildRedditAtomUrl(requested, this.baseUrl, this.feedLimit);
    const response = await context.fetch.text(feedUrl, {
      signal: context.signal,
      headers: { accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" },
    });
    const parsed = parseRedditAtom(response.text, {
      observedAt: context.clock(),
      feedUrl: response.url,
    });
    const filtered = parsed.filter((candidate) => matchesQuery(candidate, query, communityFilter));
    return query.limit === undefined ? filtered : filtered.slice(0, Math.max(0, query.limit));
  }
}
