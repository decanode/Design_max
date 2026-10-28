import { test, expect, type Page } from './fixtures';

const nav = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const link = (page: Page, name: string) => nav(page).getByRole('link', { name, exact: true });

test.describe('each role sees its own view', () => {
  const views: [string, string[], string[], string[]][] = [
    // role, nav links shown, nav links hidden, panels visible
    ['Customer', ['Board', 'Chat'], ['Mailbox', 'Project settings', 'Platform'], ['Raise a new request']],
    ['Consultant', ['Board', 'Chat'], ['Mailbox', 'Project settings', 'Platform'], ['Intake queue']],
    ['Lead', ['Board', 'Chat'], ['Mailbox', 'Project settings', 'Platform'], ['Team workload']],
    ['Manager', ['Board', 'Chat'], ['Mailbox', 'Project settings', 'Platform'], ['Portfolio']],
    ['Project Admin', ['Board', 'Chat', 'Project settings'], ['Mailbox', 'Platform'], ['Team workload', 'Portfolio']],
    ['Super Admin', ['Board', 'Chat', 'Mailbox', 'Project settings', 'Platform'], [], ['Team workload', 'Portfolio']],
  ];
  for (const [role, shown, hidden, panels] of views) {
    test.describe(role, () => {
      test.use({ storageState: `.auth/${role}.json` });
      test(`${role}: navigation and dashboard panels`, async ({ page }) => {
        await page.goto('/');
        for (const l of shown) await expect(link(page, l)).toBeVisible();
        for (const l of hidden) await expect(link(page, l)).toHaveCount(0);
        for (const p of panels) await expect(page.getByRole('heading', { name: p, level: 3 })).toBeVisible();
        await expect(page.locator('.role-badge').first()).toHaveText(role);
      });
    });
  }

  test.describe('Customer limits', () => {
    test.use({ storageState: '.auth/Customer.json' });
    test('cannot create tickets or open any admin console', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('button', { name: 'Create ticket' })).toHaveCount(0);
      for (const path of ['/admin', '/platform', '/mailbox']) { await page.goto(path); await expect(page.getByText('No access')).toBeVisible(); }
    });
  });

  test.describe('Project Admin limits', () => {
    test.use({ storageState: '.auth/Project Admin.json' });
    test('runs the project but has no platform powers', async ({ page }) => {
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: /Project settings/ })).toBeVisible();
      await page.goto('/platform'); await expect(page.getByText('No access')).toBeVisible();
      await page.goto('/mailbox'); await expect(page.getByText('No access')).toBeVisible();
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
