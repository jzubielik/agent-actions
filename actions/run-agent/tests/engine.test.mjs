import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildOptions, configureEnv, loadAgents } from "../engines/claude.mjs";

const config = { maxTurns: 1, tools: ["Read", "Edit", "Bash"], disallowedTools: ["Edit(/x/**)"], allowedTools: [] };

test("anthropic defaults to the Opus model", () => {
  assert.equal(buildOptions({ ...config, provider: "anthropic" }).model, "claude-opus-5-5");
});

test("an explicit model wins over the default", () => {
  assert.equal(buildOptions({ ...config, provider: "anthropic", model: "custom" }).model, "custom");
});

test("the agent has no shell and asks for no approval", () => {
  const options = buildOptions({ ...config, provider: "anthropic" });
  assert.ok(!options.tools.includes("Bash"));
  assert.deepEqual(options.tools, ["Read", "Edit"]);
  assert.equal(options.disallowedTools[0], "Edit(/x/**)");
  assert.equal(options.permissionMode, "dontAsk");
});

test("the scrub is on and bundled skills are off", () => {
  const env = {};
  configureEnv("anthropic", env);
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, "1");
});

test("the subagents come with their own tools and models", () => {
  const agents = loadAgents();
  assert.deepEqual(Object.keys(agents), ["bug-reviewer", "rules-reviewer"]);
  assert.deepEqual(agents["rules-reviewer"].tools, ["Read", "Grep", "Glob", "mcp__pr__get_pr", "mcp__pr__get_diff", "Skill"]);
  assert.deepEqual(agents["bug-reviewer"].tools, ["Read", "Grep", "Glob", "Skill", "mcp__pr__get_pr", "mcp__pr__get_diff"]);
  assert.equal(agents["rules-reviewer"].model, "sonnet");
  assert.ok(agents["rules-reviewer"].prompt.startsWith("You review one pull request"));
});

test("the subagents reach the session", () => {
  const options = buildOptions({ ...config, provider: "anthropic" });
  assert.deepEqual(Object.keys(options.agents), ["bug-reviewer", "rules-reviewer"]);
});

test("the rules reviewer gets the list of rule files, or none", () => {
  const listed = loadAgents({ root: fileURLToPath(new URL("../../..", import.meta.url)) });
  assert.ok(!/\{\{\w+\}\}/.test(listed["rules-reviewer"].prompt));
  assert.ok(listed["rules-reviewer"].prompt.includes("`REVIEW.md`"));
  const none = loadAgents({ root: mkdtempSync(join(tmpdir(), "no-rules-")) });
  assert.ok(none["rules-reviewer"].prompt.includes("do not read them: none. Rule files to read: none;"));
});

const PR_WRITE = ["mcp__pr__create_inline_comment", "mcp__pr__reply_to_thread", "mcp__pr__upsert_summary"];

test("no subagent gets the PR write tools", () => {
  const agents = loadAgents();
  for (const name of Object.keys(agents)) assert.deepEqual(agents[name].disallowedTools, PR_WRITE, name);
});

test("a hook denies the PR write tools inside any subagent, also one the SDK loads itself", async () => {
  const [guard] = buildOptions({ ...config, provider: "anthropic" }).hooks.PreToolUse;
  const matcher = new RegExp(guard.matcher);
  for (const tool of PR_WRITE) assert.ok(matcher.test(tool), tool);
  for (const tool of ["mcp__pr__get_diff", "mcp__pr__read_job_log", "mcp__other__upsert_summary"]) assert.ok(!matcher.test(tool), tool);
  assert.equal(guard.onFailure, "block");
  const inside = await guard.hooks[0]({ tool_name: "mcp__pr__upsert_summary", agent_id: "a1", agent_type: "skipped-file" });
  assert.equal(inside.hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(await guard.hooks[0]({ tool_name: "mcp__pr__upsert_summary" }), {});
});

test("a broken default agent stops the run", () => {
  const dir = mkdtempSync(join(tmpdir(), "default-agents-"));
  writeFileSync(join(dir, "bad.md"), "no frontmatter\n");
  assert.throws(() => loadAgents({ dir, root: undefined }), /Invalid subagent bad\.md: no frontmatter$/);
});

test("the session can read the agent-actions checkout it runs from", () => {
  const [root] = buildOptions({ ...config, provider: "anthropic", workspace: "/home/runner/work/app/app" }).additionalDirectories;
  assert.ok(existsSync(join(root, ".github/workflows/review.yml")), root);
  assert.ok(existsSync(join(root, "actions/run-agent/agents/bug-reviewer.md")), root);
  const { disallowedTools } = buildOptions({ ...config, provider: "anthropic", workspace: "/home/runner/work/app/app" });
  assert.deepEqual(disallowedTools, ["Edit(/x/**)", `Edit(/${root}**)`]);
  assert.match(disallowedTools[1], /^Edit\(\/\/.+\/\*\*\)$/);
});

test("in agent-actions itself the checkout is the workspace and stays editable", () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  for (const workspace of [root, join(root, "sub")]) {
    const options = buildOptions({ ...config, provider: "anthropic", workspace });
    assert.deepEqual(options.additionalDirectories, []);
    assert.deepEqual(options.disallowedTools, ["Edit(/x/**)"]);
  }
});
