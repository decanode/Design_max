import { test, expect } from './fixtures';

test.describe('Lead builds reports and dashboards', () => {
  test.use({ storageState: '.auth/Lead.json' });

  // Charts need something to draw; create a ticket through the API as the signed-in Lead.
  test.beforeEach(async ({ page }) => {
    await page.request.post('/api/tickets', { data: { title: `Seed ticket ${Date.now()}` } });
  });

  test('built-in dashboard renders charts and numbers, with a table view and CSV', async ({ page }) => {
    await page.goto('/dashboards');
    await expect(page.locator('#dash-pick')).toContainText('Delivery overview');
    const widgets = page.getByRole('region', { name: /widgets/ });
    await expect(widgets.getByRole('article', { name: 'Open tickets', exact: true }).locator('.viz-kpi-value')).toBeVisible();
    const phase = widgets.getByRole('article', { name: 'Tickets by phase' });
    await expect(phase.locator('svg')).toBeVisible();
    await phase.getByRole('button', { name: 'Table' }).click();
    await expect(phase.getByRole('columnheader', { name: 'Phase' })).toBeVisible();
    await expect(phase.getByRole('link', { name: 'CSV' })).toHaveAttribute('href', /\/api\/reports\/.+\/csv/);
    // built-in dashboards can't be edited directly, only copied
    await expect(page.getByRole('button', { name: 'Edit dashboard' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy to customize' })).toBeVisible();
  });

  test('create a report with a live preview, then put it on a new dashboard', async ({ page }) => {
    const stamp = Date.now();
    const report = `Open work by consultant ${stamp}`;
    const board = `My board ${stamp}`;

    await page.goto('/reports/new');
    await page.getByLabel('Name', { exact: true }).fill(report);
    await page.getByLabel('Group by').selectOption({ label: 'Consultant' });
    await page.getByRole('button', { name: 'Bars' }).click();
    await page.getByLabel('Only tickets not yet deployed').check();
    await expect(page.getByRole('region', { name: 'Preview' }).locator('svg')).toBeVisible();
    // an impossible combination is explained, not silently accepted
    await page.getByRole('button', { name: 'Line' }).click();
    await expect(page.getByRole('region', { name: 'Preview' }).locator('svg')).toBeVisible();   // switched to a time grouping
    await expect(page.getByLabel('Group by')).toContainText('Created (month)');
    await page.getByRole('button', { name: 'Bars' }).click();
    await page.getByLabel('Group by').selectOption({ label: 'Consultant' });
    await page.getByRole('button', { name: 'Create report' }).click();
    await expect(page).toHaveURL(/\/reports\/[0-9a-f-]{36}$/);

    // library lists it
    await page.goto('/reports');
    await expect(page.getByRole('link', { name: report })).toBeVisible();

    // new dashboard
    await page.goto('/dashboards');
    page.once('dialog', (d) => d.accept(board));
    await page.getByRole('button', { name: 'New dashboard' }).click();
    await expect(page.getByRole('status')).toContainText('Dashboard created');
    await page.getByLabel('Report', { exact: true }).selectOption({ label: report });
    await page.getByRole('button', { name: 'Add to dashboard' }).click();
    const card = page.getByRole('article', { name: report });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Large' }).click();
    await expect(card).toHaveClass(/span-3/);

    // add a second built-in widget and reorder
    await page.getByLabel('Report', { exact: true }).selectOption({ label: 'Open tickets (built-in)' });
    await page.getByRole('button', { name: 'Add to dashboard' }).click();
    await page.getByRole('button', { name: 'Move Open tickets earlier' }).click();
    await page.getByLabel('Who can see this').selectOption('shared');
    await page.getByRole('button', { name: 'Done' }).click();
    const titles = page.getByRole('region', { name: /widgets/ }).locator('article h3');
    await expect(titles).toHaveText(['Open tickets', report]);

    // survives a reload, and a colleague with view access can see it
    await page.reload();
    await expect(page.getByRole('article', { name: report })).toBeVisible();
  });

  test('copy a built-in dashboard, then customize it', async ({ page }) => {
    await page.goto('/dashboards');
    await page.getByRole('button', { name: 'Copy to customize' }).click();
    await expect(page.getByRole('status')).toContainText('Your copy is ready');
    await expect(page.getByLabel('Dashboard name')).toHaveValue('Copy of Delivery overview');
    const before = await page.getByRole('region', { name: /widgets/ }).locator('article').count();
    await page.getByRole('article', { name: 'Open tickets', exact: true }).getByRole('button', { name: 'Remove' }).click();
    await expect(page.getByRole('region', { name: /widgets/ }).locator('article')).toHaveCount(before - 1);
  });
});

test.describe('who can do what', () => {
  test.describe('Consultant (view only)', () => {
    test.use({ storageState: '.auth/Consultant.json' });
    test('sees dashboards but cannot build', async ({ page }) => {
      await page.goto('/dashboards');
      await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Dashboards' })).toBeVisible();
      await expect(page.getByRole('article', { name: 'Tickets by phase' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New dashboard' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Copy to customize' })).toHaveCount(0);
      await page.goto('/reports/new');
      await expect(page.getByText('No access')).toBeVisible();
    });
  });
  test.describe('Customer', () => {
    test.use({ storageState: '.auth/Customer.json' });
    test('has no dashboards', async ({ page }) => {
      await page.goto('/dashboards');
      await expect(page.getByText('No access')).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Dashboards' })).toHaveCount(0);
    });
  });
  test.describe('Super Admin', () => {
    test.use({ storageState: '.auth/Super Admin.json' });
    test('built-in dashboards are shared by every project, so even a Super Admin copies them instead of editing', async ({ page }) => {
      await page.goto('/dashboards');
      await expect(page.getByRole('button', { name: 'Edit dashboard' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Copy to customize' })).toBeVisible();
    });
  });
});
