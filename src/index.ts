/**
 * Entry point: serve MCP over stdio (protocol on stdout, logs on stderr).
 *
 * Run with Bun:      bun run src/index.ts   (or `bun run start`)
 * Run with Node:     node bin/openmeteo-mcp.js   (requires Node >= 22.18)
 * Zero-install:      bunx github:DrokAI/mcp-demo-weather
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.ts";
import { VERSION } from "./version.ts";

const server = buildServer();
await server.connect(new StdioServerTransport());

// Logs must go to stderr — stdout carries the MCP protocol.
console.error(`openmeteo-mcp v${VERSION} serving MCP over stdio (protocol: stdout, logs: stderr)`);
