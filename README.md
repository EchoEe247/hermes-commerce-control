# Hermes Commerce Control

Hermes Commerce Control (HCC) is a local-first Node.js 24 CLI and Model Context Protocol (MCP) server for agent-commerce discovery, ranking, evidence capture, and **preparation-only** workflows.

The project is a standalone Apache-2.0-licensed repository. Its npm metadata is public-package-ready, while registry publication remains a separate release action gated on clean-install and package-name checks.

## What HCC does

HCC provides two hardened process entrypoints:

- `commerce` → `dist/launch/cli.js`
- `commerce-mcp` → `dist/launch/mcp.js`

It coordinates bounded adapters for machine-commerce services and work opportunities, persists local state in SQLite, normalizes and ranks results, captures evidence, and prepares reviewable action intents.

It intentionally does **not** expose live pay, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish capability.

## Mode-A safety boundary

Both launchers harden the environment **before** importing application code. They:

- remove inherited wallet/signing-secret environment variables such as private keys, mnemonics, seed phrases, signing keys, keystores, xprv values, and NWC values;
- force `COMMERCE_MODE=A`;
- force `EXTERNAL_WRITES_ENABLED=false`;
- force `LIVE_VALUE_MOVEMENT_ENABLED=false`;
- preserve ordinary non-wallet configuration, including an explicitly configured `COMMERCE_REPO_ROOT`.

The doctor command independently reports the effective security posture. Wallet values are not copied into diagnostic output.

## Requirements

- Node.js `>=24.15.0 <25`
- npm

For the npm package contract, install paths, SemVer policy, and release gate, see [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

## Start here

**Trying HCC:** follow the [zero-secret quickstart](docs/QUICKSTART.md).

**Connecting an MCP client:** use the [MCP integration walkthrough](docs/MCP_INTEGRATION.md).

**Contributing:** read [CONTRIBUTING.md](CONTRIBUTING.md), then use the [development guide](docs/DEVELOPMENT.md) and [architecture map](docs/ARCHITECTURE.md). The [roadmap](ROADMAP.md) describes current direction and non-goals.

New contributors can look for issues labeled [`good first issue`](https://github.com/EchoEe247/hermes-commerce-control/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22) and [`help wanted`](https://github.com/EchoEe247/hermes-commerce-control/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22help%20wanted%22).

## Good first contributions

The following issues are intentionally scoped so an outside contributor can make a useful change without learning the entire codebase first:

- [#5 — Add a checked-in generic stdio MCP client example](https://github.com/EchoEe247/hermes-commerce-control/issues/5): small integration/documentation task with a portable example and validation.
- [#8 — Add a docs contract check for the canonical MCP tool list](https://github.com/EchoEe247/hermes-commerce-control/issues/8): bounded code/test task that prevents the public 11-tool documentation from drifting from the implementation contract.
- [#4 — Document the local opportunity workflow end to end](https://github.com/EchoEe247/hermes-commerce-control/issues/4): documentation task grounded in the existing opportunity scripts and tests.
- [#7 — Add an adapter authoring and fixture guide](https://github.com/EchoEe247/hermes-commerce-control/issues/7): deeper documentation task for contributors interested in adapters, hardened fetching, and test fixtures.

Each issue includes acceptance criteria and concrete starting files. Contributions should preserve the Mode-A safety boundary and include the focused validation described in [the development guide](docs/DEVELOPMENT.md).

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

`test:package` verifies the compiled-only npm boundary and public executable contract. `test:registry` rejects a package-name collision with an unrelated npm package. `test:install` packs the real artifact, installs it into a blank consumer project, and exercises both the hardened CLI and MCP entrypoints.

## Zero-secret quickstart

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

See [`docs/QUICKSTART.md`](docs/QUICKSTART.md) for the complete zero-secret path.

## Runtime and state

Portable defaults:

- state root: `~/.hermes/commerce-control/`
- SQLite database: `~/.hermes/commerce-control/state.db`
- repository/workspace root: `process.cwd()`

`COMMERCE_REPO_ROOT` is optional. When supplied, it selects the local workspace used for product inspection and evidence export.

Example:

```bash
COMMERCE_REPO_ROOT=/absolute/path/to/workspace \
  node dist/launch/cli.js export
```

## CLI commands

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

## MCP surface

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

No live-action sibling is part of the exposed tool set.

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

Network failures are isolated per source. Timeouts, rate limits, malformed responses, and upstream outages are represented as typed degraded/unreachable outcomes rather than crashing aggregate discovery.

## Hermes integration

The repository installer is a source-checkout helper and is intentionally not part of the prebuilt npm tarball.

Validate/build wrappers without changing Hermes registration:

```bash
bash scripts/install-hermes-commerce-control.sh --skip-register
```

Full source-checkout installer path:

```bash
bash scripts/install-hermes-commerce-control.sh
```

Pin a workspace explicitly when desired:

```bash
bash scripts/install-hermes-commerce-control.sh \
  --workspace /absolute/path/to/workspace
```

For environments where shell-wrapper execution is unreliable, register the direct Node entrypoint:

```bash
NODE_REAL="$(command -v node)"
MCP_JS="$(pwd)/dist/launch/mcp.js"

hermes mcp add commerce-control \
  --command "$NODE_REAL" \
  --args "$MCP_JS"
```

After an npm global install, MCP hosts can use the installed `commerce-mcp` executable directly; see [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md).

On native Termux this direct Node registration was validated against Hermes v0.20.0 and discovered all 11 tools.

## Validated standalone baseline

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

GitHub `v0.1.0` is the source-only initial release. The first npm publication must use a new version after the public-package distribution gate passes; npm `0.1.0` must not diverge from the existing GitHub tag.

## Project and contribution docs

- [`docs/QUICKSTART.md`](docs/QUICKSTART.md) — fresh-clone zero-secret run path.
- [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) — generic stdio MCP + Hermes walkthrough.
- [`docs/DISTRIBUTION.md`](docs/DISTRIBUTION.md) — npm install/release contract and adoption measurement.
- [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) — focused development/test loop and CI-equivalent commands.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — contributor-oriented module/data-flow map.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution workflow, security invariants, and AI-assisted contribution policy.
- [`ROADMAP.md`](ROADMAP.md) — current project direction and explicit non-goals.
- [`SECURITY.md`](SECURITY.md) — vulnerability-reporting policy and security-sensitive scope.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — participation standards.
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.

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
