import { test, expect } from './fixtures';

test.use({ storageState: '.auth/Super Admin.json' });

test('Super Admin browses users by project, searches, opens a person and deactivates them; a new user can be created', async ({ page }) => {
  const stamp = Date.now();
  const project = `Browse ${stamp}`, admin = `Una Browse ${stamp}`;
  expect((await page.request.post('/api/platform/projects', { data: { name: project, admin: { email: `una${stamp}@corp.com`, name: admin } } })).status()).toBe(201);

  await page.goto('/platform#users');
  const rail = page.getByRole('complementary', { name: 'Browse users' });
  await rail.getByLabel('Find a project').fill(project);
  await rail.getByRole('button', { name: new RegExp(project) }).click();
  const table = page.getByRole('table', { name: /Users/ });
  await expect(table.getByRole('row', { name: new RegExp(admin) })).toContainText('Project Admin');
  await expect(page.getByText('1 person')).toBeVisible();

  // everyone, narrowed by search
  await rail.getByRole('button', { name: 'All users' }).click();
  await page.getByLabel('Search users').fill(`una${stamp}@corp.com`);
  await expect(page.getByText('1 person match your filters')).toBeVisible();
  await page.getByRole('button', { name: `Open user ${admin}` }).click();

  // the person's page: deactivate, and the list reflects it
  await page.getByRole('switch', { name: `${admin} is active` }).click({ force: true });
  await expect(page.getByRole('status')).toContainText('deactivated');
  await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('button', { name: 'Users' }).click();
  await page.getByLabel('Status').selectOption('inactive');
  await expect(page.getByRole('table', { name: /Users/ }).getByRole('row', { name: new RegExp(admin) })).toContainText('Inactive');

  // create a user
  await page.getByRole('button', { name: '+ New user' }).click();
  await page.getByLabel(/^Name/).fill(`Newt ${stamp}`);
  await page.getByLabel(/^Email/).fill(`newt${stamp}@corp.com`);
  await page.getByRole('button', { name: 'Create user' }).click();
  await expect(page.getByRole('status')).toContainText(`Created Newt ${stamp}`);
});
