# MCP Integration Walkthrough

This walkthrough shows how to run Hermes Commerce Control as a local stdio MCP server from a fresh clone without providing wallet or signing secrets.

It is intended for external users and contributors who want to verify the integration boundary before changing code.

## 1. Clone and build

```bash
git clone https://github.com/EchoEe247/hermes-commerce-control.git
cd hermes-commerce-control
npm ci
npm run build
```

Confirm the safety posture first:

```bash
node dist/launch/cli.js doctor --json
```

The effective runtime should report Mode A with external writes and live value movement disabled.

## 2. Start the stdio MCP server

From the repository root:

```bash
node dist/launch/mcp.js
```

The process communicates over stdin/stdout using MCP. It is not an HTTP server and does not need a listening port.

Do not wrap it in a shell that prints banners or other text to stdout; extra stdout can corrupt stdio protocol traffic.

## 3. Generic MCP client configuration

MCP clients use different configuration file locations, but the process definition is the same. Point the client at your real Node executable and the absolute path to the built HCC entrypoint.

Conceptually:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/hermes-commerce-control/dist/launch/mcp.js"
  ]
}
```

Find the Node executable with:

```bash
command -v node
```

Find the entrypoint path from the repository root with:

```bash
pwd
```

Then append `/dist/launch/mcp.js`.

HCC does not require wallet/signing environment variables for normal MCP startup. Do not add private keys, seed phrases, NWC credentials, or payment authorization to the client configuration.

## 4. Hermes registration

If you use Hermes, register the direct Node entrypoint:

```bash
NODE_REAL="$(command -v node)"
MCP_JS="$(pwd)/dist/launch/mcp.js"

hermes mcp add commerce-control \
  --command "$NODE_REAL" \
  --args "$MCP_JS"
```

The repository also includes an installer:

```bash
bash scripts/install-hermes-commerce-control.sh
```

To validate the installer without changing an existing Hermes registration:

```bash
bash scripts/install-hermes-commerce-control.sh --skip-register
```

## 5. Expected tool surface

The server exposes these 11 canonical tools:

1. `commerce_status`
2. `commerce_sources`
3. `commerce_discover_services`
4. `commerce_discover_work`
5. `commerce_inspect`
6. `commerce_quote`
7. `commerce_prepare_purchase`
8. `commerce_prepare_claim`
9. `commerce_prepare_publish`
10. `commerce_probe`
11. `commerce_export_evidence`

There is intentionally no live payment, settlement, transfer, withdrawal, claim-execution, funding, or production-publish tool.

If an integration reports a different tool set, check that the client is starting the expected checkout/build and not a stale copy.

## 6. First useful calls

Start with read-oriented tools:

- `commerce_status` — inspect runtime posture/state;
- `commerce_sources` — inspect registered sources/capabilities;
- `commerce_probe` — check bounded upstream reachability;
- `commerce_discover_services` — aggregate service discovery;
- `commerce_discover_work` — aggregate work discovery.

Upstream services can be unavailable or rate-limited. HCC is designed to report a degraded/unreachable source without crashing the whole aggregate operation.

## 7. Workspace-backed operations

Some inspection/export behavior uses a local workspace. The default workspace is the current working directory of the MCP process.

To pin a workspace, set only the ordinary path configuration needed by HCC:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/hermes-commerce-control/dist/launch/mcp.js"
  ],
  "env": {
    "COMMERCE_REPO_ROOT": "/absolute/path/to/workspace"
  }
}
```

`COMMERCE_REPO_ROOT` is a filesystem path, not a credential.

## 8. Troubleshooting

### Client shows no tools

Check:

```bash
node --version
npm run build
ls -l dist/launch/mcp.js
```

Then verify the client uses absolute paths and the same Node installation that satisfies the repository engine requirement.

### Protocol parse errors

Run the MCP server without shell startup banners or debug `echo` output on stdout. Protocol diagnostics should not be mixed into stdout.

### Discovery reports unreachable sources

That can be a valid upstream state. Reproduce the corresponding CLI command to separate client configuration from adapter/network behavior:

```bash
node dist/launch/cli.js probe
node dist/launch/cli.js discover services --json
node dist/launch/cli.js discover work --json
```

### A basic setup appears to require a wallet secret

Stop. Normal HCC startup and read/preparation workflows are designed to be zero-secret. Open a security or documentation report with the exact command/client configuration and observed error; do not paste real secrets.

## 9. Contributor verification

If your pull request changes MCP behavior, run at minimum:

```bash
npm run typecheck
npm run build
node --import tsx --test test/mcp.test.ts
npm run test:contracts
```

Tool-name or schema changes are compatibility changes. Explain them explicitly in the pull request and update the README/integration docs at the same time.
