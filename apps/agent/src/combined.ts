import express from 'express';
import { createApp as createServerApp } from '@modelsense/server/app';
import { createAgentApp } from './http';
import { loadEnv } from './env';
import { initTracing } from './tracing';
import { logger } from './logger';

// One process, one public port (Render free tier forwards a single port). The
// MCP server routes (/mcp, /healthz) and the agent routes (/chat, /chat/approve)
// are mounted on the same Express app. The agent reaches the MCP server on
// localhost, so no public round-trip.
const base = loadEnv();
const port = Number(process.env.PORT ?? base.port);
const env = { ...base, port, mcpServerUrl: `http://localhost:${port}/mcp` };

initTracing(env);

const app = express();
app.use(createServerApp({ port, mcpApiKey: env.mcpApiKey, allowedOrigins: [] }));
app.use(createAgentApp(env));

app.listen(port, '0.0.0.0', () => {
  logger.info({ port, model: env.model }, 'ModelSense combined (MCP server + agent) listening');
});
