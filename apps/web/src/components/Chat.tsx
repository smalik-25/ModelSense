import { useEffect, useRef, useState } from 'react';
import type { SceneCommand } from '@modelsense/shared';
import { approve, streamChat, AgentTimeoutError, StreamEndedError } from '../lib/agentClient';
import type { AgentEvent, ChatTurn } from '../lib/agentClient';

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

// Starter prompts. The model picker offers three very different models (a vehicle,
// a single-mesh helmet, a bare box), so these stay model-agnostic: no "wheels" or
// other part names that only exist on one of them. Each still exercises a distinct
// tool (find/highlight, stats, suggest_optimizations, gated export_report).
const EXAMPLES = [
  'Highlight the largest part of this model.',
  'How many triangles and materials does this model have?',
  'What would you optimize to make this model lighter?',
  'Export a report of this scene.',
];

// The hosted demo runs on a Render free instance that cold-starts (~30-60s) and can
// pause to restart under sustained load; map its transient failures to one calm note.
const COLD_START =
  'The server is waking up (free-tier cold start, up to ~60s). Please try again in a moment.';

function describeError(err: unknown): string {
  if (err instanceof AgentTimeoutError) return COLD_START;
  if (err instanceof StreamEndedError)
    return 'The agent stopped responding before finishing. Please try again.';
  const msg = err instanceof Error ? err.message : 'Request failed';
  if (/\b(429|500|502|503|504)\b/.test(msg)) return COLD_START;
  if (/fetch|network|load failed/i.test(msg)) return COLD_START;
  return msg;
}

// Forward a bounded window of prior turns so follow-ups ("focus on them") resolve,
// without growing the free-tier process memory unbounded.
const HISTORY_LIMIT = 12;

const shortTool = (name: string) => name.replace('mcp__modelsense__', '');

export function Chat({
  modelId,
  onScene,
  onBusyChange,
}: {
  modelId: string;
  onScene: (cmd: SceneCommand) => void;
  /** Notified whenever a turn starts/ends, so the shell can lock the model picker. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [warming, setWarming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest message / card in view as content streams in.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, tools, approval, trace, error]);

  // Surface turn-in-flight state so the shell can lock the model picker mid-turn.
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

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
    const history: ChatTurn[] = messages
      .slice(-HISTORY_LIMIT)
      .filter((m) => m.text.trim().length > 0)
      .map((m) => ({ role: m.role, text: m.text }));
    setMessages((p) => [...p, { role: 'user', text }, { role: 'assistant', text: '' }]);
    setInput('');
    setBusy(true);
    setWarming(false);
    const ac = new AbortController();
    abortRef.current = ac;
    // Flip to a "waking up" hint if the first byte is slow (a cold start).
    const warmTimer = setTimeout(() => setWarming(true), 3500);
    const stopWarming = () => {
      clearTimeout(warmTimer);
      setWarming(false);
    };
    try {
      await streamChat({ message: text, modelId, history }, (e) => {
        if (e.t === 'text' || e.t === 'tool' || e.t === 'scene' || e.t === 'approval') stopWarming();
        onEvent(e);
      }, ac.signal);
    } catch (err) {
      if (!ac.signal.aborted) {
        setError(describeError(err));
        // Drop the trailing empty assistant bubble so a failure never shows as a blank reply.
        setMessages((p) => {
          const last = p[p.length - 1];
          return last && last.role === 'assistant' && !last.text ? p.slice(0, -1) : p;
        });
      }
    } finally {
      stopWarming();
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const decide = async (approved: boolean) => {
    if (!approval || deciding) return;
    setDeciding(true);
    try {
      await approve(approval.id, approved);
      setApproval(null);
    } catch {
      setError('Could not send your decision. Please try again.');
    } finally {
      setDeciding(false);
    }
  };

  return (
    <section className="chat" data-testid="chat">
      <div className="messages" aria-live="polite">
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
            {m.text ||
              (busy && i === messages.length - 1 ? (
                warming ? (
                  <span className="muted">Waking the free-tier server (up to ~60s)…</span>
                ) : (
                  <span className="dots">…</span>
                )
              ) : (
                ''
              ))}
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
            {approval.input != null && (
              <pre className="approval-input">{JSON.stringify(approval.input, null, 2)}</pre>
            )}
            <div className="row">
              <button type="button" disabled={deciding} onClick={() => decide(true)}>
                Approve
              </button>
              <button type="button" className="ghost" disabled={deciding} onClick={() => decide(false)}>
                Reject
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="error" role="alert">
            Error: {error}
          </div>
        )}

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
        <div ref={endRef} />
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
          aria-label="Ask about the model"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? 'Working…' : 'Ask about the model'}
          disabled={busy}
        />
        {busy ? (
          <button type="button" className="ghost" onClick={stop}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </section>
  );
}
