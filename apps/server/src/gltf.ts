import { stat } from 'node:fs/promises';
import { NodeIO, getBounds } from '@gltf-transform/core';
import type { Document, Material, Node as GNode, Texture } from '@gltf-transform/core';
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

/** glTF primitive modes (GLTF.MeshPrimitive.mode). */
const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

/** Triangles a primitive contributes for its draw mode; 0 for non-triangle modes. */
function trianglesForMode(mode: number, count: number): number {
  if (mode === TRIANGLES) return Math.floor(count / 3);
  // A strip or fan of N vertices renders N-2 triangles.
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) return Math.max(count - 2, 0);
  return 0;
}

function createIO(): NodeIO {
  // Register all standard extensions so extension names are reported. Draco/KTX2
  // *decoding* additionally needs decoder dependencies; Phase 1 sample models are
  // uncompressed, so reads succeed without them. A compressed model would throw,
  // which load_model surfaces as a structured error.
  return new NodeIO().registerExtensions(ALL_EXTENSIONS);
}

function toFiniteVec(v: readonly number[]): [number, number, number] {
  const f = (i: number): number => {
    const n = v[i] ?? 0;
    return Number.isFinite(n) ? n : 0;
  };
  return [f(0), f(1), f(2)];
}

// --- loading ---------------------------------------------------------------

export async function loadLocal(path: string): Promise<{ doc: Document; bytes: number }> {
  const io = createIO();
  const [doc, info] = await Promise.all([io.read(path), stat(path)]);
  return { doc, bytes: info.size };
}

/** Cap on a fetched GLB so a large remote model cannot OOM the small instance. */
const MAX_URL_MODEL_BYTES = 64 * 1_000_000;
const URL_FETCH_TIMEOUT_MS = 20_000;

export async function loadUrl(url: string): Promise<{ doc: Document; bytes: number }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new ToolError(`Fetch timed out after ${URL_FETCH_TIMEOUT_MS / 1000}s for ${url}`);
    }
    throw new ToolError(`Fetch failed for ${url}`);
  }
  if (!res.ok) throw new ToolError(`Fetch failed (${res.status}) for ${url}`);

  // Reject early on a declared oversize, then guard the actual bytes in case the
  // header lies or is absent.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_URL_MODEL_BYTES) {
    throw new ToolError(
      `Model is ${(declared / 1_000_000).toFixed(1)} MB, over the ${MAX_URL_MODEL_BYTES / 1_000_000} MB limit.`,
    );
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_URL_MODEL_BYTES) {
    throw new ToolError(
      `Model is ${(buf.byteLength / 1_000_000).toFixed(1)} MB, over the ${MAX_URL_MODEL_BYTES / 1_000_000} MB limit.`,
    );
  }
  const doc = await createIO().readBinary(buf);
  return { doc, bytes: buf.byteLength };
}

// --- node identity ---------------------------------------------------------

/**
 * Addressable id for every node, in `listNodes()` order (the glTF `nodes` array
 * order). A node's id is its glTF name when that name is UNIQUE in the document;
 * otherwise a positional `node-<index>`. The fallback covers two cases the viewer
 * could not otherwise resolve:
 *  - an unnamed node (Box.glb's mesh node): three's GLTFLoader gives it a synthetic
 *    object name, so a name-based id would never match anything in the scene.
 *  - two nodes sharing a name: a bare name would be ambiguous, so the first match
 *    silently answered for the second. Positional ids keep every id unique.
 * The web viewer mirrors this index via GLTFLoader's parser.associations, so a
 * `node-<index>` id resolves to the same node on both sides.
 */
