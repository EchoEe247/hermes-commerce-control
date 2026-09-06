# Distribution and package contract

Hermes Commerce Control is distributed as a prebuilt Node.js CLI and stdio MCP server through npm.

The canonical public package is currently **`hermes-commerce-control@0.1.2`**.

I want the 0.x public contract kept deliberately narrow. HCC is still pre-1.0, so adding extra package surfaces just because npm can expose them would make compatibility harder without necessarily giving users anything useful.

## Supported package surface

The 0.x npm package exposes two executable contracts:

- `commerce` — hardened Mode-A CLI entrypoint.
- `commerce-mcp` — hardened stdio MCP server with the canonical 11-tool surface.

There is no supported JavaScript library import API in 0.x. Internal files under `dist/` are implementation details even though npm ships them to support the executables. `package.json` is the only declared package export.

## Runtime requirements

- Node.js `>=24.15.0 <25`.
- npm or another package manager that can install npm packages.
- No wallet, signer, seed phrase, exchange credential, or payment authorization is required for startup.

## Install from npm

Global installation:

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

For MCP hosts that accept a command path, a global install provides:

```bash
command -v commerce-mcp
```

For Hermes:

```bash
hermes mcp add commerce-control \
  --command "$(command -v commerce-mcp)" \
  --connect-timeout 90
```

The repository-only `scripts/install-hermes-commerce-control.sh` remains a source-checkout integration helper. It is intentionally outside the npm tarball because a prebuilt registry consumer does not need source-tree dependency/build work.

## Release gate

A registry publication should happen only after the exact candidate passes:

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

### `test:package`

Verifies that:

- the package is not private;
- public access is explicit;
- the two executable entrypoints are exact;
- no unsupported JavaScript import API is exported;
- required metadata and launch artifacts are present;
- source, tests, workflows, lockfiles, TypeScript config, and repository-only scripts stay outside the tarball.

### `test:registry`

Queries the live npm registry and passes only if the package name is unclaimed or the existing package identifies this GitHub repository.

A name collision with an unrelated package is a hard failure.

### `test:install`

Builds a real tarball, creates a blank consumer project, installs only that tarball plus runtime dependencies, then verifies:

- `commerce doctor --json` starts with zero secrets;
- hostile inherited activation flags are forced back to Mode A;
- `commerce status --json` and `commerce sources --json` work outside the source tree;
- `commerce-mcp` completes a stdio initialize/tools-list handshake;
- exactly the canonical 11 MCP tools are exposed;
- runtime-reported version matches the package artifact.

A release is not proven by the source checkout alone. The consumer artifact is part of the contract.

## Published npm baseline

Release history:

- `v0.1.0` — source-only initial release; npm publication intentionally deferred.
- `v0.1.1` — first public npm release.
- `v0.1.2` — current canonical npm/GitHub patch release; corrected runtime/package version drift and added the clean-consumer regression gate.

Current package:

```text
name:    hermes-commerce-control
latest:  0.1.2
bins:    commerce, commerce-mcp
exports: ./package.json only
```

Published versions are immutable. Do not retag, overwrite, or republish an existing version in place.

## Future npm release procedure

Credentialed publication belongs in Hermes/local release tooling so registry credentials stay outside ChatGPT.

For a future release:

1. update package/release metadata to the new SemVer version;
2. run the full gate on the exact candidate;
3. merge only the reviewed release candidate;
4. create the matching Git commit and `vX.Y.Z` tag;
5. publish the exact tagged tree with `npm publish --access public --provenance` when the local npm client/account supports provenance;
6. create or update the matching GitHub release;
7. verify live npm metadata;
8. install the public version into a clean consumer directory and repeat CLI/MCP/version smoke checks.

For me, `npm publish` returning success is not enough. The release is complete when the public artifact matches the tagged source and passes the documented consumer contract.

## Official MCP Registry state

The Official MCP Registry is a separate distribution surface from npm.

The Registry requirements reverified on 2026-09-04 established that:

