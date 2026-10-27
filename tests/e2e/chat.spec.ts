import { test, expect } from '@playwright/test';

test('customer chats, AI drafts the requirement, Verify & Approve logs a ticket', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Start a conversation' }).click();

  const unique = `Acme${Date.now()}`;
  await page.getByLabel('Message').fill(`Please block vendor ${unique} on every purchase order.`);
  await page.getByRole('button', { name: 'Send' }).click();

  const summary = page.getByRole('complementary', { name: 'AI requirement summary' });
  await expect(summary.getByRole('heading', { level: 3 })).toContainText(unique);
  await expect(summary.getByRole('definition').filter({ hasText: 'purchase order' })).toBeVisible();

  await summary.getByRole('button', { name: 'Verify & Approve' }).click();
  await expect(summary.getByText('Verified & logged')).toBeVisible();
  await expect(summary.getByRole('button', { name: 'Verify & Approve' })).toHaveCount(0);

  await summary.getByRole('link', { name: /View ticket/ }).click();
  await expect(page.getByRole('region', { name: 'Requirement Verified' }).getByRole('link', { name: new RegExp(unique) })).toBeVisible();
});

test('conversation survives reload', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await page.getByLabel('Message').fill('Persistent hello');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('log').getByText('Persistent hello')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('log').getByText('Persistent hello')).toBeVisible();
});
