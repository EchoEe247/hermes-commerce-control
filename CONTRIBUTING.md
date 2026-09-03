# Contributing to Hermes Commerce Control

Thanks for contributing. HCC is a security-sensitive local control plane, so changes are reviewed for correctness, bounded behavior, and preservation of the Mode-A safety boundary.

## Before opening a pull request

For bugs, small fixes, tests, and documentation corrections, a direct pull request is fine when the change is narrow and well-supported.

For larger features, new adapters, protocol changes, new public commands/tools, or changes to security policy, open an issue first so the behavior and scope can be agreed before implementation.

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

Keep commits understandable. Conventional-style commit subjects are preferred when practical, for example:

```text
fix(adapters): bound provider timeout handling
docs: clarify standalone MCP setup
test(security): cover hostile redirect target
```

## Licensing

By submitting a contribution for inclusion in this repository, you agree that your contribution is provided under the repository's Apache License 2.0, unless you explicitly mark material as not a contribution or identify third-party material and its applicable license.
