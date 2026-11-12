#!/usr/bin/env node
// Launcher for the openmeteo-mcp stdio server.
// Works under Bun (bunx / bun) and under Node >= 22.18, which strips
// TypeScript types natively — no build step, no compiled output to keep
// in sync.
import "../src/index.ts";
