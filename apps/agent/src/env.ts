import { fileURLToPath } from 'node:url';

// Load the root .env in local dev. In production the platform injects env.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // no .env file
}

export interface Env {
  port: number;
  anthropicApiKey: string;
  mcpServerUrl: string;
  mcpApiKey: string;
  model: string;
  maxTurns: number;
  webOrigin: string;
  langfusePublicKey: string;
  langfuseSecretKey: string;
  langfuseBaseUrl: string;
  langfuseProjectId: string;
}

const real = (v: string | undefined): string =>
  v && !v.startsWith('REPLACE_ME') ? v : '';

export function loadEnv(): Env {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const mcpServerUrl = process.env.MCP_SERVER_URL;
  const mcpApiKey = process.env.MCP_API_KEY;
  if (!anthropicApiKey || anthropicApiKey.startsWith('REPLACE_ME')) {
    throw new Error('ANTHROPIC_API_KEY is required (set it in .env).');
  }
  if (!mcpApiKey) throw new Error('MCP_API_KEY is required.');
  return {
    port: Number(process.env.AGENT_PORT ?? 8787),
    anthropicApiKey,
    // The combined prod entry overrides this to point at its own /mcp route.
    mcpServerUrl: mcpServerUrl ?? 'http://localhost:3000/mcp',
    mcpApiKey,
    model: process.env.AGENT_MODEL ?? 'claude-sonnet-5',
    maxTurns: Number(process.env.AGENT_MAX_TURNS ?? 12),
    webOrigin: (process.env.WEB_ORIGIN ?? '*').replace(/\/+$/, ''),
    langfusePublicKey: real(process.env.LANGFUSE_PUBLIC_KEY),
    langfuseSecretKey: real(process.env.LANGFUSE_SECRET_KEY),
    langfuseBaseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://us.cloud.langfuse.com',
    langfuseProjectId: process.env.LANGFUSE_PROJECT_ID ?? '',
  };
}
