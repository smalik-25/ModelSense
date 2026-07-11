import express from 'express';
import type { Request, Response } from 'express';
import { runTurn } from './agent';
import type { AgentEvent, ApprovalRequest } from './agent';
import { logger } from './logger';
import type { Env } from './env';

interface Pending {
  resolve: (approved: boolean) => void;
}

// Pending human approvals, keyed by tool-use id. The SSE turn awaits a promise
// here; POST /chat/approve resolves it. Single-process, in-memory (fine for the demo).
const pendingApprovals = new Map<string, Pending>();

// An abandoned approval card must not wedge the turn (and leak an Agent-SDK
// subprocess + Anthropic stream) forever. Auto-deny after this long.
const APPROVAL_TIMEOUT_MS = 120_000;

/** Coerce the optional forwarded history into typed, bounded chat turns. */
function parseHistory(raw: unknown): { role: 'user' | 'assistant'; text: string }[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (h): h is { role: 'user' | 'assistant'; text: string } =>
        !!h &&
        typeof h === 'object' &&
        typeof (h as { text?: unknown }).text === 'string' &&
        ((h as { role?: unknown }).role === 'user' || (h as { role?: unknown }).role === 'assistant'),
    )
    .slice(-20)
    .map((h) => ({ role: h.role, text: h.text }));
}

export function createAgentApp(env: Env): express.Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.use((req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (env.webOrigin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && origin.replace(/\/+$/, '') === env.webOrigin) {
      // Echo the browser's exact Origin (tolerates a trailing slash in config).
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', env.webOrigin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  // Served when the agent runs standalone; in the combined deployment the MCP
  // server mounts its own /healthz first, which answers instead.
  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'modelsense-agent' });
  });

  // Resolves a pending human approval. Unauthenticated by design for the
  // single-user demo: the id is the tool_use id (an unguessable per-turn token),
  // and only a currently-pending id is accepted. A multi-user deployment would
  // bind this to the originating session (see docs/auth.md).
  app.post('/chat/approve', (req: Request, res: Response) => {
    const id = typeof req.body?.id === 'string' ? req.body.id : '';
    const approved = req.body?.approved === true;
    const pending = pendingApprovals.get(id);
    if (!pending) {
      res.status(404).json({ error: 'no pending approval for that id' });
      return;
    }
    pending.resolve(approved);
    pendingApprovals.delete(id);
    res.json({ ok: true });
  });

  app.post('/chat', async (req: Request, res: Response) => {
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId : 'DamagedHelmet';
    const history = parseHistory(req.body?.history);
    if (!message) {
      res.status(400).json({ error: 'message required' });
      return;
    }

    // SSE, hardened against proxy buffering (Render) with no-transform + flush + heartbeat.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: AgentEvent) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
    const ac = new AbortController();
    const localIds = new Set<string>();

    res.on('close', () => {
      ac.abort();
      clearInterval(heartbeat);
      for (const id of localIds) {
        const p = pendingApprovals.get(id);
        if (p) {
          p.resolve(false);
          pendingApprovals.delete(id);
        }
      }
    });

    const requestApproval = (reqA: ApprovalRequest): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        localIds.add(reqA.id);
        const timer = setTimeout(() => {
          if (pendingApprovals.delete(reqA.id)) {
            send({ t: 'text', text: '\n(Approval timed out; the action was not run.)' });
            resolve(false);
          }
        }, APPROVAL_TIMEOUT_MS);
        pendingApprovals.set(reqA.id, {
          resolve: (approved) => {
            clearTimeout(timer);
            resolve(approved);
          },
        });
        send({ t: 'approval', id: reqA.id, tool: reqA.tool, input: reqA.input });
      });

    try {
      await runTurn({ message, modelId, env, history, emit: send, signal: ac.signal, requestApproval });
    } catch (err) {
      logger.error({ err }, '/chat turn failed');
      send({ t: 'error', message: 'Agent error' });
    } finally {
      clearInterval(heartbeat);
      // The client may already be gone (res.on('close') fired); do not write a
      // trailing frame to a closed socket.
      if (!res.writableEnded) {
        res.write('event: end\ndata: {}\n\n');
        res.end();
      }
    }
  });

  return app;
}
