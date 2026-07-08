import { useRef, useState } from 'react';
import type { SceneCommand } from '@modelsense/shared';
import { approve, streamChat } from '../lib/agentClient';
import type { AgentEvent } from '../lib/agentClient';

interface Message {
  role: 'user' | 'assistant';
  text: string;
}
interface Trace {
  turns: number;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  traceUrl?: string;
}
interface Approval {
  id: string;
  tool: string;
  input: unknown;
}

const EXAMPLES = [
  'Find every node with "wheel" in the name and highlight the largest one.',
  'How many triangles and materials does this model have?',
  'Focus the camera on the wheels.',
  'Export a report of this scene.',
];

const shortTool = (name: string) => name.replace('mcp__modelsense__', '');

export function Chat({ modelId, onScene }: { modelId: string; onScene: (cmd: SceneCommand) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const appendAssistant = (delta: string) =>
    setMessages((prev) => {
      const copy = [...prev];
      const last = copy[copy.length - 1];
      if (last?.role === 'assistant') copy[copy.length - 1] = { ...last, text: last.text + delta };
      return copy;
    });

  const onEvent = (e: AgentEvent) => {
    if (e.t === 'text') appendAssistant(e.text);
    else if (e.t === 'tool' && e.phase === 'call') setTools((p) => [...p, shortTool(e.name)]);
    else if (e.t === 'scene') onScene(e.command);
    else if (e.t === 'approval') setApproval({ id: e.id, tool: shortTool(e.tool), input: e.input });
    else if (e.t === 'error') setError(e.message);
    else if (e.t === 'done')
      setTrace({
        turns: e.turns,
        costUsd: e.costUsd,
        durationMs: e.durationMs,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        traceUrl: e.traceUrl,
      });
  };

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setError(null);
    setTrace(null);
    setTools([]);
    setApproval(null);
    setMessages((p) => [...p, { role: 'user', text }, { role: 'assistant', text: '' }]);
    setInput('');
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await streamChat({ message: text, modelId }, onEvent, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        const msg = err instanceof Error ? err.message : 'Request failed';
        setError(
          /fetch/i.test(msg)
            ? 'Could not reach the agent. The server may be waking up (free-tier cold start, ~30-60s). Please try again.'
            : msg,
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const decide = async (approved: boolean) => {
    if (!approval) return;
    await approve(approval.id, approved);
    setApproval(null);
  };

  return (
    <section className="chat" data-testid="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="examples">
            <p className="muted">Ask about the model:</p>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" className="example" disabled={busy} onClick={() => send(ex)}>
                {ex}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`} data-testid={`msg-${m.role}`}>
            {m.text || (busy && i === messages.length - 1 ? <span className="dots">…</span> : '')}
          </div>
        ))}

        {busy && tools.length > 0 && (
          <div className="tools-strip" data-testid="tools-strip">
            {tools.map((t, i) => (
              <span key={i} className="tool-chip" data-testid="tool-chip">
                {t}
              </span>
            ))}
          </div>
        )}

        {approval && (
          <div className="approval" data-testid="approval">
            <div className="approval-title">Approval required</div>
            <div className="muted">
              The agent wants to run <code>{approval.tool}</code>.
            </div>
            <div className="row">
              <button type="button" onClick={() => decide(true)}>
                Approve
              </button>
              <button type="button" className="ghost" onClick={() => decide(false)}>
                Reject
              </button>
            </div>
          </div>
        )}

        {error && <div className="error">Error: {error}</div>}

        {trace && (
          <div className="trace" data-testid="trace">
            <span>{trace.turns} turns</span>
            <span>{(trace.durationMs / 1000).toFixed(1)}s</span>
            <span>${trace.costUsd.toFixed(4)}</span>
            <span>
              {trace.inputTokens}/{trace.outputTokens} tok
            </span>
            {trace.traceUrl && (
              <a href={trace.traceUrl} target="_blank" rel="noreferrer">
                Langfuse trace
              </a>
            )}
          </div>
        )}
      </div>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          data-testid="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'Working…' : 'Ask about the model'}
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </section>
  );
}
