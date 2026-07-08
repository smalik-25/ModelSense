import { defineConfig } from 'vitest/config';

// Root Vitest config. Each workspace package matched by `projects` runs its
// own tests (Node environment by default). The web app is tested with
// Playwright (Phase 4), not Vitest, so it is intentionally excluded here.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/server'],
  },
});
