# Hermes Commerce Control Plane

Unified agent-commerce command center and Model Context Protocol (MCP) server for local discovery, ranking, evidence capture, and preparation-only machine-commerce workflows.

> **Publication status:** this package remains `private` while the standalone release boundary and OSS license are finalized. Source provenance has been traced to the project design/implementation history and direct/transitive dependency licensing has been audited; those reviews do **not** by themselves authorize npm publication. No npm package has been published from this branch.

## Architecture

The control plane is a Node.js 24 TypeScript package with two supported process entrypoints:

1. **CLI launcher:** `dist/launch/cli.js` (`commerce` package bin)
2. **MCP launcher:** `dist/launch/mcp.js` (`commerce-mcp` package bin)

Both launchers harden the environment **before dynamically importing application code**. This makes the Mode-A launch boundary part of the Node package itself instead of depending on a generated Bash wrapper.

The implementation modules remain reusable libraries:

- `src/cli.ts` — command implementation and `runCli()`
- `src/mcp/server.ts` — MCP server implementation and `serveStdio()`
- `src/launch/safe-env.ts` — wallet/signing-secret removal and forced Mode-A gates

## Runtime and state

### Portable package defaults

When run without installer-specific overrides:

- **State root:** `~/.hermes/commerce-control/`
- **SQLite database:** `~/.hermes/commerce-control/state.db`
- **Repository/workspace root:** `process.cwd()`

`COMMERCE_REPO_ROOT` is optional. When explicitly supplied it selects the local repository/workspace used for product inspection and evidence export. The package does **not** need to live inside `agent-commerce-hub`.

### Hermes installer layout

The Hermes integration installer creates:

- `~/.hermes/commerce-control/commerce-control-mcp.sh`
- `~/.hermes/commerce-control/commerce-control-cli.sh`
- `~/.hermes/commerce-control/state/`
- `~/.hermes/commerce-control/install.log`

These wrappers are intentionally thin. They set the installer-specific state root and execute the hardened Node launchers; they do not duplicate wallet-secret scrubbing or the Mode-A gate logic.

The installer does **not** derive a workspace from the package's monorepo location. With no workspace option it leaves `COMMERCE_REPO_ROOT` unset. An operator who needs deterministic evidence/product paths for a long-lived Hermes registration can pin an explicit existing workspace with `--workspace PATH`.

---

## Mode-A security boundary

The control plane operates under **Mode A**: discovery, local persistence, inspection, ranking, evidence export, and preparation-only intents.

### Enforced launch invariants

The hardened CLI and MCP launchers:

- remove inherited environment variables whose names indicate wallet or financial-signing authority, including private keys, mnemonics, seed phrases, signing keys, keystores, xprv values, and NWC values;
- force `COMMERCE_MODE=A`;
- force `EXTERNAL_WRITES_ENABLED=false`;
- force `LIVE_VALUE_MOVEMENT_ENABLED=false`;
- preserve ordinary non-wallet configuration such as API credentials and an explicitly configured `COMMERCE_REPO_ROOT`.

The hardening happens before the launcher imports `cli.ts` or `mcp/server.ts`. Wallet values are never copied into diagnostic output; tests deal with variable **names** only.

The doctor command independently reports whether wallet/signing-secret variables are visible to the process. This provides a useful control check when testing direct/internal entrypoints versus the hardened launchers.

### Capability boundary

There is no live pay, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish tool in the exposed MCP surface. Preparation commands produce reviewable intents and policy decisions; they do not execute the external action.

---

## Platforms and adapters

The control plane currently coordinates seven machine-commerce sources through bounded adapters.

### Primary adapters

- **CDP Bazaar / x402** — discover machine-native HTTP service catalogs.
- **Agent402.Tools** — discover tool schemas, pricing, and routes.
- **PipRail** — discover service/payment-routing metadata without exposing a signer.
- **Agent Bounties** — discover open programmatic work/reward inventory.

### Secondary adapters

- **BountyBook**
- **the402**
- **Pay.sh / pay-skills**

Network failures degrade individual sources rather than crashing aggregate discovery. Timeouts, rate limits, malformed responses, and upstream outages are recorded as typed degraded/unreachable results.

---

## Build and portable local use

### Requirements

- Node.js `>=24.15.0 <25`
- npm

