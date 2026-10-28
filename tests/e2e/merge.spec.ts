import { test, expect } from './fixtures';
import PizZip from 'pizzip';

test('a consultant uploads their own Word file and merges it section by section', async ({ browser }) => {
  const title = `Merge flow ${Date.now()}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const sam = (await (await sup.request.get('/api/auth/dev-users')).json()).find((u: any) => u.role === 'Consultant');
  const t = await (await sup.request.post('/api/tickets', { data: { title } })).json();
  await sup.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });

  const page = await (await browser.newContext({ storageState: '.auth/Consultant.json' })).newPage();
  await page.goto(`/tickets/${t.id}`);
  await page.getByRole('button', { name: 'Generate FS draft' }).click();
  await expect(page.locator('.rte-status')).toContainText('Live');

  // the "offline" file: the downloaded draft, edited in Word (here: the requirement section text replaced)
  const dl = await page.request.get(`/api/tickets/${t.id}/documents/FS/export`);
  const zip = new PizZip(await dl.body());
  const xml = zip.file('word/document.xml')!.asText();
  expect(xml).toContain('Business Requirement');
  zip.file('word/document.xml', xml.replace(/(Business Requirement<\/w:t><\/w:r><\/w:p>[\s\S]*?<w:t[^>]*>)[^<]*/, '$1Rewritten offline by the consultant.'));
  const edited = zip.generate({ type: 'nodebuffer' });

  await page.getByRole('button', { name: /Upload & merge/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Word file/).setInputFiles({ name: 'my-draft.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: edited });
  await expect(dialog.getByText('Business Requirement').first()).toBeVisible();
  await expect(dialog.getByText('Matched').first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Merge into the document' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'Merged' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Functional Spec · v\d/ })).toBeVisible();
  const history = page.getByRole('complementary', { name: 'History' });
  await expect(history.getByText(/Merged from my-draft.docx/)).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'FS document' })).toContainText('Rewritten offline by the consultant.');
});
