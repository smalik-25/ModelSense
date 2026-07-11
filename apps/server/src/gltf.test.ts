import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { Document } from '@gltf-transform/core';
import * as domain from './gltf';
import { availableModels, isAllowedModelUrl, resolveModel } from './catalog';

const modelPath = (name: string) =>
  fileURLToPath(new URL(`../../../assets/models/${name}`, import.meta.url));

// Golden values are computed deterministically from the committed GLB fixtures.
// They will not drift because the model files are pinned in the repo.

describe('catalog', () => {
  it('lists the three committed models', () => {
    const ids = availableModels().map((m) => m.model_id).sort();
    expect(ids).toEqual(['Box', 'CesiumMilkTruck', 'DamagedHelmet']);
  });

  it('resolves a known model to a file path and rejects unknown ids', () => {
    expect(resolveModel('Box')?.location).toMatch(/Box\.glb$/);
    expect(resolveModel('nope')).toBeUndefined();
  });

  it('allows only Khronos sample .glb URLs', () => {
    const base = 'https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models';
    expect(isAllowedModelUrl(`${base}/Box/glTF-Binary/Box.glb`)).toBe(true);
    expect(isAllowedModelUrl('https://evil.example.com/x.glb')).toBe(false);
    expect(isAllowedModelUrl(`${base}/Box/README.md`)).toBe(false);
    expect(isAllowedModelUrl('not a url')).toBe(false);
    // Allowlist segment must be anchored, not merely present in the path: an
    // attacker-owned repo cannot smuggle it as a later path segment.
    expect(
      isAllowedModelUrl(
        'https://raw.githubusercontent.com/attacker/repo/main/KhronosGroup/glTF-Sample-Assets/evil.glb',
      ),
    ).toBe(false);
    // http (non-TLS) is rejected even on the right host/path.
    expect(
      isAllowedModelUrl('http://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/x.glb'),
    ).toBe(false);
  });
});

