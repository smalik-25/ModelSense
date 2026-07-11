import type { SceneCommand } from '@modelsense/shared';

export type AgentEvent =
  | { t: 'text'; text: string }
  | {
      t: 'tool';
      phase: 'call' | 'result';
      name: string;
      id?: string;
      ok?: boolean;
      input?: unknown;
      output?: unknown;
    }
  | { t: 'scene'; command: SceneCommand }
  | { t: 'approval'; id: string; tool: string; input: unknown }
  | { t: 'error'; message: string }
  | {
      t: 'done';
      turns: number;
      costUsd: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      traceUrl?: string;
    };

// `||` (not `??`) so an empty string also falls back instead of producing a
// relative POST that would hit the static host.
const AGENT_URL = import.meta.env.VITE_AGENT_URL || 'http://localhost:8787';

/** One prior chat turn forwarded so the agent can resolve follow-up references. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Abort if the stream produces no bytes for this long. Generous enough to cover a
 * Render free-tier cold start (~30-60s before the first byte) and the server's 15s
 * heartbeats, but bounded so an OOM'd/hung backend does not wedge the UI forever.
 */
const STALL_TIMEOUT_MS = 75_000;

/** Thrown when the stream stalls; Chat maps it to a friendly cold-start message. */
export class AgentTimeoutError extends Error {}
/** Thrown when the stream closes before the agent signalled completion. */
export class StreamEndedError extends Error {}

/**
 * Stream a chat turn. EventSource cannot POST, so we read the SSE body from a
 * fetch stream and parse `data:` frames ourselves. Guards against two live-demo
 * failure modes: a stalled/hung backend (stall watchdog) and a connection that
 * closes mid-turn without a terminal frame (treated as an error, not success).
 */
export async function streamChat(
  body: { message: string; modelId: string; history?: ChatTurn[] },
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  // One controller chains the caller's signal with our stall watchdog.
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort);
  let timedOut = false;
  let stall: ReturnType<typeof setTimeout> | undefined;
  const armStall = () => {
    if (stall) clearTimeout(stall);
    stall = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, STALL_TIMEOUT_MS);
  };

  try {
    armStall();
    let res: Response;
    try {
      res = await fetch(`${AGENT_URL}/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (timedOut) throw new AgentTimeoutError('The agent did not respond in time.');
      throw err;
    }
    if (!res.ok || !res.body) throw new Error(`Agent error ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawTerminal = false;
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (timedOut) throw new AgentTimeoutError('The agent stopped responding.');
        throw err;
      }
      if (chunk.done) break;
      armStall();
      buffer += decoder.decode(chunk.value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine.slice(6)) as AgentEvent;
          if (event.t === 'done' || event.t === 'error') sawTerminal = true;
          onEvent(event);
        } catch {
          // heartbeat / end frame; ignore
        }
      }
    }
    // A clean close with no 'done'/'error' frame means the turn was truncated
    // (e.g. the backend OOM'd mid-stream); surface it instead of a silent bubble.
    if (!sawTerminal && !signal.aborted) {
      throw new StreamEndedError('The agent stopped responding before finishing.');
    }
  } finally {
    if (stall) clearTimeout(stall);
    signal.removeEventListener('abort', onAbort);
  }
}

/** Fire-and-forget ping to wake the Render free-tier service before the user types. */
export function wakeAgent(): void {
  fetch(`${AGENT_URL}/healthz`, { method: 'GET' }).catch(() => {
    // ignore; the server may be cold-starting
  });
}

export async function approve(id: string, approved: boolean): Promise<void> {
  await fetch(`${AGENT_URL}/chat/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, approved }),
  });
}
