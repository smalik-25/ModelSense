import { LRUCache } from 'lru-cache';
import type { Document } from '@gltf-transform/core';
import { ToolError } from './tool-result';

export interface LoadedModel {
  doc: Document;
  model_id: string;
  name: string;
  loadedAt: number;
  /** Source bytes of the model, used to bound cache memory (see maxSize below). */
  bytes: number;
}

// In-memory LRU. Documented tradeoff: loaded-model state lives in one process
// and is lost on restart. The path to external state (Redis, object store) is
// noted in the README. Fine for Phases 1 to 4.
//
// Each entry is a fully parsed glTF Document (several times its file size), so the
// cache is bounded by memory, not just count: without maxSize, 8 near-limit models
// (64 MB each) could pin ~512 MB and OOM the free-tier instance.
const store = new LRUCache<string, LoadedModel>({
  max: 8,
  // Bound total retained source bytes. A parsed Document is a few times larger, so
  // this is a conservative proxy paired with the small count cap.
  maxSize: 128 * 1_000_000,
  sizeCalculation: (model) => Math.max(model.bytes, 1),
  ttl: 1000 * 60 * 20, // 20 minutes
  // Refresh the TTL on access so a session in active use is not evicted mid-chat
  // just because it was loaded 20 minutes ago.
  updateAgeOnGet: true,
});

export function putSession(id: string, model: LoadedModel): void {
  store.set(id, model);
}

export function getSession(id: string): LoadedModel {
  const model = store.get(id);
  if (!model) {
    throw new ToolError(`Unknown or expired session_id "${id}". Call load_model first.`);
  }
  return model;
}
