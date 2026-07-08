import { expect, test } from '@playwright/test';
import { HIGHLIGHT_TURN, mockAgent } from './lib/mockAgent';

test.describe('viewer + chat', () => {
  test('loads the viewer, model selector, and canvas', async ({ page }) => {
    await mockAgent(page, []);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'ModelSense' })).toBeVisible();
    await expect(page.getByRole('combobox')).toBeVisible();
    await expect(page.locator('canvas')).toBeVisible();
    // Example prompts are offered before the first message.
    await expect(page.getByRole('button', { name: /highlight the largest/i })).toBeVisible();
  });

  test('streams an agent reply and surfaces the trace', async ({ page }) => {
    await mockAgent(page, HIGHLIGHT_TURN);
    await page.goto('/');
    await page.getByTestId('chat-input').fill('Find the wheels and highlight the largest');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByTestId('msg-assistant').last()).toContainText(
      'highlighted the largest',
      { ignoreCase: true },
    );
    // The trace strip reports the turn metrics from the done event.
    const trace = page.getByTestId('trace');
    await expect(trace).toContainText('4 turns');
    await expect(trace).toContainText('$0.12');
  });

  test('can switch the active model', async ({ page }) => {
    await mockAgent(page, []);
    await page.goto('/');
    // Default is the first catalog entry (Cesium Milk Truck).
    await expect(page.getByRole('combobox')).toHaveValue('CesiumMilkTruck');
    await page.getByRole('combobox').selectOption('DamagedHelmet');
    await expect(page.getByRole('combobox')).toHaveValue('DamagedHelmet');
  });
});
