import { test, expect } from './fixtures';
import { readFileSync } from 'node:fs';

test('a consultant downloads a specification as a Word file in the project design', async ({ browser }) => {
  const stamp = Date.now();
  const title = `Export check ${stamp}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const sam = (await (await sup.request.get('/api/auth/dev-users')).json()).find((u: any) => u.role === 'Consultant');
  const t = await (await sup.request.post('/api/tickets', { data: { title } })).json();
  await sup.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });

  const page = await (await browser.newContext({ storageState: '.auth/Consultant.json' })).newPage();
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: 'Generate FS draft' }).click();
  const editor = page.getByRole('textbox', { name: 'FS document' });
  await expect(page.locator('.rte-status').filter({ hasText: 'Live' })).toBeVisible();
  await editor.click(); await page.keyboard.press('Control+End');
  await page.keyboard.type(' Blocked vendors never appear in value help.');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Download v2 as Word' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^FS_Export-check-\d+_v2\.docx$/);
  const bytes = readFileSync(await download.path()!);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');                               // a real Word package (a zip)
  expect(bytes.length).toBeGreaterThan(3000);

  // an older version downloads too, while viewing it
  await page.getByRole('complementary', { name: 'History' }).getByRole('button', { name: /^v1/ }).click();
  await expect(page.getByRole('link', { name: 'Download v1 as Word' })).toBeVisible();
});
