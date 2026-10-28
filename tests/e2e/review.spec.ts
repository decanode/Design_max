import { test, expect } from './fixtures';

test('a lead comments on selected text, the consultant replies and addresses it, the lead resolves it', async ({ browser }) => {
  const title = `Review flow ${Date.now()}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const users = await (await sup.request.get('/api/auth/dev-users')).json();
  const sam = users.find((u: any) => u.role === 'Consultant');
  const t = await (await sup.request.post('/api/tickets', { data: { title } })).json();
  await sup.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });

  const con = await (await browser.newContext({ storageState: '.auth/Consultant.json' })).newPage();
  await con.goto(`/tickets/${t.id}`);
  await con.getByRole('button', { name: 'Generate FS draft' }).click();
  await expect(con.locator('.rte-status')).toContainText('Live');
  const text = con.getByRole('textbox', { name: 'FS document' });
  await text.click(); await con.keyboard.press('Control+End'); await con.keyboard.type(' The vendor block must apply to purchase orders.');
  await con.getByRole('button', { name: 'Save version' }).click();
  await expect(con.getByRole('tab', { name: /Functional Spec · v2/ })).toBeVisible();

  // the lead selects a phrase and comments
  const lead = await (await browser.newContext({ storageState: '.auth/Lead.json' })).newPage();
  await lead.goto(`/tickets/${t.id}`);
  const doc = lead.getByRole('textbox', { name: 'FS document' });
  await expect(doc).toContainText('purchase orders');
  await doc.getByText('The vendor block must apply to purchase orders.', { exact: false }).first().dblclick();   // selects a word
  await lead.keyboard.press('Shift+End');
  const box = lead.getByRole('textbox', { name: 'Comment on selection' });
  await box.fill('Which purchase order types?');
  await lead.getByRole('button', { name: 'Comment on selection' }).click();
  await expect(lead.getByRole('region', { name: 'Review comments' })).toContainText('Which purchase order types?');
  await expect(lead.locator('.cmt').first()).toBeVisible();                // the text is highlighted
  await lead.getByRole('button', { name: 'Request changes' }).click();

  // the consultant sees the thread (highlight too), replies and marks it addressed
  const panel = con.getByRole('region', { name: 'Review comments' });
  await expect(panel).toContainText('Which purchase order types?', { timeout: 15000 });
  await expect(con.getByRole('tab', { name: /Functional Spec · v2 · 1 open/ })).toBeVisible();
  await expect(con.locator('.cmt').first()).toBeVisible();
  await panel.getByRole('button', { name: 'Reply' }).click();
  await panel.getByRole('textbox', { name: 'Reply' }).fill('Standard and framework orders.');
  await panel.getByRole('button', { name: 'Reply', exact: true }).last().click();
  await expect(panel).toContainText('Standard and framework orders.');
  await panel.getByRole('button', { name: 'Mark addressed' }).click();
  await expect(panel.locator('.cm-chip').first()).toHaveText('Addressed');
  await expect(panel.getByRole('button', { name: 'Resolve' })).toHaveCount(0);   // the editor cannot resolve

  // the lead resolves and passes the review
  await expect(lead.getByRole('region', { name: 'Review comments' }).locator('.cm-chip').first()).toHaveText('Addressed', { timeout: 15000 });
  await lead.getByRole('button', { name: 'Resolve' }).click();
  await expect(lead.getByText('Nothing open. All comments are resolved.')).toBeVisible();
  await lead.getByRole('button', { name: 'Looks good' }).click();
  await expect(lead.getByText(/Latest review: Looks good/)).toBeVisible();
});
