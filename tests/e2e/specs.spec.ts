import { test, expect } from '@playwright/test';

test('FS and TS: generate, edit with history, approve by emailed link, then continue', async ({ page }) => {
  const title = `Spec flow ${Date.now()}`;
  const approver = `mgr${Date.now()}@corp.com`;

  await page.goto('/');
  await page.getByLabel('New ticket title').fill(title);
  await page.getByRole('button', { name: 'Create ticket' }).click();
  await page.getByRole('link', { name: title }).click();

  // FS draft
  await page.getByRole('button', { name: 'Generate FS draft' }).click();
  const editor = page.getByLabel('Markdown editor');
  await expect(editor).toHaveValue(new RegExp(`# Functional Specification: ${title}`));

  // edit -> v2, with a diff against v1
  await editor.fill((await editor.inputValue()) + '\nBlocked vendors must not appear in the PO value help.');
  await page.getByRole('button', { name: 'Save new version' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await expect(page.getByRole('tab', { name: /Functional Spec · v2/ })).toBeVisible();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('button', { name: /^v1/ }).click();
  await expect(page.getByRole('region', { name: 'Diff' })).toContainText('Blocked vendors must not appear');
  await history.getByRole('button', { name: /^v2/ }).click();

  // request approval -> email -> approver page
  await page.getByLabel('Approver email').fill(approver);
  await page.getByRole('button', { name: 'Request approval' }).click();
  await expect(page.getByText(`Waiting for approval from ${approver}`)).toBeVisible();

  await page.getByRole('link', { name: 'Mailbox' }).click();
  const mail = page.getByRole('article').filter({ hasText: approver }).first();
  await mail.getByRole('link').click();
  await expect(page.getByText('Blocked vendors must not appear')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeDisabled();   // needs a comment
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Approved');

  // link is single-use
  await page.reload();
  await expect(page.getByText(/This request is approved/)).toBeVisible();

  // back on the ticket: FS locked, TS can now be generated
  await page.goto('/');
  await page.getByRole('region', { name: 'FS Approved' }).getByRole('link', { name: title }).click();
  await expect(page.getByText('This document is locked')).toBeVisible();
  await page.getByRole('tab', { name: /Technical Spec/ }).click();
  await page.getByRole('button', { name: 'Generate TS draft' }).click();
  await expect(page.getByLabel('Markdown editor')).toHaveValue(/Technical Specification/);
  await expect(page.getByLabel('Markdown editor')).toHaveValue(/Blocked vendors must not appear/);
});
