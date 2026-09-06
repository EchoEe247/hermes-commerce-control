# Hermes Commerce Control

Hermes Commerce Control (HCC) is my local-first Node.js 24 CLI and Model Context Protocol (MCP) server for agent-commerce discovery, ranking, evidence capture, and **preparation-only** workflows.

The project is public Apache-2.0 OSS. The canonical release is **`hermes-commerce-control@0.1.2`**.

The main boundary is intentional: I want HCC to help an agent discover opportunities, inspect them, rank them, collect evidence, and prepare actions without quietly turning that preparation layer into a wallet or live-value execution system.

So HCC does **not** expose live pay, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish capability.

## What HCC provides

HCC has two hardened process entrypoints:

- `commerce` → `dist/launch/cli.js`
- `commerce-mcp` → `dist/launch/mcp.js`

Behind those entrypoints it coordinates bounded adapters for machine-commerce services and work opportunities, persists local state in SQLite, normalizes and ranks results, captures reviewable evidence, and prepares action intents for operator review.

Published releases are immutable. If the package, public contract, or Registry compatibility needs to change, ship a new SemVer release and rerun the clean-install/package/runtime gates instead of changing an existing version in place.

## Mode-A safety boundary

For me, this is not an optional runtime preference. It is the default product contract.

Both launchers harden the environment **before** importing application code. They:

- remove inherited wallet/signing-secret environment variables such as private keys, mnemonics, seed phrases, signing keys, keystores, xprv values, and NWC values;
- force `COMMERCE_MODE=A`;
- force `EXTERNAL_WRITES_ENABLED=false`;
- force `LIVE_VALUE_MOVEMENT_ENABLED=false`;
- preserve ordinary non-wallet configuration, including an explicitly configured `COMMERCE_REPO_ROOT`.

The doctor command independently reports the effective security posture without copying wallet values into diagnostic output.

If basic startup appears to require a wallet secret, that is a problem to investigate rather than a missing setup step.

## Requirements

- Node.js `>=24.15.0 <25`
- npm

