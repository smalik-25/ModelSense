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

  it('export_report: produces markdown with summary and mesh table', () => {
    const report = domain.exportReport(helmet, 'Damaged Helmet', '2026-07-07T00:00:00.000Z');
    expect(report.format).toBe('markdown');
    expect(report.generatedAt).toBe('2026-07-07T00:00:00.000Z');
    expect(report.markdown).toContain('# ModelSense report: Damaged Helmet');
    expect(report.markdown).toContain('Heaviest meshes');
    expect(report.markdown).toContain('15452');
  });
});
