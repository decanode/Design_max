import { test, expect } from './fixtures';

test('a Mirror project pulls the customer’s Jira tickets in read-only, and shows their status next to ours', async ({ browser }) => {
  const stamp = Date.now();
  const project = `Pay mirror ${stamp}`;
  const ctx = await browser.newContext({ storageState: '.auth/Super Admin.json' });
  const sup = await ctx.newPage();
  const made = await (await sup.request.post('/api/platform/projects', { data: { name: project, operatingMode: 'mirror' } })).json();

  // the Super Admin works inside the project and connects it
  await sup.goto('/');
  await sup.getByLabel('Project', { exact: true }).selectOption(made.id);
  await expect(sup.getByLabel('Project', { exact: true })).toHaveValue(made.id);
  await sup.goto('/admin#integration');
  await sup.getByRole('button', { name: '+ Add connection' }).click();
  await sup.getByLabel(/^Name/).fill('Customer Jira');
  await sup.getByLabel(/^Address/).fill('http://localhost:4310');
  await sup.getByLabel('Account email').fill('bot@customer.test');
  await sup.getByLabel(/^API token/).fill('s3cret-token');
  await sup.getByLabel('Which issues (JQL)').fill('project = PAY');
  await sup.getByRole('button', { name: 'Add connection' }).click();
  await expect(sup.getByRole('status')).toContainText('Connection “Customer Jira” added');
  await sup.getByRole('button', { name: 'Test connection' }).click();
  await expect(sup.getByText('Signed in as Mock Jira bot')).toBeVisible();
  await sup.getByRole('button', { name: 'Back' }).click();

  // first sync pulls both tickets
  await sup.getByRole('button', { name: 'Sync now' }).click();
  await expect(sup.getByRole('status')).toContainText('2 new');
  await expect(sup.getByText('2 tickets')).toBeVisible();

  // the board shows them under their source keys, and the ticket page shows source and local status side by side
  await sup.goto('/');
  await sup.getByRole('tab', { name: 'List' }).click();
  const table = sup.getByRole('table', { name: 'Tickets' });
  await expect(table.getByRole('link', { name: 'PAY-1' })).toBeVisible();
  await expect(table.getByRole('row', { name: /Wrong currency/ })).toHaveCount(0);            // finished in the source: hidden while "Open only" is on
  await sup.getByLabel('Open only').uncheck();
  await expect(table.getByRole('row', { name: /Wrong currency/ })).toContainText('PAY-2');
  await table.getByRole('link', { name: 'Payment run fails on weekends' }).click();
  const source = sup.getByRole('region', { name: 'Source ticket' });
  await expect(source).toContainText('Jira · PAY-1');
  await expect(source).toContainText('In Progress');
  await expect(sup.getByRole('button', { name: 'Create item' })).toHaveCount(0);

  // a second sync changes nothing, and the only things the mock ever received were reads
  await sup.goto('/admin#integration');
  await sup.getByRole('button', { name: 'Sync now' }).click();
  await expect(sup.getByRole('status')).toContainText('2 unchanged');
  const calls: string[] = await (await sup.request.get('http://localhost:4310/__requests')).json();
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
});
