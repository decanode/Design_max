import { test, expect } from './fixtures';

test('the Summary has a flow and delivery dashboard, and the builder can stack a report', async ({ browser }) => {
  const lead = await (await browser.newContext({ storageState: '.auth/Lead.json' })).newPage();
  await lead.goto('/dashboards');
  await lead.locator('#dash-pick').selectOption({ label: 'Flow and delivery health (built-in)' });
  await expect(lead.getByRole('heading', { name: 'Pipeline over time' })).toBeVisible();
  await expect(lead.getByRole('heading', { name: 'Where tickets spend their time' })).toBeVisible();
  await expect(lead.getByRole('heading', { name: 'Tickets finished per week' })).toBeVisible();

  // build a stacked report: tickets by phase, stacked by consultant
  await lead.goto('/reports/new');
  await lead.getByLabel('Name').fill(`Stacked ${Date.now()}`);
  await lead.getByRole('button', { name: 'Stacked' }).click();
  await expect(lead.getByLabel('Stack by')).toBeVisible();
  await lead.getByLabel('Group by').selectOption({ label: 'Phase' });
  await lead.getByLabel('Stack by').selectOption({ label: 'Consultant' });
  await expect(lead.getByRole('img', { name: /divided by/ })).toBeVisible();
});

test('a Super Admin compares every project in the portfolio', async ({ browser }) => {
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  await sup.goto('/platform#portfolio');
  const table = sup.getByRole('table', { name: 'Projects compared' });
  await expect(table.getByRole('columnheader', { name: /Lead time p85/ })).toBeVisible();
  await expect(sup.getByLabel('Across every project')).toContainText('active projects');
  await table.getByRole('button', { name: /^Project/ }).click();
  await expect(table.getByRole('columnheader', { name: /Project/ })).toHaveAttribute('aria-sort', 'ascending');
});