describe('domain (against committed GLB fixtures)', () => {
  let truck: Document;
  let helmet: Document;

  beforeAll(async () => {
    truck = (await domain.loadLocal(modelPath('CesiumMilkTruck.glb'))).doc;
    helmet = (await domain.loadLocal(modelPath('DamagedHelmet.glb'))).doc;
  });

  it('summarize: DamagedHelmet is one textured mesh, ~15.4k triangles', () => {
    const s = domain.summarize(helmet);
    expect(s.counts.meshes).toBe(1);
    expect(s.counts.textures).toBe(5);
    expect(s.totals.triangles).toBe(15452);
  });

  it('summarize: CesiumMilkTruck has six nodes and two meshes', () => {
    const s = domain.summarize(truck);
    expect(s.counts.nodes).toBe(6);
    expect(s.counts.meshes).toBe(2);
  });

  it('find_elements: matches both wheel nodes, sorted by triangle count', () => {
    const res = domain.findElements(truck, 'wheel', 25);
    expect(res.total).toBe(2);
    expect(res.elements.map((e) => e.id).sort()).toEqual(['Wheels', 'Wheels.001']);
    expect(res.elements[0]?.triangles).toBe(768);
    expect(res.elements[0]?.type).toBe('mesh');
    expect(res.elements[0]?.bboxMin).toHaveLength(3);
  });

  it('find_elements: empty query returns all nodes sorted by triangles desc', () => {
    const all = domain.findElements(truck, '', 500);
    expect(all.total).toBe(6);
    for (let i = 1; i < all.elements.length; i++) {
      expect(all.elements[i - 1]!.triangles).toBeGreaterThanOrEqual(all.elements[i]!.triangles);
    }
  });

  it('get_scene_stats: whole scene and single-node scope', () => {
    const scene = domain.sceneStats(helmet);
    expect(scene.scope).toBe('scene');
    expect(scene.meshes).toHaveLength(1);
    expect(scene.totals.triangles).toBe(15452);
    expect(scene.textures).toHaveLength(5);

    const node = domain.sceneStats(truck, 'Wheels');
    expect(node.scope).toBe('Wheels');
    expect(node.meshes).toHaveLength(1);
    expect(node.totals.triangles).toBe(768);
  });

  it('get_scene_stats: scene totals count instanced meshes per render, matching find_elements', () => {
    // The truck reuses one Wheels mesh (768 tris) across two nodes, so the scene
    // renders 2088 + 768*2 = 3624 triangles and 3167 + 828*2 = 4823 vertices.
    const scene = domain.sceneStats(truck);
    expect(scene.totals.triangles).toBe(3624);
    expect(scene.totals.vertices).toBe(4823);

    // get_scene_stats must agree with find_elements' per-node summation.
    const perNode = domain
      .findElements(truck, '', 500)
      .elements.reduce((a, e) => a + e.triangles, 0);
    expect(perNode).toBe(3624);
  });

  it('get_scene_stats: node scope aggregates the whole subtree, not just the node mesh', () => {
    // Yup2Zup is an empty root parent whose subtree is the entire truck.
    const root = domain.sceneStats(truck, 'Yup2Zup');
    expect(root.totals.triangles).toBe(3624);
    expect(root.meshes.length).toBe(2);

    // Node is an empty parent of a single wheel.
    const oneWheel = domain.sceneStats(truck, 'Node');
    expect(oneWheel.totals.triangles).toBe(768);
    expect(oneWheel.meshes).toHaveLength(1);
  });

  it('get_scene_stats: unknown node_id throws a ToolError', () => {
    expect(() => domain.sceneStats(truck, 'does-not-exist')).toThrow();
  });

  it('highlight_elements: echoes a valid command with defaults', () => {
    const cmd = domain.buildHighlight(truck, ['Wheels', 'Wheels.001']);
    expect(cmd.type).toBe('highlight');
    expect(cmd.color).toBe('#ffcc00');
    expect(cmd.exclusive).toBe(false);
    expect(cmd.nodeIds).toEqual(['Wheels', 'Wheels.001']);
  });

  it('highlight_elements: honors an explicit color and rejects all-unknown ids', () => {
    const cmd = domain.buildHighlight(truck, ['Wheels'], '#00ff00', true);
    expect(cmd.color).toBe('#00ff00');
    expect(cmd.exclusive).toBe(true);
    expect(() => domain.buildHighlight(truck, ['nope-1', 'nope-2'])).toThrow();
  });

  it('camera_focus: returns a bounding sphere for a node', () => {
    const cmd = domain.cameraFocus(truck, 'Wheels');
    expect(cmd.type).toBe('camera_focus');
    expect(cmd.nodeId).toBe('Wheels');
    expect(cmd.center).toHaveLength(3);
    expect(cmd.radius).toBeGreaterThan(0);
    expect(() => domain.cameraFocus(truck, 'nope')).toThrow();
  });

  it('measure: bounding box mode and distance mode', () => {
    const bbox = domain.measure(truck, { node_id: 'Wheels' });
    expect(bbox.type).toBe('measurement');
    expect(bbox.points).toHaveLength(2);
    expect(bbox.value).toBeGreaterThan(0);
    expect(bbox.unit).toBe('scene-units');

    const dist = domain.measure(truck, { node_a: 'Wheels', node_b: 'Wheels.001' });
    expect(dist.points).toHaveLength(2);
    expect(dist.value).toBeGreaterThan(0);

    expect(() => domain.measure(truck, {})).toThrow();
    expect(() => domain.measure(truck, { node_id: 'nope' })).toThrow();
  });

  it('suggest_optimizations: flags oversized textures and missing compression on the helmet', () => {
    const out = domain.suggestOptimizations(helmet);
    expect(out.totals.triangles).toBe(15452);
    expect(out.totals.textureGpuBytes).toBeGreaterThan(0);
    const kinds = out.findings.map((f) => f.kind);
    expect(kinds).toContain('oversized_texture');
    expect(kinds).toContain('missing_texture_compression');
    expect(kinds).toContain('missing_geometry_compression');
    // Sorted worst-first: severity rank is non-decreasing.
    const rank = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < out.findings.length; i++) {
      expect(rank[out.findings[i]!.severity]).toBeGreaterThanOrEqual(rank[out.findings[i - 1]!.severity]);
    }
  });

  it('suggest_optimizations: a triangle budget marks the scene over budget and flags the dense mesh', () => {
    const out = domain.suggestOptimizations(helmet, 5000);
    expect(out.budget.triangles).toBe(5000);
    expect(out.overBudget.triangles).toBe(true);
    expect(out.findings.some((f) => f.kind === 'dense_mesh')).toBe(true);
  });

  it('suggest_optimizations: a generous budget is not over budget', () => {
    const out = domain.suggestOptimizations(helmet, 1_000_000, 1000);
    expect(out.overBudget.triangles).toBe(false);
    expect(out.overBudget.texture).toBe(false);
  });

  it('export_report: produces markdown with summary and mesh table', () => {
    const report = domain.exportReport(helmet, 'Damaged Helmet', '2026-07-07T00:00:00.000Z');
    expect(report.format).toBe('markdown');
    expect(report.generatedAt).toBe('2026-07-07T00:00:00.000Z');
    expect(report.markdown).toContain('# ModelSense report: Damaged Helmet');
    expect(report.markdown).toContain('Heaviest meshes');
    expect(report.markdown).toContain('15452');
  });
});
