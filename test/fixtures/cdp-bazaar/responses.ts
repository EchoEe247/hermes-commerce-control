/**
 * CDP Bazaar / Agentic.Market fixtures.
 *
 * Shapes were confirmed against the live public discovery API on 2026-08-19:
 *
 *   GET /platform/v2/x402/discovery/resources?limit&offset
 *     -> { items, pagination: { limit, offset, total }, x402Version }
 *   GET /platform/v2/x402/discovery/search?query&limit   (limit max 20)
 *     -> { resources, searchMethod, partialResults, meta: { searchToken }, x402Version }
 *
 * Item fields: accepts, description, extensions, lastUpdated, quality, resource,
 * serviceName, tags, type, x402Version (browse also returns bundleSlugs,
 * curated, iconUrl).
 * Accept fields: amount, asset, currency, extra, maxTimeoutSeconds, network,
 * payTo, recipient, scheme.
 * Quality fields: l30DaysTotalCalls, l30DaysUniquePayers, lastCalledAt.
 *
 * Note that the amount field is `amount`, not `maxAmountRequired`. Fixtures are
 * sanitized and trimmed; payloads are illustrative, not verbatim dumps.
 */

export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** A well-formed Base-mainnet resource with quality metrics. */
export const VALID_RESOURCE = {
  resource: "https://api.onesource.example/api/chain/erc20-balance",
  type: "http",
  x402Version: 2,
  serviceName: "ERC20 Balance",
  description: "ERC20 token balance for any wallet via balanceOf",
  tags: ["chain", "erc20"],
  lastUpdated: "2026-08-19T04:07:19.313Z",
  quality: {
    l30DaysTotalCalls: 914,
    l30DaysUniquePayers: 910,
    lastCalledAt: "2026-08-19T00:54:21.318Z",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "3000",
      asset: BASE_USDC,
      currency: BASE_USDC,
      payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      recipient: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      maxTimeoutSeconds: 3600,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
  extensions: {
    bazaar: {
      info: { input: { method: "GET", type: "http" }, output: { type: "json" } },
    },
  },
};

/** Multiple accepts: exact plus batch-settlement plus agent-pay. */
export const MULTI_ACCEPTS_RESOURCE = {
  ...VALID_RESOURCE,
  resource: "https://api.multi.example/v1/quote",
  serviceName: "Multi Accepts",
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "3000",
      asset: BASE_USDC,
      payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      maxTimeoutSeconds: 3600,
      extra: { name: "USD Coin", version: "2" },
    },
    {
      scheme: "batch-settlement",
      network: "eip155:8453",
      amount: "3000",
      asset: BASE_USDC,
      payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      maxTimeoutSeconds: 3600,
      extra: { name: "USD Coin", version: "2", withdrawDelay: 86400 },
    },
    {
      scheme: "agent-pay",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "5000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      maxTimeoutSeconds: 60,
    },
  ],
};

/** Base Sepolia testnet resource priced at $0.02, mirroring the profiler. */
export const SEPOLIA_RESOURCE = {
  resource: "https://profiler.example/v1/profile",
  type: "http",
  x402Version: 2,
  serviceName: "Data Quality Profiler",
  description: "Profiles a dataset and returns quality scores",
  tags: ["data", "quality"],
  lastUpdated: "2026-08-19T03:00:00.000Z",
  quality: { l30DaysTotalCalls: 0, l30DaysUniquePayers: 0, lastCalledAt: null },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:84532",
      amount: "20000",
      asset: BASE_SEPOLIA_USDC,
      payTo: "0x000000000000000000000000000000000000bEEF",
      maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    },
  ],
  extensions: { bazaar: { info: { input: { method: "POST", type: "http" } } } },
};

/** No accepts at all: price is genuinely unknown and must not be guessed. */
export const MISSING_PRICE_RESOURCE = {
  resource: "https://api.nopricing.example/v1/thing",
  type: "http",
  x402Version: 2,
  serviceName: "No Pricing",
  description: "Advertises no payment requirements",
  tags: [],
  lastUpdated: "2026-08-19T03:00:00.000Z",
  accepts: [],
};

/** Amount is not a plain integer string; the accept must be rejected. */
export const MALFORMED_AMOUNT_RESOURCE = {
  ...VALID_RESOURCE,
  resource: "https://api.malformed.example/v1/x",
  serviceName: "Malformed Amount",
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1.5e3",
      asset: BASE_USDC,
      payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      maxTimeoutSeconds: 3600,
    },
  ],
};

/** No quality block: activity is unknown, which must score neutral not zero. */
export const MISSING_QUALITY_RESOURCE = {
  resource: "https://api.noquality.example/v1/x",
  type: "http",
  x402Version: 2,
  serviceName: "No Quality",
  description: "Has no quality metrics",
  tags: [],
  lastUpdated: "2026-08-19T03:00:00.000Z",
  accepts: VALID_RESOURCE.accepts,
};

/**
 * Same canonical identity as VALID_RESOURCE but with cosmetic differences in
 * scheme case, host case and a default port. Must collapse to one service ID.
 */
export const DUPLICATE_RESOURCE = {
  ...VALID_RESOURCE,
  resource: "HTTPS://API.OneSource.Example:443/api/chain/erc20-balance",
  serviceName: "ERC20 Balance (duplicate listing)",
};

export const BROWSE_RESPONSE = {
  x402Version: 2,
  pagination: { limit: 30, offset: 0, total: 15109 },
  items: [
    VALID_RESOURCE,
    MULTI_ACCEPTS_RESOURCE,
    SEPOLIA_RESOURCE,
    MISSING_PRICE_RESOURCE,
    MALFORMED_AMOUNT_RESOURCE,
    MISSING_QUALITY_RESOURCE,
  ],
};

export const SEARCH_RESPONSE = {
  x402Version: 2,
  searchMethod: "hybrid",
  partialResults: true,
  meta: { searchToken: "fixturetoken" },
  resources: [VALID_RESOURCE, SEPOLIA_RESOURCE],
};

export const EMPTY_SEARCH_RESPONSE = {
  x402Version: 2,
  searchMethod: "hybrid",
  partialResults: false,
  meta: { searchToken: "fixturetoken" },
  resources: [],
};

/** Body that is valid JSON but structurally wrong. */
export const MALFORMED_ENVELOPE = { unexpected: "shape", items: "not-an-array" };
