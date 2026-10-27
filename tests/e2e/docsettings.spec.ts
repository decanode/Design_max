import { test, expect } from '@playwright/test';

test('an admin restyles the project documents and downloads a sample before saving', async ({ browser }) => {
  const page = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Documents' }).click();
  const form = page.getByRole('form', { name: 'Document settings' });
  await form.getByLabel('Project name on documents').fill('Acme Rollout');
  await form.getByLabel('Heading font').selectOption('Georgia');
  await expect(form.getByLabel('Preview of the document style')).toContainText('Acme Rollout');

  const [sample] = await Promise.all([page.waitForEvent('download'), form.getByRole('button', { name: /Download a sample/ }).click()]);
  expect(sample.suggestedFilename()).toBe('FS_sample.docx');

  await form.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toContainText('Document settings saved');
  await page.reload();
  await page.getByRole('tab', { name: 'Documents' }).click();
  await expect(page.getByLabel('Project name on documents')).toHaveValue('Acme Rollout');

  // put it back so other tests see the defaults
  await page.getByLabel('Project name on documents').fill('');
  await page.getByLabel('Heading font').selectOption('Calibri');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toContainText('saved');
});
