import { test, expect, type Browser, type Page } from './fixtures';

const stamp = Date.now();

/** A Super Admin creates a Support project with a brand-new Project Admin, who then signs in. */
async function supportProject(browser: Browser, project: string, adminName: string, adminEmail: string): Promise<Page> {
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  await sup.goto('/platform');
  await sup.getByRole('button', { name: '+ New project' }).click();
  await sup.getByLabel('Project name').fill(project);
  await sup.getByLabel('Project Admin email').fill(adminEmail);
  await sup.getByLabel('Project Admin name').fill(adminName);
  await sup.getByLabel('Project type').selectOption({ label: 'Support' });
  await sup.getByRole('button', { name: 'Create project' }).click();
  await expect(sup.getByRole('status')).toContainText(`Project “${project}” created`);
  const admin = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
  await admin.goto('/login');
  await admin.getByRole('button', { name: new RegExp(adminName) }).click();
  await expect(admin.locator('.proj-name')).toHaveText(project);
  return admin;
}

test('a Project Admin gives Incidents their own status and moves, and tickets follow it', async ({ browser }) => {
  const u = await supportProject(browser, `Lifecycle ${stamp}`, 'Lena Lifecycle', `lena${stamp}@corp.com`);
  await u.goto('/admin#lifecycles');
  const card = u.locator('li.lc-card', { hasText: 'Incident' });
  await expect(card).toContainText('Standard');
  await expect(card.getByRole('list', { name: 'Incident statuses' })).toContainText('Pending');
  await card.getByRole('button', { name: 'Edit the Incident lifecycle' }).click();

  // a status of the project's own, placed in the flow
  await u.getByLabel('Create a new status').fill('Awaiting Vendor');
  await u.getByLabel('Category', { exact: true }).selectOption({ label: 'Delivery' });
  await u.getByRole('button', { name: 'Create status' }).click();
  await expect(u.getByRole('list').filter({ hasText: 'Awaiting Vendor' }).first()).toBeVisible();

  // Pending is not wanted in this project
  await u.getByRole('button', { name: 'Remove Pending' }).click();

  // a dead end is explained, not saved
  await u.getByRole('button', { name: 'Move Awaiting Vendor earlier' }).click();
  await u.getByLabel('In Progress to Awaiting Vendor').check();
  await u.getByRole('button', { name: 'Save lifecycle' }).click();
  await expect(u.locator('p.err')).toContainText('Awaiting Vendor is a dead end');
  await u.getByLabel('Awaiting Vendor to In Progress').check();
  await u.getByRole('button', { name: 'Save lifecycle' }).click();
  await expect(u.getByRole('status')).toContainText('Incident lifecycle saved');

  // the board has the new column and an incident can use it
  await u.goto('/');
  await expect(u.getByRole('region', { name: 'Awaiting Vendor', exact: true })).toBeVisible();
  await u.getByRole('button', { name: 'Create item' }).click();
  const dlg = u.getByRole('dialog');
  await dlg.getByLabel('Title').fill(`Vendor wait ${stamp}`);
  await dlg.getByLabel(/^Priority/).selectOption('P3 - Medium');
  await dlg.getByLabel(/^Impact/).selectOption('Single user');
  await dlg.getByLabel(/^Steps to reproduce/).fill('Order a part');
  await dlg.getByRole('button', { name: 'Create Incident' }).click();
  await u.getByRole('region', { name: 'New', exact: true }).locator('article', { hasText: `Vendor wait ${stamp}` }).getByRole('link').click();
  const next = u.getByRole('region', { name: 'Next phase' });
  for (const step of ['Triage', 'In Progress']) await next.getByRole('button', { name: `Move to ${step}` }).click();
  await expect(next.getByRole('button', { name: 'Move to Awaiting Vendor' })).toBeVisible();
  await expect(next.getByRole('button', { name: 'Move to Pending' })).toHaveCount(0);        // the standard status is not part of this lifecycle
  await next.getByRole('button', { name: 'Move to Awaiting Vendor' }).click();
  await expect(u.getByRole('listitem').filter({ hasText: /^Awaiting Vendor$/ })).toHaveAttribute('aria-current', 'step');
});
