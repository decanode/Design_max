import { test, expect, type Browser, type Page } from './fixtures';

const stamp = Date.now();
let n = 0;

/** A fresh project with its own Project Admin signed in. */
async function newProject(browser: Browser) {
  const id = `${stamp}${++n}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const adminName = `Ada Owner ${id}`;
  expect((await sup.request.post('/api/platform/projects', { data: { name: `People ${id}`, admin: { email: `ada${id}@corp.com`, name: adminName } } })).status()).toBe(201);
  const login = async (name: string) => {
    const p = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
    await p.goto('/login'); await p.getByRole('button', { name: new RegExp(name) }).click(); await expect(p.locator('.proj-name')).toHaveText(`People ${id}`);
    return p;
  };
  const admin = await login(adminName);
  const roles: { id: number; name: string }[] = (await (await admin.request.get('/api/project/roles')).json()).roles;
  return { admin, login, roleId: (name: string) => roles.find((r) => r.name === name)!.id, id, adminName };
}
const table = (p: Page) => p.getByRole('table', { name: /Project members/ });

test('Members: a searchable table, and drill-down pages to add someone and change their details', async ({ browser }) => {
  const { admin, roleId, id, adminName } = await newProject(browser);
  // two colleagues to search and filter among
  for (const [first, last, role, title] of [['Sameer', 'Khan', 'Consultant', 'SAP MM Consultant'], ['Siva', 'Raman', 'Lead', 'Delivery Lead']] as const)
    expect((await admin.request.post('/api/project/members', { data: { email: `${first.toLowerCase()}${id}@corp.com`, firstName: first, lastName: last, jobTitle: title, roleId: roleId(role) } })).status()).toBe(201);

  await admin.goto('/admin#members');
  await expect(admin.getByRole('heading', { name: 'Members', level: 3 })).toBeVisible();
  await expect(admin.getByText('Who is in this project and the role each person has.')).toHaveCount(0);   // no explainer under the heading
  const t = table(admin);
  await expect(t.getByRole('row')).toHaveCount(4);                                                          // header + three people
  await expect(t.getByRole('row', { name: new RegExp(adminName) })).toContainText('Project Admin');
  await expect(t.getByRole('row', { name: /Sameer Khan/ })).toContainText('SAP MM Consultant');
  await expect(t.getByRole('row', { name: /Sameer Khan/ })).toContainText(`sameer${id}`);                   // the user ID made from the email

  // search and filter
  await admin.getByLabel('Search members').fill('delivery');
  await expect(t.getByRole('row', { name: /Siva Raman/ })).toBeVisible(); await expect(t.getByRole('row', { name: /Sameer Khan/ })).toHaveCount(0);
  await expect(admin.getByText('1 of 3 people')).toBeVisible();
  await admin.getByLabel('Search members').fill('');
  await admin.getByLabel('Filter by role').selectOption({ label: 'Consultant' });
  await expect(t.getByRole('row', { name: /Sameer Khan/ })).toBeVisible(); await expect(t.getByRole('row', { name: /Siva Raman/ })).toHaveCount(0);
  await admin.getByLabel('Filter by role').selectOption({ label: 'All roles' });
  await admin.getByRole('button', { name: 'Person' }).click();                                              // sort
  await expect(t.getByRole('columnheader', { name: /Person/ })).toHaveAttribute('aria-sort', 'descending');

  // a team to put people in
  await admin.getByRole('tab', { name: 'Teams' }).click();
  await admin.getByRole('button', { name: '+ New team' }).click();
  await admin.getByRole('textbox', { name: 'Name', exact: true }).fill('Procurement');
  await admin.getByRole('button', { name: 'Create team' }).click();
  await expect(admin.getByRole('status')).toContainText('Team “Procurement” was created');
  await admin.getByRole('tab', { name: 'Members' }).click();

  // add a person through the drill-down
  await admin.getByRole('button', { name: '+ Add member' }).click();
  await expect(admin.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Members › New member');
  await admin.getByRole('button', { name: 'Add member' }).click();                                          // nothing filled in
  await expect(admin.getByText('Enter a valid email address')).toBeVisible(); await expect(admin.getByRole('alert').filter({ hasText: 'Choose a role' })).toBeVisible();
  const email = `priya${id}@corp.com`;
  await admin.getByLabel('First name').fill('Priya'); await admin.getByLabel('Last name').fill('Nair'); await admin.getByLabel('Email').fill(email);
  await admin.getByLabel('Phone', { exact: true }).fill('call me'); await admin.getByLabel('Job title').fill('SAP FICO Consultant'); await admin.getByLabel('Department').fill('Finance');
  await admin.getByLabel('Location').fill('Chennai'); await admin.getByLabel('Time zone').selectOption('Asia/Kolkata');
  await admin.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: 'Consultant' });
  await admin.getByRole('checkbox', { name: 'Procurement' }).check();
  await admin.getByRole('button', { name: 'Add member' }).click();
  await expect(admin.getByText('Enter a phone number such as +91 98765 43210')).toBeVisible();              // one field to fix
  await admin.getByLabel('Phone', { exact: true }).fill('+91 98765 43210');
  await admin.getByRole('button', { name: 'Add member' }).click();
  await expect(admin.getByRole('status')).toContainText('Priya Nair was added');
  await expect(admin.getByRole('heading', { name: 'Priya Nair', level: 4 })).toBeVisible();                 // lands on the new person's page
  await expect(admin).toHaveURL(/#members\/[0-9a-f-]{36}$/);

  // change their details
  await admin.getByLabel('Job title').fill('Senior SAP FICO Consultant');
  await admin.getByRole('combobox', { name: 'Role', exact: true }).selectOption({ label: 'Lead' });
  await admin.getByRole('checkbox', { name: 'Procurement' }).uncheck();
  await admin.getByLabel('Manager').selectOption({ label: 'Siva Raman' });
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await expect(admin.getByRole('status')).toContainText('Priya Nair’s details were saved');
  await admin.reload();
  await expect(admin.getByLabel('Job title')).toHaveValue('Senior SAP FICO Consultant');
  await expect(admin.getByLabel('Manager')).toHaveValue(/.+/); await expect(admin.getByRole('checkbox', { name: 'Procurement' })).not.toBeChecked();

  // the table shows it
  await admin.getByRole('button', { name: 'Back to members' }).click();
  const row = table(admin).getByRole('row', { name: /Priya Nair/ });
  await expect(row).toContainText('Lead'); await expect(row).toContainText('Senior SAP FICO Consultant'); await expect(row).toContainText('+91 98765 43210');

  // a duplicate user ID is refused with a message at the field
  await row.getByRole('button', { name: 'Open Priya Nair' }).click();
  await admin.getByLabel('User ID').fill(`sameer${id}`);
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await expect(admin.getByText('That user ID is already taken').first()).toBeVisible();

  // unsaved edits are not lost silently
  admin.once('dialog', (d) => d.dismiss());
  await admin.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Members' }).click();
  await expect(admin.getByRole('heading', { name: 'Priya Nair', level: 4 })).toBeVisible();

  // removal
  admin.once('dialog', (d) => d.accept());
  await admin.getByLabel('User ID').fill(`priya.nair${id}`);
  await admin.getByRole('button', { name: /^Remove Priya/ }).click();
  await expect(admin.getByRole('status')).toContainText('Priya Nair was removed');
  await expect(table(admin).getByRole('row', { name: /Priya Nair/ })).toHaveCount(0);
});

test('Teams: a ticket assigned to a team is visible to that team’s members, and only to them', async ({ browser }) => {
  const { admin, login, roleId, id, adminName } = await newProject(browser);
  const mk = async (first: string) => { const email = `${first.toLowerCase()}${id}@corp.com`; const r = await admin.request.post('/api/project/members', { data: { email, firstName: first, lastName: `Tester${id}`, roleId: roleId('Consultant') } }); expect(r.status()).toBe(201); return (await r.json()).userId as string; };
  const inId = await mk('Inna'), outId = await mk('Otto');

  // a team with Inna in it
  await admin.goto('/admin#teams');
  await admin.getByRole('button', { name: '+ New team' }).click();
  await admin.getByRole('textbox', { name: 'Name', exact: true }).fill('Finance team');
  await admin.getByRole('group', { name: 'Team members' }).getByText(`Inna Tester${id}`).click();
  await admin.getByRole('button', { name: 'Create team' }).click();
  await expect(admin.getByRole('status')).toContainText('Team “Finance team” was created');
  await admin.getByRole('button', { name: 'Back to teams' }).click();
  const teamRow = admin.getByRole('table', { name: /Teams/ }).getByRole('row', { name: /Finance team/ });
  await expect(teamRow).toBeVisible();

  // a ticket with an owner (so it is not in the open queue), given to the team on the ticket page
  const t = await (await admin.request.post('/api/tickets', { data: { title: `Team ticket ${id}` } })).json();
  const me = (await (await admin.request.get('/api/auth/me')).json()).user.id;
  await admin.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: me } });
  await admin.goto(`/tickets/${t.id}`);
  await admin.getByLabel('Assign team').selectOption({ label: 'Finance team' });
  await expect(admin.getByRole('status')).toContainText('Team updated');
  await admin.goto('/');
  await expect(admin.getByRole('region', { name: 'Requirement Verified', exact: true }).locator('article', { hasText: `Team ticket ${id}` })).toContainText('Finance team');

  // Inna (in the team) sees it; Otto (not) does not
  const inna = await login(`Inna Tester${id}`), otto = await login(`Otto Tester${id}`);
  await inna.goto('/');
  await expect(inna.getByRole('link', { name: `Team ticket ${id}` })).toBeVisible();
  await otto.goto('/');
  await expect(otto.getByRole('link', { name: `Team ticket ${id}` })).toHaveCount(0);
  expect((await otto.request.get(`/api/tickets/${t.id}`)).status()).toBe(404);

  // adding Otto to the team from his own page gives him the same access
  await admin.goto(`/admin#members/${outId}`);
  await admin.getByRole('checkbox', { name: 'Finance team' }).check();
  await admin.getByRole('button', { name: 'Save changes' }).click();
  await expect(admin.getByRole('status')).toContainText('details were saved');
  await otto.reload();
  await expect(otto.getByRole('link', { name: `Team ticket ${id}` })).toBeVisible();
  void inId; void adminName;
});
