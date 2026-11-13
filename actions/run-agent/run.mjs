import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeThreadsOutput } from "./pr-tools.mjs";
import { modelSummary, saveOnCancel, toolLogLine } from "./tool-log.mjs";

const { PROVIDER, PROMPT, SUMMARY_LANGUAGE, TOOLS, DISALLOWED_TOOLS, ALLOWED_TOOLS, REQUIRED_TOOL, MAX_TURNS, MODEL, RUNNER_TEMP, GITHUB_OUTPUT } = process.env;

// Engines load lazily, so a provider does not need the SDKs of the others.
const ENGINES = {
  anthropic: () => import("./engines/claude.mjs"),
};

if (!Object.hasOwn(ENGINES, PROVIDER)) {
  console.error(`Unknown provider: ${PROVIDER}`);
  process.exit(1);
}
const engine = await ENGINES[PROVIDER]();

function splitList(value) {
  return (value ?? "").split(",").map((rule) => rule.trim()).filter(Boolean);
}

const messages = [];
const calledTools = new Set();
let result;
let failure;
// The review script reads this path also when the step is cancelled and sets no outputs.
const executionFile = join(RUNNER_TEMP, "agent-execution.json");
saveOnCancel(executionFile, messages);

try {
  for await (const message of engine.run({
    provider: PROVIDER,
    prompt: `${PROMPT}\n\nWrite the prose of every comment and summary in ${SUMMARY_LANGUAGE}. Keep headings, the category value, the "Fixed in", "Answered" and "Still present in" reply prefixes, and the pr-review marker exactly as specified, in English.`,
    model: MODEL,
    maxTurns: Number(MAX_TURNS),
    tools: splitList(TOOLS),
    disallowedTools: splitList(DISALLOWED_TOOLS),
    allowedTools: splitList(ALLOWED_TOOLS),
  })) {
    messages.push(message);
    if (message.type === "system" && message.subtype === "init") {
      console.log("session", JSON.stringify({
        provider: PROVIDER,
        model: message.model,
        version: message.claude_code_version,
        tools: message.tools,
        skills: message.skills,
        mcp: message.mcp_servers,
      }));
      // An agent without its tools would still finish and could report a clean review.
      const down = message.mcp_servers.filter((server) => server.status !== "connected");
      if (down.length) throw new Error(`MCP servers unavailable: ${JSON.stringify(down)}`);
      // The model call comes next, so a run interrupted from here on still counts as used.
      appendFileSync(GITHUB_OUTPUT, "model_started=true\n");
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          console.log(toolLogLine(message, block));
          calledTools.add(block.name);
        }
      }
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type === "tool_result" && block.is_error) {
          console.log("tool error", JSON.stringify(block.content).slice(0, 200));
        }
      }
    }
    if (message.type === "result") result = message;
  }
} catch (error) {
  failure = error;
}

writeThreadsOutput(RUNNER_TEMP, GITHUB_OUTPUT);

if (result) {
  writeFileSync(executionFile, JSON.stringify(messages));
  appendFileSync(GITHUB_OUTPUT, `execution_file=${executionFile}\n`);
  console.log("result", JSON.stringify({
    subtype: result.subtype,
    is_error: result.is_error,
    result: result.result,
    cost: result.total_cost_usd,
    duration_ms: result.duration_ms,
  }));
  // Every model that ran, subagents included, with what it cost.
  console.log("models", JSON.stringify(modelSummary(result.modelUsage)));
}

// A billing error arrives with subtype "success", so is_error has to be checked too.
if (failure || !result || result.subtype !== "success" || result.is_error) {
  console.error(failure ?? "The agent session did not finish successfully");
  process.exit(1);
}

// An agent that gives up can still end with a success result.
if (REQUIRED_TOOL && !calledTools.has(REQUIRED_TOOL)) {
  console.error(`The agent finished without calling ${REQUIRED_TOOL}`);
  process.exit(1);
}
