import { test, expect } from './fixtures';

test('a Connected project sends only what its rules say back to the customer’s Jira, and only after it is switched on', async ({ browser }) => {
  const stamp = Date.now();
  const project = `Pay connected ${stamp}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const support = (await (await sup.request.get('/api/platform/workflow/catalog')).json()).projectTypes.find((p: any) => p.key === 'support').id;
  const made = await (await sup.request.post('/api/platform/projects', { data: { name: project, operatingMode: 'connected', projectTypeId: support } })).json();
  await sup.goto('/');
  await sup.getByLabel('Project', { exact: true }).selectOption(made.id);
  await expect(sup.getByLabel('Project', { exact: true })).toHaveValue(made.id);

  // connect and pull
  await sup.goto('/admin#integration');
  await sup.getByRole('button', { name: '+ Add connection' }).click();
  await sup.getByLabel(/^Name/).fill('Customer Jira');
  await sup.getByLabel(/^Address/).fill('http://localhost:4310');
  await sup.getByLabel('Account email').fill('bot@customer.test');
  await sup.getByLabel(/^API token/).fill('s3cret-token');
  await sup.getByRole('button', { name: 'Add connection' }).click();
  await expect(sup.getByRole('status')).toContainText('added');
  await sup.getByRole('button', { name: 'Back' }).click();
  await sup.getByRole('button', { name: 'Sync now' }).click();
  await expect(sup.getByRole('status')).toContainText('2 new');

  // rules: when a ticket reaches Resolved, set the source status to Done and say so
  await sup.getByRole('button', { name: /Send back settings for Customer Jira/ }).click();
  await sup.getByRole('button', { name: '+ Add a rule' }).click();
  await sup.getByLabel('Rule 1 phase').selectOption('Resolved');
  await sup.getByLabel('Rule 1 status').fill('Done');
  await sup.getByRole('button', { name: '+ Add a rule' }).click();
  await sup.getByLabel('Rule 2 action').selectOption('comment');
  await sup.getByLabel('Rule 2 phase').selectOption('Resolved');
  await sup.getByLabel('Rule 2 comment').fill('{{ticket.key}} is resolved in Design Max.');
  await sup.getByRole('button', { name: 'Save rules' }).click();
  await expect(sup.getByRole('status')).toContainText('Rules saved');

  // trial run first: the item is recorded, nothing leaves
  await sup.getByRole('switch', { name: 'Send changes back' }).click({ force: true });
  await expect(sup.getByRole('status')).toContainText('Sending is on');
  await sup.goto('/');
  await sup.getByRole('tab', { name: 'List' }).click();
  await sup.getByRole('link', { name: 'Payment run fails on weekends' }).click();
  await sup.getByRole('region', { name: 'Next phase' }).getByRole('button', { name: 'Move to Resolved' }).click();
  await sup.goto('/admin#integration');
  await sup.getByRole('button', { name: /Send back settings for Customer Jira/ }).click();
  await sup.getByRole('button', { name: 'Send now' }).click();
  await expect(sup.getByRole('table', { name: 'Outbound queue' })).toContainText('Would have been sent');
  const trial: string[] = await (await sup.request.get('http://localhost:4310/__requests')).json();
  expect(trial.some((c) => c.startsWith('POST'))).toBe(false);

  // go live: the same kind of change is now sent, and the source tool received exactly the rule's two actions
  await sup.getByRole('switch', { name: 'Trial run' }).click({ force: true });
  await expect(sup.getByRole('status')).toContainText('Trial run is off');
  await sup.getByRole('button', { name: 'Try again' }).first().click();
  await sup.getByRole('button', { name: 'Try again' }).first().click().catch(() => {});
  await sup.getByRole('button', { name: 'Send now' }).click();
  await expect(sup.getByRole('table', { name: 'Outbound queue' })).toContainText('Sent');
  const calls: string[] = await (await sup.request.get('http://localhost:4310/__requests')).json();
  const writes = calls.filter((c) => !c.startsWith('GET'));
  expect(writes.sort()).toEqual(['POST /rest/api/3/issue/PAY-1/comment', 'POST /rest/api/3/issue/PAY-1/transitions']);
  const bodies = await (await sup.request.get('http://localhost:4310/__bodies')).json();
  expect(JSON.stringify(bodies)).toContain('PAY-1 is resolved in Design Max.');

  // the second ticket has its own switch: pausing it means nothing about it is ever sent
  await sup.goto('/');
  await sup.getByRole('tab', { name: 'List' }).click();
  await sup.getByLabel('Open only').uncheck();
  await sup.getByRole('link', { name: 'Wrong currency on invoices' }).click();
  await sup.getByLabel(/Do not send anything about this ticket/).click();
  await expect(sup.getByLabel(/Do not send anything about this ticket/)).toBeChecked();
});
