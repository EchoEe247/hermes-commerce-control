# Zero-Secret Quickstart

This path exercises Hermes Commerce Control without wallet keys, seed phrases, signing authority, or live payment credentials.

## Requirements

- Node.js `>=24.15.0 <25`
- npm

## 1. Install and build

```bash
git clone https://github.com/EchoEe247/hermes-commerce-control.git
cd hermes-commerce-control
npm ci
npm run build
```

Until the repository is made public, use an authenticated clone of the same repository instead of the public HTTPS example above.

## 2. Confirm the safety boundary

Do not set wallet or signing variables.

Run:

```bash
node dist/launch/cli.js doctor --json
node dist/launch/cli.js status --json
```

Expected security posture:

- mode is `A`;
- general external writes are disabled;
- live value movement is disabled;
- no wallet/signing secret is visible to the application process.

The hardened launchers force those Mode-A gates even if inherited environment variables try to enable them.

## 3. Inspect available sources

```bash
node dist/launch/cli.js sources --json
```

This is local configuration inspection and does not require a signer.

## 4. Run health/discovery operations

```bash
node dist/launch/cli.js probe
node dist/launch/cli.js discover services --json
node dist/launch/cli.js discover work --json
```

Some adapters may contact public upstream endpoints. Individual upstream failures are reported as degraded or unreachable instead of failing the aggregate operation.

No wallet authority is required for these discovery paths.

## 5. Start the MCP server

```bash
node dist/launch/mcp.js
```

The stdio server exposes exactly 11 canonical tools. None is a live payment, settlement, transfer, withdrawal, claim-execution, or production-publish tool.

## Optional: Hermes registration

If Hermes is installed, the safest portable integration is the direct Node entrypoint:

```bash
NODE_REAL="$(command -v node)"
MCP_JS="$(pwd)/dist/launch/mcp.js"

hermes mcp add commerce-control \
  --command "$NODE_REAL" \
  --args "$MCP_JS"
```

You can also validate the installer without changing Hermes registration:

```bash
bash scripts/install-hermes-commerce-control.sh --skip-register
```

## Workspace behavior

Repository-facing operations default to your current working directory. To pin a separate workspace explicitly:

```bash
COMMERCE_REPO_ROOT=/absolute/path/to/workspace \
  node dist/launch/cli.js export
```

The workspace is a filesystem location for inspection/evidence output. It is not a credential source.

## What not to provide

A normal quickstart does not require:

- private keys;
- mnemonics or seed phrases;
- wallet signing keys;
- NWC credentials;
- exchange credentials;
- payment authorization;
- production deployment secrets.

If a workflow appears to require any of those for basic HCC startup, stop and report it as a security or documentation issue.