From this package directory:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:contracts
npm run test:package
```

`test:package` runs `npm pack --dry-run` and fails if development-only paths such as `src/`, `test/`, `tsconfig.json`, or the package-boundary verifier itself enter the release tarball. `package.json` has an explicit `files` allowlist for the compiled runtime and the Hermes installer script.

Run the hardened CLI directly from the build:

```bash
node dist/launch/cli.js doctor --json
node dist/launch/cli.js status --json
node dist/launch/cli.js probe
```

Run the hardened stdio MCP entrypoint:

```bash
node dist/launch/mcp.js
```

The package metadata defines these installable bins:

```text
commerce     -> dist/launch/cli.js
commerce-mcp -> dist/launch/mcp.js
```

The package remains `private` until the standalone release and license decision is complete.

### Workspace selection

By default, repository-facing operations use the caller's current working directory:

```bash
cd /path/to/a/workspace
node /path/to/hermes-commerce-control/dist/launch/cli.js export
```

Or set an explicit local workspace:

```bash
COMMERCE_REPO_ROOT=/path/to/a/workspace \
  node dist/launch/cli.js export
```

No installer should silently replace this portable behavior with the package's own monorepo location.

---

## Hermes integration

Build, validate, and create local wrappers without changing Hermes registration:

```bash
bash scripts/install-hermes-commerce-control.sh --skip-register
```

Perform full local Hermes integration using runtime CWD as the default workspace behavior:

```bash
bash scripts/install-hermes-commerce-control.sh
```

For a persistent Hermes registration that should always inspect/export against one known repository, pin that choice explicitly:

```bash
bash scripts/install-hermes-commerce-control.sh \
  --workspace /absolute/path/to/workspace
```

Other supported options:

```text
--skip-deps       reuse the current dependency tree
--skip-register   validate/install wrappers without modifying Hermes registration
--force           remove and re-add an existing commerce-control MCP registration
--workspace PATH  explicitly pin COMMERCE_REPO_ROOT in generated wrappers
```

The installer validates Node `>=24.15.0 <25`, builds the package, proves the direct doctor sees a fake wallet canary while the hardened launcher removes it, proves hostile inherited gate values normalize back to Mode A, runs the doctor through the hardened wrapper, and verifies the exact MCP tool set before registration.

### Native Termux / Hermes v0.20.0 compatibility

Pixel 6a validation on native Termux showed two host-runtime problems in Hermes v0.20.0 that are outside HCC:

1. the Hermes Python environment can fail loading `cryptography` with `PyLong_Type` on Termux;
2. the v0.20.0 per-server MCP stdio watchdog can fail to `exec()` a `#!/usr/bin/env bash` wrapper even when that wrapper runs directly in the Termux shell.

HCC itself passed the native runtime gate by registering the **absolute Node executable** as the MCP command and `dist/launch/mcp.js` as its argument. Hermes successfully connected and discovered all 11 tools. This is also the most direct integration shape for environments where wrapper execution is unreliable:

```bash
NODE_REAL="$(command -v node)"
MCP_JS="$(pwd)/dist/launch/mcp.js"

hermes mcp add commerce-control \
  --command "$NODE_REAL" \
  --args "$MCP_JS"
```

`--args` must be the final Hermes option. Add `--env COMMERCE_STATE_ROOT=...` and/or `--env COMMERCE_REPO_ROOT=...` before `--args` when explicit state/workspace locations are required.

If the Hermes CLI itself fails before MCP operations with the Termux `cryptography` loader error, repair/update the Hermes runtime first. HCC does not require `LD_PRELOAD` or a Python runtime modification.

Do not publish the package or remove `private: true` merely because the installer/runtime validation works.

---

## Command reference

The CLI supports:

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

`--json` keeps stdout machine-readable; diagnostics go to stderr.

## MCP surface

The stdio server exposes exactly these 11 canonical tools:

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

---

## Validated release-readiness evidence

The current portability branch has passed:

1. Node 24 clean install, build, typecheck, full test suite, and contract suite;
2. **562/562** full tests and **68/68** contract tests on the Pixel validation revision;
3. full and runtime-only npm security audit with zero vulnerabilities after the transitive lock update;
4. direct and transitive dependency-license inventory with no missing/custom/copyleft license flags in the installed tree;
5. wallet-canary removal and forced Mode-A gate normalization;
6. CWD-default and explicit-workspace portability;
7. packed CLI and MCP bin execution;
8. isolated installer validation;
9. native Pixel 6a / Android 17 / Termux execution;
10. real Hermes MCP connection through the direct Node entrypoint with exactly **11 discovered tools** and no HCC stderr failure.

The remaining release work is package-size/boundary CI confirmation, standalone repository extraction, OSS license selection, contributor/security documentation, and the deliberate removal of `private: true` only when publication is approved.

---

## Uninstallation of the Hermes integration layout

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
