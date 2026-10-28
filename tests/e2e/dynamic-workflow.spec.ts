import { test, expect, type Browser, type Page } from './fixtures';

const stamp = Date.now();

/** A Super Admin creates a project of the given type with a brand-new Project Admin, who then signs in. */
async function projectWithAdmin(browser: Browser, kind: string, project: string, adminName: string, adminEmail: string): Promise<{ admin: Page; sup: Page }> {
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  await sup.goto('/platform');
  await sup.getByLabel('Project name').fill(project);
  await sup.getByLabel('Project Admin email').fill(adminEmail);
  await sup.getByLabel('Project Admin name').fill(adminName);
  await sup.getByLabel('Project type').selectOption({ label: kind });
  await sup.getByRole('button', { name: 'Create project' }).click();
  await expect(sup.getByRole('status')).toContainText(`Project “${project}” created`);
  const admin = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
  await admin.goto('/login');
  await admin.getByRole('button', { name: new RegExp(adminName) }).click();
  await expect(admin.locator('.proj-name')).toHaveText(project);
  return { admin, sup };
}
const dialog = (p: Page) => p.getByRole('dialog');

test('Scenario 1: a Support project runs on ITIL phases, allows only Incident and Change Request, and an Incident walks the support lifecycle', async ({ browser }) => {
  const { admin: u } = await projectWithAdmin(browser, 'Support', `Support ${stamp}`, 'Sue Support', `sue${stamp}@corp.com`);

  // the board's columns are the ITIL phases, not the old lifecycle
  for (const phase of ['New', 'Triage', 'In Progress', 'Resolved', 'Closed']) await expect(u.getByRole('region', { name: phase, exact: true })).toBeVisible();
  await expect(u.getByRole('region', { name: 'Requirement Verified', exact: true })).toHaveCount(0);
  await expect(u.getByRole('region', { name: 'FS Drafted', exact: true })).toHaveCount(0);

  // only Incident and Change Request can be created
  await u.getByRole('button', { name: 'Create item' }).click();
  const types = dialog(u).getByRole('group', { name: 'Type of item' });
  await expect(types.locator('label.type-card')).toHaveCount(2);
  await expect(types).toContainText('Incident'); await expect(types).toContainText('Change Request');
  for (const other of ['WRICEF', 'Epic', 'Problem', 'Requirement']) await expect(types).not.toContainText(other);

  // Incident form: required fields are enforced before anything is sent
  await dialog(u).getByRole('button', { name: 'Create Incident' }).click();
  await expect(dialog(u).getByText('Give the item a title')).toBeVisible();
  await expect(dialog(u).getByText('Priority is required')).toBeVisible();
  await expect(dialog(u).getByText('Steps to reproduce is required')).toBeVisible();
  const title = `Printer down ${stamp}`;
  await dialog(u).getByLabel('Title').fill(title);
  await dialog(u).getByLabel(/^Priority/).selectOption('P2 - High');
  await dialog(u).getByLabel(/^Impact/).selectOption('Department');
  await dialog(u).getByLabel(/^Steps to reproduce/).fill('Print any document on floor 3');
  await dialog(u).getByRole('button', { name: 'Create Incident' }).click();
  const card = u.getByRole('region', { name: 'New', exact: true }).locator('article', { hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText('INC');

  // the ticket shows its own details and walks the lifecycle with the moves the workflow allows
  await card.getByRole('link', { name: title }).click();
  const details = u.getByRole('region', { name: 'Incident details' });
  await expect(details).toContainText('P2 - High'); await expect(details).toContainText('Print any document on floor 3');
  await expect(u.getByRole('list', { name: 'Ticket lifecycle' })).toContainText('Triage');
  const next = u.getByRole('region', { name: 'Next phase' });
  await expect(next.getByRole('button')).toHaveCount(1);                       // from New the only move is Triage
  for (const step of ['Triage', 'In Progress', 'Resolved', 'Closed']) {
    await next.getByRole('button', { name: `Move to ${step}` }).click();
    await expect(u.getByRole('listitem').filter({ hasText: new RegExp(`^${step}$`) })).toHaveAttribute('aria-current', 'step');
  }
  await expect(u.getByText('Closed is the last phase of this ticket')).toBeVisible();
});

test('Scenario 2: an Implementation project offers WRICEF, renders its fields and saves them to dynamic_metadata', async ({ browser }) => {
  const { admin: u } = await projectWithAdmin(browser, 'Implementation', `Implementation ${stamp}`, 'Ian Implementation', `ian${stamp}@corp.com`);

  await u.getByRole('button', { name: 'Create item' }).click();
  const types = dialog(u).getByRole('group', { name: 'Type of item' });
  await expect(types).toContainText('WRICEF'); await expect(types).toContainText('Epic'); await expect(types).toContainText('Requirement');
  await expect(types).not.toContainText('Incident');

  await types.locator('label.type-card', { hasText: 'WRICEF' }).locator('input').check({ force: true });
  await expect(dialog(u).getByLabel(/^RICEF category/)).toBeVisible();
  await expect(dialog(u).getByLabel(/^SAP module/)).toBeVisible();
  await expect(dialog(u).getByLabel(/^Business value/)).toBeVisible();
  await expect(dialog(u).getByLabel(/^Steps to reproduce/)).toHaveCount(0);    // Incident fields do not leak into WRICEF

  await dialog(u).getByRole('button', { name: 'Create WRICEF' }).click();
  await expect(dialog(u).getByText('RICEF category is required')).toBeVisible();
  const title = `Vendor invoice report ${stamp}`;
  await dialog(u).getByLabel('Title').fill(title);
  await dialog(u).getByLabel(/^RICEF category/).selectOption('Report');
  await dialog(u).getByLabel(/^SAP module/).selectOption('MM');
  await dialog(u).getByLabel(/^Business value/).fill('Fewer invoice errors');
  await dialog(u).getByRole('button', { name: 'Create WRICEF' }).click();

  const card = u.getByRole('region', { name: 'Requirement Verified', exact: true }).locator('article', { hasText: title });
  await expect(card).toBeVisible(); await expect(card).toContainText('WRCF');
  const href = await card.getByRole('link', { name: title }).getAttribute('href');
  const id = href!.split('/').pop();

  // saved in the JSONB column: read it back from the API
  const t = await (await u.request.get(`/api/tickets/${id}`)).json();
  expect(t.ticket.dynamic_metadata).toEqual({ ricef_category: 'Report', sap_module: 'MM', business_value: 'Fewer invoice errors' });
  expect(t.ticketType.key).toBe('wricef');

  // shown on the ticket, and editable with the same validation
  await card.getByRole('link', { name: title }).click();
  const details = u.getByRole('region', { name: 'WRICEF details' });
  await expect(details).toContainText('Report'); await expect(details).toContainText('MM'); await expect(details).toContainText('Fewer invoice errors');
  await details.getByRole('button', { name: 'Edit WRICEF details' }).click();
  await details.getByLabel(/^SAP module/).selectOption('SD');
  await details.getByRole('button', { name: 'Save details' }).click();
  await expect(details.getByRole('button', { name: 'Edit WRICEF details' })).toBeVisible();   // the form closed: it was saved
  await expect(details.locator('dd', { hasText: /^SD$/ })).toBeVisible();
  expect((await (await u.request.get(`/api/tickets/${id}`)).json()).ticket.dynamic_metadata.sap_module).toBe('SD');
});

test('Scenario 3: the state machine refuses to skip phases, in the interface and at the API', async ({ browser }) => {
  const { admin: u } = await projectWithAdmin(browser, 'Implementation', `Violation ${stamp}`, 'Vic Violation', `vic${stamp}@corp.com`);
  const title = `Skip me ${stamp}`;
  const created = await (await u.request.post('/api/tickets', { data: { title } })).json();    // a Requirement, starting in Requirement Verified
  expect(created.current_state).toBe('Requirement Verified');

  // the interface offers no way to jump: the only next step is document-driven and says so
  await u.goto(`/tickets/${created.id}`);
  const next = u.getByRole('region', { name: 'Next phase' });
  await expect(next).toContainText('Generate the Functional Specification to move forward');
  await expect(next.getByRole('button')).toHaveCount(0);
  await expect(u.getByRole('button', { name: /Move to Deployed/ })).toHaveCount(0);

  // the API refuses a jump straight to Deployed, and the document-driven step too
  const jump = await u.request.post(`/api/tickets/${created.id}/transition`, { data: { to: 'Deployed' } });
  expect(jump.status()).toBe(409);
  expect((await jump.json()).error).toMatch(/Illegal transition: Requirement Verified -> Deployed/);
  const gated = await u.request.post(`/api/tickets/${created.id}/transition`, { data: { to: 'FS Drafted' } });
  expect(gated.status()).toBe(409); expect((await gated.json()).error).toMatch(/Generate the Functional Specification/);
  const unknown = await u.request.post(`/api/tickets/${created.id}/transition`, { data: { to: 'Nonexistent phase' } });
  expect(unknown.status()).toBe(409);
  expect((await (await u.request.get(`/api/tickets/${created.id}`)).json()).ticket.current_state).toBe('Requirement Verified');
});

test('Scenario 4: a Project Admin changes the template; a switched-off phase is skipped, locked phases cannot be switched off', async ({ browser }) => {
  const { admin: u } = await projectWithAdmin(browser, 'Implementation', `Builder ${stamp}`, 'Bea Builder', `bea${stamp}@corp.com`);
  await u.goto('/admin');
  await u.getByRole('tab', { name: 'Template builder' }).click();
  await expect(u.getByRole('radio', { name: /Implementation/ })).toBeChecked();
  await expect(u.getByRole('radio', { name: /Waterfall/ })).toBeChecked();

  // phases tied to documents are locked on
  await expect(u.getByRole('switch', { name: 'FS Approved phase' })).toBeDisabled();
  const hyper = u.getByRole('switch', { name: 'Hypercare phase' });
  await expect(hyper).toBeChecked();
  await expect(u.getByRole('list', { name: 'Phases in order' })).toContainText('Hypercare');

  // switching Hypercare off previews the skip and saves
  await hyper.uncheck({ force: true });
  await expect(u.getByRole('list', { name: 'Phases in order' })).not.toContainText('Hypercare');
  await expect(u.getByText('Skipped: Hypercare')).toBeVisible();
  await u.getByRole('button', { name: 'Save template' }).click();
  await expect(u.getByRole('status')).toContainText('Template saved');
  await u.goto('/');
  await expect(u.getByRole('region', { name: 'Hypercare', exact: true })).toHaveCount(0);
  await expect(u.getByRole('region', { name: 'Deployed', exact: true })).toBeVisible();

  // allowing another ticket type makes it appear in the create dialog
  await u.goto('/admin');
  await u.getByRole('tab', { name: 'Template builder' }).click();
  await u.getByRole('switch', { name: 'Allow Bug' }).check({ force: true });
  await u.getByRole('button', { name: 'Save template' }).click();
  await expect(u.getByRole('status')).toContainText('Template saved');
  await u.goto('/');
  await u.getByRole('button', { name: 'Create item' }).click();
  await expect(dialog(u).getByRole('group', { name: 'Type of item' })).toContainText('Bug');
});

test('Scenario 5: a Super Admin defines a new ticket type and the methodology that carries it; a project then uses it', async ({ browser }) => {
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const name = `Risk${stamp}`;
  await sup.goto('/platform');
  await sup.getByRole('tab', { name: 'Workflows' }).click();

  // a new ticket type with a required choice field
  await sup.getByRole('button', { name: 'New ticket type' }).click();
  const form = sup.getByRole('form', { name: 'New ticket type' });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Short tag').fill('RSK');
  await form.getByRole('button', { name: 'Add a field' }).click();
  await form.getByLabel('Field 1 label').fill('Likelihood');
  await form.getByLabel('Field 1 kind').selectOption('select');
  await form.getByLabel('Field 1 options').fill('Rare, Likely, Certain');
  await form.getByRole('group', { name: 'Field 1' }).getByLabel('Required').check();
  await form.getByRole('button', { name: 'Save ticket type' }).click();
  await expect(sup.getByRole('status')).toContainText('Ticket type saved');

  // Agile can carry it (its general flow applies)
  const methods = sup.getByRole('region', { name: 'Methodologies' });
  await methods.getByRole('tab', { name: 'Agile' }).click();
  await methods.getByLabel(name).check();
  await methods.getByRole('button', { name: 'Save methodology' }).click();
  await expect(sup.getByRole('status')).toContainText('Methodology saved');

  // a DevOps project (Agile) can now allow it, and the create dialog renders its field
  const { admin: u } = await projectWithAdmin(browser, 'DevOps', `DevOps ${stamp}`, 'Dev Ops', `dev${stamp}@corp.com`);
  await u.goto('/admin');
  await u.getByRole('tab', { name: 'Template builder' }).click();
  await u.getByRole('switch', { name: `Allow ${name}` }).check({ force: true });
  await u.getByRole('button', { name: 'Save template' }).click();
  await expect(u.getByRole('status')).toContainText('Template saved');
  await u.goto('/');
  await u.getByRole('button', { name: 'Create item' }).click();
  await dialog(u).getByRole('group', { name: 'Type of item' }).locator('label.type-card', { hasText: name }).locator('input').check({ force: true });
  await dialog(u).getByRole('button', { name: `Create ${name}` }).click();
  await expect(dialog(u).getByText('Likelihood is required')).toBeVisible();
  await dialog(u).getByLabel('Title').fill(`Vendor delay ${stamp}`);
  await dialog(u).getByLabel(/^Likelihood/).selectOption('Likely');
  await dialog(u).getByRole('button', { name: `Create ${name}` }).click();
  await expect(u.getByRole('region', { name: 'Backlog', exact: true }).locator('article', { hasText: `Vendor delay ${stamp}` })).toBeVisible();
});
