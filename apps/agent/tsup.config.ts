import { defineConfig } from 'tsup';

// Production build: the COMBINED entry (MCP server routes + agent /chat) as one
// ESM file for a single Render service. The workspace packages are bundled in;
// runtime deps (Agent SDK, express, Langfuse, gltf-transform) stay external.
export default defineConfig({
  entry: ['src/combined.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  noExternal: ['@modelsense/shared', '@modelsense/server'],
});
