# Architecture

This document is a contributor-oriented map of Hermes Commerce Control (HCC). It is intentionally about code ownership and data flow rather than package distribution.

## System boundary

HCC is a local-first TypeScript control plane with two hardened launch surfaces:

- CLI: `src/launch/cli.ts` -> `src/cli.ts`
- MCP: `src/launch/mcp.ts` -> `src/mcp/server.ts`

Both launchers apply `src/launch/safe-env.ts` before application code is loaded. The application identity in `src/app.ts` is fixed to Mode A. Contributors should treat the preparation-only boundary as an architectural invariant, not a runtime preference.

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

Changes here are security-sensitive. Always run the contract and adversarial security tests.

### `src/config.ts` and `src/policy/`

Configuration parsing and policy decisions.

`src/policy/` contains the Mode-A decision engine and mode definitions. Code in this layer determines whether an operation is permitted to proceed as a preparation-only action.

Relevant tests include `test/config.test.ts`, `test/policy.test.ts`, `test/launch-safe-env.test.ts`, and `test/security-adversarial.test.ts`.

### `src/core/`

Shared domain primitives:

- capabilities;
- typed errors;
- stable IDs;
- normalized models;
- money handling;
- schemas.

Prefer adding shared domain rules here instead of duplicating representations inside individual adapters.

### `src/adapters/`

External service/work-source integrations. Each adapter normalizes an upstream surface into HCC domain models and is expected to fail in a bounded way.

Current adapter areas include CDP Bazaar/x402, Agent402, PipRail, Agent Bounties, BountyBook, the402, and Pay.sh/pay-skills.

Common adapter contracts live in `src/adapters/interface.ts`, registration in `src/adapters/registry.ts`, URL handling in `src/adapters/resource-url.ts`, and shared x402 behavior in `src/adapters/x402-common.ts`.

When changing an adapter, cover success, empty-but-healthy results, malformed responses, timeout/unavailability, capability declarations, and hostile URL/input cases where applicable.

### `src/network/`

Network safety and resilience:

- `safe-fetch.ts` provides bounded request behavior;
- `retry.ts` centralizes retry behavior;
- `ssrf.ts` defends against unsafe destinations.

Do not bypass this layer with ad-hoc fetch calls for untrusted or upstream-controlled URLs.

### `src/aggregate/` and `src/ranking/`

Cross-adapter normalization, aggregation, and deterministic ranking for service and work discovery.

A new adapter should feed these layers rather than invent a separate presentation path unless the architecture explicitly requires it.

### `src/actions/`

Preparation-only action intents for purchase, claim, and publish workflows. These produce reviewable intent; they are not live value-moving execution paths.

### `src/state/`

Local persistence:

- `sqlite.ts` owns the SQLite connection layer;
- `migrations.ts` owns schema migration logic;
- `repository.ts` owns persistence operations.

State changes should come with migration/durability tests where appropriate. See `test/state.test.ts` and `test/durability.test.ts`.

### `src/evidence/` and `src/export/`

Evidence capture, hashing, provenance, sanitization, and repository/workspace export. These modules exist so an operator can review what HCC observed and prepared.

### `src/mcp/`

The Model Context Protocol server. `src/mcp/server.ts` exposes the canonical HCC tool surface. The public MCP contract is intentionally narrow and preparation-only.

Any change to tool names, schemas, or count is a public contract change and must update `test/mcp.test.ts`, README documentation, and compatibility notes.

### `src/opportunities/`

A separate but related local opportunity-processing subsystem. It includes ingestion, deduplication, triage, ranking, evaluation queues, operator packets, pursuit dossiers, verification planning, execution routing, human-candidate/fulfillment workflows, and local CLI entrypoints.

The npm scripts prefixed with `opportunities:` are developer/runtime entrypoints for these modules. This subsystem has its own focused tests under `test/opportunity-*.test.ts` and related files.

### `src/products/`

Local product/workspace inspection logic. `data-quality-profiler.ts` is currently the main product-oriented implementation.

## Request flow: discovery

A typical service discovery request follows this path:

1. CLI or MCP receives a request.
2. Launcher hardening has already forced the safe environment.
3. Configuration and policy establish the Mode-A runtime posture.
4. Registered adapters query or inspect their bounded upstream surfaces.
5. Network safety/retry logic isolates bad endpoints.
6. Adapter results are normalized.
7. Aggregation and ranking produce a stable result set.
8. State/evidence layers persist or capture reviewable information as required.
9. CLI returns human/JSON output or MCP returns a tool result.

## Request flow: preparation action

Preparation commands such as `prepare purchase`, `prepare claim`, and `prepare publish` do not execute the external action. They:

1. validate the requested target/product;
2. run applicable policy checks;
3. construct a bounded action intent;
4. capture enough information for operator review;
5. return/store the prepared representation without enabling live settlement or publication.

## Contributor change map

Use this as a first routing guide:

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

1. Preserve the Mode-A safety boundary unless an explicitly discussed project decision says otherwise.
2. Keep adapter failures isolated; one upstream should not crash aggregate discovery.
3. Reuse shared schemas/models instead of creating parallel domain types without a reason.
4. Route untrusted network access through the hardened network layer.
5. Keep CLI JSON output and MCP schemas stable unless the change intentionally modifies a public contract.
6. Add tests close to the behavior being changed; security-sensitive changes need adversarial coverage.
7. Avoid combining unrelated refactors with functional changes.

See [DEVELOPMENT.md](DEVELOPMENT.md) for the development loop and [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution policy.