import { z } from 'zod';

/**
 * Opaque, server-minted identifier for a loaded-model session.
 *
 * We deliberately do NOT use MCP protocol sessions (the Mcp-Session-Id header):
 * the Streamable HTTP transport is built stateless-first, and the upcoming
 * 2026-07-28 spec removes protocol sessions entirely. Instead `load_model`
 * mints one of these, returns it, and every later tool takes it as an argument.
 */
export const SessionId = z.string().min(1).brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

/** The `session_id` argument shared by every tool that operates on a loaded model. */
export const WithSessionId = z.object({
  session_id: SessionId,
});
export type WithSessionId = z.infer<typeof WithSessionId>;
