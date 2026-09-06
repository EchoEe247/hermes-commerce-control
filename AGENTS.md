# AGENTS.md

This file is the operating handoff for fresh ChatGPT or agent sessions working in Hermes Commerce Control.

## Project authority

Read the repository's current README, relevant docs, tests, package metadata, and current GitHub state before changing claims. HCC itself defines its architecture, Mode-A safety boundary, package/MCP contracts, release state, and technical behavior.

Do not let older chat context override current repository evidence.

## Angel wording integration

For Angel-owned project communication, use `EchoEe247/Chatgpt-Angel-wording-refinement` as the wording/refinement authority.

The relationship is:

- HCC defines **what the project is and what is technically true**;
- `Chatgpt-Angel-wording-refinement` defines **how Angel-owned communication about HCC should be refined and expressed**.

For routine wording work, use that repository's `prompts/SESSION_BOOTSTRAP.md`. For important or ambiguous documentation, release communication, contributor guidance, or public-facing wording, also load the full system spec, relevant context profile, and meaning-preservation rules.

Default to Angel-refined. Use Angel-professional for serious technical, security, release, and business material.

Project truth and security constraints always outrank style.

## HCC invariants

Unless a separately reviewed project decision changes them, preserve:

- Mode A as the preparation-only operating boundary;
- no live pay, purchase, claim execution, settlement, transfer, withdrawal, funding, or production-publish capability;
- zero-secret normal startup;
- removal/override of inherited wallet or signing authority before application imports;
- exactly the documented CLI/MCP public contracts for the current release;
- bounded and isolated adapter failures;
- hardened network/SSRF behavior;
- truthful unknown/degraded states instead of invented success;
- current release/package truth rather than stale candidate state.

Do not broaden a public contract, weaken a safety gate, or claim unsupported cancellation/termination behavior merely to simplify wording or implementation.

## Validation behavior

Use the nearest focused tests while developing, then run the broader applicable gates before declaring a change complete. Security-sensitive, package-contract, MCP-schema, launcher, network, adapter-budget, and persistence changes require the corresponding focused validation.

Historical release evidence remains historical. Update living docs when current state changes instead of rewriting old evidence to look current.