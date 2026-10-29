import { test, expect, type Browser, type Page } from './fixtures';

const ctxFor = (browser: Browser, role: string) => browser.newContext({ storageState: `.auth/${role}.json` });
async function switchTo(page: Page, projectId: string) {
  await page.goto('/');
  const menu = page.getByLabel('Project', { exact: true });
  await menu.selectOption(projectId);
  await expect(menu).toHaveValue(projectId);
}

test('a Project Admin requires approval for new Requirements: they wait, a refusal parks them, and an approval releases them', async ({ browser }) => {
  const stamp = Date.now();
  const project = `Zeta approvals ${stamp}`;   // sorts last: people land in their alphabetically first project, which other specs rely on
  const [superCtx, piaCtx, miaCtx, leoCtx] = await Promise.all(['Super Admin', 'Project Admin', 'Manager', 'Lead'].map((r) => ctxFor(browser, r)));
  const sup = await superCtx.newPage();
  const made = await (await sup.request.post('/api/platform/projects', { data: { name: project, admin: { email: 'pia@designmax.dev' } } })).json();
  const pid: string = made.id;

  // Pia adds a Manager (approver) and a Lead (who raises tickets)
  const pia = await piaCtx.newPage();
  await switchTo(pia, pid);
  await pia.goto('/admin');
  for (const [email, role] of [['mia@designmax.dev', 'Manager'], ['leo@designmax.dev', 'Lead']]) {
    await pia.getByRole('button', { name: '+ Add member' }).click();
    await pia.getByLabel('Email').fill(email);
    await pia.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: role });
    await pia.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(pia.getByRole('status')).toContainText(`${email} already had an account`);
    await pia.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Members' }).click();
  }

  // A workflow that approves new Requirements, not documents
  await pia.getByRole('tab', { name: 'Approval workflows' }).click();
  await pia.getByRole('button', { name: 'New workflow' }).click();
  await pia.getByLabel('Name', { exact: true }).fill(`Requirement sign-off ${stamp}`);
  const docs = pia.getByRole('group', { name: 'Documents' });
  await docs.getByLabel('Functional Spec').uncheck(); await docs.getByLabel('Technical Spec').uncheck();
  await pia.getByRole('group', { name: /New tickets/ }).getByLabel('Requirement').check();
  await pia.getByLabel('Add an approver to L1').selectOption({ label: 'Manager' });
  await pia.getByRole('button', { name: 'Create workflow' }).click();
  await expect(pia.getByRole('status')).toContainText('Saved');
  await expect(pia.getByRole('article', { name: `Workflow Requirement sign-off ${stamp}` })).toContainText('New Requirement');

  // Leo raises one: it waits
  const leo = await leoCtx.newPage();
  await switchTo(leo, pid);
  const first = await (await leo.request.post('/api/tickets', { data: { title: `Refuse me ${stamp}` } })).json();
  expect(first.approval_status).toBe('pending');
  await leo.goto(`/tickets/${first.id}`);
  const card = leo.getByRole('region', { name: 'Ticket approval' });
  await expect(card).toContainText('Waiting for approval');
  await expect(leo.getByRole('region', { name: 'Next phase' }).getByRole('button')).toHaveCount(0);   // no moves while waiting

  // Mia refuses it with a reason
  const mia = await miaCtx.newPage();
  await switchTo(mia, pid);
  await mia.goto(`/tickets/${first.id}`);
  await mia.getByRole('region', { name: 'Ticket approval' }).getByLabel(/Comment/).fill('Duplicate of an existing request');
  await mia.getByRole('button', { name: 'Reject', exact: true }).click();
  await expect(mia.getByRole('region', { name: 'Ticket approval' })).toContainText('Not approved');

  // Leo sees why and sends it again; Mia approves; the ticket can move
  await leo.reload();
  await expect(card).toContainText('Duplicate of an existing request');
  await card.getByRole('button', { name: 'Send for approval again' }).click();
  await expect(card).toContainText('Waiting for approval');
  await mia.reload();
  await mia.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(mia.getByRole('region', { name: 'Ticket approval' })).toContainText('Approved');
  await leo.reload();
  await expect(card).toContainText('Approved');
  await expect(leo.getByRole('region', { name: 'Next phase' })).toBeVisible();

  // Later specs create tickets as the Super Admin in whichever project they last touched: leave this one without approvals
  for (const w of await (await pia.request.get('/api/project/workflows')).json()) if ((w.ticketTypeIds ?? []).length) await pia.request.delete(`/api/project/workflows/${w.id}`);
  await Promise.all([superCtx, piaCtx, miaCtx, leoCtx].map((c) => c.close()));
});
