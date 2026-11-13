// Engine for Claude through the Agent SDK. An engine runs one session and yields its messages
// in the Agent SDK format, so run.mjs stays independent of the SDK behind it.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { parse as parseYaml } from "yaml";
import { prTools, tools as prToolList } from "../pr-tools.mjs";

const ACTIONS_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const DEFAULT_MODELS = { anthropic: "claude-opus-5-5" };

export function configureEnv(provider, env = process.env) {
  // Keeps credentials out of stdio MCP servers.
  env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = "1";
  // Claude Code ships skills for interactive work; here they only fill every session's
  // context, and one with a similar purpose could be picked instead of ours. Plugin and
  // repository skills are not affected.
  env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS = "1";
}

const AGENTS_DIR = new URL("../agents/", import.meta.url);

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

// A subagent file that does not parse stops the run.
function readAgents(dir) {
  return readdirSync(dir).filter((name) => name.endsWith(".md")).sort().map((file) => {
    try {
      return parseAgent(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`Invalid subagent ${file}: ${error.message}`);
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

// The tools of every subagent are an allow list. The PR write tools are for the main session,
// which confirms each finding before posting it; no subagent gets them.
export function loadAgents({ dir = fileURLToPath(AGENTS_DIR), root = process.env.GITHUB_WORKSPACE } = {}) {
  if (root && !existsSync(root)) root = undefined;
  const { loaded, toRead } = root ? splitLoaded(ruleFiles(root), root) : { loaded: [], toRead: [] };
  const prWrite = prToolList.filter((tool) => !tool.annotations?.readOnlyHint).map((tool) => `mcp__pr__${tool.name}`);
  const agents = {};
  for (const agent of readAgents(dir)) {
    const tools = splitList(agent.tools);
    agents[agent.name] = {
      description: agent.description,
      prompt: agent.prompt.replaceAll("{{LOADED_RULES}}", listOrNone(loaded)).replaceAll("{{RULE_FILES}}", listOrNone(toRead)),
      ...(agent.model ? { model: agent.model } : {}),
      ...(tools ? { tools } : {}),
      disallowedTools: prWrite,
    };
  }
  return agents;
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

export function buildOptions({ provider, model, maxTurns, tools, disallowedTools, allowedTools, workspace = process.env.GITHUB_WORKSPACE }) {
  const sessionTools = tools.filter((tool) => tool !== "Bash");
  const agents = loadAgents({ root: workspace });
  // The reusable workflows check out all of agent-actions, at their own version, into the
  // working directory. Reading it lets the model check what the workflows, the skill and the
  // agents do, instead of guessing; it stays read only ("//" starts an absolute path in a rule,
  // and Edit rules cover Write too). When agent-actions tests itself the action runs from the
  // checkout, which is the working directory and must stay editable.
  const own = Boolean(workspace) && !relative(ACTIONS_ROOT, workspace).startsWith("..");
  return {
    cwd: workspace,
    additionalDirectories: own ? [] : [ACTIONS_ROOT],
    model: model || DEFAULT_MODELS[provider],
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
