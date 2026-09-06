# Security Policy

Hermes Commerce Control is security-sensitive because it consumes external marketplace/service data while deliberately enforcing a preparation-only commerce boundary.

The security promise is not that every upstream is trustworthy. The point is that HCC should remain bounded even when an upstream is malformed, unavailable, hostile, or simply does not provide the cancellation controls we would prefer.

## Supported versions

Security fixes are developed against `main` and the current published `0.1.x` release line.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| current `0.1.x` release | Yes |
| older/unreleased snapshots | Best effort only |

The current canonical public release is `v0.1.2` / `hermes-commerce-control@0.1.2`.

## Reporting a vulnerability

Do not disclose exploitable security details in a public issue.

Preferred path:

1. Use GitHub Private Vulnerability Reporting / the Security Advisory flow when available.
2. Include the affected revision, impact, reproduction steps, and the smallest proof of concept needed to demonstrate the problem.
3. Use synthetic data. Do not include real wallet secrets, private keys, seed phrases, API credentials, or production payment authority.

If private reporting is unavailable, open only a minimal public issue saying you need a private security contact channel. Do not publish the exploit details there.

## High-sensitivity areas

Reports are especially important when they concern:

- wallet/signing-secret exposure or inheritance;
- bypass of forced Mode-A configuration;
- unintended external writes or live value movement;
- MCP tools capable of live financial action;
- SSRF, redirect, DNS, or private-network bypasses;
- secret leakage into evidence, logs, state, exports, or diagnostics;
- schema-validation or actionability bypasses;
- adapter isolation failures that let one provider block aggregate control-plane progress beyond the documented caller budget;
- unsafe command/process execution;
- dependency vulnerabilities reachable in HCC's runtime path.

### Third-party cancellation boundary

HCC strictly bounds the time its caller waits for an adapter through `adapterBudgetMs` and aborts HCC-owned `SafeFetch` resources when that budget expires.

That does not mean JavaScript can forcibly terminate arbitrary third-party SDK work. If an SDK ignores `AbortSignal` or exposes no cancel/close primitive, its background promise can continue until it finishes naturally even though HCC already returned `UPSTREAM_TIMEOUT` to the caller.

That distinction is part of the documented architecture, not a hidden failure mode. A report showing that HCC itself keeps waiting beyond its budget, leaks authority, or leaves an HCC-owned resource unbounded is still security/reliability relevant.

## Disclosure expectations

Allow maintainers a reasonable opportunity to reproduce, patch, validate, and release a fix before public disclosure.

I do not want a security issue marked fixed merely because a patch exists. The relevant regression and release validation should pass first.

## Scope boundary

HCC intentionally exposes no live payment, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish capability.

A report that demonstrates a bypass of that boundary is high priority.
