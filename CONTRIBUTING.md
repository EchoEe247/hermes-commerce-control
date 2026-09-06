# Contributing to Hermes Commerce Control

Contributions are welcome. HCC is a security-sensitive local control plane, so I want outside changes to be easy to contribute without making the review standard vague.

A correct community patch does not need to be recreated by a maintainer. It does need clear evidence, bounded scope, and preservation of the Mode-A safety contract.

## New contributor path

If this is your first HCC contribution:

1. Read the [zero-secret quickstart](docs/QUICKSTART.md) and confirm the project builds/runs without wallet or signing credentials.
2. Read the [architecture map](docs/ARCHITECTURE.md) so you know which layer owns the behavior and which tests are closest to it.
3. Use the [development guide](docs/DEVELOPMENT.md) for fresh-clone setup, focused tests, and CI-equivalent validation.
4. Look for `good first issue` or `help wanted`, or file a reproducible bug/feature request.
5. Keep the first PR focused. Documentation, regression tests, fixture coverage, and bounded adapter fixes are useful contributions without requiring the entire architecture in your head.

The [roadmap](ROADMAP.md) explains the current direction and the boundaries I am not trying to cross by accident.

## Before opening a pull request

For narrow bugs, tests, or documentation corrections, a direct PR is fine when the problem and evidence are clear.

For larger features, new adapters, protocol/public-command changes, persistent-state changes, or security-boundary changes, open an issue first so the intended behavior can be discussed before implementation spreads across the repository.

Please do not create generated issue spam, duplicate reports, speculative vulnerability claims, or low-information PRs.

## Development setup

Requirements:

- Node.js `>=24.15.0 <25`
- npm

Run:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:contracts
npm run test:package
```

For constrained hosts such as Android/Termux:

```bash
npm run test:serial
```

Use [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the CI-equivalent sequence, focused tests, state cleanup, and change-specific guidance.

A contribution is not ready just because the implementation looks correct. Run the relevant gates. If something cannot be run in your environment, say that explicitly instead of turning it into an implied PASS.

## Security invariants

Unless a separately reviewed product decision changes them, contributions preserve these boundaries:

- `COMMERCE_MODE=A` is forced by the hardened launchers.
- General external writes remain disabled.
- Live value movement remains disabled.
- Wallet/signing authority is removed before application code imports.
- MCP exposes no live pay, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish tool.
- Preparation actions remain reviewable and non-executing.
- Adapter failures remain isolated and bounded from the caller's perspective.
- Untrusted network/content inputs remain behind schema validation, sanitization, and SSRF protections.

A PR that intentionally changes one of these is not an ordinary refactor. Explain the threat model, migration path, and validation evidence and discuss the decision first.

## Adding or changing an adapter

Start with `src/adapters/interface.ts`, `src/adapters/registry.ts`, the nearest existing adapter, and the adapter section of [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

Cover the relevant cases:

- successful normalization;
- empty-but-healthy results;
- malformed upstream responses;
- timeout/rate-limit/unavailability behavior;
- capability declarations;
- actionability flags;
- schema validation;
- secret/wallet isolation;
- SSRF or hostile URL behavior where network endpoints are involved.

HCC bounds the caller wait with adapter budgets and aborts HCC-owned network resources. Do not claim hard cancellation of third-party SDK work unless that SDK exposes a real cancellation primitive and the implementation proves it.

Never add private keys, seed phrases, signing material, live payment authority, or production secrets to fixtures.

## MCP contributions

The MCP server is a public integration contract. Tool names and schemas should not drift casually.

Before changing MCP behavior, read [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) and run:

```bash
node --import tsx --test test/mcp.test.ts
npm run test:contracts
```

If a tool name or schema intentionally changes, update the README/integration docs and make the compatibility impact explicit in the PR.

## AI-assisted contributions

AI-assisted development is welcome. The contributor still owns the submitted result.

The rule I care about is not whether AI was used; it is whether the code and evidence are real. Verify referenced APIs, understand the behavior, remove hallucinated assumptions or duplicated tests, run what the PR claims was run, and make sure no secret/private fixture entered the diff.

Large mechanically generated changes that the submitter cannot explain are not useful simply because they contain a lot of code.

## Pull request quality

A strong PR includes:

- a focused problem statement;
- the smallest coherent implementation that solves it;
- tests or concrete validation evidence;
- compatibility/security implications when relevant;
- no unrelated formatting or generated-file churn.

Conventional-style subjects are preferred when practical, for example:

```text
fix(adapters): bound provider timeout handling
docs: clarify standalone MCP setup
test(security): cover hostile redirect target
```

## Reporting security issues

Read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Never put real secrets, signing material, or payment credentials into a public issue.

## Licensing

By submitting a contribution for inclusion here, you agree that the contribution is provided under the repository's Apache License 2.0 unless you explicitly identify material that is not your contribution or has another applicable license.
