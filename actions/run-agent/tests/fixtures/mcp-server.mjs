// Minimal stdio MCP server with one tool, for the preflight tests.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "fixture", version: "1" });
server.registerTool("lookup", { description: "fixture" }, async () => ({ content: [] }));
await server.connect(new StdioServerTransport());
