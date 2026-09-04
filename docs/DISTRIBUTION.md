# Distribution and package contract

Hermes Commerce Control (HCC) is distributed as a prebuilt Node.js CLI and MCP server through npm.

The canonical public package is currently **`hermes-commerce-control@0.1.2`**. This document defines the supported npm surface, release gate, current Registry state, and the metrics that may be used to measure real adoption.

## Supported package surface

The 0.x npm package intentionally exposes two executable contracts:

- `commerce` — hardened Mode-A CLI entrypoint.
- `commerce-mcp` — hardened stdio MCP server exposing the canonical 11-tool surface.

There is no supported JavaScript library import API in 0.x. Internal files under `dist/` are implementation details even though npm necessarily ships them to back the executables. `package.json` is the only declared package export.

This keeps the compatibility promise narrow enough to version safely while the project is still pre-1.0.

## Runtime requirements

- Node.js `>=24.15.0 <25`.
- npm or another package manager capable of installing npm packages.
- No wallet, signer, seed phrase, exchange credential, or payment authorization is required for startup.

## Install from npm

Global installation:

```bash
npm install --global hermes-commerce-control
commerce doctor --json
commerce status --json
commerce sources --json
```

A project can also install HCC locally:

```bash
npm install hermes-commerce-control
npm exec -- commerce doctor --json
```

For MCP hosts that accept a command path, a global install provides the stable executable directly:

```bash
command -v commerce-mcp
```

For Hermes specifically:

```bash
hermes mcp add commerce-control \
  --command "$(command -v commerce-mcp)" \
  --connect-timeout 90
```

The repository-only `scripts/install-hermes-commerce-control.sh` remains a source-checkout integration helper. It is deliberately not part of the npm tarball because it performs source-tree dependency/build work that a prebuilt registry consumer neither needs nor receives.

## Release gate

