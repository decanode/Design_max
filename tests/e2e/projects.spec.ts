import { test, expect, type Browser } from '@playwright/test';

const ctxFor = (browser: Browser, role: string) => browser.newContext({ storageState: `.auth/${role}.json` });

test('Super Admin creates a project; its new Project Admin sees only that project, and other projects see nothing of it', async ({ browser }) => {
  const stamp = Date.now();
  const project = `Gamma ${stamp}`, adminEmail = `gina${stamp}@corp.com`, ticketTitle = `Gamma secret ${stamp}`;
  const sup = await (await ctxFor(browser, 'Super Admin')).newPage();

  // Platform console: create the project with a brand-new Project Admin
  await sup.goto('/platform');
  await sup.getByLabel('Project name').fill(project);
  await sup.getByLabel('Project Admin email').fill(adminEmail);
  await sup.getByLabel('Project Admin name').fill('Gina Admin');
  await sup.getByRole('button', { name: 'Create project' }).click();
  await expect(sup.getByRole('status')).toContainText(`Project “${project}” created`);
  const card = sup.getByRole('article', { name: `Project ${project}` });
  await expect(card).toContainText('Gina Admin');

  // Gina signs in: her account exists, she is Project Admin of exactly one project, and that is where she lands
  const gctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const g = await gctx.newPage();
  await g.goto('/login');
  await g.getByRole('button', { name: /Gina Admin/ }).click();
  await expect(g.locator('.proj-name')).toHaveText(project);
  await expect(g.getByLabel('Project', { exact: true })).toHaveCount(0);            // nothing to switch between
  await expect(g.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Platform' })).toHaveCount(0);

  // She creates a ticket; nobody outside this project can see it
  await g.getByLabel('New ticket title').fill(ticketTitle);
  await g.getByRole('button', { name: 'Create ticket' }).click();
  await expect(g.getByRole('region', { name: 'Requirement Verified' }).getByRole('link', { name: ticketTitle })).toBeVisible();

  const pia = await (await ctxFor(browser, 'Project Admin')).newPage();            // a Project Admin of a different project
  await pia.goto('/');
  await expect(pia.getByText(ticketTitle)).toHaveCount(0);
  const list: any[] = await (await pia.request.get('/api/tickets')).json();
  expect(list.map((t) => t.title)).not.toContain(ticketTitle);

  // The Super Admin can step in to help, and the project's own admin can see that they did
  await sup.getByRole('button', { name: 'Open project' }).first().waitFor();
  await card.getByRole('button', { name: 'Open project' }).click();
  await expect(sup.getByRole('article', { name: `Project ${project}` }).getByText('Working here')).toBeVisible();
  await sup.goto('/');
  await expect(sup.getByRole('region', { name: 'Requirement Verified' }).getByRole('link', { name: ticketTitle })).toBeVisible();
  await g.goto('/admin');
  await g.getByRole('tab', { name: 'Activity' }).click();
  await expect(g.getByText('Super Admin entered')).toBeVisible();

  // Archiving cuts access off at once
  await sup.goto('/platform');
  sup.once('dialog', (d) => d.accept());
  await sup.getByRole('article', { name: `Project ${project}` }).getByRole('button', { name: 'Archive' }).click();
  await expect(sup.getByRole('status')).toContainText('is now archived');
  await g.goto('/');
  await expect(g.getByText('You are not in a project yet')).toBeVisible();
  await gctx.close();
});

test('a Project Admin tunes a role for their project, and the change is theirs alone', async ({ browser }) => {
  const [paCtx, samCtx] = await Promise.all(['Project Admin', 'Consultant'].map((r) => ctxFor(browser, r)));
  const pa = await paCtx.newPage(), sp = await samCtx.newPage();
  await sp.goto('/');
  await expect(sp.getByRole('button', { name: 'Create ticket' })).toHaveCount(0);                // Consultants cannot create tickets by default

  await pa.goto('/admin');
  await pa.getByRole('tab', { name: 'Roles & permissions' }).click();
  const box = pa.getByRole('checkbox', { name: 'Consultant role: Create tickets manually' });
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(pa.getByRole('status')).toContainText('Consultant can now “Create tickets manually” in this project');
  await expect(pa.getByText('Customized').first()).toBeVisible();
  await expect(pa.getByRole('checkbox', { name: 'Project Admin role: Create tickets manually' })).toBeDisabled();
  await expect(pa.getByRole('checkbox', { name: /Consultant role: View the dev mailbox/ })).toHaveCount(0);   // platform powers are not on offer

  await sp.reload();
  await expect(sp.getByRole('button', { name: 'Create ticket' })).toBeVisible();

  await pa.getByRole('button', { name: 'Reset Consultant to the standard role' }).click();
  await expect(pa.getByRole('status')).toContainText('back to the standard role');
  await sp.reload();
  await expect(sp.getByRole('button', { name: 'Create ticket' })).toHaveCount(0);
  await Promise.all([paCtx, samCtx].map((c) => c.close()));
});
