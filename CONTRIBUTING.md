# Contributing to Hermes Commerce Control

Thanks for contributing. HCC is a security-sensitive local control plane, so changes are reviewed for correctness, bounded behavior, and preservation of the Mode-A safety boundary.

## New contributor path

If this is your first HCC contribution:

1. Read the [zero-secret quickstart](docs/QUICKSTART.md) and confirm you can build/run the project without wallet or signing credentials.
2. Read the [architecture map](docs/ARCHITECTURE.md) to identify the code and nearest tests for your change.
3. Use the [development guide](docs/DEVELOPMENT.md) for the fresh-clone, focused-test, and CI-equivalent commands.
4. Look for issues labeled `good first issue` or `help wanted`, or file a reproducible bug/feature request using the issue forms.
5. Keep the first PR focused. Documentation fixes, regression tests, fixture coverage, and bounded adapter corrections are strong starting points.

The public [roadmap](ROADMAP.md) explains current project direction and non-goals.

## Before opening a pull request

For bugs, small fixes, tests, and documentation corrections, a direct pull request is fine when the change is narrow and well-supported.

For larger features, new adapters, protocol changes, new public commands/tools, persistent-state changes, or changes to security policy, open an issue first so the behavior and scope can be agreed before implementation.

Please do not open generated issue spam, duplicate reports, speculative vulnerability claims, or low-information pull requests.

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

For constrained hosts such as Android/Termux, the repository also provides:

```bash
npm run test:serial
```

The CI-equivalent validation sequence, focused single-test commands, state cleanup, and change-specific test guidance are documented in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

A contribution should not be considered ready if relevant tests have not been run. If a test cannot be run in your environment, say so explicitly in the pull request instead of claiming it passed.

## Security invariants

Unless a separately reviewed project decision changes them, contributions must preserve these invariants:

- `COMMERCE_MODE=A` is forced by the hardened launchers.
- General external writes remain disabled.
- Live value movement remains disabled.
- Wallet/signing authority is removed before application code is imported.
- The MCP server exposes no live pay, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish tool.
- Preparation actions remain reviewable and non-executing.
- Adapter failures remain isolated and bounded.
- Untrusted network/content inputs remain subject to schema validation, sanitization, and SSRF protections.

A pull request that intentionally changes one of these boundaries must explain the threat model, migration path, and validation evidence in detail and should be discussed in an issue first.

## Adding or changing an adapter

Start with `src/adapters/interface.ts`, `src/adapters/registry.ts`, the nearest existing adapter, and the adapter section of [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Adapter work should include tests for relevant cases such as:

- successful normalization;
- empty-but-healthy results;
- malformed upstream responses;
- timeout/rate-limit/unavailability behavior;
- capability declarations;
- actionability flags;
- schema validation;
- secret/wallet isolation;
- SSRF or hostile URL behavior when network endpoints are involved.

Do not add credentials, private keys, seed phrases, wallet signing material, live payment authority, or real production secrets to fixtures.

## MCP contributions

The MCP server is a public integration surface. Tool names and schemas should be treated as compatibility contracts.

Before changing MCP behavior, read [docs/MCP_INTEGRATION.md](docs/MCP_INTEGRATION.md) and run:

```bash
node --import tsx --test test/mcp.test.ts
npm run test:contracts
```

If a tool name/schema intentionally changes, update the README/integration documentation and call the compatibility impact out in the pull request.

## AI-assisted contributions

AI-assisted development is welcome. The contributor remains responsible for the submitted change.

Please verify generated code and tests, remove hallucinated APIs or assumptions, and ensure the pull request describes what was actually validated. Large mechanically generated changes, duplicated tests, synthetic issue volume, or code that has not been understood by the submitter may be closed without merge.

## Pull request quality

A strong pull request includes:

- a focused problem statement;
- the smallest coherent implementation that solves it;
- tests or concrete validation evidence;
- any compatibility or security implications;
- no unrelated formatting or generated-file churn.

The repository PR template asks for these items explicitly.

Keep commits understandable. Conventional-style commit subjects are preferred when practical, for example:

```text
fix(adapters): bound provider timeout handling
docs: clarify standalone MCP setup
test(security): cover hostile redirect target
```

## Reporting security issues

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Never put real secrets, signing material, or payment credentials into a public issue.

## Licensing

By submitting a contribution for inclusion in this repository, you agree that your contribution is provided under the repository's Apache License 2.0, unless you explicitly mark material as not a contribution or identify third-party material and its applicable license.
