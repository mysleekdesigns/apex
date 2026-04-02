#!/usr/bin/env node

/**
 * APEX Learning — MCP Server Entry Point
 *
 * Exposes the APEX tool suite over the Model Context Protocol
 * using stdio transport. All output to stdout is reserved for
 * the MCP protocol; diagnostic logging goes to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { tools } from './tools.js';
import { handlers } from './handlers.js';

// ── Server setup ──────────────────────────────────────────────────

const server = new Server(
  { name: 'apex-learning', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

// ── List tools ────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// ── Call tool ─────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const { name, arguments: args } = request.params;

  const handler = handlers.get(name);
  if (!handler) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: `Unknown tool: ${name}`,
            availableTools: Array.from(handlers.keys()),
          }),
        },
      ],
      isError: true,
    };
  }

  try {
    return await handler(args ?? {});
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[apex] Error in ${name}:`, message);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ error: message, tool: name }),
        },
      ],
      isError: true,
    };
  }
});

// ── Startup ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[apex] APEX Learning MCP server started (stdio transport)');
  console.error(`[apex] ${tools.length} tools registered`);
}

// ── Graceful shutdown ─────────────────────────────────────────────

function shutdown(): void {
  console.error('[apex] Shutting down...');
  server.close().catch((err) => {
    console.error('[apex] Error during shutdown:', err);
  });
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ── Run ───────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[apex] Fatal error:', err);
  process.exit(1);
});
