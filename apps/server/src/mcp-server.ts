import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as schema from '@modelsense/shared';
import { availableModels, isAllowedModelUrl, resolveModel } from './catalog';
import * as domain from './gltf';
import { getSession, putSession } from './session-store';
import { fail, ok, ToolError } from './tool-result';
import { logger } from './logger';

function toFail(err: unknown, tool: string): CallToolResult {
  if (err instanceof ToolError) return fail(err.message);
  logger.error({ err, tool }, 'tool handler failed');
  return fail(`Internal error in ${tool}.`);
}

/**
 * Build a fresh MCP server with all tools registered. In stateless Streamable
 * HTTP one of these is created per request; loaded-model state is shared out of
 * band via the session store (keyed by the server-minted session_id).
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'modelsense', version: '0.1.0' });

  server.registerTool(
    'list_models',
    {
      title: 'List models',
      description: 'List the sample 3D models available to load.',
      inputSchema: schema.listModelsInput,
      outputSchema: schema.listModelsOutput,
    },
    () => ok({ models: availableModels() }),
  );

  server.registerTool(
    'load_model',
    {
      title: 'Load model',
      description:
        'Load a glTF/GLB model by catalog model_id or an allowlisted Khronos .glb URL. Returns a session_id (pass it to every later call) plus a scene summary.',
      inputSchema: schema.loadModelInput,
      outputSchema: schema.loadModelOutput,
    },
    async ({ model_id, url }) => {
      try {
        if ((!model_id && !url) || (model_id && url)) {
          return fail('Provide exactly one of model_id or url.');
        }
        let doc, bytes: number, id: string, name: string;
        if (model_id) {
          const entry = resolveModel(model_id);
          if (!entry) return fail(`Unknown model_id "${model_id}". Use list_models.`);
          ({ doc, bytes } = await domain.loadLocal(entry.location));
          id = entry.model_id;
          name = entry.name;
        } else {
          if (!isAllowedModelUrl(url!)) {
            return fail('URL not allowed. Only Khronos glTF-Sample-Assets .glb URLs are permitted.');
          }
          ({ doc, bytes } = await domain.loadUrl(url!));
          id = url!;
          name = url!.split('/').pop() ?? 'model';
        }
        const summary = domain.summarize(doc);
        const session_id = randomUUID();
        putSession(session_id, { doc, model_id: id, name, loadedAt: Date.now() });
        return ok({ session_id, model_id: id, name, ...summary, fileSizeBytes: bytes });
      } catch (err) {
        return toFail(err, 'load_model');
      }
    },
  );

  server.registerTool(
    'get_scene_stats',
    {
      title: 'Get scene stats',
      description:
        'Vertices, triangles, materials, textures, and a draw-call estimate for the whole scene, or a single node subtree when node_id is given.',
      inputSchema: schema.getSceneStatsInput,
      outputSchema: schema.getSceneStatsOutput,
    },
    ({ session_id, node_id }) => {
      try {
        const { doc } = getSession(session_id);
        return ok(domain.sceneStats(doc, node_id));
      } catch (err) {
        return toFail(err, 'get_scene_stats');
      }
    },
  );

  server.registerTool(
    'find_elements',
    {
      title: 'Find elements',
      description:
        'Find nodes whose name contains the query (case-insensitive). Results are sorted by triangle count descending, so the largest match is first.',
      inputSchema: schema.findElementsInput,
      outputSchema: schema.findElementsOutput,
    },
    ({ session_id, query, limit }) => {
      try {
        const { doc } = getSession(session_id);
        return ok(domain.findElements(doc, query, limit));
      } catch (err) {
        return toFail(err, 'find_elements');
      }
    },
  );

  server.registerTool(
    'highlight_elements',
    {
      title: 'Highlight elements',
      description:
        'Return a highlight command for the viewer. Provide node ids from find_elements. The viewer applies an emissive color swap.',
      inputSchema: schema.highlightElementsInput,
      outputSchema: schema.highlightElementsOutput,
    },
    ({ session_id, node_ids, color, exclusive }) => {
      try {
        const { doc } = getSession(session_id);
        return ok(domain.buildHighlight(doc, node_ids, color, exclusive));
      } catch (err) {
        return toFail(err, 'highlight_elements');
      }
    },
  );

  server.registerTool(
    'camera_focus',
    {
      title: 'Camera focus',
      description: 'Return a camera command that frames the given node. The viewer tweens to it.',
      inputSchema: schema.cameraFocusInput,
      outputSchema: schema.cameraFocusOutput,
    },
    ({ session_id, node_id }) => {
      try {
        const { doc } = getSession(session_id);
        return ok(domain.cameraFocus(doc, node_id));
      } catch (err) {
        return toFail(err, 'camera_focus');
      }
    },
  );

  server.registerTool(
    'measure',
    {
      title: 'Measure',
      description:
        'Measure a node bounding box (node_id) or the distance between two nodes (node_a and node_b). Values are in glTF scene units.',
      inputSchema: schema.measureInput,
      outputSchema: schema.measureOutput,
    },
    ({ session_id, node_id, node_a, node_b }) => {
      try {
        const { doc } = getSession(session_id);
        return ok(domain.measure(doc, { node_id, node_a, node_b }));
      } catch (err) {
        return toFail(err, 'measure');
      }
    },
  );

  server.registerTool(
    'suggest_optimizations',
    {
      title: 'Suggest optimizations',
      description:
        'Rank deterministic optimization findings for the loaded scene: oversized textures, dense meshes, missing Draco/KTX2 compression, and duplicate materials. Optional budget_triangles and budget_texture_mb sharpen the findings. The agent narrates; the numbers are computed.',
      inputSchema: schema.suggestOptimizationsInput,
      outputSchema: schema.suggestOptimizationsOutput,
    },
    ({ session_id, budget_triangles, budget_texture_mb }) => {
      try {
        const { doc } = getSession(session_id);
        return ok(domain.suggestOptimizations(doc, budget_triangles, budget_texture_mb));
      } catch (err) {
        return toFail(err, 'suggest_optimizations');
      }
    },
  );

  server.registerTool(
    'export_report',
    {
      title: 'Export report',
      description:
        'Generate a Markdown report of the scene (summary, heaviest meshes, textures). Gated: the agent must get human approval before calling it.',
      inputSchema: schema.exportReportInput,
      outputSchema: schema.exportReportOutput,
      annotations: { readOnlyHint: false },
    },
    ({ session_id }) => {
      try {
        const { doc, name } = getSession(session_id);
        return ok(domain.exportReport(doc, name, new Date().toISOString()));
      } catch (err) {
        return toFail(err, 'export_report');
      }
    },
  );

  return server;
}
