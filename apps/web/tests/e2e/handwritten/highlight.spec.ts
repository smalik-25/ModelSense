import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mockAgent, truckHighlightTurn } from './lib/mockAgent';

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

  test('highlighting both wheels lights the dot-stripped rear mesh too', async ({ page }) => {
    // glTF "Wheels.001" becomes three.js "Wheels001": the regression this guards.
    await mockAgent(page, truckHighlightTurn(['Wheels', 'Wheels.001']));
    await page.goto('/');
    await expect.poll(() => emissiveOf(page, 'Wheels001'), { timeout: 30_000 }).not.toBeNull();

    await page.getByTestId('chat-input').fill('highlight both wheels');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect.poll(() => emissiveOf(page, 'Wheels'), { timeout: 15_000 }).toBe('ffcc00');
    await expect.poll(() => emissiveOf(page, 'Wheels001'), { timeout: 15_000 }).toBe('ffcc00');
  });
});
