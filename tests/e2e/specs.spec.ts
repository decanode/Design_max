import { test, expect } from './fixtures';

test('FS and TS: generate, edit with history, approve by emailed link, then continue', async ({ page }) => {
  const title = `Spec flow ${Date.now()}`;

  await page.goto('/');
  await page.getByRole('button', { name: 'Create item' }).click();
  await page.getByRole('dialog').getByLabel('Title').fill(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Create Requirement' }).click();
  await page.getByRole('region', { name: 'Requirement Verified' }).getByRole('link', { name: title }).click();

  // FS draft
  await page.getByRole('button', { name: 'Generate FS draft' }).click();
  const editor = page.getByRole('textbox', { name: 'FS document' });
  await expect(editor).toContainText(`Functional Specification: ${title}`);
  await expect(page.locator('.rte-status').filter({ hasText: 'Live' })).toBeVisible();

  // edit in the live editor -> v2, with a diff against v1
  await editor.click(); await page.keyboard.press('Control+End');
  await page.keyboard.type(' Blocked vendors must not appear in the PO value help.');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await expect(page.getByRole('tab', { name: /Functional Spec · v2/ })).toBeVisible();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('button', { name: /^v1/ }).click();
  await expect(page.getByRole('region', { name: 'Diff' })).toContainText('Blocked vendors must not appear');
  await history.getByRole('button', { name: /^v2/ }).click();

  // request approval: the route comes from the Admin's workflow, no free-typed approver
  await expect(page.getByRole('region', { name: 'Approval route' })).toContainText('Standard approval');
  await page.getByRole('button', { name: 'Request approval' }).click();
  await expect(page.getByRole('region', { name: 'Approval' })).toContainText('Waiting for approval');
  await expect(page.getByRole('list', { name: 'Approval progress' })).toContainText('L1');

  // the approver gets an emailed link (here: the local mailbox)
  await page.getByRole('link', { name: 'Mailbox' }).click();
  const mail = page.getByRole('article').filter({ hasText: title }).filter({ hasText: 'mia@designmax.dev' }).first();
  await mail.getByRole('link').click();
  await expect(page.getByText('Blocked vendors must not appear')).toBeVisible();
  await expect(page.getByText('Level L1 (1 of 1)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reject' })).toBeDisabled();   // needs a comment
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Approved');

  // link is single-use
  await page.reload();
  await expect(page.getByText(/This request is approved/)).toBeVisible();

  // back on the ticket: FS locked, TS can now be generated
  await page.goto('/');
  await page.getByRole('region', { name: 'FS Approved' }).getByRole('link', { name: title }).click();
  await expect(page.getByText(/Locked: the ticket is in .FS Approved./)).toBeVisible();
  await page.getByRole('tab', { name: /Technical Spec/ }).click();
  await page.getByRole('button', { name: 'Generate TS draft' }).click();
  await expect(page.getByRole('textbox', { name: 'TS document' })).toContainText('Technical Specification');
  await expect(page.getByRole('textbox', { name: 'TS document' })).toContainText('Blocked vendors must not appear');
});
