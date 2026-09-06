# MCP Integration Walkthrough

This walkthrough proves the HCC MCP boundary from a fresh source checkout without wallet or signing secrets.

The setup is deliberately ordinary: build HCC, point an MCP client at the real Node executable and HCC's stdio entrypoint, and verify the exact preparation-only tool surface. There is no separate HCC network service to deploy for this path.

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

The process communicates over stdin/stdout using MCP. It is **not** an HTTP server and does not need a listening port.

Keep stdout clean. Do not wrap the process in shell startup banners or debug `echo` output because extra stdout can corrupt stdio protocol traffic.

## 3. Generic MCP client configuration

Client configuration locations differ, but the process definition is the same: point the client at the real Node executable and the absolute path to the built HCC entrypoint.

Conceptually:

```json
{
  "command": "/absolute/path/to/node",
  "args": [
    "/absolute/path/to/hermes-commerce-control/dist/launch/mcp.js"
  ]
}
```

Find Node with:

```bash
command -v node
```

Find the repository root with:

```bash
pwd
```

Then append `/dist/launch/mcp.js`.

Normal MCP startup does not require wallet/signing environment variables. Do not add private keys, seed phrases, NWC credentials, or payment authorization to the client configuration.

## 4. Hermes registration

For Hermes, register the direct Node entrypoint:

```bash
NODE_REAL="$(command -v node)"
MCP_JS="$(pwd)/dist/launch/mcp.js"

hermes mcp add commerce-control \
  --command "$NODE_REAL" \
  --args "$MCP_JS"
```

The source repository also includes an installer:

```bash
bash scripts/install-hermes-commerce-control.sh
```

Validate that installer without changing an existing Hermes registration:

```bash
bash scripts/install-hermes-commerce-control.sh --skip-register
```

## 5. Expected tool surface

The server exposes exactly these 11 canonical tools:

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

If your client shows a different set, first verify that it is starting the expected checkout/build rather than a stale HCC copy.

## 6. First useful calls

Start with read-oriented tools:

- `commerce_status` — runtime posture/state;
- `commerce_sources` — registered sources/capabilities;
- `commerce_probe` — bounded upstream reachability;
- `commerce_discover_services` — aggregate service discovery;
- `commerce_discover_work` — aggregate work discovery.

Individual upstreams can be offline, malformed, timed out, or rate-limited. HCC is designed to return a degraded/unreachable source instead of turning one provider failure into failure of the whole aggregate operation.

## 7. Workspace-backed operations

Some inspection/export behavior uses a local workspace. By default, that is the MCP process's current working directory.

To pin another workspace, set the ordinary path configuration HCC needs:

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

`COMMERCE_REPO_ROOT` is a filesystem path, not a credential source.

## 8. Troubleshooting

### Client shows no tools

Check:

```bash
node --version
npm run build
ls -l dist/launch/mcp.js
```

Then verify the client uses absolute paths and the same Node installation that satisfies HCC's engine requirement.

### Protocol parse errors

Run the MCP server without shell banners or debug output on stdout. Keep protocol traffic and diagnostics separated.

### Discovery reports unreachable sources

That can be a truthful upstream state rather than an MCP configuration failure.

Reproduce through the CLI:

```bash
node dist/launch/cli.js probe
node dist/launch/cli.js discover services --json
node dist/launch/cli.js discover work --json
```

HCC bounds how long the caller waits for each adapter. For HCC-owned `SafeFetch` operations, timeout also aborts the underlying network resource. A third-party SDK that exposes no cancellation primitive may continue its own background task after HCC has already returned `UPSTREAM_TIMEOUT`; see [`ARCHITECTURE.md`](ARCHITECTURE.md).

### A basic setup appears to require a wallet secret

Stop. Normal HCC startup and read/preparation workflows are designed to be zero-secret.

Report the exact command/client configuration and observed error without pasting a real secret. Supplying financial authority just to make the quickstart pass would hide the problem rather than solve it.

## 9. Contributor verification

If a PR changes MCP behavior, run at minimum:

```bash
npm run typecheck
npm run build
node --import tsx --test test/mcp.test.ts
npm run test:contracts
```

Tool names and schemas are compatibility contracts. If one intentionally changes, explain the impact in the PR and update README/integration documentation in the same change.
