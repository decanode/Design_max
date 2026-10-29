import { test, expect } from './fixtures';

test('a Super Admin chooses how much of the lifecycle a project runs here, and the project reflects it', async ({ browser }) => {
  const stamp = Date.now();
  const project = `Mirror ${stamp}`, adminEmail = `mona${stamp}@corp.com`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  await sup.goto('/platform#projects');
  await sup.getByRole('button', { name: '+ New project' }).click();
  await sup.getByLabel('Project name').fill(project);
  await sup.getByLabel('Project Admin email').fill(adminEmail);
  await sup.getByLabel('Project Admin name').fill('Mona Mirror');
  await sup.getByRole('radio', { name: /Mirror \(read-only\)/ }).click();
  await sup.getByRole('button', { name: 'Create project' }).click();
  await expect(sup.getByRole('status')).toContainText(`Project “${project}” created`);
  await expect(sup.getByRole('row', { name: new RegExp(project) })).toContainText('Mirror');

  // the project admin sees the mode, and cannot create tickets here
  const admin = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
  await admin.goto('/login');
  await admin.getByRole('button', { name: /Mona Mirror/ }).click();
  await expect(admin.locator('.proj-name')).toHaveText(project);
  await expect(admin.locator('.mode-chip')).toContainText('Mirror');
  await expect(admin.getByRole('button', { name: 'Create item' })).toHaveCount(0);
  expect((await admin.request.post('/api/tickets', { data: { title: 'Nope' } })).status()).toBe(403);

  // the Super Admin changes the mode; nothing else needed
  await sup.getByRole('button', { name: `Open project ${project}` }).click();
  await sup.getByRole('radio', { name: /Full adoption/ }).click();
  sup.once('dialog', (d) => d.accept());
  await sup.getByRole('button', { name: 'Change to Full adoption' }).click();
  await expect(sup.getByRole('status')).toContainText('now runs in Full adoption mode');
  await admin.reload();
  await expect(admin.locator('.mode-chip')).toHaveCount(0);
  await expect(admin.getByRole('button', { name: 'Create item' })).toBeVisible();
});
