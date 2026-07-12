import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { boxHighlightTurn, mockAgent, truckHighlightTurn } from './lib/mockAgent';

/**
 * Highlight fidelity: the existing chat spec proves the SSE plumbing (text +
 * trace), but nothing checks that a highlight command actually changes a mesh in
 * the three.js scene. That gap hid a real bug: three's GLTFLoader strips `.` from
 * node names (glTF "Wheels.001" -> mesh "Wheels001"), so matching only on
 * `object.name` silently missed every dotted id. These tests read the emissive
 * off the live scene the viewer exposes on `window.__modelsenseScene` (only when
 * the test opts in via `__MODELSENSE_TEST`, set before load).
 */

// Minimal shape of the three.js objects we read in the browser context; keeps the
// evaluate body free of `any` under the repo's no-explicit-any rule.
interface EmissiveLike {
  getHexString(): string;
}
interface MaterialLike {
  emissive?: EmissiveLike;
}
interface Object3DLike {
  isMesh?: boolean;
  name: string;
  material?: MaterialLike | MaterialLike[];
  traverse(cb: (o: Object3DLike) => void): void;
}

/** Emissive hex (e.g. "ffcc00") of the named mesh, or null if not in the scene yet. */
function emissiveOf(page: Page, meshName: string): Promise<string | null> {
  return page.evaluate((name) => {
    const scene = (window as unknown as { __modelsenseScene?: Object3DLike }).__modelsenseScene;
    if (!scene) return null;
    let hex: string | null = null;
    scene.traverse((o) => {
      if (o.isMesh && o.name === name) {
        const mat = Array.isArray(o.material) ? o.material[0] : o.material;
        hex = mat?.emissive ? mat.emissive.getHexString() : null;
      }
    });
    return hex;
  }, meshName);
}

test.describe('highlight fidelity', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __MODELSENSE_TEST?: boolean }).__MODELSENSE_TEST = true;
    });
  });

  test('a Wheels highlight lands on the Wheels mesh', async ({ page }) => {
    await mockAgent(page, truckHighlightTurn(['Wheels']));
    await page.goto('/');
    // Wait for the default truck model to finish loading into the scene.
    await expect.poll(() => emissiveOf(page, 'Wheels'), { timeout: 30_000 }).not.toBeNull();

    await page.getByTestId('chat-input').fill('highlight the wheels');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => emissiveOf(page, 'Wheels'), { timeout: 15_000 }).toBe('ffcc00');
  });

  test('highlighting only the dotted id (Wheels.001) lights the sanitized Wheels001 mesh', async ({
    page,
  }) => {
    // Regression guard for the dot-strip fix, and it must target Wheels.001
    // ALONE. If we also passed "Wheels", that match alone would light the shared
    // wheel material (Wheels and Wheels001 are instances of one mesh, so they
    // share a material) and the assertion would pass even if userData.name
    // matching were broken. Targeting only "Wheels.001" means the material can
    // only light via the sanitized-name match under test: without the fix,
    // "Wheels.001" matches no object.name and Wheels001 stays black.
    await mockAgent(page, truckHighlightTurn(['Wheels.001']));
    await page.goto('/');
    await expect.poll(() => emissiveOf(page, 'Wheels001'), { timeout: 30_000 }).not.toBeNull();

    await page.getByTestId('chat-input').fill('highlight the rear wheels');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => emissiveOf(page, 'Wheels001'), { timeout: 15_000 }).toBe('ffcc00');
  });

  test('highlighting an unnamed node (Box node-1) lights the sanitized mesh', async ({ page }) => {
    // H1 guard: Box.glb's mesh node has no glTF name, so the server addresses it
    // positionally as "node-1". three names the object "Mesh", so name matching
    // alone can never resolve it; the viewer must map "node-1" via the stamped
    // modelsenseId (from GLTFLoader's node index). Without the fix this highlight
    // silently no-ops while the agent reports success.
    await mockAgent(page, boxHighlightTurn(['node-1']));
    await page.goto('/');
    await page.locator('select').selectOption('Box');
    await expect.poll(() => emissiveOf(page, 'Mesh'), { timeout: 30_000 }).not.toBeNull();

    await page.getByTestId('chat-input').fill('highlight the largest mesh');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => emissiveOf(page, 'Mesh'), { timeout: 15_000 }).toBe('ffcc00');
  });
});
