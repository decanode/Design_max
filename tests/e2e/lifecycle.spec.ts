import { test, expect } from '@playwright/test';

test('board: new ticket cannot skip the gated steps', async ({ page }) => {
  const title = `E2E ticket ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('New ticket title').fill(title);
  await page.getByRole('button', { name: 'Create ticket' }).click();

  const card = page.getByRole('region', { name: 'Requirement Verified' }).locator('article', { hasText: title });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);   // no "Advance" before FS exists

  await card.getByRole('link', { name: title }).click();
  await page.getByRole('button', { name: 'Generate FS draft' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'FS Drafted' })).toHaveAttribute('aria-current', 'step');
});
