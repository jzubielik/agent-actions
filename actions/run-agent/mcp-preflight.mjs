// The application's MCP servers connect inside a subagent, after the session's own check of
// its servers. A server that fails there would leave the rules reviewer without its tools
// and the review would still pass, so each server is connected once here, before the session.
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// The PR tools come from this action only, so a "pr" entry in mcp_config is dropped before
// both the check and the session.
export function appServers(mcpConfig) {
  const { pr: _ignored, ...rest } = mcpConfig;
  return rest;
}

// A stdio server starts in the checkout of the base branch, not in the pull request's, so what
// its runtime reads from the working directory (a package.json, an .npmrc, modules) is trusted
// like the server's own code. The session has no option for the directory, so a shell changes
// it and then becomes the command, here and in the session alike. The command and its arguments
// are passed as arguments of the shell, never as its text. An entry without a command is left
// as it is, and the check reports it.
const ENTER = 'cd "$1" && shift && exec "$@"';

export function inTrustedDir(mcpServers, dir) {
  return Object.fromEntries(Object.entries(mcpServers).map(([name, config]) => [
    name,
    (config.type ?? "stdio") === "stdio" && typeof config.command === "string"
      ? { ...config, command: "sh", args: ["-c", ENTER, "sh", dir, config.command, ...(config.args ?? [])] }
      : config,
  ]));
}

// The servers of one session, from the mcp_config input: an empty input means none.
export function sessionServers(mcpConfig, workspace, trustedDir) {
  return inTrustedDir(appServers(JSON.parse(mcpConfig || "{}")), resolve(workspace, trustedDir));
}

// The session starts the server with the job's environment, credentials scrubbed, plus the
// server's own env. The scrub list is Claude Code's, so this one is deliberately wider.
const CREDENTIAL = /TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|^AWS_/i;

export function serverEnv(own = {}, env = process.env) {
  const kept = Object.entries(env).filter(([name, value]) => value !== undefined && !CREDENTIAL.test(name));
  return { ...Object.fromEntries(kept), ...own };
}

function transportFor(config, cwd) {
  const type = config.type ?? "stdio";
  if (type === "stdio") {
    return new StdioClientTransport({ command: config.command, args: config.args ?? [], env: serverEnv(config.env), cwd, stderr: "pipe" });
  }
  const url = new URL(config.url);
  const requestInit = { headers: config.headers ?? {} };
  if (type === "http") return new StreamableHTTPClientTransport(url, { requestInit });
  if (type === "sse") return new SSEClientTransport(url, { requestInit });
  throw new Error(`unsupported transport ${type}`);
}

// Every allow rule for a server, such as mcp__app__lookup, names a tool that
// server must list. Rules with wildcards only need the server to connect.
function requiredTools(server, allowedTools) {
  const prefix = `mcp__${server}__`;
  return allowedTools.filter((rule) => rule.startsWith(prefix) && !rule.includes("*")).map((rule) => rule.slice(prefix.length));
}

const STDERR_TAIL = 1000;

export async function checkServers(mcpServers, allowedTools, { cwd = process.cwd(), timeoutMs = 30000 } = {}) {
  const problems = [];
  for (const [name, config] of Object.entries(mcpServers)) {
    const client = new Client({ name: "agent-actions-preflight", version: "1" });
    // "Connection closed" alone does not say why a server exited; its stderr usually does.
    let stderr = "";
    try {
      const transport = transportFor(config, cwd);
      transport.stderr?.on("data", (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
      await client.connect(transport, { timeout: timeoutMs });
      const { tools } = await client.listTools(undefined, { timeout: timeoutMs });
      const listed = new Set(tools.map((tool) => tool.name));
      const missing = requiredTools(name, allowedTools).filter((tool) => !listed.has(tool));
      if (missing.length) problems.push(`${name}: missing tools ${missing.join(", ")}`);
    } catch (error) {
      await new Promise((done) => setImmediate(done));
      const output = stderr.trim();
      problems.push(`${name}: ${error.message}${output ? `\n  stderr: ${output.replaceAll("\n", "\n  ")}` : ""}`);
    } finally {
      await client.close().catch(() => {});
    }
  }
  return problems;
}
