import { NodeSDK } from '@opentelemetry/sdk-node';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { startObservation } from '@langfuse/tracing';
import { logger } from './logger';
import type { Env } from './env';

let processor: LangfuseSpanProcessor | null = null;

/** Register the Langfuse OTEL span processor. No-op if keys are absent. */
export function initTracing(env: Env): boolean {
  if (!env.langfusePublicKey || !env.langfuseSecretKey) {
    logger.info('Langfuse keys not set; tracing disabled');
    return false;
  }
  try {
    processor = new LangfuseSpanProcessor({
      publicKey: env.langfusePublicKey,
      secretKey: env.langfuseSecretKey,
      baseUrl: env.langfuseBaseUrl,
    });
    new NodeSDK({ spanProcessors: [processor] }).start();
    logger.info('Langfuse tracing enabled');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Langfuse init failed; continuing without traces');
    return false;
  }
}

export async function flushTraces(): Promise<void> {
  try {
    await processor?.forceFlush();
  } catch {
    // best effort
  }
}

// Structural view of the span methods we use. The concrete runtime objects
// (LangfuseAgent / LangfuseTool) have these; the exported union is broader.
interface LfSpan {
  traceId: string;
  update(attributes: Record<string, unknown>): unknown;
  end(): unknown;
  startObservation(
    name: string,
    attributes?: Record<string, unknown>,
    options?: { asType?: string },
  ): LfSpan;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

export interface TurnTrace {
  toolStart(id: string, name: string, input: unknown): void;
  toolEnd(id: string, output: unknown, isError: boolean): void;
  finish(output: string, usage: TurnUsage): string | undefined;
}

const short = (name: string) => name.replace('mcp__modelsense__', '');

/** Start a Langfuse trace for one chat turn, with a child span per tool call. */
export function startTurnTrace(env: Env, message: string, modelId: string): TurnTrace | null {
  if (!processor) return null;
  const root = startObservation(
    'modelsense-turn',
    { input: { message, modelId }, metadata: { modelId } },
    { asType: 'agent' },
  ) as unknown as LfSpan;
  const traceId = root.traceId;
  const spans = new Map<string, LfSpan>();

  return {
    toolStart(id, name, input) {
      spans.set(id, root.startObservation(short(name), { input }, { asType: 'tool' }));
    },
    toolEnd(id, output, isError) {
      const span = spans.get(id);
      if (!span) return;
      span.update({ output, level: isError ? 'ERROR' : 'DEFAULT' });
      span.end();
      spans.delete(id);
    },
    finish(output, usage) {
      root.update({
        output,
        // First-class usage/cost so Langfuse aggregates tokens and spend, not just
        // free-form metadata.
        usageDetails: {
          input: usage.inputTokens,
          output: usage.outputTokens,
          total: usage.inputTokens + usage.outputTokens,
        },
        costDetails: { total: usage.costUsd },
        metadata: { modelId, turns: usage.turns },
      });
      root.end();
      // Only hand a visitor a deep link if the project shares traces publicly;
      // otherwise the link lands on a login wall.
      return env.langfuseProjectId && env.langfusePublicTraces
        ? `${env.langfuseBaseUrl}/project/${env.langfuseProjectId}/traces/${traceId}`
        : undefined;
    },
  };
}
