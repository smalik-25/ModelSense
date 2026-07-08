import { createApp } from './http';
import { loadEnv } from './env';
import { logger } from './logger';

const env = loadEnv();
const app = createApp(env);

app.listen(env.port, '0.0.0.0', () => {
  logger.info({ port: env.port }, 'ModelSense MCP server listening');
});
