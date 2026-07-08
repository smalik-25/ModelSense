import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A recoverable, user-facing error inside a tool. The tool handler catches it
 * and returns a structured tool execution error (isError: true) so the agent
 * can self-correct, per MCP spec 2025-11-25 (SEP-1303). We never throw raw
 * across the protocol boundary.
 */
export class ToolError extends Error {}

/** A successful tool result: JSON text mirror in `content`, typed `structuredContent`. */
export function ok(output: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  };
}

/** A structured tool execution error the model can read and recover from. */
export function fail(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}
