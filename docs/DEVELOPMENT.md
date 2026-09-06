# Development Guide

This is the shortest reliable path from a fresh clone to a change that is ready for review.

The main thing I want contributors to avoid is an implied PASS: if a relevant command was not run, say that. A focused patch with clear evidence is more useful than a broader change with vague validation.

## Prerequisites

- Node.js `>=24.15.0 <25`
- npm
- Git

Check the runtime first:

```bash
node --version
npm --version
```

HCC deliberately targets Node 24. If your runtime is outside the declared engine range, fix that before treating resulting failures as project bugs.

## Fresh-clone setup

```bash
git clone https://github.com/EchoEe247/hermes-commerce-control.git
cd hermes-commerce-control
npm ci
npm run typecheck
npm run build
```

Then prove the zero-secret baseline:

```bash
node dist/launch/cli.js doctor --json
node dist/launch/cli.js status --json
node dist/launch/cli.js sources --json
```

Normal startup does not require wallet keys, seed phrases, signing authority, exchange credentials, or payment authorization.

## Test commands

### CI-equivalent validation

The repository CI baseline includes:

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

Use the full relevant gate before asking for review on a substantial change.

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

This covers configuration, policy, MCP, and adversarial-security contracts. Run it for changes touching launchers, environment handling, commands/tools, configuration, policy, or safety behavior.

### Package-boundary check

```bash
npm run test:package
```

This checks what would be included in the npm package. Contributor work should not accidentally expand the public release surface with source/tests/internal scripts or create a new JavaScript import API.

## Run one test file

The suite uses Node's built-in test runner through `tsx`.

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

TypeScript source lives under `src/`; compiled output is generated under `dist/`.

```bash
npm run build
```

Do not hand-edit `dist/`. Change `src/` and rebuild so generated output stays reproducible.

## Local state and cleanup

Default state root:

```text
~/.hermes/commerce-control/
```

Default SQLite database:

```text
~/.hermes/commerce-control/state.db
```

Most tests use isolated fixtures or temporary state. If you manually exercised the CLI against user state, preserve anything you care about before removing it.

Build artifacts can be removed with:

```bash
rm -rf dist/ node_modules/
```

Then restore them with:

```bash
npm ci
npm run build
```

## Change-specific validation

Use [`ARCHITECTURE.md`](ARCHITECTURE.md) to identify the owning layer and nearest tests.

### Adapter changes

Run the adapter's focused tests plus relevant shared adapter/aggregate coverage. Include the states that apply:

- successful normalization;
- healthy empty response;
- malformed upstream payload;
- timeout/rate-limit/unreachable behavior;
- capability/actionability declarations;
- hostile or unsafe URLs.

If the adapter uses a third-party SDK, distinguish HCC's caller-time budget from hard cancellation of the SDK's own background work. Only claim cancellation behavior the provider API actually supports.

### CLI changes

```bash
node --import tsx --test test/cli.test.ts
```

If machine-readable JSON output changes, treat that as a compatibility change and document it.

### MCP changes

```bash
node --import tsx --test test/mcp.test.ts
npm run test:contracts
```

Tool names and schemas are public integration contracts.

### Network/security changes

```bash
node --import tsx --test test/safe-fetch.test.ts
node --import tsx --test test/ssrf.test.ts
npm run test:contracts
```

### State/migration changes

```bash
node --import tsx --test test/state.test.ts
node --import tsx --test test/durability.test.ts
```

### Opportunity subsystem changes

Use the matching `test/opportunity-*.test.ts` files. The package scripts prefixed with `opportunities:*` expose development/runtime entrypoints for these workflows.

## Working on an issue

1. Read the issue and linked code/tests before writing.
2. If the acceptance criteria are unclear or the scope is larger than described, discuss that before expanding the change.
3. Create a focused branch.
4. Add or update tests with the implementation.
5. Run the smallest useful loop while developing.
6. Run typecheck/build and the relevant broader gate before opening a PR.
7. In the PR, list exactly what you ran. If something could not be run, state it explicitly.

## Pull request scope

Good review units keep the behavioral change and evidence together.

Examples:

- one adapter bug + regression coverage;
- one documentation gap;
- one isolated CLI/MCP behavior change;
- one migration + durability coverage;
- one deterministic ranking correction.

Avoid mixing formatting churn, renames, dependency changes, and functional changes unless they are genuinely inseparable.

## AI-assisted development

AI assistance is allowed. The contributor owns the result.

For me, the relevant question is not whether AI generated part of the patch. It is whether the submitted code is understood, real, safe, and validated.

Before submitting AI-assisted code:

- verify referenced APIs exist;
- understand the changed behavior;
- remove hallucinated assumptions, speculative abstractions, and duplicated tests;
- run the validation you claim;
- check that no secret, token, wallet material, or private fixture entered the diff.

## Where to start

Look for `good first issue` or `help wanted` labels. Documentation, focused regression coverage, and bounded adapter improvements are generally better first contributions than changes to launch hardening, policy, or the MCP public contract.

See [`CONTRIBUTING.md`](../CONTRIBUTING.md) for project policy and [`ARCHITECTURE.md`](ARCHITECTURE.md) for code ownership.
