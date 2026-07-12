import { expect, test } from '@playwright/test';
import type { ApproveBody } from './lib/mockAgent';
import { APPROVAL_TURN, mockAgent } from './lib/mockAgent';

test.describe('human-in-the-loop approval', () => {
  test('Approve posts the approval decision (id + approved:true) and clears the card', async ({
    page,
  }) => {
    // Assert the POST body, not just that the card hides: the card hides on either
    // decision, so a client that dropped/renamed `approved` (sending nothing, i.e.
    // always-deny in prod) would still pass a visibility-only check.
    const approveLog: ApproveBody[] = [];
    await mockAgent(page, APPROVAL_TURN, { approveLog });
    await page.goto('/');
    await page.getByTestId('chat-input').fill('Export a report of this scene');
    await page.getByRole('button', { name: 'Send' }).click();

    const approval = page.getByTestId('approval');
    await expect(approval).toBeVisible();
    await expect(approval).toContainText('Approval required');
    await expect(approval).toContainText('export_report');

    await approval.getByRole('button', { name: 'Approve' }).click();
    await expect(approval).toBeHidden();
    expect(approveLog).toHaveLength(1);
    expect(approveLog[0]).toMatchObject({ id: 'appr-1', approved: true });
  });

  test('Reject posts approved:false and clears the card', async ({ page }) => {
    const approveLog: ApproveBody[] = [];
    await mockAgent(page, APPROVAL_TURN, { approveLog });
    await page.goto('/');
    await page.getByTestId('chat-input').fill('Export a report of this scene');
    await page.getByRole('button', { name: 'Send' }).click();

    const approval = page.getByTestId('approval');
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Reject' }).click();
    await expect(approval).toBeHidden();
    expect(approveLog).toHaveLength(1);
    expect(approveLog[0]).toMatchObject({ id: 'appr-1', approved: false });
  });
});
