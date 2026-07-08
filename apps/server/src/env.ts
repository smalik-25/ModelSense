import { fileURLToPath } from 'node:url';

// In local dev, load the root .env. In production (Render) the platform injects
// real env vars and no file exists, so the failure is expected and ignored.
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // No .env file; rely on process.env (production) or shell exports (tests).
}

export interface Env {
  port: number;
  mcpApiKey: string;
  allowedOrigins: string[];
}

export function loadEnv(): Env {
  const mcpApiKey = process.env.MCP_API_KEY;
  if (!mcpApiKey) {
    throw new Error('MCP_API_KEY is required (shared bearer secret for the MCP server).');
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    mcpApiKey,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
