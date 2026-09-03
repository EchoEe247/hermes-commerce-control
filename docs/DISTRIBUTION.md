# Distribution and package contract

Hermes Commerce Control (HCC) is distributed as a prebuilt Node.js CLI and MCP server.

This document defines the supported npm surface, the release gate, and the metrics that may be used to measure real adoption.

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

After the first registry release:

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

A registry publication is allowed only after all of the following pass on the exact release candidate:

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
- exactly the canonical 11 MCP tools are exposed.

## First npm release

GitHub release `v0.1.0` was intentionally source-only and its release notes state that npm publication was deferred. Do **not** publish a different artifact under npm version `0.1.0`.

The first npm publication must therefore use a new version, normally `0.1.1`, after the distribution changes are merged and validated.

Credentialed publication is executed from Hermes/local release tooling so registry credentials remain outside ChatGPT. The release operator should:

1. update `package.json` and `package-lock.json` to the new patch version;
2. rerun the full release gate above;
3. create the matching Git commit and `vX.Y.Z` tag;
4. publish the exact tagged tree with `npm publish --access public --provenance` when the local npm client/account supports provenance;
5. create or update the matching GitHub release;
6. verify registry metadata and install the published version into another clean directory.

A release is not complete merely because `npm publish` returned success; the published artifact must pass the same CLI/MCP smoke checks.

## SemVer policy

HCC follows semantic versioning.

During 0.x:

- patch: compatible fixes, documentation, packaging/release improvements, and additive behavior that does not change the documented CLI/MCP contract;
- minor: intentional additions or changes to the documented CLI command surface, MCP tool contract, persisted-state compatibility, or other externally consumed behavior;
- major (`1.0.0`): first stable compatibility commitment.

Removing or renaming a documented executable, CLI command, MCP tool, required field, or established behavior must not be hidden in a patch release.

## Measuring real adoption

Only organic external use counts. Never create downloads, dependents, repositories, or packages for the purpose of inflating metrics.

Useful registry checks after publication include:

```bash
npm view hermes-commerce-control version dist-tags repository
npm view hermes-commerce-control time --json
```

The npm downloads API can be used for auditable download counts:

```text
https://api.npmjs.org/downloads/point/last-month/hermes-commerce-control
```

Record the returned period, package name, and download count together. Do not convert local installs, CI loops, or synthetic traffic into claimed adoption.

Dependent repository/package counts should be recorded from public ecosystem evidence with the observation date and source. Private repositories and projects controlled only to manufacture a dependency relationship do not count as external adoption.

## Publication status

Source release: available on GitHub.

npm package: publication is gated on the distribution PR passing CI, a new post-v0.1.0 version being created, and the credentialed Hermes publication step.
