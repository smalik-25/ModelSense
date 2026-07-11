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
  'suggest_optimizations',
].map((t) => `mcp__${SERVER}__${t}`);
const GATED_TOOL = `mcp__${SERVER}__export_report`;

export type AgentEvent =
  | { t: 'text'; text: string }
  | {
      t: 'tool';
      phase: 'call' | 'result';
      name: string;
      /** tool_use id, so call and result frames can be paired (eval trajectory). */
      id?: string;
      ok?: boolean;
      /** Present on a 'call' frame: the arguments the model passed. */
      input?: unknown;
      /** Present on a 'result' frame: the tool's structuredContent (or error text). */
      output?: unknown;
    }
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

/** One prior turn of the conversation, forwarded so follow-up references resolve. */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

// Built-in Claude Code tools are already blocked by the canUseTool catch-all
// (only our MCP tools are allowlisted); disallow them explicitly too as
// defense-in-depth so they never enter the tool set in the first place.
const DISALLOWED_BUILTINS = [
  'Bash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'NotebookEdit',
  'Task',
  'TodoWrite',
];

/**
 * Fold prior turns into the single stateless prompt as context. The server holds
 * no session, so the browser forwards a bounded history; embedding it as a
 * transcript lets follow-ups like "now focus on them" resolve their referents.
 */
function buildPromptText(message: string, history?: ChatTurn[]): string {
  if (!history || history.length === 0) return message;
  const transcript = history
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`)
    .join('\n');
  return `Conversation so far (for context; do not re-answer these):\n${transcript}\n\nUser's new message:\n${message}`;
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

/**
 * Pull the tool's payload out of a tool_result for observability. Successful
 * tools mirror their structuredContent as a JSON text block; errors carry a
 * plain message. Returns the parsed JSON when possible, else `{ text }`.
 */
export function extractToolOutput(content: unknown): unknown {
  const texts: string[] = [];
  if (typeof content === 'string') texts.push(content);
  else if (Array.isArray(content)) {
    for (const c of content) {
      const block = c as Block;
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  if (texts.length === 0) return null;
  const joined = texts.join('\n');
  try {
    return JSON.parse(joined);
  } catch {
    return { text: joined };
  }
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
  /** Prior conversation turns, oldest first, for follow-up context. */
  history?: ChatTurn[];
  /** Ask the human to approve a gated tool. Resolves true to allow. */
  requestApproval?: (req: ApprovalRequest) => Promise<boolean>;
}

export async function runTurn(opts: RunTurnOptions): Promise<void> {
  const { message, modelId, env, emit, signal, history, requestApproval } = opts;
  const abort = new AbortController();
  signal.addEventListener('abort', () => abort.abort());
  const trace = startTurnTrace(env, message, modelId);
  let finalText = '';
  // Pair tool_result frames back to the tool that produced them (by tool_use id).
  const toolNames = new Map<string, string>();

  try {
    for await (const msg of query({
      prompt: singleUserMessage(buildPromptText(message, history)),
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
        disallowedTools: DISALLOWED_BUILTINS,
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
          // Anything reaching here is not allowlisted (e.g. built-in tools), so deny.
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
            toolNames.set(block.id, block.name);
            emit({ t: 'tool', phase: 'call', name: block.name, id: block.id, input: block.input });
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
              const id = block.tool_use_id;
              emit({
                t: 'tool',
                phase: 'result',
                name: (id && toolNames.get(id)) || 'result',
                id,
                ok: !block.is_error,
                output: extractToolOutput(block.content),
              });
              if (id) trace?.toolEnd(id, block.content, !!block.is_error);
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
