#!/usr/bin/env node

import { hardenModeAEnvironment } from "./safe-env.js";

// Harden before importing any MCP/application module so a wallet/signing secret
// inherited from Hermes or the operator shell never enters the control plane.
hardenModeAEnvironment(process.env);

const { serveStdio } = await import("../mcp/server.js");
await serveStdio();