- public npm packages are supported;
- `stdio` package transport is supported;
- publication uses a `server.json` manifest;
- npm ownership verification requires the published npm package to contain an `mcpName` exactly matching the Registry server name;
- GitHub authentication can authorize the `io.github.<user>/*` namespace;
- Registry publication happens after the referenced npm version exists publicly.

Published `hermes-commerce-control@0.1.2` does **not** contain `mcpName`, so it cannot be legitimately registered as-is.

A narrow **0.1.3 Registry-compatibility candidate** was prepared on branch `cycle2/mcp-registry-0.1.3` / PR #13 with:

- `mcpName: io.github.EchoEe247/hermes-commerce-control`;
- matching current-schema `server.json` npm/stdio metadata;
- package-boundary checks tying Registry name/version/package/transport to the npm artifact;
- unchanged `commerce` + `commerce-mcp` binaries and `./package.json`-only JavaScript export;
- unchanged Mode A, zero-secret startup, and exactly 11 MCP tools.

That candidate passed the then-current `mcp-publisher validate server.json` check and the full candidate CI gate, including 562/562 tests, 68/68 contracts, clean consumer/version/MCP checks, and full/runtime npm audits at 0 vulnerabilities.

PR #13 is **closed without merge**. There is no public `0.1.3` package and no Official MCP Registry entry. The candidate is dormant/recoverable and **0.1.2 remains canonical**.

If I intentionally resume the Registry path, the sequence is:

1. refresh current Registry/npm requirements;
2. review the dormant candidate against current requirements and perform authorized Hermes/local validation;
3. merge only if it is still clean;
4. publish `hermes-commerce-control@0.1.3` through the authenticated npm path;
5. independently verify the public package/runtime contract;
6. authenticate `mcp-publisher` with the authorized GitHub identity;
7. publish `server.json`;
8. verify the exact Registry entry and preserve a publication receipt.

Do not add a third npm binary or broaden the public package surface merely to accommodate generic executable inference unless real client evidence justifies that compatibility change.

## SemVer policy

HCC follows semantic versioning.

During 0.x:

- **patch:** compatible fixes, documentation, packaging/release improvements, and additive behavior that does not change the documented CLI/MCP contract;
- **minor:** intentional additions or changes to the documented CLI command surface, MCP tool contract, persisted-state compatibility, or other externally consumed behavior;
- **major (`1.0.0`):** first stable compatibility commitment.

Removing or renaming a documented executable, CLI command, MCP tool, required field, or established behavior should never be hidden inside a patch release.

## Measuring real adoption

Only organic external use counts.

Do not create downloads, dependents, repositories, packages, or synthetic consumers for the purpose of inflating adoption metrics.

Useful registry checks include:

```bash
npm view hermes-commerce-control version dist-tags repository
npm view hermes-commerce-control time --json
```

The npm Downloads API can be used for auditable raw counts when it actually returns data:

```text
https://api.npmjs.org/downloads/point/last-month/hermes-commerce-control
```

At the 2026-09-04 Cycle 2 measurement, the Downloads API returned HTTP 404 `package hermes-commerce-control not found` for the checked windows even though registry metadata and package installation were live.

That metric is therefore **UNAVAILABLE / UNVERIFIED**, not zero.

When data becomes available, record the returned period, package name, raw count, timestamp, and source. Do not equate downloads with unique users. Known maintainer/release-validation installs should be disclosed as a caveat without inventing an unsupported subtraction.

Dependent repository/package counts require machine-verifiable consumption evidence such as a package manifest, lockfile, install/setup dependency edge, or equivalent.

Text mentions, review logs, indexes, copied release notes, synthetic consumers, and owner-created qualification fixtures do not count as external dependencies.

Current confirmed external dependent repositories/packages: **0 / 0**.

## Current publication status

- GitHub source releases: live through **v0.1.2**.
- npm package: **`hermes-commerce-control@0.1.2` live and canonical**.
- npm Downloads API: **UNAVAILABLE / UNVERIFIED** at the latest checked window.
- Official MCP Registry: **not yet published**.
- Registry-compatible 0.1.3 candidate: **validated at its historical gate, closed unmerged, dormant/recoverable, not public**.
