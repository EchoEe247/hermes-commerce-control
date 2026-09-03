/**
 * Shared normalization for x402 payment requirements.
 *
 * CDP Bazaar, Agent402 and PipRail all describe x402 services, so the accept ->
 * price/asset/network mapping lives here once rather than being re-derived (and
 * re-broken) in each adapter.
 */
import { atomicToDecimalString, isAuthoritativeAmount } from "../core/money.js";
import type { AssetRef, PriceRef } from "../core/models.js";

/**
 * Assets whose decimals and USD parity are known with confidence.
 *
 * USD is only ever populated for an asset in this table. For anything else the
 * price stays in its native asset and `usd` is left undefined, because guessing
 * a USD value for an unknown token would fabricate evidence.
 */
const KNOWN_ASSETS: Readonly<Record<string, { symbol: string; decimals: number; usdParity: boolean }>> =
  Object.freeze({
    // USDC on Base mainnet
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": { symbol: "USDC", decimals: 6, usdParity: true },
    // USDC on Base Sepolia
    "0x036cbd53842c5426634e7929541ec2318f3dcf7e": { symbol: "USDC", decimals: 6, usdParity: true },
    // USDC on Ethereum mainnet
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { symbol: "USDC", decimals: 6, usdParity: true },
    // USDC on Polygon
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": { symbol: "USDC", decimals: 6, usdParity: true },
    // USDT on Ethereum mainnet
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { symbol: "USDT", decimals: 6, usdParity: true },
    // USDC SPL mint on Solana
    epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v: { symbol: "USDC", decimals: 6, usdParity: true },
  });

export interface X402Accept {
  readonly scheme?: unknown;
  readonly network?: unknown;
  readonly amount?: unknown;
  readonly maxAmountRequired?: unknown;
  readonly asset?: unknown;
  readonly currency?: unknown;
  readonly payTo?: unknown;
  readonly recipient?: unknown;
  readonly maxTimeoutSeconds?: unknown;
  readonly extra?: unknown;
}

export interface NormalizedAccept {
  readonly scheme: string;
  readonly network: string | undefined;
  readonly asset: AssetRef | undefined;
  readonly price: PriceRef | undefined;
  readonly payTo: string | undefined;
  /** True when the accept declared an amount we could not trust. */
  readonly amountRejected: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function lookupAsset(address: string | undefined): {
  symbol: string;
  decimals: number;
  usdParity: boolean;
} | undefined {
  if (address === undefined) return undefined;
  return KNOWN_ASSETS[address.toLowerCase()];
}

/**
 * Normalizes one x402 accept entry.
 *
 * Accepts both `amount` (current CDP discovery field) and `maxAmountRequired`
 * (the x402 payment-requirements field name). An amount that is not a plain
 * unsigned integer string is rejected rather than coerced: the price becomes
 * unknown and `amountRejected` records why.
 */
export function normalizeAccept(accept: X402Accept): NormalizedAccept {
  const scheme = str(accept.scheme) ?? "exact";
  const network = str(accept.network);
  const payTo = str(accept.payTo) ?? str(accept.recipient);
  const assetAddress = str(accept.asset) ?? str(accept.currency);
  const known = lookupAsset(assetAddress);

  const rawAmount = str(accept.amount) ?? str(accept.maxAmountRequired);
  let price: PriceRef | undefined;
  let amountRejected = false;

  if (rawAmount !== undefined) {
    if (/^\d+$/.test(rawAmount)) {
      if (known !== undefined) {
        const decimal = atomicToDecimalString(rawAmount, known.decimals);
        price = Object.freeze({
          atomic: rawAmount,
          decimal,
          display: known.usdParity ? `$${decimal}` : `${decimal} ${known.symbol}`,
          currency: known.symbol,
          // USD only for a known USD-parity stablecoin.
          ...(known.usdParity ? { usd: decimal } : {}),
        });
      } else {
        // Atomic amount is authoritative, but without decimals we cannot
        // produce a decimal or USD form. Leaving them undefined is correct.
        price = Object.freeze({ atomic: rawAmount });
      }
    } else {
      amountRejected = true;
    }
  }

  const asset: AssetRef | undefined =
    assetAddress === undefined && known === undefined
      ? undefined
      : Object.freeze({
          ...(assetAddress === undefined ? {} : { address: assetAddress }),
          ...(known === undefined ? {} : { symbol: known.symbol, decimals: known.decimals }),
        });

  return Object.freeze({ scheme, network, asset, price, payTo, amountRejected });
}

/**
 * Chooses the accept to represent a service.
 *
 * Prefers a scheme we can actually reason about (`exact`), then the cheapest
 * trustworthy price, then the first entry. Deterministic given the same input.
 */
export function selectPrimaryAccept(accepts: readonly X402Accept[]): NormalizedAccept | undefined {
  const normalized = accepts.map(normalizeAccept);
  if (normalized.length === 0) return undefined;

  const exact = normalized.filter((a) => a.scheme === "exact");
  const pool = exact.length > 0 ? exact : normalized;

  const priced = pool.filter(
    (a) => a.price?.atomic !== undefined && isAuthoritativeAmount(a.price.atomic),
  );
  if (priced.length === 0) return pool[0];

  return priced.reduce((best, candidate) => {
    const bestAtomic = BigInt(best.price?.atomic ?? "0");
    const candidateAtomic = BigInt(candidate.price?.atomic ?? "0");
    return candidateAtomic < bestAtomic ? candidate : best;
  });
}

/** Infers the HTTP method a Bazaar-style resource expects, defaulting to POST. */
export function inferMethod(extensions: unknown, fallback = "POST"): string {
  if (extensions === null || typeof extensions !== "object") return fallback;
  const bazaar = (extensions as Record<string, unknown>).bazaar;
  if (bazaar === null || typeof bazaar !== "object") return fallback;
  const info = (bazaar as Record<string, unknown>).info;
  if (info === null || typeof info !== "object") return fallback;
  const input = (info as Record<string, unknown>).input;
  if (input === null || typeof input !== "object") return fallback;
  const method = (input as Record<string, unknown>).method;
  if (typeof method === "string" && /^[A-Za-z]+$/.test(method)) return method.toUpperCase();
  return fallback;
}
