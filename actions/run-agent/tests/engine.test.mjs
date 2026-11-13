import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { applyModels, buildOptions, configureEnv, loadAgents } from "../engines/claude.mjs";

const config = { maxTurns: 1, tools: ["Read", "Edit", "Bash"], disallowedTools: ["Edit(/x/**)"], allowedTools: [], mcpServers: {} };

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

test("the PR tools cannot be replaced through mcp_config", () => {
  const options = buildOptions({ ...config, provider: "anthropic", mcpServers: { pr: "other" } });
  assert.notEqual(options.mcpServers.pr, "other");
  assert.equal(options.agents["rules-reviewer"].mcpServers, undefined);
});

test("application servers connect only in the rules reviewer", () => {
  const app = { app: { command: "python3", args: ["server.py"] } };
  const options = buildOptions({ ...config, provider: "anthropic", mcpServers: app });
  assert.deepEqual(Object.keys(options.mcpServers), ["pr"]);
  assert.deepEqual(options.agents["rules-reviewer"].mcpServers, [app]);
  assert.equal(options.agents["bug-reviewer"].mcpServers, undefined);
});

test("the scrub is on and bundled skills are off", () => {
  const env = {};
  configureEnv("anthropic", env);
  assert.equal(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, "1");
});

test("only the rules reviewer gets the application's MCP tools, and no PR write tool", () => {
  const agents = loadAgents(["Skill", "mcp__pr__upsert_summary", "mcp__app__lookup"]);
  assert.deepEqual(Object.keys(agents), ["bug-reviewer", "rules-reviewer"]);
  assert.deepEqual(agents["rules-reviewer"].tools,
    ["Read", "Grep", "Glob", "mcp__pr__get_pr", "mcp__pr__get_diff", "Skill", "mcp__app__lookup"]);
  assert.deepEqual(agents["bug-reviewer"].tools, ["Read", "Grep", "Glob", "Skill", "mcp__pr__get_pr", "mcp__pr__get_diff"]);
  assert.equal(agents["rules-reviewer"].model, "sonnet");
  assert.ok(agents["rules-reviewer"].prompt.startsWith("You review one pull request"));
});

test("the subagents reach the session", () => {
  const options = buildOptions({ ...config, provider: "anthropic", allowedTools: ["mcp__app__x"] });
  assert.ok(options.agents["rules-reviewer"].tools.includes("mcp__app__x"));
});

test("a rule that covers the PR server never reaches a subagent", () => {
  const agents = loadAgents(["mcp__pr", "mcp__pr__*", "mcp__*", "mcp__app__x"]);
  assert.deepEqual(agents["rules-reviewer"].tools.filter((tool) => tool.startsWith("mcp__") && !tool.startsWith("mcp__pr__get_")),
    ["mcp__app__x"]);
});

test("the rules reviewer gets the list of rule files, or none", () => {
  const listed = loadAgents([], {}, { root: fileURLToPath(new URL("../../..", import.meta.url)) });
  assert.ok(!/\{\{\w+\}\}/.test(listed["rules-reviewer"].prompt));
  assert.ok(listed["rules-reviewer"].prompt.includes("`REVIEW.md`"));
  const none = loadAgents([], {}, { root: mkdtempSync(join(tmpdir(), "no-rules-")) });
  assert.ok(none["rules-reviewer"].prompt.includes("do not read them: none. Rule files to read: none;"));
});

test("models sets the main session by role and each subagent by name", () => {
  const options = buildOptions({ ...config, provider: "anthropic", role: "review", models: { review: "sonnet", "bug-reviewer": "haiku" } });
  assert.equal(options.model, "sonnet");
  assert.equal(options.agents["bug-reviewer"].model, "haiku");
  assert.equal(options.agents["rules-reviewer"].model, "sonnet");
});

test("the model input wins over models, and the provider default applies last", () => {
  assert.equal(buildOptions({ ...config, provider: "anthropic", model: "x", role: "review", models: { review: "sonnet" } }).model, "x");
  assert.equal(buildOptions({ ...config, provider: "anthropic", role: "agent", models: {} }).model, "claude-opus-5-5");
});

test("an unknown role is reported and the run goes on with the file's model", () => {
  const warnings = [];
  const agents = { "rules-reviewer": { model: "sonnet" } };
  applyModels(agents, { role: "review", models: { "rules-reviwer": "opus" } }, (text) => warnings.push(text));
  assert.deepEqual(warnings, ["Unknown roles in models, ignored: rules-reviwer. Known: main, review, agent, rules-reviewer"]);
  assert.equal(agents["rules-reviewer"].model, "sonnet");
});

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), "repo-agents-"));
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, ".claude", "agents", name), text);
  return root;
}

test("a repository agent joins ours, and one of the same name replaces ours", () => {
  const root = repoWith({
    "migrations.md": "---\nname: migration-reviewer\ndescription: Checks migrations\ntools:\n  - Read\n  - Grep\nmodel: haiku\n---\nCheck migrations.\n",
    "bug.md": "---\nname: bug-reviewer\ndescription: Our own bug review\n---\nFind bugs our way.\n",
  });
  const agents = loadAgents([], {}, { root });
  assert.deepEqual(Object.keys(agents).sort(), ["bug-reviewer", "migration-reviewer", "rules-reviewer"]);
  assert.deepEqual(agents["migration-reviewer"],
    { description: "Checks migrations", prompt: "Check migrations.", model: "haiku", tools: ["Read", "Grep"], disallowedTools: PR_WRITE });
  assert.deepEqual(agents["bug-reviewer"], { description: "Our own bug review", prompt: "Find bugs our way.", disallowedTools: PR_WRITE });
});

