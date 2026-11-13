import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("an unknown provider stops before any engine loads", () => {
  const run = spawnSync(process.execPath, [new URL("../run.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PROVIDER: "nope" },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Unknown provider: nope/);
});

test("a name inherited from Object is not a provider", () => {
  const run = spawnSync(process.execPath, [new URL("../run.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, PROVIDER: "constructor" },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
});

test("the model start is recorded after the MCP check", () => {
  const source = readFileSync(new URL("../run.mjs", import.meta.url), "utf8");
  const check = source.indexOf("MCP servers unavailable");
  const started = source.indexOf("model_started=true");
  assert.ok(check !== -1 && started > check);
});
