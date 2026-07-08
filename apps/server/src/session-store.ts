import { LRUCache } from 'lru-cache';
import type { Document } from '@gltf-transform/core';
import { ToolError } from './tool-result';

export interface LoadedModel {
  doc: Document;
  model_id: string;
  name: string;
  loadedAt: number;
}

// In-memory LRU. Documented tradeoff: loaded-model state lives in one process
// and is lost on restart. The path to external state (Redis, object store) is
// noted in the README. Fine for Phases 1 to 4.
const store = new LRUCache<string, LoadedModel>({
  max: 25,
  ttl: 1000 * 60 * 30, // 30 minutes
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
