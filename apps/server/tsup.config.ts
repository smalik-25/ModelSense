import { defineConfig } from 'tsup';

// Bundle the server (and the @modelsense/shared source it imports) to a single
// ESM file for production. tsx runs the TS directly in dev; this is build/start.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  // three.js-free server; keep node built-ins external (default) and bundle the rest.
  noExternal: ['@modelsense/shared'],
});
