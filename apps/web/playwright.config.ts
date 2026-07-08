import { defineConfig, devices } from '@playwright/test';

// e2e runs against the built app served by `vite preview`. The agent is mocked at
// the network layer (see tests/e2e/handwritten/lib/mockAgent.ts), so these tests
// are deterministic and never call a live API - safe for CI.
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Force software WebGL so the R3F canvas initializes in headless CI.
        launchOptions: {
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
  webServer: {
    command: 'pnpm run build && pnpm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !CI,
    timeout: 240_000,
  },
});
