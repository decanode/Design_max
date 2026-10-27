import { test, expect } from '@playwright/test';

test('an Admin builds a two-level workflow, and a request then walks L1 → L2 with the right people', async ({ browser }) => {
  const stamp = Date.now();
  const project = `Governed ${stamp}`, flow = `Two-step ${stamp}`, title = `Regulated change ${stamp}`;
  const ctxFor = (role: string) => browser.newContext({ storageState: `.auth/${role}.json` });
  const [adminCtx, samCtx, miaCtx, leoCtx] = await Promise.all(['Admin', 'Consultant', 'Manager', 'Lead'].map(ctxFor));
  const admin = await adminCtx.newPage();

  // set up: a project and a ticket assigned to Sam (the consultant who will request approval)
  const proj = await (await admin.request.post('/api/projects', { data: { name: project } })).json();
  const sam = (await (await admin.request.get('/api/auth/dev-users')).json()).find((u: any) => u.role === 'Consultant');
  const t = await (await admin.request.post('/api/tickets', { data: { projectId: proj.id, title } })).json();
  await admin.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });

  // Admin builds the workflow in the UI: L1 = any Manager, L2 = every Lead
  await admin.goto('/admin');
  await admin.getByRole('tab', { name: 'Approval workflows' }).click();
  await admin.getByRole('button', { name: 'New workflow' }).click();
  await admin.getByLabel('Name', { exact: true }).fill(flow);
  await admin.getByLabel('Applies to').selectOption({ label: project });
  await admin.getByLabel('Add an approver to L1').selectOption({ label: 'Manager' });
  await admin.getByRole('button', { name: 'Add level' }).click();
  await admin.getByLabel('Level 2 rule').selectOption('all');
  await admin.getByLabel('Add an approver to L2').selectOption({ label: 'Lead' });
  await admin.getByRole('button', { name: 'Create workflow' }).click();
  await expect(admin.getByRole('status')).toContainText(`Saved “${flow}”`);
  const card = admin.getByRole('article', { name: `Workflow ${flow}` });
  await expect(card.getByRole('list', { name: 'Approval levels in order' }).getByRole('listitem')).toHaveCount(2);
  await expect(card).toContainText('Manager role');
  await expect(card).toContainText('Lead role');

  // Sam drafts the FS and sees the route before requesting
  const sp = await samCtx.newPage();
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
  await lp.goto(`/tickets/${t.id}`);
  await expect(lp.getByRole('heading', { name: /Your decision/ })).toHaveCount(0);

  // Mia (L1) approves in the app
  const mp = await miaCtx.newPage();
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
  await Promise.all([adminCtx, samCtx, miaCtx, leoCtx].map((c) => c.close()));
});

test('a rejection stops the chain and the reason shows to the requester', async ({ browser }) => {
  const stamp = Date.now();
  const title = `Rejected change ${stamp}`;
  const [adminCtx, samCtx, miaCtx] = await Promise.all(['Admin', 'Consultant', 'Manager'].map((r) => browser.newContext({ storageState: `.auth/${r}.json` })));
  const admin = await adminCtx.newPage();
  const proj = await (await admin.request.post('/api/projects', { data: { name: `Rej ${stamp}` } })).json();
  const sam = (await (await admin.request.get('/api/auth/dev-users')).json()).find((u: any) => u.role === 'Consultant');
  const t = await (await admin.request.post('/api/tickets', { data: { projectId: proj.id, title } })).json();
  await admin.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });

  const sp = await samCtx.newPage();
  await sp.goto(`/tickets/${t.id}`);
  await sp.getByRole('button', { name: 'Generate FS draft' }).click();
  await sp.getByRole('button', { name: 'Request approval' }).click();    // default workflow: any Manager

  const mp = await miaCtx.newPage();
  await mp.goto(`/tickets/${t.id}`);
  await mp.getByLabel('Comment').fill('Scope is unclear');
  await mp.getByRole('button', { name: 'Reject' }).click();
  await expect(mp.getByRole('status')).toContainText('Rejected');

  await sp.reload();
  const last = sp.getByRole('region', { name: 'Last approval result' });
  await expect(last).toContainText('Last request was rejected');
  await expect(last).toContainText('Scope is unclear');
  await expect(sp.getByRole('region', { name: 'Approval route' }).getByRole('button', { name: 'Request approval' })).toBeVisible();   // can go again
  await Promise.all([adminCtx, samCtx, miaCtx].map((c) => c.close()));
});
