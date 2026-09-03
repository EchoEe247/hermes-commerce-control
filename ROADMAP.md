# Hermes Commerce Control Roadmap

This roadmap communicates project direction to users and contributors. It is not a promise of dates, funding, package publication, or live-value execution.

HCC is currently a **preparation-only Mode-A control plane**. Safety-boundary changes require explicit design and review; they are not implicit roadmap items.

## Current: make the OSS baseline easy to use and change

Primary goals:

- keep the zero-secret CLI and MCP quickstart reproducible;
- make architecture and development workflows understandable to a new contributor;
- improve issue quality and contributor feedback loops;
- maintain deterministic, bounded discovery across upstream adapters;
- keep security/SSRF/environment-isolation tests strong;
- make state/evidence behavior auditable;
- reduce documentation drift from CLI and MCP contracts.

Good contributions in this phase include focused documentation improvements, regression tests, bounded adapter fixes, fixture coverage, and developer tooling that makes validation easier without weakening safety gates.

## Next: broader integrations and operational clarity

Likely areas of work, subject to issue-level design:

- clearer adapter authoring guidance and reusable adapter test patterns;
- more reproducible examples for generic MCP clients;
- stronger platform compatibility evidence across supported Node 24 environments;
- clearer opportunity-subsystem documentation and examples;
- better observability of degraded upstreams without exposing secrets;
- compatibility documentation for CLI JSON and MCP schema evolution;
- contributor-facing maintenance/release notes that distinguish public contracts from internal implementation.

## Later: ecosystem maturity

Longer-term OSS goals include:

- a stable contributor base with multiple maintainers/reviewers over time;
- real third-party integrations and usage examples;
- predictable compatibility/versioning policy;
- reusable conformance tests for adapters and MCP clients;
- documented upgrade/migration paths for persistent state and public contracts.

Distribution and registry publication are managed as a separate release workstream and should happen only when the package boundary and public API are technically ready.

## Explicit non-goals of this roadmap

This roadmap does **not** authorize:

- live payment or settlement execution;
- wallet custody or signing authority;
- production publishing without operator review;
- weakening SSRF, schema-validation, or secret-isolation controls;
- fake stars, forks, issues, contributors, dependents, or downloads;
- features added solely to inflate project activity.

## How contributors can influence direction

- For a small bug, test, or documentation fix: a focused PR is welcome.
- For a new adapter, new public command/tool, protocol change, persistent-state change, or security-boundary change: open an issue first.
- For an idea that matches a roadmap area but is not yet specified: open a feature request with a concrete user problem and acceptance criteria.

See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md), and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
