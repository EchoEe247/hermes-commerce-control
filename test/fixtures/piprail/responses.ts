/**
 * PipRail fixtures.
 *
 * Confirmed against @piprail/sdk 2.15.0 on 2026-08-19 by constructing
 * `new PipRailClient({ chain: "base" })` with no private key and calling
 * `discover({ network: "any" })`. That walletless call succeeded and returned an
 * array of:
 *
 *   { resource, source, rails: [{ scheme, network, asset, amount, payTo }], description }
 *
 * PipRail's own documentation confirms PIPRAIL_PRIVATE_KEY is optional and that
 * omitting it boots read-only: discover / quote / plan / register / budget /
 * guide work, and only paying needs a key. This control plane goes further and
 * uses only discover and quote.
 */

export const DISCOVER_RESULTS = [
  {
    resource: "https://api.onesource.example/api/chain/erc20-balance",
    source: "bazaar",
    description: "ERC20 token balance for any wallet",
    rails: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "3000",
        payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      },
      {
        scheme: "batch-settlement",
        network: "eip155:8453",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        amount: "3000",
        payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      },
    ],
  },
  {
    resource: "https://profiler.example/v1/profile",
    source: "402index",
    description: "Data quality profiler",
    rails: [
      {
        scheme: "exact",
        network: "eip155:84532",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount: "20000",
        payTo: "0x000000000000000000000000000000000000bEEF",
      },
    ],
  },
  {
    // No rails: price unknown, must not be guessed.
    resource: "https://norails.example/v1/thing",
    source: "402index",
    description: "No payment rails advertised",
    rails: [],
  },
  {
    // Unusable resource: must be skipped, not crash the batch.
    resource: "not-a-url",
    source: "bazaar",
    description: "Broken entry",
    rails: [],
  },
];

/** A 402 quote as returned by client.quote(url) without paying. */
export const QUOTE_RESULT = {
  resource: "https://profiler.example/v1/profile",
  rails: [
    {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "20000",
      payTo: "0x000000000000000000000000000000000000bEEF",
    },
  ],
};

export const EMPTY_DISCOVER_RESULTS: unknown[] = [];

export const MALFORMED_DISCOVER_RESULT = { notAnArray: true };
