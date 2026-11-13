// Minimal MCP server over HTTP with one tool, for the preflight tests: streamable HTTP at /mcp,
// SSE at /sse. With a key, a request without it in the x-key header gets 401.
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function fixtureServer() {
  const server = new McpServer({ name: "fixture", version: "1" });
  server.registerTool("lookup", { description: "fixture" }, async () => ({ content: [] }));
  return server;
}

export async function startHttpServer({ key } = {}) {
  const sessions = new Map();
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (key && req.headers["x-key"] !== key) {
      res.writeHead(401).end();
    } else if (url.pathname === "/mcp") {
      // No session: each request gets its own server, as a stateless deployment does.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => transport.close());
      await fixtureServer().connect(transport);
      await transport.handleRequest(req, res);
    } else if (url.pathname === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      sessions.set(transport.sessionId, transport);
      res.on("close", () => sessions.delete(transport.sessionId));
      await fixtureServer().connect(transport);
    } else if (url.pathname === "/messages" && sessions.has(url.searchParams.get("sessionId"))) {
      await sessions.get(url.searchParams.get("sessionId")).handlePostMessage(req, res);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${http.address().port}`;
  return {
    http: `${origin}/mcp`,
    sse: `${origin}/sse`,
    close: () => new Promise((done) => { http.closeAllConnections(); http.close(done); }),
  };
}