A new registry publication is allowed only after all of the following pass on the exact release candidate:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:contracts
npm run test:package
npm run test:registry
npm run test:install
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
```

`test:package` verifies that:

- the package is not marked private;
- public access is explicit;
- the two executable entrypoints are exact;
- no unsupported JavaScript import API is exported;
- required metadata and launch artifacts are present;
- source, tests, workflows, lockfiles, TypeScript config, and repository-only scripts are absent from the tarball.

`test:registry` queries the live npm registry. It passes only when the package name is unclaimed or the existing registry package identifies this GitHub repository. A name collision with an unrelated package is a hard failure.

`test:install` builds a real tarball, creates a blank consumer project, installs only that tarball plus its runtime dependencies, then verifies:

- `commerce doctor --json` starts with zero secrets;
- hostile inherited activation flags are forced back to Mode A;
- `commerce status --json` and `commerce sources --json` work outside the source tree;
- `commerce-mcp` completes a stdio initialize/tools-list handshake;
- exactly the canonical 11 MCP tools are exposed;
- runtime-reported version matches the package artifact.

## Published npm baseline

Release history:

- `v0.1.0` was intentionally source-only. Its existing GitHub tag must never be reused for a different npm artifact.
- `v0.1.1` was the first public npm release.
- `v0.1.2` is the current canonical npm/GitHub patch release. It corrected runtime/package version drift and added the clean-consumer regression gate.

Current package:

```text
name:    hermes-commerce-control
latest:  0.1.2
bins:    commerce, commerce-mcp
exports: ./package.json only
```

Published versions are immutable. Never retag, overwrite, or republish an existing version in place.

## Future npm release procedure

Credentialed publication is executed from Hermes/local release tooling so registry credentials remain outside ChatGPT.

For a future release, the release operator should:

1. update all package/release metadata to the new SemVer version;
2. rerun the full release gate above on the exact candidate;
3. merge only the reviewed release candidate;
4. create the matching Git commit and `vX.Y.Z` tag;
5. publish the exact tagged tree with `npm publish --access public --provenance` when the local npm client/account supports provenance;
6. create/update the matching GitHub release;
7. verify live npm metadata;
8. install the published version into a clean consumer directory and repeat CLI/MCP/version smoke checks.

A release is not complete merely because `npm publish` returned success; the public artifact must match the tagged source and pass the documented consumer contract.

## Official MCP Registry state

The Official MCP Registry is a separate distribution surface from npm.

Current first-party Registry rules reverified on 2026-09-04 establish that:

- public npm packages are supported;
- `stdio` package transport is supported;
- publication uses a `server.json` manifest;
- npm ownership verification requires the published npm package to contain an `mcpName` that exactly matches the Registry server name;
- GitHub authentication can authorize the `io.github.<user>/*` namespace;
- Registry publication happens after the referenced npm package/version exists publicly.

Published `hermes-commerce-control@0.1.2` does **not** contain `mcpName`, so it cannot be legitimately registered as-is.

A narrowly scoped **0.1.3 Registry-compatibility candidate** was prepared on branch `cycle2/mcp-registry-0.1.3` / PR #13 with:

- `mcpName: io.github.EchoEe247/hermes-commerce-control`;
- matching current-schema `server.json` npm/stdio metadata;
- package-boundary checks tying Registry name/version/package/transport to the npm artifact;
- unchanged `commerce` + `commerce-mcp` binaries and `./package.json`-only JavaScript export;
- unchanged Mode A, zero-secret startup, and exactly 11 MCP tools.

The candidate passed current `mcp-publisher validate server.json` and the full candidate CI gate, including 562/562 tests, 68/68 contracts, clean consumer/version/MCP checks, and full/runtime npm audits at 0 vulnerabilities.

PR #13 is **closed without merge** and the candidate is dormant/recoverable. There is no public 0.1.3 package and no Official MCP Registry entry. **0.1.2 remains canonical.**

If Angel intentionally resumes this path, the correct sequence is:

1. refresh current Registry/npm requirements;
2. reopen/review the dormant candidate and perform the authorized Hermes/local validation;
3. merge only if still clean;
4. publish `hermes-commerce-control@0.1.3` through the authenticated npm path;
5. independently verify the public package/runtime contract;
6. authenticate `mcp-publisher` with the authorized GitHub identity;
7. publish `server.json`;
8. verify the exact Registry entry and preserve a publication receipt.

Do not add a third npm binary or broaden the public package surface merely to accommodate generic executable inference unless real client integration evidence justifies that compatibility change.

## SemVer policy

HCC follows semantic versioning.

During 0.x:

- patch: compatible fixes, documentation, packaging/release improvements, and additive behavior that does not change the documented CLI/MCP contract;
- minor: intentional additions or changes to the documented CLI command surface, MCP tool contract, persisted-state compatibility, or other externally consumed behavior;
- major (`1.0.0`): first stable compatibility commitment.

Removing or renaming a documented executable, CLI command, MCP tool, required field, or established behavior must not be hidden in a patch release.

## Measuring real adoption

Only organic external use counts. Never create downloads, dependents, repositories, or packages for the purpose of inflating metrics.

Useful registry checks include:

```bash
npm view hermes-commerce-control version dist-tags repository
npm view hermes-commerce-control time --json
```

The npm Downloads API can be used for auditable raw download counts when it returns data:

```text
https://api.npmjs.org/downloads/point/last-month/hermes-commerce-control
```

As of the 2026-09-04 Cycle 2 measurement, the Downloads API returned HTTP 404 `package hermes-commerce-control not found` for the checked 2026-09-03/04 windows even though registry metadata and package installation were live. The download metric is therefore **UNAVAILABLE / UNVERIFIED**, not zero.

When data becomes available, record the returned period, package name, raw download count, timestamp, and source. Do not equate downloads with unique users. Known maintainer/release-validation installs should be disclosed as a caveat without inventing an unsupported subtraction.

Dependent repository/package counts require machine-verifiable consumption evidence such as a package manifest, lockfile, install/setup dependency edge, or equivalent. Text mentions, review logs, indexes, copied release notes, synthetic consumers, and owner-created qualification fixtures do not count as external dependencies.

Current confirmed external dependent repositories/packages: **0 / 0**.

## Publication status

- GitHub source releases: live through **v0.1.2**.
- npm package: **`hermes-commerce-control@0.1.2` live and canonical**.
- npm Downloads API: **UNAVAILABLE / UNVERIFIED** at the latest checked window.
- Official MCP Registry: **not yet published**.
- Registry-compatible 0.1.3 candidate: **validated, closed unmerged, dormant/recoverable, not public**.
