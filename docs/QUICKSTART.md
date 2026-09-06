# Zero-Secret Quickstart

This is the shortest source-checkout path for proving that Hermes Commerce Control works without wallet keys, seed phrases, signing authority, or live payment credentials.

That zero-secret property is part of the product boundary. If a basic startup path asks for financial authority, do not work around it by supplying a secret; treat it as a bug or documentation problem.

## Requirements

- Node.js `>=24.15.0 <25`
- npm

## 1. Clone and build

```bash
git clone https://github.com/EchoEe247/hermes-commerce-control.git
cd hermes-commerce-control
npm ci
npm run build
```

## 2. Prove the safety posture

Do not set wallet or signing variables.

Run:

```bash
node dist/launch/cli.js doctor --json
node dist/launch/cli.js status --json
```

Expected posture:

- mode is `A`;
- general external writes are disabled;
- live value movement is disabled;
- no wallet/signing secret is visible to the application process.

The hardened launchers force those Mode-A gates even if inherited environment variables try to enable them.

## 3. Inspect the configured sources

```bash
node dist/launch/cli.js sources --json
```

This is local configuration inspection and does not require a signer.

## 4. Probe and discover

```bash
node dist/launch/cli.js probe
node dist/launch/cli.js discover services --json
node dist/launch/cli.js discover work --json
```

Some adapters contact public upstream endpoints. One provider being rate-limited, malformed, timed out, or offline should become a degraded/unreachable source result rather than crashing the entire aggregate operation.

No wallet authority is required for these discovery paths.

## 5. Start the MCP server

```bash
node dist/launch/mcp.js
```

The stdio server exposes exactly 11 canonical tools. None is a live payment, settlement, transfer, withdrawal, claim-execution, funding, or production-publish tool.

## Optional — Hermes registration

If Hermes is installed, the most portable integration is the direct Node entrypoint:

```bash
NODE_REAL="$(command -v node)"
MCP_JS="$(pwd)/dist/launch/mcp.js"

hermes mcp add commerce-control \
  --command "$NODE_REAL" \
  --args "$MCP_JS"
```

Validate the repository installer without changing Hermes registration:

```bash
bash scripts/install-hermes-commerce-control.sh --skip-register
```

## Workspace behavior

Repository-facing operations use the current working directory by default. To pin another workspace:

```bash
COMMERCE_REPO_ROOT=/absolute/path/to/workspace \
  node dist/launch/cli.js export
```

The workspace is a filesystem location for inspection/evidence output. It is not a credential source.

## What normal startup does not need

- private keys;
- mnemonics or seed phrases;
- wallet signing keys;
- NWC credentials;
- exchange credentials;
- payment authorization;
- production deployment secrets.

If a normal quickstart appears to require one of these, stop and report the exact command and observed behavior without pasting a real secret.