For the npm contract, current publication state, SemVer policy, Registry boundary, and release gate, see [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

## Start here

**Trying HCC:** use the [zero-secret quickstart](docs/QUICKSTART.md).

**Connecting an MCP client:** use the [MCP integration walkthrough](docs/MCP_INTEGRATION.md).

**Contributing:** read [CONTRIBUTING.md](CONTRIBUTING.md), then use the [development guide](docs/DEVELOPMENT.md) and [architecture map](docs/ARCHITECTURE.md). The [roadmap](ROADMAP.md) describes where I want the project to go and what is deliberately outside that direction.

New contributors can look for issues labeled [`good first issue`](https://github.com/EchoEe247/hermes-commerce-control/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) and [`help wanted`](https://github.com/EchoEe247/hermes-commerce-control/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22).

## Good first contributions

The contributor path should not require learning the whole codebase before making something useful. Current scoped examples include:

- [#5 — Add a checked-in generic stdio MCP client example](https://github.com/EchoEe247/hermes-commerce-control/issues/5): portable integration/documentation work with concrete validation.
- [#8 — Add a docs contract check for the canonical MCP tool list](https://github.com/EchoEe247/hermes-commerce-control/issues/8): a bounded code/test task that prevents the public 11-tool documentation from drifting from implementation.
- [#4 — Document the local opportunity workflow end to end](https://github.com/EchoEe247/hermes-commerce-control/issues/4): documentation grounded in existing opportunity scripts and tests.
- [#7 — Add an adapter authoring and fixture guide](https://github.com/EchoEe247/hermes-commerce-control/issues/7): deeper contributor documentation around adapters, hardened fetching, and fixtures.

Each issue has acceptance criteria and starting files. Contributions should preserve the Mode-A boundary and run the focused validation described in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

## Build and validate

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:contracts
npm run test:package
npm run test:registry
npm run test:install
```

For constrained hosts such as Android/Termux:

```bash
npm run test:serial
```

`test:package` checks the compiled-only npm boundary and executable contract. `test:registry` verifies that the live npm package name belongs to this repository. `test:install` packs the real artifact, installs it into a blank consumer project, and exercises both hardened entrypoints.

## Install from npm

```bash
npm install --global hermes-commerce-control
commerce doctor --json
commerce status --json
commerce sources --json
```

Project-local installation:

```bash
npm install hermes-commerce-control
npm exec -- commerce doctor --json
```

The canonical public version is currently **0.1.2**.

## Zero-secret source quickstart

No wallet key, seed phrase, signer, exchange credential, or payment authorization is needed for normal startup.

```bash
npm ci
npm run build
node dist/launch/cli.js doctor --json
node dist/launch/cli.js status --json
node dist/launch/cli.js sources --json
```

Then optionally probe or discover public upstream sources:

```bash
node dist/launch/cli.js probe
node dist/launch/cli.js discover services --json
node dist/launch/cli.js discover work --json
```

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for the complete path.

## Runtime and state

Portable defaults:

- state root: `~/.hermes/commerce-control/`
- SQLite database: `~/.hermes/commerce-control/state.db`
- repository/workspace root: `process.cwd()`

`COMMERCE_REPO_ROOT` is optional. When supplied, it selects the local workspace used for product inspection and evidence export.

```bash
COMMERCE_REPO_ROOT=/absolute/path/to/workspace \
  node dist/launch/cli.js export
```

## CLI contract

The canonical CLI surface is:

- `sources`
- `status`
- `discover services`
- `discover work`
- `inspect <target>`
- `quote <target>`
- `prepare purchase <target>`
- `prepare claim <target>`
- `prepare publish <product>`
- `probe`
- `export`
- `doctor`

`--json` keeps stdout machine-readable and sends diagnostics to stderr.

## MCP contract

The stdio MCP server exposes exactly 11 canonical tools:

1. `commerce_status`
2. `commerce_sources`
3. `commerce_discover_services`
4. `commerce_discover_work`
5. `commerce_inspect`
6. `commerce_quote`
7. `commerce_prepare_purchase`
8. `commerce_prepare_claim`
9. `commerce_prepare_publish`
10. `commerce_probe`
11. `commerce_export_evidence`

There is no live-action sibling tool hidden beside that list.

Start the server directly:

```bash
node dist/launch/mcp.js
```

## Platforms and adapters

HCC currently coordinates seven bounded sources:

- CDP Bazaar / x402
- Agent402.Tools
- PipRail
- Agent Bounties
- BountyBook
- the402
- Pay.sh / pay-skills

Network failures are isolated per source. Timeouts, rate limits, malformed responses, and upstream outages become typed degraded/unreachable outcomes instead of crashing aggregate discovery.

One important boundary: HCC can strictly bound how long the caller waits for an adapter and can abort HCC-owned network resources. It cannot claim hard process-level cancellation of arbitrary third-party SDK work when the provider does not expose a cancellation primitive. The current PipRail SDK is an example of that limitation. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Hermes integration

The repository installer is a source-checkout helper and is intentionally outside the prebuilt npm tarball.

Validate/build wrappers without changing Hermes registration:

```bash
bash scripts/install-hermes-commerce-control.sh --skip-register
```

Full source-checkout installer path:

```bash
bash scripts/install-hermes-commerce-control.sh
```

Pin a workspace explicitly when needed:

```bash
bash scripts/install-hermes-commerce-control.sh \
  --workspace /absolute/path/to/workspace
```

Where shell-wrapper execution is unreliable, register the direct Node entrypoint:

```bash
NODE_REAL="$(command -v node)"
MCP_JS="$(pwd)/dist/launch/mcp.js"

hermes mcp add commerce-control \
  --command "$NODE_REAL" \
  --args "$MCP_JS"
```

After a global npm install, MCP hosts can use `commerce-mcp` directly. See [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

On native Termux, direct Node registration was validated against Hermes v0.20.0 and discovered all 11 tools.

## Validated release history

Before the OSS metadata gate, the standalone extraction passed:

- clean tracked-only extraction from the audited source revision;
- secret-file scan and synthetic-fixture allowlist checks;
- Node 24 `npm ci`, typecheck, and build;
- **562/562** full tests on Pixel 6a / Android 17 / native Termux;
- **68/68** contract tests;
- adapter timeout isolation checks;
- package-boundary verification;
- full and runtime-only npm audits;
- standalone GitHub Actions CI on the exact initial commit;
- real Hermes MCP connectivity through the direct Node entrypoint.

Release history:

- `v0.1.0` — source-only initial release; npm publication intentionally deferred.
- `v0.1.1` — first public npm release.
- `v0.1.2` — current canonical patch release; fixed runtime/package version drift and added the clean-consumer regression gate.

The Official MCP Registry is a separate distribution surface. Published `0.1.2` does not contain the Registry-required npm `mcpName`, so it is not registered as-is.

A validated `0.1.3` Registry-compatibility candidate exists as dormant/recoverable work, but it is not public and does not replace the canonical release. Until a reviewed release actually succeeds, **0.1.2 remains canonical**.

## Documentation map

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — fresh-clone zero-secret run path.
- [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) — generic stdio MCP + Hermes walkthrough.
- [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) — npm release/install contract, Registry state, and adoption measurement.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — development/test loop and CI-equivalent commands.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module/data-flow map and architectural boundaries.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contributor workflow, security invariants, and AI-assisted contribution policy.
- [`ROADMAP.md`](ROADMAP.md) — project direction and explicit non-goals.
- [`SECURITY.md`](SECURITY.md) — vulnerability-reporting policy and sensitive surfaces.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — participation standards.
- [`CHANGELOG.md`](CHANGELOG.md) — immutable release notes/history.

## License

Licensed under the [Apache License 2.0](LICENSE).

## Uninstalling the Hermes integration layout

```bash
if command -v hermes >/dev/null 2>&1; then
  hermes mcp remove commerce-control || true
fi

rm -rf ~/.hermes/commerce-control/
```

Package-local build outputs can be removed independently:

```bash
rm -rf dist/ node_modules/
```
