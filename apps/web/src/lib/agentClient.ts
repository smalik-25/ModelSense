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

/**
 * Stream a chat turn. EventSource cannot POST, so we read the SSE body from a
 * fetch stream and parse `data:` frames ourselves.
 */
export async function streamChat(
  body: { message: string; modelId: string },
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${AGENT_URL}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Agent error ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try {
        onEvent(JSON.parse(dataLine.slice(6)) as AgentEvent);
      } catch {
        // heartbeat / end frame; ignore
      }
    }
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
