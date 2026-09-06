# Architecture

This is the contributor-oriented map of Hermes Commerce Control (HCC): which layer owns what, how requests move through the system, and which boundaries should not be weakened accidentally while making a local change.

The main architectural rule is that HCC is a **preparation-only Mode-A control plane**. That is not just a configuration default. The launch path establishes the safety boundary before application code loads, and the rest of the architecture is built around it.

## System boundary

HCC is a local-first TypeScript control plane with two hardened launch surfaces:

- CLI: `src/launch/cli.ts` → `src/cli.ts`
- MCP: `src/launch/mcp.ts` → `src/mcp/server.ts`

Both launchers apply `src/launch/safe-env.ts` before application imports. The application identity in `src/app.ts` is fixed to Mode A.

At a high level:

```text
CLI / MCP
   |
   v
safe-env + config + policy
   |
   +----------------------+----------------------+
   |                      |                      |
   v                      v                      v
adapters              local workflows       doctor/status
   |                      |                      |
   v                      v                      |
aggregate/rank        evidence/export             |
   |                      |                      |
   +-----------> state / SQLite <---------------+
```

## Main source areas

### `src/launch/`

Process entrypoints and environment hardening.

- `safe-env.ts` removes or overrides unsafe inherited authority before application imports.
- `cli.ts` starts the command-line surface.
- `mcp.ts` starts the stdio MCP surface.

Changes here are security-sensitive because they happen before the rest of the application can protect itself. Run the contract and adversarial-security tests for any change in this layer.

### `src/config.ts` and `src/policy/`

Configuration parsing and policy decisions.

`src/policy/` contains the Mode-A decision engine and mode definitions. Code here determines whether an operation remains a preparation-only action.

Relevant tests include `test/config.test.ts`, `test/policy.test.ts`, `test/launch-safe-env.test.ts`, and `test/security-adversarial.test.ts`.

### `src/core/`

Shared domain primitives, including:

- capabilities;
- typed errors;
- stable IDs;
- normalized models;
- money handling;
- schemas.

Prefer shared domain rules here rather than inventing slightly different versions inside individual adapters.

### `src/adapters/`

External service and work-source integrations. Each adapter converts an upstream surface into HCC domain models and is expected to fail in a bounded, explicit way.

Current adapter areas include CDP Bazaar/x402, Agent402, PipRail, Agent Bounties, BountyBook, the402, and Pay.sh/pay-skills.

Common contracts live in:

- `src/adapters/interface.ts`
- `src/adapters/registry.ts`
- `src/adapters/resource-url.ts`
- `src/adapters/x402-common.ts`

When changing an adapter, cover the states the operator actually needs to distinguish: success, healthy empty results, malformed responses, timeout/unavailability, capability declarations, and hostile URL/input behavior where applicable.

#### Adapter timeout and cancellation semantics

This boundary is important because “the caller stopped waiting” and “all provider work was forcibly terminated” are not the same claim.

HCC enforces these limits around external adapter operations (`src/adapters/registry.ts`, `src/network/retry.ts`):

- **Caller wait bound:** `adapterBudgetMs` strictly caps how long the HCC caller/control plane waits for one adapter invocation. When the budget expires, HCC returns `UPSTREAM_TIMEOUT`.
- **AbortSignal emission:** HCC creates and signals an `AbortSignal` when the adapter budget expires.
- **HCC-owned network resources:** requests made through HCC-owned `SafeFetch` are aborted and their underlying sockets are destroyed on budget expiration.
- **Third-party SDK limitation:** in single-threaded JavaScript, `Promise.race` cannot preemptively kill arbitrary asynchronous work. If a third-party SDK ignores the provided `AbortSignal` or exposes no cancellation/close primitive, its background promise can continue until natural completion.
- **Current PipRail status:** `@piprail/sdk` currently does not accept an `AbortSignal` or expose a cancel/close handle. HCC caller latency still remains bounded at `adapterBudgetMs`; the SDK's underlying task may continue in the background after HCC has already returned.
- **Architectural claim:** HCC does not claim hard process-level termination of non-cooperative third-party SDK work where the provider gives us no cancellation primitive. We should document that limitation rather than fake a stronger guarantee with artificial wording or unnecessary process isolation.

### `src/network/`

Network safety and resilience:

- `safe-fetch.ts` provides bounded request behavior;
- `retry.ts` centralizes retry behavior;
- `ssrf.ts` defends against unsafe destinations.

Do not bypass this layer with ad-hoc fetches for untrusted or upstream-controlled URLs.

### `src/aggregate/` and `src/ranking/`

