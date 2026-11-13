// Engine for Claude through the Agent SDK. An engine runs one session and yields its messages
// in the Agent SDK format, so run.mjs stays independent of the SDK behind it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import { prTools, tools as prToolList } from "../pr-tools.mjs";

const ACTIONS_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Bedrock has no entry: without a model, Claude Code picks the inference profile for the region.
const DEFAULT_MODELS = { anthropic: "claude-opus-5-5" };

export function configureEnv(provider, env = process.env) {
  // Keeps credentials out of stdio MCP servers.
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  // Claude Code ships skills for interactive work; here they only fill every session's
  // context, and one with a similar purpose could be picked instead of ours. Plugin and
  // repository skills are not affected.
  env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1";
  if (provider === "bedrock") env.CLAUDE_CODE_USE_BEDROCK = "1";
}

const AGENTS_DIR = new URL("../agents/", import.meta.url);

function githubWarning(text) {
  console.log(`::warning::${text}`);
}

// Claude Code accepts a tool list as "A, B" or as a YAML list.
function splitList(value) {
  if (value === undefined || value === null) return undefined;
  const items = Array.isArray(value) ? value : String(value).split(",");
  return items.map((item) => String(item).trim()).filter(Boolean);
}

// A subagent file is YAML frontmatter followed by the prompt, as in .claude/agents.
export function parseAgent(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("no frontmatter");
  const fields = parseYaml(match[1]) ?? {};
  if (typeof fields !== "object" || !fields.name || !fields.description) throw new Error("name and description are required");
  return { ...fields, prompt: match[2].trim() };
}

// Ours must parse. A broken file in the repository is skipped with a warning, so the review
// still runs with the other agents.
function readAgents(dir, onInvalid = (message) => { throw new Error(message); }) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort().flatMap((file) => {
    try {
      return [parseAgent(readFileSync(join(dir, file), "utf8"))];
    } catch (error) {
      onInvalid(`Invalid subagent ${file}: ${error.message}`);
      return [];
    }
  });
}

// The same names restore-config.sh restores from the base branch. Listing the files that
// exist saves the rules reviewer a turn for each one it would otherwise try to read.
// The base branch checkout is skipped: its files are the source of the restored ones. So is
// the checkout of this action, when it sits in the working directory.
export function ruleFiles(root, trustedDir = process.env.TRUSTED_DIR, own = ACTIONS_ROOT) {
  const skip = new Set([join(root, ".git"), resolve(own), ...(trustedDir ? [resolve(root, trustedDir)] : [])]);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (skip.has(path) || entry.name === "node_modules") continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "CLAUDE.md" || entry.name === "AGENTS.md") found.push(relative(root, path));
    }
  };
  walk(root);
  if (existsSync(join(root, "REVIEW.md"))) found.push("REVIEW.md");
  return found.sort();
}

// Claude Code puts the root CLAUDE.md into every session and subagent, and the root AGENTS.md
// only when no root CLAUDE.md, .claude/CLAUDE.md or CLAUDE.local.md exists. Files in
// subdirectories load only when a file there is read, and REVIEW.md never does.
// https://code.claude.com/docs/en/memory
export function splitLoaded(files, root) {
  const rootClaude = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"].some((file) => existsSync(join(root, file)));
  const loaded = rootClaude ? ["CLAUDE.md", ".claude/CLAUDE.md"] : ["AGENTS.md", ".claude/AGENTS.md"];
  return {
    loaded: files.filter((file) => loaded.includes(file)),
    toRead: files.filter((file) => !loaded.includes(file)),
  };
}

function listOrNone(files) {
  return files.map((file) => `\`${file}\``).join(", ") || "none";
}

// The tools of every subagent are an allow list. The application's MCP tools are known only
// at runtime, so they are added here for subagents marked app-tools; a new PR write tool
// stays out until a subagent lists it. The application's servers connect only inside those
// subagents, so the main session neither sees nor calls their tools.
// Ours are a starting point: an agent in the repository's .claude/agents (restored from the
// base branch) replaces ours of the same name. All of them go through the agents option, so
// models applies to each; the SDK would otherwise let ours win over a file of the same name.
// The session's tools and permission mode still bound every subagent, so a file cannot add
// Bash or change the permission mode. The PR write tools are for the main session, which
// confirms each finding before posting it; no subagent gets them, even one with no tools line.
export function loadAgents(allowedTools, mcpServers = {}, { dir = fileURLToPath(AGENTS_DIR), root = process.env.GITHUB_WORKSPACE, warn = githubWarning, sessionTools } = {}) {
  if (root && !existsSync(root)) root = undefined;
  const { loaded, toRead } = root ? splitLoaded(ruleFiles(root), root) : { loaded: [], toRead: [] };
  // The server is matched by name: "mcp__pr" and "mcp__*" would otherwise cover the PR tools.
  const appTools = allowedTools.filter((tool) => {
    const server = tool.split("__")[1];
    return tool.startsWith("mcp__") && server && server !== "pr" && !server.includes("*");
  });
  const repo = root ? readAgents(join(root, ".claude", "agents"), (text) => warn(`${text}; skipped`)) : [];
  const prWrite = prToolList.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => `mcp__pr__${tool.name}`);
  const agents = {};
  for (const agent of [...readAgents(dir), ...repo]) {
    const tools = splitList(agent.tools);
    const disallowed = [...(splitList(agent.disallowedTools) ?? []), ...prWrite];
    const skills = splitList(agent.skills);
    const withApp = agent["app-tools"] === true || agent["app-tools"] === "true";
    if (repo.includes(agent) && tools && sessionTools) {
      const missing = missingTools(tools, { sessionTools, prWrite, appTools: withApp ? appTools : [] });
      if (missing.length) warn(`Subagent ${agent.name} in .claude/agents lists tools the session does not have, ignored: ${missing.join(", ")}`);
    }
    agents[agent.name] = {
      description: agent.description,
      prompt: agent.prompt.replaceAll("{{LOADED_RULES}}", listOrNone(loaded)).replaceAll("{{RULE_FILES}}", listOrNone(toRead)),
      ...(agent.model ? { model: agent.model } : {}),
      ...(tools ? { tools: withApp ? [...tools, ...appTools] : tools } : {}),
      disallowedTools: disallowed,
      ...(skills ? { skills } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
      ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
      ...(withApp && Object.keys(mcpServers).length ? { mcpServers: [mcpServers] } : {}),
    };
  }
  return agents;
}

