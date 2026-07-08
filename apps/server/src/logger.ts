import pino from 'pino';

/** Structured logger. Pretty output is left to the environment (e.g. `pino-pretty` in dev). */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'modelsense-server' },
});
