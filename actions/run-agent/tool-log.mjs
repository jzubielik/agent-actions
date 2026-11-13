import { writeFileSync } from "node:fs";

// One log line per tool call. A subagent's calls carry the id of the Agent call that started
// it, and the Agent line shows that id, so the log tells who called each tool.
export function toolLogLine(message, block) {
  const caller = message.parent_tool_use_id ? `subagent:${message.parent_tool_use_id}` : "main";
  const detail = block.name === "Read" ? block.input.file_path
    : block.name === "Agent" ? `${block.input.subagent_type} ${block.id}`
    : block.name === "Skill" ? block.input.skill : "";
  return ["tool", caller, block.name, detail].join(" ").trimEnd();
}

// Per model: calls are not counted by the SDK, so tokens and cost show what each model did.
export function modelSummary(modelUsage = {}) {
  return Object.fromEntries(Object.entries(modelUsage).map(([model, usage]) => [model, {
    input: usage.inputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens,
    output: usage.outputTokens,
    cost: Math.round(usage.costUSD * 10000) / 10000,
  }]));
}

// Tokens of every model call so far, subagents included. A run that is cancelled ends without
// the result message that carries the cost, so this is what it is known to have used. The SDK
// sends one assistant message per content block, all with the usage of their call.
export function usedTokens(messages) {
  const calls = new Map();
  for (const message of messages) {
    if (message.type !== "assistant" || !message.message?.usage) continue;
    const { input_tokens = 0, output_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } = message.message.usage;
    calls.set(message.message.id ?? calls.size, input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens);
  }
  return [...calls.values()].reduce((sum, tokens) => sum + tokens, 0);
}

// Cancelling the job (a newer review of the same PR, or a person) signals this process before
// the session ends. Once the session started, the first model call may already be under way, so
// the run is saved even before any usage arrived; record counts it either way.
export function saveOnCancel(file, messages, started = Date.now()) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      const tokens = usedTokens(messages);
      // The session already gave its result: the review is done, and record reads its cost.
      if (messages.some((message) => message.type === "result")) {
        writeFileSync(file, JSON.stringify(messages));
      } else if (messages.some((message) => message.type === "system" && message.subtype === "init")) {
        writeFileSync(file, JSON.stringify([...messages, { type: "cancelled", signal, tokens, duration_ms: Date.now() - started }]));
        console.log("cancelled", JSON.stringify({ signal, tokens }));
      }
      process.exit(1);
    });
  }
}
