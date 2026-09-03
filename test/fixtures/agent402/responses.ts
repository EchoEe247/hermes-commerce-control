/**
 * Agent402.Tools fixtures.
 *
 * Shapes confirmed against the live public API on 2026-08-19:
 *
 *   GET /api/find?q=...
 *     -> { query, count, results[], packs, rarestTerm, rarestTermCovered }
 *      result keys: callExample, category, computePayable, description, docs,
 *      example, inputSchema, name, price, priceUsd, required, route, score, slug
 *      note: `route` combines method and path, e.g. "GET /api/gov-data"
 *
 *   GET /api/pricing
 *     -> { name, description, llmGateway, payment, altPayment, baseUrl,
 *          openapi, categories, endpoints[] }
 *      endpoint keys: category, computePayable, description, docs, method,
 *      name, path, price, slug
 *      payment: { protocol: "x402", version: 2, network: "base",
 *                 currency: "USDC", networks: [...] }
 *
 * Prices are display strings such as "$0.003" / "$0.010". `priceUsd` is a JSON
 * number and is deliberately NOT used as an authoritative amount.
 */

export const FIND_RESPONSE = {
  query: "data",
  count: 3,
  rarestTerm: "data",
  rarestTermCovered: true,
  packs: [],
  results: [
    {
      slug: "gov-data",
      name: "US gov dataset search",
      route: "GET /api/gov-data",
      price: "$0.003",
      priceUsd: 0.003,
      category: "data",
      description: "Search 300,000+ US government datasets on catalog.data.gov",
      computePayable: true,
      docs: "https://agent402.tools/docs/gov-data",
      required: ["q"],
      inputSchema: {
        properties: {
          q: { type: "string", description: "Search query" },
          rows: { type: "number", description: "Results to return, 1-20" },
        },
        required: ["q"],
      },
      example: { q: "electric vehicle charging stations", rows: 5 },
      callExample: { method: "GET", path: "/api/gov-data", query: { q: "ev", rows: 5 } },
      score: 4.2,
    },
    {
      slug: "extract",
      name: "Extract article",
      route: "POST /api/extract",
      price: "$0.010",
      priceUsd: 0.01,
      category: "web",
      description: "Extract the main article content from any public URL as clean markdown",
      computePayable: true,
      score: 3.1,
    },
    {
      // No price at all: must normalize with an unknown price, not a zero price.
      slug: "mystery",
      name: "Mystery tool",
      route: "GET /api/mystery",
      category: "data",
      description: "Advertises no price",
      score: 1.0,
    },
  ],
};

export const PRICING_RESPONSE = {
  name: "Agent402",
  description: "x402 tool catalog",
  baseUrl: "https://agent402.tools",
  openapi: "https://agent402.tools/openapi.json",
  llmGateway: "https://agent402.tools/api/llm",
  payment: {
    protocol: "x402",
    version: 2,
    network: "base",
    currency: "USDC",
    networks: ["base", "solana", "polygon", "arbitrum", "optimism", "celo"],
  },
  altPayment: {
    protocol: "proof-of-work",
    summary: "No wallet? Solve a sha256 puzzle instead.",
    challengeUrl: "https://agent402.tools/api/pow/challenge",
  },
  categories: { web: "Web & documents", data: "Live public data" },
  endpoints: [
    {
      method: "POST",
      path: "/api/extract",
      name: "Extract article",
      price: "$0.010",
      category: "web",
      slug: "extract",
      description: "Extract the main article content from any public URL",
      computePayable: true,
      docs: "https://agent402.tools/docs/extract",
    },
    {
      method: "GET",
      path: "/api/gov-data",
      name: "US gov dataset search",
      price: "$0.003",
      category: "data",
      slug: "gov-data",
      description: "Search US government datasets",
      computePayable: true,
    },
    {
      // Malformed price: must be rejected rather than coerced.
      method: "GET",
      path: "/api/weird",
      name: "Weird price",
      price: "three cents",
      category: "data",
      slug: "weird",
      description: "Price is not machine-readable",
    },
  ],
};

/**
 * Overlap fixture: the same canonical URL + method + network + payTo as a CDP
 * Bazaar listing, so the dedupe stage has a genuine cross-source duplicate.
 */
export const OVERLAP_ENDPOINT = {
  method: "GET",
  path: "/api/chain/erc20-balance",
  name: "ERC20 Balance (via Agent402)",
  price: "$0.003",
  category: "data",
  slug: "erc20-balance",
  description: "ERC20 token balance",
};

export const OVERLAP_PRICING_RESPONSE = {
  ...PRICING_RESPONSE,
  baseUrl: "https://api.onesource.example",
  endpoints: [OVERLAP_ENDPOINT],
};

export const EMPTY_FIND_RESPONSE = {
  query: "nothing",
  count: 0,
  results: [],
  packs: [],
  rarestTerm: "nothing",
  rarestTermCovered: false,
};

export const MALFORMED_FIND_RESPONSE = { query: "x", results: "not-an-array" };
