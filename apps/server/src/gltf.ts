import { stat } from 'node:fs/promises';
import { NodeIO, getBounds } from '@gltf-transform/core';
import type { Document, Node as GNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { inspect } from '@gltf-transform/functions';
import { CameraFocusCommand, HighlightCommand, MeasurementCommand } from '@modelsense/shared';
import type {
  CameraFocusOutput,
  ExportReportOutput,
  FindElementsOutput,
  GetSceneStatsOutput,
  HighlightElementsOutput,
  MeasureOutput,
  OptimizationFinding,
  SuggestOptimizationsOutput,
} from '@modelsense/shared';
import { ToolError } from './tool-result';

/** glTF primitive mode for triangles (GLTF.MeshPrimitive.mode). */
const TRIANGLES = 4;

function createIO(): NodeIO {
  // Register all standard extensions so extension names are reported. Draco/KTX2
  // *decoding* additionally needs decoder dependencies; Phase 1 sample models are
  // uncompressed, so reads succeed without them. A compressed model would throw,
  // which load_model surfaces as a structured error.
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

function toFiniteVec(v: readonly number[]): number[] {
  return [0, 1, 2].map((i) => {
    const n = v[i] ?? 0;
    return Number.isFinite(n) ? n : 0;
  });
}

// --- loading ---------------------------------------------------------------

export async function loadLocal(path: string): Promise<{ doc: Document; bytes: number }> {
  const io = createIO();
  const [doc, info] = await Promise.all([io.read(path), stat(path)]);
  return { doc, bytes: info.size };
}

export async function loadUrl(url: string): Promise<{ doc: Document; bytes: number }> {
  const res = await fetch(url);
  if (!res.ok) throw new ToolError(`Fetch failed (${res.status}) for ${url}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const doc = await createIO().readBinary(buf);
  return { doc, bytes: buf.byteLength };
}

// --- node identity ---------------------------------------------------------

/** Stable per-node id: the node name if present, else `node-<index>`. */
function nodeId(node: GNode, index: number): string {
  return node.getName() || `node-${index}`;
}

function findNodeById(doc: Document, id: string): GNode | undefined {
  const nodes = doc.getRoot().listNodes();
  return nodes.find((n, i) => nodeId(n, i) === id);
}

function nodeGeometry(node: GNode): { vertices: number; triangles: number } {
  const mesh = node.getMesh();
  let vertices = 0;
  let triangles = 0;
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (pos) vertices += pos.getCount();
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : (pos?.getCount() ?? 0);
      if (prim.getMode() === TRIANGLES) triangles += Math.floor(count / 3);
    }
  }
  return { vertices, triangles };
}

// --- tool domain logic -----------------------------------------------------

export function summarize(doc: Document): {
  counts: { nodes: number; meshes: number; materials: number; textures: number; animations: number };
  totals: { vertices: number; triangles: number };
  extensionsUsed: string[];
} {
  const root = doc.getRoot();
  const report = inspect(doc);
  const totals = report.meshes.properties.reduce(
    (acc, m) => ({ vertices: acc.vertices + m.vertices, triangles: acc.triangles + m.glPrimitives }),
    { vertices: 0, triangles: 0 },
  );
  return {
    counts: {
      nodes: root.listNodes().length,
      meshes: root.listMeshes().length,
      materials: root.listMaterials().length,
      textures: root.listTextures().length,
      animations: root.listAnimations().length,
    },
    totals,
    extensionsUsed: root.listExtensionsUsed().map((e) => e.extensionName),
  };
}

export function sceneStats(doc: Document, nodeId?: string): GetSceneStatsOutput {
  const report = inspect(doc);
  const meshes = doc.getRoot().listMeshes();

  const meshStats = report.meshes.properties.map((m, i) => ({
    id: `mesh-${i}`,
    name: m.name,
    vertices: m.vertices,
    triangles: m.glPrimitives,
    sizeBytes: m.size,
    instances: m.instances,
  }));
  const textureStats = report.textures.properties.map((t) => ({
    name: t.name,
    resolution: t.resolution,
    mimeType: t.mimeType,
    sizeBytes: t.size,
    gpuSizeBytes: t.gpuSize,
  }));

  if (nodeId) {
    const node = findNodeById(doc, nodeId);
    if (!node) throw new ToolError(`Unknown node_id "${nodeId}".`);
    const mesh = node.getMesh();
    const idx = mesh ? meshes.indexOf(mesh) : -1;
    const row = idx >= 0 ? meshStats[idx] : undefined;
    const only = row ? [row] : [];
    return {
      scope: nodeId,
      totals: {
        vertices: only.reduce((a, m) => a + m.vertices, 0),
        triangles: only.reduce((a, m) => a + m.triangles, 0),
        drawCallEstimate: idx >= 0 ? (report.meshes.properties[idx]?.meshPrimitives ?? 0) : 0,
        materials: mesh ? mesh.listPrimitives().filter((p) => p.getMaterial()).length : 0,
        textures: 0,
      },
      meshes: only,
      textures: [],
    };
  }

  return {
    scope: 'scene',
    totals: {
      vertices: meshStats.reduce((a, m) => a + m.vertices, 0),
      triangles: meshStats.reduce((a, m) => a + m.triangles, 0),
      drawCallEstimate: report.meshes.properties.reduce((a, m) => a + m.meshPrimitives, 0),
      materials: report.materials.properties.length,
      textures: report.textures.properties.length,
    },
    meshes: meshStats,
    textures: textureStats,
  };
}

export function findElements(doc: Document, query: string, limit: number): FindElementsOutput {
  const needle = query.toLowerCase();
  const matches = doc
    .getRoot()
    .listNodes()
    .map((node, i) => ({ node, id: nodeId(node, i) }))
    .filter(({ id }) => id.toLowerCase().includes(needle))
    .map(({ node, id }) => {
      const { vertices, triangles } = nodeGeometry(node);
      const bounds = getBounds(node);
      return {
        id,
        name: node.getName(),
        type: node.getMesh() ? ('mesh' as const) : ('empty' as const),
        triangles,
        vertices,
        bboxMin: toFiniteVec(bounds.min),
        bboxMax: toFiniteVec(bounds.max),
      };
    });

  // Sort by triangle count desc so "the largest" is first for the agent.
  matches.sort((a, b) => b.triangles - a.triangles);
  return { total: matches.length, elements: matches.slice(0, limit) };
}

export function buildHighlight(
  doc: Document,
  nodeIds: string[],
  color?: string,
  exclusive?: boolean,
): HighlightElementsOutput {
  const known = new Set(doc.getRoot().listNodes().map((n, i) => nodeId(n, i)));
  const missing = nodeIds.filter((id) => !known.has(id));
  if (missing.length === nodeIds.length) {
    throw new ToolError(
      `None of the requested node ids exist: ${nodeIds.join(', ')}. Use find_elements to get valid ids.`,
    );
  }
  return HighlightCommand.parse({ type: 'highlight', nodeIds, color, exclusive });
}

// --- vector helpers --------------------------------------------------------

const at = (v: readonly number[], i: number): number => v[i] ?? 0;
const sub = (a: readonly number[], b: readonly number[]): number[] => [
  at(a, 0) - at(b, 0),
  at(a, 1) - at(b, 1),
  at(a, 2) - at(b, 2),
];
const mid = (a: readonly number[], b: readonly number[]): number[] => [
  (at(a, 0) + at(b, 0)) / 2,
  (at(a, 1) + at(b, 1)) / 2,
  (at(a, 2) + at(b, 2)) / 2,
];
const vlen = (v: readonly number[]): number => Math.hypot(at(v, 0), at(v, 1), at(v, 2));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

function nodeCenter(node: GNode): number[] {
  const b = getBounds(node);
  return mid(toFiniteVec(b.min), toFiniteVec(b.max));
}

// --- camera_focus / measure / export_report --------------------------------

export function cameraFocus(doc: Document, nodeId: string): CameraFocusOutput {
  const node = findNodeById(doc, nodeId);
  if (!node) throw new ToolError(`Unknown node_id "${nodeId}".`);
  const b = getBounds(node);
  const min = toFiniteVec(b.min);
  const max = toFiniteVec(b.max);
  return CameraFocusCommand.parse({
    type: 'camera_focus',
    nodeId,
    center: mid(min, max),
    radius: Math.max(vlen(sub(max, min)) / 2, 0.001),
  });
}

export function measure(
  doc: Document,
  args: { node_id?: string; node_a?: string; node_b?: string },
): MeasureOutput {
  const { node_id, node_a, node_b } = args;

  if (node_id) {
    const node = findNodeById(doc, node_id);
    if (!node) throw new ToolError(`Unknown node_id "${node_id}".`);
    const b = getBounds(node);
    const min = toFiniteVec(b.min);
    const max = toFiniteVec(b.max);
    const dims = sub(max, min).map(round3);
    const diagonal = round3(vlen(sub(max, min)));
    return MeasurementCommand.parse({
      type: 'measurement',
      label: `bbox ${dims[0]} x ${dims[1]} x ${dims[2]} (diagonal ${diagonal}) scene units`,
      points: [min, max],
      value: diagonal,
      unit: 'scene-units',
    });
  }

  if (node_a && node_b) {
    const na = findNodeById(doc, node_a);
    if (!na) throw new ToolError(`Unknown node_a "${node_a}".`);
    const nb = findNodeById(doc, node_b);
    if (!nb) throw new ToolError(`Unknown node_b "${node_b}".`);
    const ca = nodeCenter(na);
    const cb = nodeCenter(nb);
    const dist = round3(vlen(sub(cb, ca)));
    return MeasurementCommand.parse({
      type: 'measurement',
      label: `distance ${node_a} to ${node_b} = ${dist} scene units`,
      points: [ca, cb],
      value: dist,
      unit: 'scene-units',
    });
  }

  throw new ToolError('Provide node_id (bounding box) or both node_a and node_b (distance).');
}

// --- suggest_optimizations -------------------------------------------------

const GEOMETRY_COMPRESSION = ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'];
const TEXTURE_COMPRESSION = 'KHR_texture_basisu';
const SEVERITY_ORDER: Record<OptimizationFinding['severity'], number> = { high: 0, medium: 1, low: 2 };

/** Longer edge of a "WxH" resolution string, 0 if unparseable. */
function maxTextureDim(resolution: string): number {
  return resolution
    .split('x')
    .map((n) => Number.parseInt(n, 10))
    .reduce((max, n) => (Number.isFinite(n) ? Math.max(max, n) : max), 0);
}

/** Name-independent signature of a material, so renamed-but-identical materials group. */
function materialSignature(mat: import('@gltf-transform/core').Material): string {
  const tex = (t: { getName(): string } | null): string | null => (t ? t.getName() || 'unnamed' : null);
  const round = (v: readonly number[]): number[] => v.map((n) => Math.round(n * 1000) / 1000);
  return JSON.stringify({
    base: round(mat.getBaseColorFactor()),
    metallic: Math.round(mat.getMetallicFactor() * 1000) / 1000,
    roughness: Math.round(mat.getRoughnessFactor() * 1000) / 1000,
    emissive: round(mat.getEmissiveFactor()),
    alphaMode: mat.getAlphaMode(),
    doubleSided: mat.getDoubleSided(),
    baseTex: tex(mat.getBaseColorTexture()),
    mrTex: tex(mat.getMetallicRoughnessTexture()),
    normalTex: tex(mat.getNormalTexture()),
    emissiveTex: tex(mat.getEmissiveTexture()),
    occlusionTex: tex(mat.getOcclusionTexture()),
  });
}

/**
 * Deterministic optimization heuristics: oversized textures, dense meshes,
 * missing Draco/KTX2 compression, and duplicate materials. The agent narrates;
 * the numbers here are computed, not guessed. Findings are sorted worst-first.
 */
export function suggestOptimizations(
  doc: Document,
  budgetTriangles?: number,
  budgetTextureMb?: number,
): SuggestOptimizationsOutput {
  const report = inspect(doc);
  const root = doc.getRoot();
  const extensions = new Set(root.listExtensionsUsed().map((e) => e.extensionName));
  const findings: OptimizationFinding[] = [];

  const totalTriangles = report.meshes.properties.reduce((a, m) => a + m.glPrimitives, 0);
  const textureGpuBytes = report.textures.properties.reduce((a, t) => a + (t.gpuSize ?? t.size), 0);
  const budgetTextureBytes = budgetTextureMb != null ? budgetTextureMb * 1_000_000 : null;
  const overTriangles = budgetTriangles != null && totalTriangles > budgetTriangles;
  const overTexture = budgetTextureBytes != null && textureGpuBytes > budgetTextureBytes;

  // Oversized textures (>= 2048 on the long edge, or over an explicit texture budget).
  for (const t of report.textures.properties) {
    const dim = maxTextureDim(t.resolution);
    const gpu = t.gpuSize ?? t.size;
    if (dim >= 4096 || (dim >= 2048 && (overTexture || budgetTextureBytes == null))) {
      findings.push({
        kind: 'oversized_texture',
        severity: dim >= 4096 ? 'high' : 'medium',
        target: t.name || t.uri || `${t.resolution} texture`,
        detail: `Texture is ${t.resolution} (${(gpu / 1_000_000).toFixed(1)} MB GPU). Halving to ${dim / 2}px cuts it to a quarter.`,
        estimatedSavings: `~${((gpu * 0.75) / 1_000_000).toFixed(1)} MB GPU`,
      });
    }
  }

  // Dense meshes (absolute thresholds, or the densest offenders when over a triangle budget).
  for (const m of report.meshes.properties) {
    const overThreshold = m.glPrimitives >= 50_000;
    const contributesToOverage = overTriangles && m.glPrimitives >= (budgetTriangles ?? 0) * 0.1;
    if (overThreshold || contributesToOverage) {
      findings.push({
        kind: 'dense_mesh',
        severity: m.glPrimitives >= 100_000 ? 'high' : 'medium',
        target: m.name || 'mesh',
        detail: `Mesh has ${m.glPrimitives.toLocaleString()} triangles${overTriangles ? ` against a ${budgetTriangles!.toLocaleString()} budget` : ''}.`,
        estimatedSavings: null,
      });
    }
  }

  // Missing geometry compression on non-trivial geometry.
  if (totalTriangles >= 10_000 && !GEOMETRY_COMPRESSION.some((e) => extensions.has(e))) {
    findings.push({
      kind: 'missing_geometry_compression',
      severity: totalTriangles >= 100_000 ? 'high' : totalTriangles >= 50_000 ? 'medium' : 'low',
      target: 'scene geometry',
      detail: `${totalTriangles.toLocaleString()} triangles with no Draco or meshopt compression.`,
      estimatedSavings: '~30-50% geometry bytes with Draco',
    });
  }

  // Uncompressed textures where KTX2/BasisU would help.
  const hasLargeUncompressed = report.textures.properties.some(
    (t) => maxTextureDim(t.resolution) >= 1024 && t.mimeType !== 'image/ktx2',
  );
  if (hasLargeUncompressed && !extensions.has(TEXTURE_COMPRESSION)) {
    findings.push({
      kind: 'missing_texture_compression',
      severity: overTexture ? 'high' : 'medium',
      target: 'scene textures',
      detail: `${report.textures.properties.length} textures with no KTX2/BasisU supercompression.`,
      estimatedSavings: '~70-90% texture bytes with KTX2',
    });
  }

  // Duplicate materials (identical properties, different objects).
  const bySignature = new Map<string, number>();
  for (const mat of root.listMaterials()) {
    const sig = materialSignature(mat);
    bySignature.set(sig, (bySignature.get(sig) ?? 0) + 1);
  }
  const duplicateGroups = [...bySignature.values()].filter((n) => n > 1);
  if (duplicateGroups.length > 0) {
    const redundant = duplicateGroups.reduce((a, n) => a + (n - 1), 0);
    findings.push({
      kind: 'duplicate_materials',
      severity: 'low',
      target: 'materials',
      detail: `${duplicateGroups.length} group(s) of identical materials; ${redundant} could be merged.`,
      estimatedSavings: `~${redundant} redundant material(s)`,
    });
  }

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    totals: { triangles: totalTriangles, textureGpuBytes },
    budget: { triangles: budgetTriangles ?? null, textureMb: budgetTextureMb ?? null },
    overBudget: { triangles: overTriangles, texture: overTexture },
    findings,
  };
}

export function exportReport(doc: Document, name: string, iso: string): ExportReportOutput {
  const s = summarize(doc);
  const stats = sceneStats(doc);
  const topMeshes = [...stats.meshes].sort((a, b) => b.triangles - a.triangles).slice(0, 5);

  const lines: string[] = [
    `# ModelSense report: ${name}`,
    '',
    `Generated ${iso}`,
    '',
    '## Summary',
    '',
    `- Nodes ${s.counts.nodes}, meshes ${s.counts.meshes}, materials ${s.counts.materials}, textures ${s.counts.textures}, animations ${s.counts.animations}`,
    `- Triangles ${s.totals.triangles}, vertices ${s.totals.vertices}`,
    `- Draw call estimate ${stats.totals.drawCallEstimate}`,
    `- Extensions: ${s.extensionsUsed.length ? s.extensionsUsed.join(', ') : 'none'}`,
    '',
    '## Heaviest meshes',
    '',
    '| mesh | triangles | vertices | size (bytes) |',
    '|---|---:|---:|---:|',
    ...topMeshes.map((m) => `| ${m.name || m.id} | ${m.triangles} | ${m.vertices} | ${m.sizeBytes} |`),
    '',
    '## Textures',
    '',
    '| name | resolution | mime | gpu (bytes) |',
    '|---|---|---|---:|',
    ...stats.textures.map(
      (t) => `| ${t.name || '(unnamed)'} | ${t.resolution} | ${t.mimeType} | ${t.gpuSizeBytes ?? 'n/a'} |`,
    ),
    '',
    '_Units are glTF scene units._',
  ];

  return { format: 'markdown', markdown: lines.join('\n'), generatedAt: iso };
}
