import { createAgentApp } from './http';
import { loadEnv } from './env';
import { initTracing } from './tracing';
import { logger } from './logger';

const env = loadEnv();
initTracing(env);
createAgentApp(env).listen(env.port, '0.0.0.0', () => {
  logger.info({ port: env.port, model: env.model }, 'ModelSense agent listening');
});
