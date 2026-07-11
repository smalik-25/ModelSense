import { z } from 'zod';

/**
 * Opaque, server-minted identifier for a loaded-model session. Used as the
 * `session_id` argument on every tool that operates on a loaded model (see
 * tools.ts), so this is the single source of truth for that field.
 *
 * We deliberately do NOT use MCP protocol sessions (the Mcp-Session-Id header):
 * the Streamable HTTP transport is built stateless-first, and the upcoming
 * 2026-07-28 spec removes protocol sessions entirely. Instead `load_model`
 * mints one of these, returns it, and every later tool takes it as an argument.
 */
export const SessionId = z.string().min(1);
export type SessionId = z.infer<typeof SessionId>;