const PR_WRITE = ["mcp__pr__create_inline_comment", "mcp__pr__reply_to_thread", "mcp__pr__upsert_summary"];

test("no subagent gets the PR write tools, with or without a tools line", () => {
  const root = repoWith({
    "open.md": "---\nname: open\ndescription: No tools line\n---\nx\n",
    "writer.md": "---\nname: writer\ndescription: Lists them\ntools: Read, mcp__pr__upsert_summary\ndisallowedTools: Glob\n---\nx\n",
  });
  const agents = loadAgents([], {}, { root });
  for (const name of Object.keys(agents)) {
    for (const tool of PR_WRITE) assert.ok(agents[name].disallowedTools.includes(tool), `${name} ${tool}`);
  }
  assert.equal(agents.writer.disallowedTools[0], "Glob");
});

test("a repository agent file passes through the supported fields, app-tools included", () => {
  const root = repoWith({
    "all.md": "---\nname: all\ndescription: Every field\ntools: [Read]\nskills: [checklist]\neffort: high\nmaxTurns: 7\napp-tools: true\n---\nx\n",
  });
  const app = { app: { command: "python3", args: ["server.py"] } };
  const { all } = loadAgents(["mcp__app__lookup"], app, { root });
  assert.deepEqual(all.tools, ["Read", "mcp__app__lookup"]);
  assert.deepEqual(all.skills, ["checklist"]);
  assert.equal(all.effort, "high");
  assert.equal(all.maxTurns, 7);
  assert.deepEqual(all.mcpServers, [app]);
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
  assert.throws(() => loadAgents([], {}, { dir, root: undefined }), /Invalid subagent bad\.md: no frontmatter$/);
});

test("models reaches repository agents too", () => {
  const root = repoWith({ "m.md": "---\nname: migration-reviewer\ndescription: Checks migrations\nmodel: haiku\n---\nx\n" });
  const options = buildOptions({ ...config, provider: "anthropic", role: "review", models: { "migration-reviewer": "opus" }, workspace: root });
  assert.equal(options.agents["migration-reviewer"].model, "opus");
});

test("a repository agent cannot add Bash or a permission mode", () => {
  const root = repoWith({ "s.md": "---\nname: shell\ndescription: Runs things\ntools: Bash, Read\npermissionMode: bypassPermissions\n---\nx\n" });
  const options = buildOptions({ ...config, provider: "anthropic", workspace: root });
  assert.equal(options.agents.shell.permissionMode, undefined);
  assert.ok(!options.tools.includes("Bash"));
  assert.equal(options.permissionMode, "dontAsk");
});

test("a repository agent that lists tools the session lacks gets a warning", () => {
  const root = repoWith({
    "s.md": "---\nname: shell-probe\ndescription: Runs things\ntools: Bash, Bash(npm test *), Read, Grep(shop/**), mcp__pr__get_diff, mcp__pr__upsert_summary, mcp__app__x, mcp__*\n---\nx\n",
    "a.md": "---\nname: app\ndescription: App tools\ntools: Read, mcp__app__x\napp-tools: true\n---\nx\n",
    "o.md": "---\nname: open\ndescription: No tools line\n---\nx\n",
  });
  const warnings = [];
  loadAgents(["mcp__app__x"], {}, { root, warn: (text) => warnings.push(text), sessionTools: ["Skill", "Agent", "Read", "Grep", "Glob"] });
  assert.deepEqual(warnings, ["Subagent shell-probe in .claude/agents lists tools the session does not have, ignored: Bash, Bash(npm test *), mcp__pr__upsert_summary, mcp__app__x"]);
});

test("an application server granted as a whole covers each of its tools", () => {
  const root = repoWith({
    "a.md": "---\nname: app\ndescription: App tools\ntools: mcp__app__x, mcp__api__y, mcp__other__z\napp-tools: true\n---\nx\n",
  });
  const warnings = [];
  loadAgents(["mcp__app__*", "mcp__api"], {}, { root, warn: (text) => warnings.push(text), sessionTools: ["Agent", "Read"] });
  assert.deepEqual(warnings, ["Subagent app in .claude/agents lists tools the session does not have, ignored: mcp__other__z"]);
});

test("only a session with the Agent tool checks the tools of repository agents", () => {
  const root = repoWith({ "s.md": "---\nname: shell\ndescription: Runs things\ntools: Bash\n---\nx\n" });
  const lines = [];
  const log = console.log;
  console.log = (text) => lines.push(text);
  try {
    buildOptions({ ...config, provider: "anthropic", workspace: root });
    buildOptions({ ...config, tools: [...config.tools, "Agent"], provider: "anthropic", workspace: root });
  } finally {
    console.log = log;
  }
  assert.deepEqual(lines, ["::warning::Subagent shell in .claude/agents lists tools the session does not have, ignored: Bash"]);
});

test("a broken repository agent is skipped with a warning", () => {
  const root = repoWith({ "bad.md": "no frontmatter\n", "half.md": "---\nname: half\n---\nx\n" });
  const warnings = [];
  const agents = loadAgents([], {}, { root, warn: (text) => warnings.push(text) });
  assert.deepEqual(Object.keys(agents), ["bug-reviewer", "rules-reviewer"]);
  assert.deepEqual(warnings, ["Invalid subagent bad.md: no frontmatter; skipped", "Invalid subagent half.md: name and description are required; skipped"]);
});

test("one AI_MODELS serves both workflows, each taking its own role", () => {
  const models = { review: "opus", agent: "sonnet", "rules-reviewer": "haiku" };
  assert.equal(buildOptions({ ...config, provider: "anthropic", role: "review", models }).model, "opus");
  assert.equal(buildOptions({ ...config, provider: "anthropic", role: "agent", models }).model, "sonnet");
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
