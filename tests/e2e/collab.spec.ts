import { test, expect } from '@playwright/test';

test('two people edit one document at the same time and see each other', async ({ browser }) => {
  const title = `Co-edit ${Date.now()}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const sam = (await (await sup.request.get('/api/auth/dev-users')).json()).find((u: any) => u.role === 'Consultant');
  const t = await (await sup.request.post('/api/tickets', { data: { title } })).json();
  await sup.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });
  const con = await (await browser.newContext({ storageState: '.auth/Consultant.json' })).newPage();

  await con.goto(`/tickets/${t.id}`);
  await con.getByRole('button', { name: 'Generate FS draft' }).click();
  await sup.goto(`/tickets/${t.id}`);
  const a = con.getByRole('textbox', { name: 'FS document' }), b = sup.getByRole('textbox', { name: 'FS document' });
  await expect(con.locator('.rte-status')).toContainText('Live');
  await expect(sup.locator('.rte-status')).toContainText('Live');

  await a.click(); await con.keyboard.press('Control+End'); await con.keyboard.type(' Typed by the consultant.');
  await expect(b).toContainText('Typed by the consultant.');            // arrives without a reload
  await b.click(); await sup.keyboard.press('Control+End'); await sup.keyboard.type(' Typed by the admin.');
  await expect(a).toContainText('Typed by the admin.');
  await expect(con.locator('.peer').first()).toBeVisible();              // the other person is shown

  // closing and reopening keeps the shared draft; saving makes a version containing both edits
  await con.reload();
  await expect(con.getByRole('textbox', { name: 'FS document' })).toContainText('Typed by the admin.');
  await con.getByRole('button', { name: 'Save version' }).click();
  await expect(con.getByRole('tab', { name: /Functional Spec · v2/ })).toBeVisible();
  const text = await (await con.request.get(`/api/tickets/${t.id}/documents/FS/versions/2`)).json();
  expect(text.content_md).toContain('Typed by the consultant.'); expect(text.content_md).toContain('Typed by the admin.');
});

test('unit test and code review documents are created in delivery and show beside the specifications', async ({ browser }) => {
  const title = `Delivery docs ${Date.now()}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const t = await (await sup.request.post('/api/tickets', { data: { title } })).json();
  await sup.goto(`/tickets/${t.id}`);
  await sup.getByRole('tab', { name: /Unit Test/ }).click();
  await expect(sup.getByText(/can be generated once the ticket is in Development/)).toBeVisible();
  await sup.getByRole('tab', { name: /Code Review/ }).click();
  await expect(sup.getByText(/can be generated once the ticket is in Development/)).toBeVisible();
});
