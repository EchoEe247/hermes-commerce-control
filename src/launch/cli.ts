#!/usr/bin/env node

import { hardenModeAEnvironment } from "./safe-env.js";

// Harden before importing the application. This keeps wallet/signing material
// unreachable even when the parent shell exported it.
hardenModeAEnvironment(process.env);

const { runCli } = await import("../cli.js");

const code = await runCli(process.argv.slice(2), {
  stdout: (chunk: string): void => {
    process.stdout.write(chunk);
  },
  stderr: (chunk: string): void => {
    process.stderr.write(chunk);
  },
});

process.exitCode = code;
