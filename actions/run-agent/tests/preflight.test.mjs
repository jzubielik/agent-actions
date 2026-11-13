import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ruleFiles, splitLoaded } from "../engines/claude.mjs";
import { modelSummary, toolLogLine, usedTokens } from "../tool-log.mjs";

test("the tool log names the caller", () => {
  const read = { type: "tool_use", name: "Read", input: { file_path: "/w/a.py" } };
  assert.equal(toolLogLine({ parent_tool_use_id: null }, read), "tool main Read /w/a.py");
  assert.equal(toolLogLine({ parent_tool_use_id: "toolu_1" }, { name: "Grep", input: {} }), "tool subagent:toolu_1 Grep");
  const agent = { name: "Agent", id: "toolu_1", input: { subagent_type: "rules-reviewer" } };
  assert.equal(toolLogLine({ parent_tool_use_id: null }, agent), "tool main Agent rules-reviewer toolu_1");
  const skill = { name: "Skill", input: { skill: "pr-review" } };
  assert.equal(toolLogLine({ parent_tool_use_id: "toolu_1" }, skill), "tool subagent:toolu_1 Skill pr-review");
});

test("rule files are listed from the restored config, not from the base checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "rules-"));
  for (const dir of ["shop", ".ai-base", ".git", "node_modules/x"]) mkdirSync(join(root, dir), { recursive: true });
  for (const file of ["CLAUDE.md", "REVIEW.md", "shop/AGENTS.md", ".ai-base/CLAUDE.md", ".git/CLAUDE.md", "node_modules/x/CLAUDE.md", "shop/README.md"]) {
    writeFileSync(join(root, file), "");
  }
  assert.deepEqual(ruleFiles(root, ".ai-base"), ["CLAUDE.md", "REVIEW.md", "shop/AGENTS.md"]);
  assert.deepEqual(ruleFiles(mkdtempSync(join(tmpdir(), "empty-")), ".ai-base"), []);
  // The action's own checkout in the working directory is not the pull request's.
  mkdirSync(join(root, ".agent-actions"));
  writeFileSync(join(root, ".agent-actions/CLAUDE.md"), "");
  assert.deepEqual(ruleFiles(root, ".ai-base", join(root, ".agent-actions")), ["CLAUDE.md", "REVIEW.md", "shop/AGENTS.md"]);
});

test("the root CLAUDE.md counts as loaded, and AGENTS.md only without one", () => {
  const withClaude = mkdtempSync(join(tmpdir(), "claude-"));
  writeFileSync(join(withClaude, "CLAUDE.md"), "");
  assert.deepEqual(splitLoaded(["AGENTS.md", "CLAUDE.md", "REVIEW.md", "shop/CLAUDE.md"], withClaude),
    { loaded: ["CLAUDE.md"], toRead: ["AGENTS.md", "REVIEW.md", "shop/CLAUDE.md"] });
  const agentsOnly = mkdtempSync(join(tmpdir(), "agents-"));
  assert.deepEqual(splitLoaded(["AGENTS.md", "REVIEW.md"], agentsOnly), { loaded: ["AGENTS.md"], toRead: ["REVIEW.md"] });
  const localOnly = mkdtempSync(join(tmpdir(), "local-"));
  writeFileSync(join(localOnly, "CLAUDE.local.md"), "");
  assert.deepEqual(splitLoaded(["AGENTS.md"], localOnly), { loaded: [], toRead: ["AGENTS.md"] });
});

test("the model summary lists every model with tokens and cost", () => {
  const usage = { "claude-sonnet-5-5": { inputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 1, outputTokens: 3, costUSD: 0.123456 } };
  assert.deepEqual(modelSummary(usage), { "claude-sonnet-5-5": { input: 16, output: 3, cost: 0.1235 } });
  assert.deepEqual(modelSummary(undefined), {});
});

test("used tokens count each model call once, subagents included", () => {
  const call = (id, usage, parent = null) => ({ type: "assistant", parent_tool_use_id: parent, message: { id, usage } });
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
  assert.equal(usedTokens([
    call("m1", usage), call("m1", usage), // two content blocks of one call
    call("m2", { input_tokens: 1, output_tokens: 2 }, "toolu_1"),
    { type: "user", message: { content: [] } },
  ]), 135 + 3);
  assert.equal(usedTokens([]), 0);
});

test("a run stopped by the runner's cancel signal saves what it used", async () => {
  const { spawn } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "cancel-"));
  const file = join(dir, "exec.json");
  const script = join(dir, "run.mjs");
  writeFileSync(script, `import { saveOnCancel } from ${JSON.stringify(new URL("../tool-log.mjs", import.meta.url).href)};
saveOnCancel(${JSON.stringify(file)}, [{ type: "system", subtype: "init" }, { type: "assistant", message: { id: "m1", usage: { input_tokens: 7, output_tokens: 3 } } }]);
console.log("ready"); setInterval(() => {}, 1000);`);
  // As in action.yml: bash replaces itself with node, so the signal reaches node.
  const child = spawn("bash", ["-c", `exec node ${script}`]);
  await new Promise((done) => child.stdout.once("data", done));
  child.kill("SIGTERM");
  await new Promise((done) => child.once("exit", done));
  const last = JSON.parse(readFileSync(file, "utf8")).at(-1);
  assert.equal(last.type, "cancelled");
  assert.equal(last.tokens, 10);
  const action = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
  assert.ok(action.includes('run: exec node "$GITHUB_ACTION_PATH/run.mjs"'));
});

test("a run cancelled during its first model call is saved with no tokens, one before the session is not", async () => {
  const { spawn } = await import("node:child_process");
  const finished = [{ type: "system", subtype: "init" }, { type: "result", total_cost_usd: 0.2 }];
  for (const [messages, saved] of [[[{ type: "system", subtype: "init" }], true], [[], false], [finished, true]]) {
    const dir = mkdtempSync(join(tmpdir(), "cancel-"));
    const file = join(dir, "exec.json");
    const script = join(dir, "run.mjs");
    writeFileSync(script, `import { saveOnCancel } from ${JSON.stringify(new URL("../tool-log.mjs", import.meta.url).href)};
saveOnCancel(${JSON.stringify(file)}, ${JSON.stringify(messages)});
console.log("ready"); setInterval(() => {}, 1000);`);
    const child = spawn("bash", ["-c", `exec node ${script}`]);
    await new Promise((done) => child.stdout.once("data", done));
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
    assert.equal(existsSync(file), saved);
    const last = saved && JSON.parse(readFileSync(file, "utf8")).at(-1);
    if (messages === finished) assert.equal(last.type, "result");
    else if (saved) assert.equal(last.tokens, 0);
  }
});
