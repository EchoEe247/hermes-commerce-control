# Development Guide

This guide is the shortest reliable path from a fresh clone to a pull request that is ready for review.

## Prerequisites

- Node.js `>=24.15.0 <25`
- npm
- Git

Check your runtime before installing dependencies:

```bash
node --version
npm --version
```

HCC intentionally targets Node 24. If your Node version is outside the declared engine range, fix that first so failures are not confused with project bugs.

## Fresh-clone setup

```bash
git clone https://github.com/EchoEe247/hermes-commerce-control.git
cd hermes-commerce-control
npm ci
npm run typecheck
npm run build
```

At this point you can run the zero-secret smoke path:

```bash
node dist/launch/cli.js doctor --json
node dist/launch/cli.js status --json
node dist/launch/cli.js sources --json
```

Normal startup does not require wallet keys, seed phrases, signing authority, exchange credentials, or payment authorization.

## Test commands

### Full CI-equivalent validation

The repository CI currently runs:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:contracts
npm run test:package
npm audit --audit-level=moderate
npm audit --omit=dev --audit-level=moderate
```

Use this before requesting review on a substantial change.

### Full test suite

```bash
npm test
```

### Low-concurrency test suite

For constrained environments such as native Android/Termux:

```bash
npm run test:serial
```

### Contract/security subset

```bash
npm run test:contracts
```

This runs the configuration, policy, MCP, and adversarial-security contract files. Run it for changes affecting launchers, environment handling, commands/tools, configuration, policy, or safety behavior.

### Package-boundary check

```bash
npm run test:package
```

This validates what would be included in a package archive. Package publication itself is handled separately from contributor work, but contributors should not accidentally expand the release boundary with source/tests/internal files.

## Run one test file

The test suite uses Node's built-in test runner through `tsx`. To focus on a single file while developing:

```bash
node --import tsx --test test/<name>.test.ts
```

Examples:

```bash
node --import tsx --test test/mcp.test.ts
node --import tsx --test test/state.test.ts
node --import tsx --test test/piprail.test.ts
```

For a single-file serial run:

```bash
node --import tsx --test --test-concurrency=1 test/<name>.test.ts
```

## Build output

TypeScript source is under `src/`; compiled output is written to `dist/`.

Rebuild after source changes:

```bash
npm run build
```

Do not hand-edit `dist/`. Make the change in `src/` and regenerate it through the build.

## Local state and cleanup

Default HCC state lives under:

```text
~/.hermes/commerce-control/
```

The default SQLite database is:

```text
~/.hermes/commerce-control/state.db
```

Most unit tests use isolated fixtures or temporary state. If you are manually exercising the CLI and need a clean user-state baseline, preserve anything you care about before removing local state.

Build artifacts can be removed safely with:

```bash
rm -rf dist/ node_modules/
```

Then restore dependencies/build with:

```bash
npm ci
npm run build
```

## Change-specific validation

Use the architecture map in [ARCHITECTURE.md](ARCHITECTURE.md) to find the nearest tests. Minimum expectations:

### Adapter changes

Run the adapter's test file plus shared adapter/aggregate tests. Cover, when relevant:

- normal successful normalization;
- healthy empty response;
- malformed upstream payload;
- timeout/rate-limit/unreachable behavior;
- capability/actionability declarations;
- hostile or unsafe URLs.

### CLI changes

Run:

```bash
node --import tsx --test test/cli.test.ts
```

If JSON output changes, treat it as a compatibility change and document it.

### MCP changes

Run:

```bash
node --import tsx --test test/mcp.test.ts
npm run test:contracts
```

Tool names and schemas are public integration contracts.

### Network/security changes

Run the focused tests plus contracts:

```bash
node --import tsx --test test/safe-fetch.test.ts
node --import tsx --test test/ssrf.test.ts
npm run test:contracts
```

### State/migration changes

Run:

```bash
node --import tsx --test test/state.test.ts
node --import tsx --test test/durability.test.ts
```

### Opportunity subsystem changes

Use the matching `test/opportunity-*.test.ts` file(s). The package scripts named `opportunities:*` expose development/runtime entrypoints for these workflows.

## Working on an issue

1. Read the issue and linked code/tests before writing code.
2. Comment on the issue if acceptance criteria are unclear or the change is larger than described.
3. Create a focused branch.
4. Add or update tests with the implementation.
5. Run the smallest relevant test loop while developing.
6. Run typecheck/build and the relevant broader suite before opening a PR.
7. In the PR, list exactly what you ran. If something could not be run, state that explicitly.

## Pull request scope

Good review units are small enough that a maintainer can understand the behavioral change and its evidence together.

Prefer:

- one adapter bug + regression tests;
- one documentation gap;
- one isolated CLI/MCP behavior change;
- one migration + durability coverage;
- one deterministic ranking correction.

Avoid mixing formatting churn, renames, dependency changes, and functional changes unless they are inseparable.

## AI-assisted development

AI assistance is allowed, but the contributor owns the result. Before submitting generated code:

- verify referenced APIs exist;
- understand the changed behavior;
- remove speculative or duplicated tests;
- run the claimed validation;
- check that no secret, token, wallet material, or private fixture entered the diff.

## Where to start

New contributors should look for issues labeled `good first issue` or `help wanted`. Documentation, focused test coverage, and bounded adapter improvements are generally better first contributions than changes to launch hardening, policy, or MCP public contracts.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for project policy and [ARCHITECTURE.md](ARCHITECTURE.md) for code ownership.