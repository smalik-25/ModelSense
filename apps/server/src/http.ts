import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-server';
import { logger } from './logger';
import type { Env } from './env';

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  error: { code, message },
  id: null,
});

/** Length-checked, timing-safe string comparison for the shared bearer token. */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function createApp(env: Env): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // The Origin allowlist is DNS-rebinding protection for browser callers. /mcp is
  // additionally bearer-gated and reached server-to-server (no Origin), so an empty
  // allowlist is not a hole, but surface it so a config regression is not silent.
  if (env.allowedOrigins.length === 0) {
    logger.warn('MCP Origin allowlist is empty; relying on bearer auth alone for /mcp.');
  }

  app.get('/healthz', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'modelsense-server' });
  });

  // Origin allowlist (spec 2025-11-25 requires HTTP 403 for an invalid Origin).
  // Server-to-server callers (the agent, MCP Inspector) send no Origin header
  // and are allowed through.
  app.use('/mcp', (req: Request, res: Response, next) => {
    const origin = req.headers.origin;
    if (origin && env.allowedOrigins.length > 0 && !env.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next();
  });

  // Shared bearer auth (timing-safe compare).
  const expectedAuth = `Bearer ${env.mcpApiKey}`;
  app.use('/mcp', (req: Request, res: Response, next) => {
    if (!safeEqual(req.headers.authorization ?? '', expectedAuth)) {
      res.status(401).json(jsonRpcError(-32001, 'Unauthorized'));
      return;
    }
    next();
  });

  // Stateless Streamable HTTP: a fresh server + transport per POST, cleaned up
  // on response close. GET/DELETE are not supported in stateless mode.
  app.post('/mcp', async (req: Request, res: Response) => {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error({ err }, 'MCP request failed');
      if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, 'Internal error'));
    }
  });

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json(jsonRpcError(-32000, 'Method not allowed.'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
