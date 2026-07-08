import { stat } from 'node:fs/promises';
import { NodeIO, getBounds } from '@gltf-transform/core';
import type { Document, Node as GNode } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { inspect } from '@gltf-transform/functions';
import { HighlightCommand } from '@modelsense/shared';
import type {
  FindElementsOutput,
  GetSceneStatsOutput,
  HighlightElementsOutput,
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
