import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const [name, workspace] of [
  ["process.json", false],
  ["process-workspace.json", true],
]) {
  test(`${name} is a portable zero-secret stdio process definition`, () => {
    const definition = JSON.parse(
      readFileSync(new URL(`../examples/mcp-stdio/${name}`, import.meta.url), "utf8"),
    );
    assert.deepEqual(Object.keys(definition).sort(),
      workspace ? ["args", "command", "env"] : ["args", "command"]);
    assert.equal(definition.command, "/absolute/path/to/node");
    assert.deepEqual(definition.args, [
      "/absolute/path/to/hermes-commerce-control/dist/launch/mcp.js",
    ]);
    if (workspace) {
      assert.deepEqual(definition.env, {
        COMMERCE_REPO_ROOT: "/absolute/path/to/workspace",
      });
    }
  });
}
