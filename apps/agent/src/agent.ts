import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { SceneCommand } from '@modelsense/shared';
import type { SceneCommand as SceneCommandType } from '@modelsense/shared';
import { buildSystemPrompt } from './system-prompt';
import { startTurnTrace, flushTraces } from './tracing';
import { logger } from './logger';
import type { Env } from './env';

const SERVER = 'modelsense';
const SAFE_TOOLS = [
  'list_models',
  'load_model',
  'get_scene_stats',
  'find_elements',
  'highlight_elements',
  'camera_focus',
  'measure',
].map((t) => `mcp__${SERVER}__${t}`);
const GATED_TOOL = `mcp__${SERVER}__export_report`;

export type AgentEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; phase: 'call' | 'result'; name: string; ok?: boolean }
  | { t: 'scene'; command: SceneCommandType }
  | { t: 'approval'; id: string; tool: string; input: unknown }
  | { t: 'error'; message: string }
  | {
      t: 'done';
      turns: number;
      costUsd: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      traceUrl?: string;
    };

export interface ApprovalRequest {
  id: string;
  tool: string;
  input: unknown;
}

/** Minimal view of the Anthropic content blocks we care about. */
interface Block {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/**
 * Our tools mirror their structuredContent as JSON in the tool_result text.
 * Parse it back and keep it only if it is a viewer SceneCommand.
 */
export function extractScene(content: unknown): SceneCommandType | null {
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      const block = c as Block;
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  for (const text of texts) {
    try {
      const parsed = SceneCommand.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // not JSON; ignore
    }
  }
  return null;
}

async function* singleUserMessage(text: string): AsyncGenerator<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}

export interface RunTurnOptions {
  message: string;
  modelId: string;
  env: Env;
  emit: (event: AgentEvent) => void;
  signal: AbortSignal;
  /** Ask the human to approve a gated tool. Resolves true to allow. */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
}

export async function runTurn(opts: RunTurnOptions): Promise<void> {
  const { message, modelId, env, emit, signal, requestApproval } = opts;
  const abort = new AbortController();
  signal.addEventListener('abort', () => abort.abort());
  const trace = startTurnTrace(env, message, modelId);
  let finalText = '';

  try {
    for await (const msg of query({
      prompt: singleUserMessage(message),
      options: {
        model: env.model,
        systemPrompt: buildSystemPrompt(modelId),
        mcpServers: {
          [SERVER]: {
            type: 'http' as const,
            url: env.mcpServerUrl,
            headers: { Authorization: `Bearer ${env.mcpApiKey}` },
            // Put our tools directly in the prompt instead of deferring them
            // behind the built-in ToolSearch. Removes the multi-call search
            // preamble, cutting turns, latency, and cost substantially.
            alwaysLoad: true,
          },
        },
        allowedTools: SAFE_TOOLS,
        maxTurns: env.maxTurns,
        permissionMode: 'default',
        abortController: abort,
        canUseTool: async (toolName, input, ctx) => {
          if (toolName === GATED_TOOL) {
            if (!requestApproval) {
              return { behavior: 'deny', message: 'This action needs approval, which is unavailable.' };
            }
            const approved = await requestApproval({ id: ctx.toolUseID, tool: toolName, input });
            return approved
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: 'The user declined this action.' };
          }
          // Anything reaching here is not allowlisted (e.g. built-in tools) — deny.
          return { behavior: 'deny', message: `Tool ${toolName} is not permitted.` };
        },
      },
    })) {
      if (msg.type === 'assistant') {
        const blocks = msg.message.content as unknown as Block[];
        for (const block of blocks) {
          if (block.type === 'text' && block.text) {
            finalText += block.text;
            emit({ t: 'text', text: block.text });
          } else if (block.type === 'tool_use' && block.name && block.id) {
            emit({ t: 'tool', phase: 'call', name: block.name });
            trace?.toolStart(block.id, block.name, block.input);
          }
        }
      } else if (msg.type === 'user') {
        const content = (msg.message as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const raw of content) {
            const block = raw as Block;
            if (block.type === 'tool_result') {
              const scene = extractScene(block.content);
              if (scene) emit({ t: 'scene', command: scene });
              emit({ t: 'tool', phase: 'result', name: 'result', ok: !block.is_error });
              if (block.tool_use_id) trace?.toolEnd(block.tool_use_id, block.content, !!block.is_error);
            }
          }
        }
      } else if (msg.type === 'result') {
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined;
        const inputTokens = usage?.input_tokens ?? 0;
        const outputTokens = usage?.output_tokens ?? 0;
        const traceUrl = trace?.finish(finalText, {
          inputTokens,
          outputTokens,
          costUsd: msg.total_cost_usd,
          turns: msg.num_turns,
        });
        emit({
          t: 'done',
          turns: msg.num_turns,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          inputTokens,
          outputTokens,
          traceUrl,
        });
      }
    }
  } catch (err) {
    logger.error({ err }, 'agent turn failed');
    emit({ t: 'error', message: err instanceof Error ? err.message : 'Agent error' });
  } finally {
    await flushTraces();
  }
}
