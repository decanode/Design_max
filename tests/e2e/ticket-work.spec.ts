import { test, expect, type Page } from './fixtures';

const say = async (page: Page, text: string) => { await page.getByLabel('Message').fill(text); await page.getByRole('button', { name: 'Send' }).click(); };

test('a customer raises a ticket; the team works it and asks them to confirm; internal notes stay internal', async ({ browser }) => {
  const customer = await (await browser.newContext({ storageState: '.auth/Customer.json' })).newPage();
  const lead = await (await browser.newContext({ storageState: '.auth/Lead.json' })).newPage();
  const unique = `Printer${Date.now()}`;

  // the customer raises it through the chat assistant
  await customer.goto('/chat');
  await customer.getByRole('button', { name: 'Start a conversation' }).click();
  await customer.getByRole('group', { name: 'Quick replies' }).getByRole('button', { name: 'Report a problem' }).click();
  await expect(customer.getByRole('log')).toContainText('what were you trying to do');
  await say(customer, `The ${unique} will not print invoices`);
  await customer.getByRole('button', { name: 'Raise the incident now' }).click();
  await customer.getByRole('button', { name: 'High, my whole team' }).click();
  const scope = customer.getByRole('complementary', { name: 'Scope' });
  await scope.getByRole('button', { name: 'Create ticket' }).click();
  await scope.getByRole('link', { name: /View ticket/ }).click();

  // the customer sees a proper ticket: key, fields, activity; and can comment
  await expect(customer.getByRole('heading', { level: 2 }).first()).toContainText(unique);
  await expect(customer.getByRole('heading', { level: 2 }).first()).toContainText(/\w+-\d+/);
  const url = customer.url();
  const fields = customer.getByRole('complementary', { name: 'Ticket fields' });
  await expect(fields).toContainText('Priority');
  await customer.getByRole('form', { name: 'Add a comment' }).getByLabel('Comment').fill('Any update on this?');
  await customer.getByRole('button', { name: 'Add comment' }).click();
  await expect(customer.getByRole('list', { name: 'Timeline' })).toContainText('Any update on this?');
  await expect(customer.getByLabel(/Internal note/)).toHaveCount(0);          // a customer cannot write internal notes

  // the team: change priority, leave an internal note, ask the customer to confirm
  await lead.goto(url);
  await lead.getByLabel('Priority').selectOption('Critical');
  await expect(lead.getByRole('status')).toContainText('Priority is now Critical');
  await lead.getByRole('form', { name: 'Add a comment' }).getByLabel('Comment').fill('Spooler restarted, waiting on customer');
  await lead.getByLabel(/Internal note/).check();
  await lead.getByRole('button', { name: 'Add internal note' }).click();
  await expect(lead.getByRole('list', { name: 'Timeline' })).toContainText('Spooler restarted');
  const checklist = lead.getByRole('region', { name: 'Closing checklist' });
  await expect(checklist).toContainText('must confirm it is resolved');
  await checklist.getByRole('button', { name: 'Ask the customer to confirm' }).click();
  await expect(lead.getByRole('region', { name: 'Closing checklist' })).toContainText('Waiting for');

  // the customer answers; they never saw the internal note
  await customer.reload();
  await expect(customer.getByRole('list', { name: 'Timeline' })).not.toContainText('Spooler restarted');
  await customer.getByRole('button', { name: 'Yes, it is resolved' }).click();
  await expect(customer.getByRole('status')).toContainText('Thank you');
  await expect(customer.getByRole('region', { name: 'Closing checklist' })).toContainText('confirmed it is resolved');
  await lead.reload();
  await expect(lead.getByRole('region', { name: 'Closing checklist' })).toContainText('confirmed it is resolved');
});

test('the board has a list view with filters', async ({ browser }) => {
  const lead = await (await browser.newContext({ storageState: '.auth/Lead.json' })).newPage();
  await lead.goto('/');
  await lead.getByRole('tab', { name: 'List' }).click();
  const table = lead.getByRole('table', { name: 'Tickets' });
  await expect(table.getByRole('columnheader', { name: /Priority/ })).toBeVisible();
  await lead.getByLabel('Priority', { exact: true }).selectOption('Critical');
  await expect(table.getByRole('row').nth(1)).toContainText(/Critical|No tickets match/);
  await lead.getByRole('tab', { name: 'Board' }).click();
  await expect(lead.getByRole('group', { name: 'Filter tickets' })).toBeVisible();
});