function nodeIdsFor(nodes: GNode[]): string[] {
  const counts = new Map<string, number>();
  for (const n of nodes) {
    const name = n.getName();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return nodes.map((n, i) => {
    const name = n.getName();
    return name && counts.get(name) === 1 ? name : `node-${i}`;
  });
}

function findNodeById(doc: Document, id: string): GNode | undefined {
  const nodes = doc.getRoot().listNodes();
  const idx = nodeIdsFor(nodes).indexOf(id);
  return idx >= 0 ? nodes[idx] : undefined;
}

/** Every node in the subtree rooted at `node` (the node itself plus descendants). */
function collectSubtree(node: GNode): GNode[] {
  const out: GNode[] = [node];
  for (const child of node.listChildren()) out.push(...collectSubtree(child));
  return out;
}

/** The distinct textures a material references across its PBR slots. */
function materialTextures(mat: Material): Texture[] {
  return [
    mat.getBaseColorTexture(),
    mat.getMetallicRoughnessTexture(),
    mat.getNormalTexture(),
    mat.getEmissiveTexture(),
    mat.getOcclusionTexture(),
  ].filter((t): t is Texture => t !== null);
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
      triangles += trianglesForMode(prim.getMode(), count);
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
  // Multiply per-mesh geometry by how many nodes reference the mesh, so an
  // instanced mesh (e.g. a wheel reused across nodes) counts once per instance.
  // This makes the scene totals match find_elements' per-node summation.
  const totals = report.meshes.properties.reduce(
    (acc, m) => ({
      vertices: acc.vertices + m.vertices * m.instances,
      triangles: acc.triangles + m.glPrimitives * m.instances,
    }),
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
  const root = doc.getRoot();
  const meshes = root.listMeshes();
  const docTextures = root.listTextures();

  const meshStats = report.meshes.properties.map((m, i) => ({
    id: `mesh-${i}`,
    name: m.name,
    vertices: m.vertices,
    triangles: m.glPrimitives,
    sizeBytes: m.size ?? null,
    instances: m.instances,
  }));
  const textureStats = report.textures.properties.map((t) => ({
    name: t.name,
    resolution: t.resolution,
    mimeType: t.mimeType,
    sizeBytes: t.size ?? null,
    gpuSizeBytes: t.gpuSize ?? null,
  }));

  if (nodeId) {
    const node = findNodeById(doc, nodeId);
    if (!node) throw new ToolError(`Unknown node_id "${nodeId}".`);

    // Aggregate over the whole subtree (self + descendants) so a parent/group node
    // reports the geometry it contains, matching the subtree scope getBounds uses.
    // Each referencing node counts the mesh once (instancing-correct).
    const subtree = collectSubtree(node);
    const meshRefsInSubtree = new Map<number, number>();
    const materials = new Set<Material>();
    const textures = new Set<Texture>();
    let vertices = 0;
    let triangles = 0;
    let drawCallEstimate = 0;

    for (const n of subtree) {
      const mesh = n.getMesh();
      if (!mesh) continue;
      const idx = meshes.indexOf(mesh);
      const row = idx >= 0 ? meshStats[idx] : undefined;
      if (idx >= 0 && row) {
        meshRefsInSubtree.set(idx, (meshRefsInSubtree.get(idx) ?? 0) + 1);
        vertices += row.vertices;
        triangles += row.triangles;
        drawCallEstimate += report.meshes.properties[idx]?.meshPrimitives ?? 0;
      }
      for (const prim of mesh.listPrimitives()) {
        const mat = prim.getMaterial();
        if (!mat) continue;
        materials.add(mat);
        for (const tex of materialTextures(mat)) textures.add(tex);
      }
    }

    const meshRows = [...meshRefsInSubtree.entries()].map(([idx, count]) => ({
      ...meshStats[idx]!,
      instances: count,
    }));
    const textureRows = [...textures]
      .map((t) => docTextures.indexOf(t))
      .filter((i) => i >= 0)
      .map((i) => textureStats[i]!);

    return {
      scope: nodeId,
      totals: { vertices, triangles, drawCallEstimate, materials: materials.size, textures: textures.size },
      meshes: meshRows,
      textures: textureRows,
    };
  }

  // Scene totals multiply per-mesh geometry by instance count so instanced meshes
  // are counted per render, agreeing with find_elements' per-node summation.
  return {
    scope: 'scene',
    totals: {
      vertices: report.meshes.properties.reduce((a, m) => a + m.vertices * m.instances, 0),
      triangles: report.meshes.properties.reduce((a, m) => a + m.glPrimitives * m.instances, 0),
      drawCallEstimate: report.meshes.properties.reduce((a, m) => a + m.meshPrimitives * m.instances, 0),
      materials: report.materials.properties.length,
      textures: report.textures.properties.length,
    },
    meshes: meshStats,
    textures: textureStats,
  };
}

export function findElements(doc: Document, query: string, limit: number): FindElementsOutput {
  const needle = query.toLowerCase();
  const nodes = doc.getRoot().listNodes();
  const ids = nodeIdsFor(nodes);
  const matches = nodes
    .map((node, i) => ({ node, id: ids[i]! }))
    // Match the query against the node's name AND its id, so a duplicately named
    // node (whose id falls back to positional `node-<index>`) is still findable by
    // name, and an unnamed node is findable by its `node-` id.
    .filter(({ node, id }) => {
      const name = node.getName();
      return id.toLowerCase().includes(needle) || (!!name && name.toLowerCase().includes(needle));
    })
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
  const known = new Set(nodeIdsFor(doc.getRoot().listNodes()));
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

  // Rendered triangles (instanced), consistent with get_scene_stats and the
  // user's "get this under N triangles" budget framing.
  const totalTriangles = report.meshes.properties.reduce((a, m) => a + m.glPrimitives * m.instances, 0);
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