// A tool a repository subagent lists but cannot get is dropped without a trace in the run, so
// its author would think it ran, for example Bash. Rules such as "Bash(npm test *)" are matched
// by tool name; a name with "*" is left to Claude Code. An application server granted as a
// whole ("mcp__app" or "mcp__app__*") covers each of its tools.
function missingTools(tools, { sessionTools, prWrite, appTools }) {
  const prRead = prToolList.map((tool) => `mcp__pr__${tool.name}`).filter((name) => !prWrite.includes(name));
  const available = new Set([...sessionTools, ...prRead, ...appTools]);
  const servers = appTools.filter((tool) => tool.split("__").length === 2 || tool.endsWith("__*")).map((tool) => tool.replace(/__\*$/, ""));
  return tools.filter((tool) => {
    const name = tool.replace(/\(.*$/, "");
    return !name.includes("*") && !available.has(name) && !servers.some((server) => name.startsWith(`${server}__`));
  });
}

// Claude Code also loads .claude/agents itself, so a file that loadAgents skips or never reads
// still reaches the session without our disallowedTools. The hook covers every subagent: a
// call from inside one carries agent_id.
export function subagentWriteGuard() {
  const names = prToolList.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => tool.name);
  const deny = async (input) => input.agent_id
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Only the main session posts to the pull request" } }
    : {};
  return { matcher: `^mcp__pr__(${names.join("|")})$`, hooks: [deny], onFailure: "block" };
}

// The PR tools come from this action only; mcp_config cannot replace them.
function withoutPr(mcpServers) {
  const { pr, ...rest } = mcpServers;
  return rest;
}

// One AI_MODELS serves every workflow, so it holds the main-session roles of all of them.
const MAIN_ROLES = ["main", "review", "agent"];

// models maps roles to models: the main-session roles and each subagent's name. Only the
// current role applies to the main session. models only overrides the model: line of a
// subagent file, so a key that matches no role leaves a model someone chose; it is reported,
// not fatal.
export function applyModels(agents, { role, models }, warn = githubWarning) {
  const known = new Set([...MAIN_ROLES, role, ...Object.keys(agents)]);
  const unknown = Object.keys(models).filter((key) => !known.has(key));
  if (unknown.length) warn(`Unknown roles in models, ignored: ${unknown.join(", ")}. Known: ${[...known].join(", ")}`);
  for (const [name, agent] of Object.entries(agents)) {
    if (models[name]) agent.model = models[name];
  }
  return models[role];
}

export function buildOptions({ provider, model, role = "main", models = {}, maxTurns, tools, disallowedTools, allowedTools, mcpServers, workspace = process.env.GITHUB_WORKSPACE }) {
  const sessionTools = tools.filter((tool) => tool !== "Bash");
  // Without the Agent tool no subagent runs, so a mismatch in one is no news.
  const agents = loadAgents(allowedTools, withoutPr(mcpServers), { root: workspace, sessionTools: sessionTools.includes("Agent") ? sessionTools : undefined });
  const roleModel = applyModels(agents, { role, models });
  // The reusable workflows check out all of agent-actions, at their own version, into the
  // working directory. Reading it lets the model check what the workflows, the skill and the
  // agents do, instead of guessing; it stays read only ("//" starts an absolute path in a rule,
  // and Edit rules cover Write too). When agent-actions tests itself the action runs from the
  // checkout, which is the working directory and must stay editable.
  const own = Boolean(workspace) && !relative(ACTIONS_ROOT, workspace).startsWith("..");
  return {
    cwd: workspace,
    additionalDirectories: own ? [] : [ACTIONS_ROOT],
    model: model || roleModel || DEFAULT_MODELS[provider],
    maxTurns,
    // Only config restored from the base branch is on disk at this point.
    settingSources: ["project"],
    // The review skill; it lives outside the checkout, so a PR cannot change it.
    plugins: [{ type: "local", path: fileURLToPath(new URL("../plugin", import.meta.url)) }],
    agents,
    mcpServers: { pr: prTools },
    hooks: { PreToolUse: [subagentWriteGuard()] },
    // Never Bash: a prompt injected through the PR must not be able to run commands.
    tools: sessionTools,
    disallowedTools: own ? disallowedTools : [...disallowedTools, `Edit(/${ACTIONS_ROOT}**)`],
    allowedTools,
    // Reads are approved only inside the working directory and agent-actions; anything else is denied.
    permissionMode: "dontAsk",
  };
}

export function run({ prompt, ...config }) {
  configureEnv(config.provider);
  return query({ prompt, options: buildOptions(config) });
}
