# Hermes Commerce Control Roadmap

This roadmap explains where I want HCC to go. It is not a promise of dates, funding, releases, Registry publication, or live-value execution.

HCC is currently a **preparation-only Mode-A control plane**. I do not want live financial authority to arrive indirectly because it looked like the next obvious roadmap feature. Any change to that boundary would need an explicit product/security decision and its own evidence.

## Current — make the OSS baseline easy to use and contribute to

The immediate goal is a public project that outside users can actually run and outside contributors can understand without lowering the safety standard.

Priorities:

- keep the zero-secret CLI and MCP quickstart reproducible;
- make architecture and development workflows understandable to a new contributor;
- improve issue quality and contributor feedback loops;
- maintain deterministic, bounded discovery across upstream adapters;
- keep SSRF, environment isolation, and security tests strong;
- make state/evidence behavior auditable;
- reduce drift between documentation and the CLI/MCP public contracts;
- document real third-party limitations instead of implying stronger cancellation or reliability guarantees than providers expose.

Good work in this phase includes focused documentation, regression tests, bounded adapter fixes, fixture coverage, and developer tooling that makes validation easier without weakening the gates.

## Next — broader integrations and operational clarity

Likely areas, subject to issue-level design:

- clearer adapter authoring guidance and reusable test patterns;
- more reproducible generic MCP-client examples;
- stronger compatibility evidence across supported Node 24 environments;
- clearer opportunity-subsystem documentation and examples;
- better observability of degraded upstreams without exposing secrets;
- compatibility documentation for CLI JSON and MCP schema evolution;
- contributor-facing maintenance/release notes that distinguish public contracts from internal implementation.

## Later — ecosystem maturity

Longer-term OSS goals include:

- a stable contributor base with multiple maintainers/reviewers over time;
- real third-party integrations and usage examples;
- predictable compatibility/versioning policy;
- reusable conformance tests for adapters and MCP clients;
- documented upgrade/migration paths for persistent state and public contracts.

Distribution is its own release workstream. npm or MCP Registry publication should follow a validated package/public contract rather than becoming the reason to broaden that contract prematurely.

## Explicit non-goals

This roadmap does **not** authorize:

- live payment or settlement execution;
- wallet custody or signing authority;
- production publishing without operator review;
- weakening SSRF, schema-validation, or secret-isolation controls;
- fake stars, forks, issues, contributors, dependents, or downloads;
- features added only to make project activity look larger.

## How contributors can influence direction

- Small bug, test, or documentation fix: a focused PR is welcome.
- New adapter, public command/tool, protocol change, persistent-state change, or security-boundary change: open an issue first.
- Roadmap-aligned idea without a specification yet: open a feature request around the concrete user problem and acceptance criteria.

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md), and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
