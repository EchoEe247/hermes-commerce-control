# Portable stdio process definition

Copy [process.json](process.json) into the process-definition field of your MCP
client. It is a client-neutral command/arguments object, not a complete config
for any particular client; use the enclosing structure that client requires.

Replace both placeholder paths with absolute paths to a Node executable in HCC's
supported range (`>=24.15.0 <25`) and your checkout's built
`dist/launch/mcp.js`. Build the checkout first as described in the
[MCP integration walkthrough](../../docs/MCP_INTEGRATION.md).
On Windows, JSON paths need escaped backslashes or forward slashes.

Before registering the server, run the matching CLI entrypoint with the same
Node executable:

```text
<absolute-node-executable> <absolute-checkout>/dist/launch/cli.js doctor --json
```

Confirm Mode A, disabled external writes, and disabled live value movement.
Do not add wallet, signing, or payment credentials to make setup succeed.
Launch the MCP entrypoint directly with Node; stdout belongs exclusively to
protocol messages, so do not insert shell banners or redirect it into a log.

[process-workspace.json](process-workspace.json) is an optional variant for
pinning repository-facing inspection/evidence operations to a chosen filesystem
path. Replace `COMMERCE_REPO_ROOT` with that path, or omit the entire `env` field
to use the MCP process's working directory. It is not a credential source.

Validate the checked-in examples without installing dependencies:

```bash
node --test test/mcp-process-example.test.ts
```
