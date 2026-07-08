import type { SceneCommand } from '@modelsense/shared';

export type AgentEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; phase: 'call' | 'result'; name: string; ok?: boolean }
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

const AGENT_URL = import.meta.env.VITE_AGENT_URL ?? 'http://localhost:8787';

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

export async function approve(id: string, approved: boolean): Promise<void> {
  await fetch(`${AGENT_URL}/chat/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, approved }),
  });
}
