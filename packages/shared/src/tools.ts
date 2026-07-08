import { z } from 'zod';
import { CameraFocusCommand, HighlightCommand, MeasurementCommand } from './structured-content';

/**
 * Zod schemas for every MCP tool's input and output. The server registers tools
 * with these (inputs as raw Zod shapes, outputs as full object schemas); the
 * agent and web import the inferred types. This module is the single source of
 * truth for the tool contract.
 *
 * Output schemas deliberately use plain primitives (string/number/array/object/
 * enum) so the SDK's JSON Schema derivation stays boring and portable.
 */

export const ModelCategory = z.enum(['hero', 'vehicle', 'scene']);
export type ModelCategory = z.infer<typeof ModelCategory>;

export const CatalogEntry = z.object({
  model_id: z.string(),
  name: z.string(),
  description: z.string(),
  category: ModelCategory,
  source: z.enum(['local', 'url']),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

// --- list_models -----------------------------------------------------------
export const listModelsInput = {} as const;
export const listModelsOutput = z.object({
  models: z.array(CatalogEntry),
});
export type ListModelsOutput = z.infer<typeof listModelsOutput>;

// --- load_model ------------------------------------------------------------
export const loadModelInput = {
  model_id: z.string().optional().describe('Catalog model id from list_models.'),
  url: z.string().url().optional().describe('Allowlisted Khronos sample model URL (.glb).'),
};
export const loadModelOutput = z.object({
  session_id: z.string().describe('Pass this to every later tool call.'),
  model_id: z.string(),
  name: z.string(),
  counts: z.object({
    nodes: z.number().int(),
    meshes: z.number().int(),
    materials: z.number().int(),
    textures: z.number().int(),
    animations: z.number().int(),
  }),
  totals: z.object({
    vertices: z.number().int(),
    triangles: z.number().int(),
  }),
  extensionsUsed: z.array(z.string()),
  fileSizeBytes: z.number().int(),
});
export type LoadModelOutput = z.infer<typeof loadModelOutput>;

// --- get_scene_stats -------------------------------------------------------
export const getSceneStatsInput = {
  session_id: z.string(),
  node_id: z.string().optional().describe('Restrict stats to this node.'),
};
export const MeshStat = z.object({
  id: z.string(),
  name: z.string(),
  vertices: z.number().int(),
  triangles: z.number().int(),
  sizeBytes: z.number().int(),
  instances: z.number().int(),
});
export type MeshStat = z.infer<typeof MeshStat>;
export const TextureStat = z.object({
  name: z.string(),
  resolution: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  gpuSizeBytes: z.number().int().nullable(),
});
export type TextureStat = z.infer<typeof TextureStat>;
export const getSceneStatsOutput = z.object({
  scope: z.string().describe('"scene" or the node id the stats are restricted to.'),
  totals: z.object({
    vertices: z.number().int(),
    triangles: z.number().int(),
    drawCallEstimate: z.number().int(),
    materials: z.number().int(),
    textures: z.number().int(),
  }),
  meshes: z.array(MeshStat),
  textures: z.array(TextureStat),
});
export type GetSceneStatsOutput = z.infer<typeof getSceneStatsOutput>;

// --- find_elements ---------------------------------------------------------
export const findElementsInput = {
  session_id: z.string(),
  query: z.string().describe('Case-insensitive substring matched against node names.'),
  limit: z.number().int().positive().max(200).default(25),
};
export const ElementMatch = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(['mesh', 'empty']),
  triangles: z.number().int(),
  vertices: z.number().int(),
  bboxMin: z.array(z.number()).length(3),
  bboxMax: z.array(z.number()).length(3),
});
export type ElementMatch = z.infer<typeof ElementMatch>;
export const findElementsOutput = z.object({
  total: z.number().int().describe('Total matches before the limit was applied.'),
  elements: z.array(ElementMatch),
});
export type FindElementsOutput = z.infer<typeof findElementsOutput>;

// --- highlight_elements ----------------------------------------------------
export const highlightElementsInput = {
  session_id: z.string(),
  node_ids: z.array(z.string()).min(1),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'hex color like #ffcc00')
    .optional(),
  exclusive: z.boolean().optional().describe('Clear existing highlights first.'),
};
// The output IS the scene command the viewer applies.
export const highlightElementsOutput = HighlightCommand;
export type HighlightElementsOutput = z.infer<typeof HighlightCommand>;

// --- camera_focus ----------------------------------------------------------
export const cameraFocusInput = {
  session_id: z.string(),
  node_id: z.string().describe('Node id to frame the camera on.'),
};
export const cameraFocusOutput = CameraFocusCommand;
export type CameraFocusOutput = z.infer<typeof CameraFocusCommand>;

// --- measure ---------------------------------------------------------------
export const measureInput = {
  session_id: z.string(),
  node_id: z.string().optional().describe('Measure this node bounding box.'),
  node_a: z.string().optional().describe('First node id for a distance measurement.'),
  node_b: z.string().optional().describe('Second node id for a distance measurement.'),
};
export const measureOutput = MeasurementCommand;
export type MeasureOutput = z.infer<typeof MeasurementCommand>;

// --- export_report (gated at the agent layer via canUseTool) ---------------
export const exportReportInput = {
  session_id: z.string(),
  format: z.literal('markdown').default('markdown'),
};
export const exportReportOutput = z.object({
  format: z.literal('markdown'),
  markdown: z.string(),
  generatedAt: z.string(),
});
export type ExportReportOutput = z.infer<typeof exportReportOutput>;
