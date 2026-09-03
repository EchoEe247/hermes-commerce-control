/**
 * the402 fixtures.
 *
 * Confirmed against the live public API on 2026-08-19:
 *
 *   GET https://api.the402.ai/v1/services/catalog
 *     -> { total, limit, offset, services[], queried_at, referral_hint }
 *        total was 485, default limit 20
 *
 *   service -> { agent_price, category, description, endpoint, estimated_delivery,
 *                fulfillment_type, id, input_schema, listed_at, name,
 *                platform_fee_pct, price, pricing_model,
 *                provider_completed_jobs, provider_completion_rate,
 *                provider_confidence, provider_id, provider_is_new,
 *                provider_name, provider_net_price, provider_reputation,
 *                provider_type, provider_verification_tier, service_type,
 *                tags, updated_at, webhook_healthy }
 *
 * Observed service_type values: data_api, automated_service, human_service.
 * Observed provider_verification_tier values: unverified, email_verified.
 */

export const DATA_API_SERVICE = {
  id: "svc_81153beeef3341c6",
  name: "Sourced Research Brief with Checkable Citations",
  description: "One focused question, answered in a brief with cited sources.",
  category: "research",
  service_type: "data_api",
  fulfillment_type: "instant",
  endpoint: "https://api.fablerlabs.example/v1/research-brief",
  price: "2.50",
  agent_price: "2.75",
  provider_net_price: "2.25",
  platform_fee_pct: 10,
  pricing_model: "fixed",
  estimated_delivery: "instant",
  provider_id: "p_dec93458c28c4faa",
  provider_name: "Fabler Labs",
  provider_type: "provider",
  provider_verification_tier: "unverified",
  provider_reputation: 4.6,
  provider_confidence: 0.82,
  provider_completed_jobs: 31,
  provider_completion_rate: 0.94,
  provider_is_new: false,
  webhook_healthy: true,
  tags: ["research", "citations"],
  listed_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-08-18T00:00:00.000Z",
  input_schema: { properties: { question: { type: "string" } }, required: ["question"] },
};

export const AUTOMATED_SERVICE = {
  ...DATA_API_SERVICE,
  id: "svc_automated01",
  name: "Automated CSV cleanup",
  service_type: "automated_service",
  endpoint: "https://api.autoclean.example/v1/clean",
  price: "0.75",
  provider_verification_tier: "email_verified",
  provider_confidence: 0.61,
  provider_reputation: 3.9,
  webhook_healthy: true,
};

export const HUMAN_SERVICE = {
  ...DATA_API_SERVICE,
  id: "svc_human01",
  name: "Human expert review",
  service_type: "human_service",
  endpoint: "https://api.humanreview.example/v1/review",
  price: "40.00",
  estimated_delivery: "48h",
  provider_verification_tier: "email_verified",
  provider_confidence: 0.9,
  provider_reputation: 4.9,
  webhook_healthy: false,
};

/** pricing_model is variable, so no fixed price is knowable. */
export const UNKNOWN_PRICE_SERVICE = {
  ...DATA_API_SERVICE,
  id: "svc_variable01",
  name: "Variable priced service",
  endpoint: "https://api.variable.example/v1/thing",
  price: null,
  agent_price: null,
  pricing_model: "variable",
};

/** A brand-new provider with no track record: confidence must not be inflated. */
export const NEW_PROVIDER_SERVICE = {
  ...DATA_API_SERVICE,
  id: "svc_new01",
  name: "Brand new provider service",
  endpoint: "https://api.brandnew.example/v1/x",
  provider_is_new: true,
  provider_completed_jobs: 0,
  provider_completion_rate: null,
  provider_confidence: null,
  provider_reputation: null,
};

export const CATALOG_RESPONSE = {
  total: 485,
  limit: 20,
  offset: 0,
  queried_at: "2026-08-19T06:00:00.000Z",
  referral_hint: "ignored",
  services: [
    DATA_API_SERVICE,
    AUTOMATED_SERVICE,
    HUMAN_SERVICE,
    UNKNOWN_PRICE_SERVICE,
    NEW_PROVIDER_SERVICE,
  ],
};

export const EMPTY_CATALOG = {
  total: 0,
  limit: 20,
  offset: 0,
  queried_at: "2026-08-19T06:00:00.000Z",
  services: [],
};

export const MALFORMED_CATALOG = { total: 1, services: "not-an-array" };
