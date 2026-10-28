import { test, expect, type Browser, type Page } from './fixtures';

const ctxFor = (browser: Browser, role: string) => browser.newContext({ storageState: `.auth/${role}.json` });
/** Works in `projectId` via the project menu in the header (people in several projects choose which one they are in). */
async function switchTo(page: Page, projectId: string) {
  await page.goto('/');
  const menu = page.getByLabel('Project', { exact: true });
  await menu.selectOption(projectId);
  await expect(menu).toHaveValue(projectId);
}

test('a Project Admin sets up a project and its two-level workflow; a request then walks L1 → L2 with the right people', async ({ browser }) => {
  const stamp = Date.now();
  const project = `Governed ${stamp}`, flow = `Two-step ${stamp}`, title = `Regulated change ${stamp}`;
  const [superCtx, piaCtx, samCtx, miaCtx, leoCtx] = await Promise.all(['Super Admin', 'Project Admin', 'Consultant', 'Manager', 'Lead'].map((r) => ctxFor(browser, r)));
  const sup = await superCtx.newPage();

  // The Super Admin creates the project and appoints Pia as its Project Admin; from here Pia runs it.
  const made = await (await sup.request.post('/api/platform/projects', { data: { name: project, admin: { email: 'pia@designmax.dev' } } })).json();
  const projectId: string = made.id;

  // Pia switches into it and adds the people who will work in it
  const pia = await piaCtx.newPage();
  await switchTo(pia, projectId);
  await pia.goto('/admin');
  await expect(pia.getByRole('heading', { name: new RegExp(`Project settings.*${project}`) })).toBeVisible();
  for (const [email, role] of [['sam@designmax.dev', 'Consultant'], ['mia@designmax.dev', 'Manager'], ['leo@designmax.dev', 'Lead']]) {
    await pia.getByLabel('Email').fill(email);
    await pia.getByLabel('Role', { exact: true }).selectOption({ label: role });
    await pia.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(pia.getByRole('status')).toContainText(`${email} was added to this project`);
  }

  // A ticket assigned to Sam, in this project (the API call uses the project Pia is working in)
  const sam = (await (await pia.request.get('/api/project/members')).json()).find((m: any) => m.email === 'sam@designmax.dev');
  const t = await (await pia.request.post('/api/tickets', { data: { title } })).json();
  await pia.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });

  // Pia turns the project's own copy of the standard workflow into L1 = any Manager, L2 = every Lead
  await pia.getByRole('tab', { name: 'Approval workflows' }).click();
  await pia.getByRole('article', { name: 'Workflow Standard approval' }).getByRole('button', { name: 'Edit' }).click();
  await pia.getByLabel('Name', { exact: true }).fill(flow);
  await pia.getByRole('button', { name: 'Add level' }).click();
  await pia.getByLabel('Level 2 rule').selectOption('all');
  await pia.getByLabel('Add an approver to L2').selectOption({ label: 'Lead' });
  await pia.getByRole('button', { name: 'Save changes' }).click();
  await expect(pia.getByRole('status')).toContainText(`Saved “${flow}”`);
  const card = pia.getByRole('article', { name: `Workflow ${flow}` });
  await expect(card.getByRole('list', { name: 'Approval levels in order' }).getByRole('listitem')).toHaveCount(2);

  // Sam drafts the FS and sees the route before requesting
  const sp = await samCtx.newPage();
  await switchTo(sp, projectId);
  await sp.goto(`/tickets/${t.id}`);
  await sp.getByRole('button', { name: 'Generate FS draft' }).click();
  const route = sp.getByRole('region', { name: 'Approval route' });
  await expect(route).toContainText(flow);
  await expect(route.getByRole('list', { name: 'Approval levels in order' }).getByRole('listitem')).toHaveCount(2);
  await route.getByRole('button', { name: 'Request approval' }).click();
  const progress = sp.getByRole('list', { name: 'Approval progress' });
  await expect(progress.locator(':scope > li').nth(0)).toContainText('Waiting for approval');
  await expect(progress.locator(':scope > li').nth(1)).toContainText('Not started');

  // L2 is not asked yet: Leo has nothing to approve
  const lp = await leoCtx.newPage();
  await switchTo(lp, projectId);
  await lp.goto(`/tickets/${t.id}`);
  await expect(lp.getByRole('heading', { name: /Your decision/ })).toHaveCount(0);

  // Mia (L1) approves in the app
  const mp = await miaCtx.newPage();
  await switchTo(mp, projectId);
  await mp.goto(`/tickets/${t.id}`);
  await expect(mp.getByRole('heading', { name: /Your decision at L1/ })).toBeVisible();
  await mp.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(mp.getByRole('status')).toContainText('Approved');

  // now L2 is active: Leo is asked, and Sam's view shows L1 done / L2 waiting
  await sp.reload();
  const steps = sp.getByRole('list', { name: 'Approval progress' }).locator(':scope > li');
  await expect(steps.nth(0)).toContainText('Approved');
  await expect(steps.nth(1)).toContainText('Waiting for approval');
  await expect(sp.getByRole('list', { name: 'Ticket lifecycle' }).locator('[aria-current=step]')).toHaveText('FS Drafted');   // not approved until L2 signs off
  await lp.reload();
  await expect(lp.getByRole('heading', { name: /Your decision at L2/ })).toBeVisible();
  await lp.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(lp.getByRole('status')).toContainText('Approved');

  // fully approved: the ticket moved on
  await sp.reload();
  await expect(sp.getByRole('listitem').filter({ hasText: 'FS Approved' }).first()).toHaveAttribute('aria-current', 'step');
  await Promise.all([superCtx, piaCtx, samCtx, miaCtx, leoCtx].map((c) => c.close()));
});

test('a rejection stops the chain and the reason shows to the requester', async ({ browser }) => {
  const stamp = Date.now();
  const title = `Rejected change ${stamp}`;
  const [superCtx, samCtx, miaCtx] = await Promise.all(['Super Admin', 'Consultant', 'Manager'].map((r) => ctxFor(browser, r)));
  const admin = await superCtx.newPage();
  const sam = (await (await admin.request.get('/api/auth/dev-users')).json()).find((u: any) => u.role === 'Consultant');
  const t = await (await admin.request.post('/api/tickets', { data: { title } })).json();
  await admin.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });

  const sp = await samCtx.newPage();
  await sp.goto(`/tickets/${t.id}`);
  await sp.getByRole('button', { name: 'Generate FS draft' }).click();
  await sp.getByRole('button', { name: 'Request approval' }).click();    // the project's default workflow: any Manager

  const mp = await miaCtx.newPage();
  await mp.goto(`/tickets/${t.id}`);
  await mp.getByPlaceholder('Comment (required to reject)').fill('Scope is unclear');
  await mp.getByRole('button', { name: 'Reject' }).click();
  await expect(mp.getByRole('status')).toContainText('Rejected');

  await sp.reload();
  const last = sp.getByRole('region', { name: 'Last approval result' });
  await expect(last).toContainText('Last request was rejected');
  await expect(last).toContainText('Scope is unclear');
  await expect(sp.getByRole('region', { name: 'Approval route' }).getByRole('button', { name: 'Request approval' })).toBeVisible();   // can go again
  await Promise.all([superCtx, samCtx, miaCtx].map((c) => c.close()));
});
