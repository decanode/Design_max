import { test, expect } from './fixtures';

const stamp = Date.now();
/** Follows an in-page link (#section): what clicking a link to the same page does. */
const hash = (p: import('@playwright/test').Page, h: string) => p.evaluate((x) => { location.hash = x; }, h);

test('A Super Admin lets a Project Admin create roles; the role is private to that project and works like any other', async ({ browser }) => {
  const names = { a: `Rae Admin ${stamp}`, b: `Ben Admin ${stamp}` };
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const mk = async (project: string, admin: string, email: string) => expect((await sup.request.post('/api/platform/projects', { data: { name: project, admin: { email, name: admin } } })).status()).toBe(201);
  await mk(`Roles A ${stamp}`, names.a, `rae${stamp}@corp.com`); await mk(`Roles B ${stamp}`, names.b, `ben${stamp}@corp.com`);
  const login = async (name: string) => { const p = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage(); await p.goto('/login'); await p.getByRole('button', { name: new RegExp(name) }).click(); await expect(p.locator('.proj-name')).toBeVisible(); return p; };
  const rae = await login(names.a), ben = await login(names.b);

  // by default she can only tune the standard roles, and is told how to get more
  await rae.goto('/admin#roles');
  await expect(rae.getByRole('table', { name: /Roles/ })).toBeVisible();
  await expect(rae.getByRole('button', { name: '+ New role' })).toHaveCount(0);
  await expect(rae.getByText('Creating roles of your own needs a Super Admin to allow it for you.')).toBeVisible();

  // the Super Admin allows Rae (and only Rae) in the Platform console
  await sup.goto('/platform#projects');
  const card = sup.getByRole('article', { name: `Project Roles A ${stamp}` });
  await card.getByRole('checkbox', { name: `${names.a} may create roles in Roles A ${stamp}` }).click();
  await expect(sup.getByRole('status')).toContainText(`${names.a} can now create roles`);

  // Rae can now create a role, in two steps: name it (here starting from a copy of Consultant), then choose what it can do
  await rae.reload();
  await rae.getByRole('button', { name: '+ New role' }).click();
  await expect(rae.getByRole('list', { name: 'Steps' }).getByRole('listitem').first()).toHaveAttribute('aria-current', 'step');
  await rae.getByRole('button', { name: 'Create role and continue' }).click();
  await expect(rae.getByText('Give the role a name of at least 2 letters')).toBeVisible();
  await rae.getByLabel('Role name').fill('Consultant');
  await rae.getByRole('button', { name: 'Create role and continue' }).click();
  await expect(rae.getByRole('alert').filter({ hasText: 'already exists' })).toBeVisible();                   // standard names are taken
  await rae.getByLabel('Role name').fill('Solution Architect');
  await rae.getByLabel('What is this role for?').fill('Designs the solution');
  await rae.getByLabel('Start from').selectOption({ label: 'Copy of Consultant' });
  await rae.getByRole('button', { name: 'Create role and continue' }).click();
  await expect(rae.getByText('Step 2: choose what “Solution Architect” can do.')).toBeVisible();
  await expect(rae.getByRole('checkbox', { name: 'Solution Architect role: Edit specifications' })).toBeChecked();     // it started with the Consultant's permissions
  await rae.getByRole('checkbox', { name: 'Solution Architect role: Edit specifications' }).uncheck();
  await expect(rae.getByRole('status')).toContainText('Solution Architect can no longer');
  await rae.getByRole('checkbox', { name: 'Solution Architect role: Plan the project' }).check();
  await expect(rae.getByRole('status')).toContainText('can now');
  await rae.getByRole('tab', { name: 'Field access' }).click();
  await expect(rae.getByLabel('Solution Architect role: Title')).toBeVisible();
  await rae.getByRole('button', { name: 'Done' }).click();
  const row = rae.getByRole('table', { name: /Roles/ }).getByRole('row', { name: /Solution Architect/ });
  await expect(row).toContainText('This project’s role'); await expect(row).toContainText('Designs the solution');

  // give it to someone
  await hash(rae, 'members/new');
  await rae.getByLabel('Email').fill(`arch${stamp}@corp.com`); await rae.getByLabel('First name').fill('Ari');
  await rae.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: 'Solution Architect' });
  await rae.getByRole('button', { name: 'Add member' }).click();
  await expect(rae.getByRole('status')).toContainText('Ari was added');

  // a role in use cannot be deleted; renaming is fine
  await expect(rae.getByRole('heading', { name: 'Ari', level: 4 })).toBeVisible();      // the app has moved to the new person's page
  await hash(rae, 'roles');
  await rae.getByRole('button', { name: 'Open role Solution Architect' }).click();
  await expect(rae.getByRole('link', { name: /Ari/ })).toBeVisible();                   // the people who hold it are listed
  rae.once('dialog', (d) => d.accept());
  await rae.getByRole('button', { name: 'Delete role' }).click();
  await expect(rae.getByRole('alert').filter({ hasText: 'holds this role' })).toBeVisible();
  await rae.getByRole('textbox', { name: 'Name', exact: true }).fill('Lead Architect');
  await rae.getByRole('button', { name: 'Save details' }).click();
  await expect(rae.getByRole('status')).toContainText('Role details saved');
  await expect(rae.getByRole('heading', { name: 'Lead Architect', level: 4 })).toBeVisible();

  // Ben, in another project, never sees it, and cannot create roles himself
  await ben.goto('/admin#roles');
  await expect(ben.getByRole('table', { name: /Roles/ })).toBeVisible();
  await expect(ben.getByRole('row', { name: /Architect/ })).toHaveCount(0);
  await expect(ben.getByRole('button', { name: '+ New role' })).toHaveCount(0);
  await hash(ben, 'members/new');
  await expect(ben.getByRole('combobox', { name: 'Role', exact: true }).locator('option', { hasText: 'Architect' })).toHaveCount(0);
  // nor does the platform catalog list it
  await hash(sup, 'roles');
  await expect(sup.getByRole('table', { name: /Roles/ })).toBeVisible();
  await expect(sup.getByRole('row', { name: /Architect/ })).toHaveCount(0);

  // the Super Admin takes the permission back
  await hash(sup, 'projects');
  await sup.getByRole('article', { name: `Project Roles A ${stamp}` }).getByRole('checkbox', { name: `${names.a} may create roles in Roles A ${stamp}` }).click();
  await expect(sup.getByRole('status')).toContainText('can no longer create roles');
  await rae.reload(); await hash(rae, 'roles');
  await expect(rae.getByRole('button', { name: '+ New role' })).toHaveCount(0);
  await expect(rae.getByRole('row', { name: /Lead Architect/ })).toBeVisible();      // what exists stays
});

