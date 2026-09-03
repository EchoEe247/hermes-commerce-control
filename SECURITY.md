# Security Policy

Hermes Commerce Control is security-sensitive because it processes external marketplace/service data and intentionally enforces a preparation-only commerce boundary.

## Supported versions

Security fixes are currently developed against the latest `main` branch and the current `0.1.x` release line once published.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| `0.1.x` | Yes, after first release |
| Older/unreleased snapshots | Best effort only |

## Reporting a vulnerability

Please do not disclose exploitable security issues in a public issue.

Preferred reporting path:

1. Use GitHub's private vulnerability reporting / Security Advisory flow for this repository when available.
2. Include the affected revision, impact, reproduction steps, and the smallest proof of concept needed to demonstrate the issue.
3. Do not include real wallet secrets, private keys, seed phrases, API credentials, or production payment authority in a report.

If private vulnerability reporting is unavailable, open a minimal public issue stating that you need a private security contact channel, without publishing exploit details.

## Security-sensitive areas

Reports are especially useful when they concern:

- wallet/signing-secret exposure or inheritance;
- bypass of forced Mode-A configuration;
- unintended external writes or live value movement;
- MCP tools that can perform a live financial action;
- SSRF, redirect, DNS, or private-network bypasses;
- secret leakage into evidence, logs, state, exports, or diagnostics;
- schema-validation or actionability bypasses;
- adapter timeout/isolation failures that permit unbounded hangs;
- unsafe command/process execution;
- dependency vulnerabilities that are reachable in HCC's runtime path.

## Disclosure expectations

Please allow maintainers a reasonable opportunity to reproduce, patch, and validate a reported vulnerability before public disclosure. We will avoid claiming a fix is complete until the relevant tests and release validation have actually passed.

## Scope boundary

HCC does not intentionally expose live payment, purchase, claim, settlement, transfer, withdrawal, funding, or production-publish capability. A report demonstrating that this boundary can be bypassed is considered high priority.
