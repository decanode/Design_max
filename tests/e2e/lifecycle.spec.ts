import { test, expect } from '@playwright/test';

test('create a ticket and advance it through the state machine', async ({ page }) => {
  const title = `E2E ticket ${Date.now()}`;
  await page.goto('/');
  await page.getByLabel('New ticket title').fill(title);
  await page.getByRole('button', { name: 'Create ticket' }).click();

  const col = (name: string) => page.getByRole('region', { name });
  await expect(col('Requirement Verified').getByText(title)).toBeVisible();

  await col('Requirement Verified').locator('article', { hasText: title }).getByRole('button').click();
  await expect(col('FS Drafted').getByText(title)).toBeVisible();
});
