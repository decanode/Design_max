import { test, expect, type Page } from '@playwright/test';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

test.describe('each role sees its own view', () => {
  const views: [string, string[], string[], string[]][] = [
    // role, nav links shown, nav links hidden, panels visible
    ['Customer', ['Board', 'Chat'], ['Mailbox', 'Admin'], ['Raise a new request']],
    ['Consultant', ['Board', 'Chat'], ['Mailbox', 'Admin'], ['Intake queue']],
    ['Lead', ['Board', 'Chat'], ['Mailbox', 'Admin'], ['Team workload']],
    ['Manager', ['Board', 'Chat'], ['Mailbox', 'Admin'], ['Portfolio']],
    ['Admin', ['Board', 'Chat', 'Mailbox', 'Admin'], [], ['Team workload', 'Portfolio']],
  ];
  for (const [role, shown, hidden, panels] of views) {
    test.describe(role, () => {
      test.use({ storageState: `.auth/${role}.json` });
      test(`${role}: navigation and dashboard panels`, async ({ page }) => {
        await page.goto('/');
        for (const l of shown) await expect(nav(page).getByRole('link', { name: l })).toBeVisible();
        for (const l of hidden) await expect(nav(page).getByRole('link', { name: l })).toHaveCount(0);
        for (const p of panels) await expect(page.getByRole('heading', { name: p, level: 3 })).toBeVisible();
        await expect(page.locator('.role-badge').first()).toHaveText(role);
      });
    });
  }

  test.describe('Customer limits', () => {
    test.use({ storageState: '.auth/Customer.json' });
    test('cannot create tickets or open the admin console', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Create ticket' })).toHaveCount(0);
      await page.goto('/admin');
      await expect(page.getByText('No access')).toBeVisible();
      await page.goto('/mailbox');
      await expect(page.getByText('No access')).toBeVisible();
    });
  });
});

test('signed-out visitors are sent to the sign-in page, and signing in lands on the role view', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
  await page.getByRole('button', { name: /Cleo Customer/ }).click();
  await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});

test('an Admin builds a role, grants it a feature, and the change takes effect for its user', async ({ page, browser }) => {
  const stamp = Date.now();
  const role = `Reviewer ${stamp}`;
  const email = `reviewer${stamp}@corp.com`;
  await page.goto('/admin');

  // build the role
  await page.getByLabel('Role name').fill(role);
  await page.getByLabel('Description').fill('Reads the mailbox');
  await page.getByLabel('Start from').selectOption({ label: 'Copy of Consultant' });
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByRole('status')).toContainText(`“${role}” created`);
  const box = page.getByRole('checkbox', { name: `${role} role: View the dev mailbox` });
  await expect(box).not.toBeChecked();

  // assign it to a new user
  await page.getByRole('tab', { name: 'Users' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Rita Reviewer');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption({ label: role });
  await page.getByRole('button', { name: 'Add user' }).click();
  await expect(page.getByRole('status')).toContainText('Added Rita Reviewer');

  // that user signs in on their own: no Mailbox yet
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const rita = await ctx.newPage();
  await rita.goto('/login');
  await rita.getByRole('button', { name: /Rita Reviewer/ }).click();
  await expect(rita.getByRole('heading', { name: 'My work' })).toBeVisible();
  await expect(nav(rita).getByRole('link', { name: 'Mailbox' })).toHaveCount(0);

  // admin ticks the permission
  await page.getByRole('tab', { name: 'Roles & permissions' }).click();
  await page.getByRole('checkbox', { name: `${role} role: View the dev mailbox` }).check();
  await expect(page.getByRole('status')).toContainText('can now use “View the dev mailbox”');

  await rita.reload();
  await expect(nav(rita).getByRole('link', { name: 'Mailbox' })).toBeVisible();

  // and unticks it again
  await page.getByRole('checkbox', { name: `${role} role: View the dev mailbox` }).uncheck();
  await expect(page.getByRole('status')).toContainText('can no longer use');
  await rita.reload();
  await expect(nav(rita).getByRole('link', { name: 'Mailbox' })).toHaveCount(0);

  // the Admin column is locked
  await expect(page.getByRole('checkbox', { name: 'Admin role: View the dev mailbox' })).toBeDisabled();
  await ctx.close();
});