Cross-adapter normalization, aggregation, and deterministic ranking for service and work discovery.

A new adapter should feed these shared layers rather than create another presentation path unless there is an explicit architectural reason.

### `src/actions/`

Preparation-only action intents for purchase, claim, and publish workflows.

These produce reviewable intent. They do not execute live value movement, claims, or production publication.

### `src/state/`

Local persistence:

- `sqlite.ts` owns the SQLite connection layer;
- `migrations.ts` owns schema migration logic;
- `repository.ts` owns persistence operations.

State changes should include migration/durability coverage when applicable. See `test/state.test.ts` and `test/durability.test.ts`.

### `src/evidence/` and `src/export/`

Evidence capture, hashing, provenance, sanitization, and repository/workspace export.

I want the operator to be able to review what HCC observed and what it prepared without turning evidence storage into another place where secrets or live authority can leak.

### `src/mcp/`

The Model Context Protocol server. `src/mcp/server.ts` owns the canonical HCC tool surface.

The public MCP contract is intentionally narrow and preparation-only. Any change to tool names, schemas, or tool count is a public compatibility change and must update `test/mcp.test.ts`, README documentation, and the relevant integration/compatibility notes.

### `src/opportunities/`

A separate but related local opportunity-processing subsystem. It includes ingestion, deduplication, triage, ranking, evaluation queues, operator packets, pursuit dossiers, verification planning, execution routing, human-candidate/fulfillment workflows, and local CLI entrypoints.

The `opportunities:*` npm scripts are developer/runtime entrypoints for these modules. Focused tests live under `test/opportunity-*.test.ts` and related files.

### `src/products/`

Local product/workspace inspection logic. `data-quality-profiler.ts` is currently the main product-oriented implementation.

## Request flow — discovery

A typical service-discovery request follows this path:

1. CLI or MCP receives the request.
2. Launcher hardening has already forced the safe environment.
3. Configuration and policy establish the Mode-A posture.
4. Registered adapters query or inspect their bounded upstream surfaces.
5. Network safety/retry logic isolates bad endpoints.
6. Adapter results are normalized.
7. Aggregation and ranking produce a stable result set.
8. State/evidence layers persist or capture reviewable information as required.
9. CLI returns human/JSON output or MCP returns the tool result.

The important property is that one degraded provider should not become a failure of the entire control plane.

## Request flow — preparation action

Commands such as `prepare purchase`, `prepare claim`, and `prepare publish` do **not** execute the external action.

They:

1. validate the target or product;
2. run applicable policy checks;
3. construct a bounded action intent;
4. capture enough information for operator review;
5. return or store the prepared representation without enabling live settlement or publication.

Preparation should remain visibly different from execution.

## Contributor change map

| Change | Start here | Tests to inspect first |
| --- | --- | --- |
| New/changed upstream adapter | `src/adapters/` | adapter-specific test + `test/adapters.test.ts` |
| Fetch/retry/URL security | `src/network/` | `test/safe-fetch.test.ts`, `test/ssrf.test.ts`, security tests |
| Ranking behavior | `src/ranking/`, `src/aggregate/` | `test/ranking.test.ts`, `test/aggregate.test.ts`, determinism tests |
| CLI behavior | `src/cli.ts` | `test/cli.test.ts` |
| MCP tool/schema | `src/mcp/server.ts` | `test/mcp.test.ts`, contract tests |
| Safety/mode policy | `src/launch/`, `src/config.ts`, `src/policy/` | config/policy/safe-env/security tests |
| Persistence/migration | `src/state/` | state + durability tests |
| Evidence/export | `src/evidence/`, `src/export/` | evidence + export tests |
| Opportunity workflow | `src/opportunities/` | matching `test/opportunity-*.test.ts` files |

## Architectural rules for pull requests

1. Preserve the Mode-A safety boundary unless an explicitly reviewed project decision changes it.
2. Keep adapter failures isolated; one upstream should not crash aggregate discovery.
3. Reuse shared schemas/models instead of creating parallel domain types without a reason.
4. Route untrusted network access through the hardened network layer.
5. Keep CLI JSON output and MCP schemas stable unless the change intentionally modifies a public contract.
6. Put tests close to the changed behavior; security-sensitive changes need adversarial coverage.
7. Avoid mixing unrelated refactors with functional changes.
8. Do not describe a third-party limitation as solved unless the underlying implementation actually provides the claimed guarantee.

See [`DEVELOPMENT.md`](DEVELOPMENT.md) for the development loop and [`CONTRIBUTING.md`](../CONTRIBUTING.md) for contribution policy.
