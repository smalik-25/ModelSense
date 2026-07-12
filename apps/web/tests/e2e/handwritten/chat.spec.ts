import { expect, test } from '@playwright/test';
import { ERROR_TURN, HIGHLIGHT_TURN, mockAgent } from './lib/mockAgent';

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

  test('surfaces an agent error frame as an alert and re-enables input', async ({ page }) => {
    await mockAgent(page, ERROR_TURN);
    await page.goto('/');
    await page.getByTestId('chat-input').fill('do something');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('alert')).toContainText('Agent error');
    // A failed turn must return control: the composer is usable again.
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByTestId('chat-input')).toBeEnabled();
  });

  test('Stop aborts an in-flight turn and returns to idle without an error', async ({ page }) => {
    await mockAgent(page, [], { hangChat: true });
    await page.goto('/');
    await page.getByTestId('chat-input').fill('long running request');
    await page.getByRole('button', { name: 'Send' }).click();

    // While busy the composer swaps Send for Stop and locks the model picker.
    const stop = page.getByRole('button', { name: 'Stop' });
    await expect(stop).toBeVisible();
    await expect(page.getByRole('combobox')).toBeDisabled();
    await stop.click();

    // Aborting is not an error: no alert, Send returns, picker unlocks.
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('combobox')).toBeEnabled();
  });
});
