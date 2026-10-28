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
  await expect(rae.getByRole('form', { name: 'Create a role for this project' })).toHaveCount(0);
  await expect(rae.getByText('Creating roles of your own needs a Super Admin to allow it for you.')).toBeVisible();

  // the Super Admin allows Rae (and only Rae) in the Platform console
  await sup.goto('/platform#projects');
  const card = sup.getByRole('article', { name: `Project Roles A ${stamp}` });
  await card.getByRole('checkbox', { name: `${names.a} may create roles in Roles A ${stamp}` }).click();
  await expect(sup.getByRole('status')).toContainText(`${names.a} can now create roles`);

  // Rae can create one, starting from a copy of Consultant
  await rae.reload();
  const form = rae.getByRole('form', { name: 'Create a role for this project' });
  await form.getByLabel('Role name').fill('Solution Architect');
  await form.getByLabel('Description').fill('Designs the solution');
  await form.getByLabel('Start from').selectOption({ label: 'Copy of Consultant' });
  await form.getByRole('button', { name: 'Create role' }).click();
  await expect(rae.getByRole('status')).toContainText('Role “Solution Architect” was created for this project');
  const header = rae.getByRole('columnheader', { name: /Solution Architect/ });
  await expect(header).toContainText('This project’s role');
  // it started with the Consultant's permissions, and can be tuned like any role
  await expect(rae.getByRole('checkbox', { name: 'Solution Architect role: Edit specifications' })).toBeChecked();
  await rae.getByRole('checkbox', { name: 'Solution Architect role: Edit specifications' }).uncheck();
  await expect(rae.getByRole('status')).toContainText('Solution Architect can no longer');
  await rae.getByRole('checkbox', { name: 'Solution Architect role: Plan the project' }).check();
  await expect(rae.getByRole('status')).toContainText('can now');

  // give it to someone
  await hash(rae, 'members/new');
  await rae.getByLabel('Email').fill(`arch${stamp}@corp.com`); await rae.getByLabel('First name').fill('Ari');
  await rae.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: 'Solution Architect' });
  await rae.getByRole('button', { name: 'Add member' }).click();
  await expect(rae.getByRole('status')).toContainText('Ari was added');

  // a role in use cannot be deleted; renaming is fine
  await expect(rae.getByRole('heading', { name: 'Ari', level: 4 })).toBeVisible();      // the app has moved to the new person's page
  await hash(rae, 'roles');
  rae.once('dialog', (d) => d.accept());
  await rae.getByRole('button', { name: 'Delete role Solution Architect' }).click();
  await expect(rae.getByRole('alert').filter({ hasText: 'holds this role' })).toBeVisible();
  await rae.getByRole('button', { name: 'Rename role Solution Architect' }).click();
  await rae.getByLabel('New role name').fill('Lead Architect');
  await rae.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(rae.getByRole('columnheader', { name: /Lead Architect/ })).toBeVisible();

  // Ben, in another project, never sees it, and cannot create roles himself
  await ben.goto('/admin#roles');
  await expect(ben.getByRole('columnheader', { name: /Architect/ })).toHaveCount(0);
  await expect(ben.getByRole('form', { name: 'Create a role for this project' })).toHaveCount(0);
  await hash(ben, 'members/new');
  await expect(ben.getByRole('combobox', { name: 'Role', exact: true }).locator('option', { hasText: 'Architect' })).toHaveCount(0);
  // nor does the platform catalog list it
  await hash(sup, 'roles');
  await expect(sup.getByRole('columnheader', { name: /Architect/ })).toHaveCount(0);

  // the Super Admin takes the permission back
  await hash(sup, 'projects');
  await sup.getByRole('article', { name: `Project Roles A ${stamp}` }).getByRole('checkbox', { name: `${names.a} may create roles in Roles A ${stamp}` }).click();
  await expect(sup.getByRole('status')).toContainText('can no longer create roles');
  await rae.reload(); await hash(rae, 'roles');
  await expect(rae.getByRole('form', { name: 'Create a role for this project' })).toHaveCount(0);
  await expect(rae.getByRole('columnheader', { name: /Lead Architect/ })).toBeVisible();      // what exists stays
});
