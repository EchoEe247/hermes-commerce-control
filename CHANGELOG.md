# Changelog

All notable changes to Hermes Commerce Control will be documented in this file.

The project follows semantic versioning for published releases.

## [0.1.0] - Unreleased

Initial standalone open-source release candidate.

### Added

- Local-first Node.js 24 TypeScript CLI for discovery, inspection, ranking, evidence export, health probes, and preparation-only commerce intents.
- Stdio Model Context Protocol server exposing exactly 11 canonical tools.
- Hardened CLI and MCP launchers that remove wallet/signing-secret environment variables before importing application code.
- Forced Mode-A startup with general external writes and live value movement disabled.
- Seven bounded commerce/work adapters with typed per-source degradation and timeout isolation.
- Local SQLite state and deterministic evidence/ranking paths.
- SSRF protections, schema validation, hostile-input handling, evidence sanitization, and secret-redaction tests.
- Hermes integration installer with explicit optional workspace pinning.
- Portable current-working-directory behavior when no repository root is explicitly configured.
- Standalone product-readiness fixtures so the test suite does not depend on the former monorepo tree.
- Package-boundary verification using `npm pack --dry-run`.
- Full and contract test suites, including serial execution for constrained hosts.
- Apache License 2.0, contribution guidelines, security policy, code of conduct, and zero-secret quickstart.

### Validated before release

- 562/562 full tests passed on Pixel 6a / Android 17 / native Termux.
- 68/68 contract tests passed.
- Standalone GitHub Actions CI passed on Node 24.
- Package boundary passed with 95 files in the pre-license standalone package validation.
- Full and runtime-only npm audits reported zero vulnerabilities at the extraction gate.
- Real Hermes MCP integration discovered exactly 11 tools through the direct Node entrypoint.

### Safety boundary

Version 0.1.0 intentionally does **not** expose live pay, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish capability. Preparation actions remain non-executing and reviewable.

### Publication status

The repository may be licensed before package publication. `private: true` remains authoritative until a separate release decision explicitly approves npm publication.
