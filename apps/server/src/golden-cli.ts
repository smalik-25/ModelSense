/**
 * Compute canonical golden answers for the eval harness, straight from the
 * committed GLBs using the exact same domain logic the MCP server runs. This is
 * the `make golden-answers` step: the eval golden set references these values by
 * key instead of hand-typing numbers, so if a model file changes, regenerating
 * this file keeps every assertion honest.
 *
 * Output: evals/golden/reference.json
 *
 * Run: pnpm --filter @modelsense/server golden
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as domain from './gltf';
import { availableModels, resolveModel } from './catalog';

const OUT_DIR = fileURLToPath(new URL('../../../evals/golden/', import.meta.url));
const OUT_FILE = `${OUT_DIR}reference.json`;

interface ModelReference {
  model_id: string;
  name: string;
  fileSizeBytes: number;
  counts: ReturnType<typeof domain.summarize>['counts'];
  totals: ReturnType<typeof domain.summarize>['totals'];
  extensionsUsed: string[];
  /** Every node, sorted by triangle count descending (largest first). */
  nodes: ReturnType<typeof domain.findElements>['elements'];
  largestNode: { id: string; triangles: number } | null;
  sceneStats: ReturnType<typeof domain.sceneStats>;
  optimizations: ReturnType<typeof domain.suggestOptimizations>;
}

async function computeModel(model_id: string): Promise<ModelReference> {
  const entry = resolveModel(model_id);
  if (!entry) throw new Error(`Unknown model_id ${model_id}`);
  const { doc, bytes } = await domain.loadLocal(entry.location);

  const summary = domain.summarize(doc);
  // Empty query returns all nodes, already sorted by triangle count descending.
  const all = domain.findElements(doc, '', 10_000).elements;
  const largest = all[0] ?? null;

  return {
    model_id: entry.model_id,
    name: entry.name,
    fileSizeBytes: bytes,
    counts: summary.counts,
    totals: summary.totals,
    extensionsUsed: summary.extensionsUsed,
    nodes: all,
    largestNode: largest ? { id: largest.id, triangles: largest.triangles } : null,
    sceneStats: domain.sceneStats(doc),
    optimizations: domain.suggestOptimizations(doc),
  };
}

async function main(): Promise<void> {
  const ids = availableModels().map((m) => m.model_id);
  const models: Record<string, ModelReference> = {};
  for (const id of ids) {
    models[id] = await computeModel(id);
  }

  const output = {
    // Bump when the reference schema changes so stale files are obvious.
    schemaVersion: 1,
    generator: 'apps/server/src/golden-cli.ts',
    models,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  const summary = ids
    .map((id) => `${id}: ${models[id]!.totals.triangles} tris, ${models[id]!.nodes.length} nodes`)
    .join('; ');
  process.stdout.write(`Wrote ${OUT_FILE}\n${summary}\n`);
}

main().catch((err) => {
  process.stderr.write(`golden-cli failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