test('Roles are maintained in two steps: a list, then the role’s own page; the side-by-side grids are still there', async ({ browser }) => {
  const id = `${stamp}x`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  expect((await sup.request.post('/api/platform/projects', { data: { name: `Roles C ${id}`, admin: { email: `cy${id}@corp.com`, name: `Cy Admin ${id}` } } })).status()).toBe(201);
  const pa = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
  await pa.goto('/login'); await pa.getByRole('button', { name: new RegExp(`Cy Admin ${id}`) }).click(); await expect(pa.locator('.proj-name')).toBeVisible();

  // step one: the list shows every role, what kind it is and how much it can do
  await pa.goto('/admin#roles');
  const table = pa.getByRole('table', { name: /Roles/ });
  await expect(table.getByRole('row', { name: /Consultant/ })).toContainText('Standard');
  await expect(table.getByRole('row', { name: /Project Admin/ })).toContainText('Everything');
  // the comparison grids are one click away
  await pa.getByRole('button', { name: 'Compare permissions' }).click();
  await expect(pa.getByRole('checkbox', { name: 'Consultant role: Edit specifications' })).toBeVisible();
  await pa.getByRole('button', { name: 'Compare ticket fields' }).click();
  await expect(pa.getByLabel('Consultant role: Title', { exact: true })).toBeVisible();
  await pa.getByRole('button', { name: 'Roles', exact: true }).click();

  // step two: open a role, change it, see it marked as customized, and reset it
  await table.getByRole('button', { name: 'Open role Consultant' }).click();
  await expect(pa).toHaveURL(/#roles\/\d+$/);
  await pa.getByLabel('Find a permission').fill('mailbox');
  await expect(pa.getByText('No permission matches.')).toBeVisible();                       // platform powers are not on offer to a project
  await pa.getByLabel('Find a permission').fill('');
  await pa.getByRole('checkbox', { name: 'Consultant role: Create tickets manually' }).check();
  await expect(pa.getByRole('status')).toContainText('Consultant can now “Create tickets manually” in this project');
  await pa.getByRole('button', { name: 'Select all Tickets permissions' }).click();
  await expect(pa.getByRole('status')).toContainText('can now use everything under Tickets');
  await pa.getByRole('tab', { name: 'Field access' }).click();
  await pa.getByLabel('Consultant role: Resolution notes').selectOption('read');
  await expect(pa.getByRole('status')).toContainText('resolution notes is now read only');
  await pa.getByRole('button', { name: 'Reset Consultant ticket fields to the standard role' }).click();
  await expect(pa.getByRole('status')).toContainText('back to the standard ticket-field access');
  await pa.getByRole('tab', { name: /Permissions/ }).click();
  await pa.getByRole('button', { name: 'Reset Consultant to the standard role' }).click();
  await expect(pa.getByRole('status')).toContainText('Consultant is back to the standard');
  await expect(pa.getByRole('checkbox', { name: 'Consultant role: Create tickets manually' })).not.toBeChecked();
  // standard roles cannot be renamed or deleted here
  await expect(pa.getByRole('button', { name: 'Delete role' })).toHaveCount(0);
  await expect(pa.getByRole('form', { name: 'Role details' })).toHaveCount(0);
  await pa.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Roles' }).click();
  await expect(table).toBeVisible();

  // the Platform console uses the same two steps for the standard catalog
  await sup.goto('/platform#roles');
  const cat = sup.getByRole('table', { name: /Roles/ });
  await expect(cat.getByRole('row', { name: /Consultant/ })).toContainText('Built-in');
  await sup.getByRole('button', { name: '+ New role' }).click();
  const nm = `Catalog role ${id}`;
  await sup.getByLabel('Role name').fill(nm);
  await sup.getByRole('button', { name: 'Create role and continue' }).click();
  await expect(sup.getByText(`Step 2: choose what “${nm}” can do.`)).toBeVisible();
  await sup.getByRole('button', { name: 'Done' }).click();
  await expect(cat.getByRole('row', { name: new RegExp(nm) })).toContainText('Custom');
  await cat.getByRole('button', { name: `Open role ${nm}` }).click();
  sup.once('dialog', (d) => d.accept());
  await sup.getByRole('button', { name: 'Delete role' }).click();
  await expect(sup.getByRole('status')).toContainText(`Deleted “${nm}”`);
  await expect(cat.getByRole('row', { name: new RegExp(nm) })).toHaveCount(0);
});
