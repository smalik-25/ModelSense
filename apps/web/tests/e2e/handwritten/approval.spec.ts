import { expect, test } from '@playwright/test';
import { APPROVAL_TURN, mockAgent } from './lib/mockAgent';

test.describe('human-in-the-loop approval', () => {
  test('gated tool shows an approval card that clears on approve', async ({ page }) => {
    await mockAgent(page, APPROVAL_TURN);
    await page.goto('/');
    await page.getByTestId('chat-input').fill('Export a report of this scene');
    await page.getByRole('button', { name: 'Send' }).click();

    const approval = page.getByTestId('approval');
    await expect(approval).toBeVisible();
    await expect(approval).toContainText('Approval required');
    await expect(approval).toContainText('export_report');

    await approval.getByRole('button', { name: 'Approve' }).click();
    await expect(approval).toBeHidden();
  });

  test('approval card can be rejected', async ({ page }) => {
    await mockAgent(page, APPROVAL_TURN);
    await page.goto('/');
    await page.getByTestId('chat-input').fill('Export a report of this scene');
    await page.getByRole('button', { name: 'Send' }).click();

    const approval = page.getByTestId('approval');
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Reject' }).click();
    await expect(approval).toBeHidden();
  });
});
