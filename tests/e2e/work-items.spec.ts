import { test, expect } from './fixtures';

test('the team breaks a ticket into work, tracks it, and a task waits for the one before it', async ({ browser }) => {
  const stamp = Date.now();
  const lead = await (await browser.newContext({ storageState: '.auth/Lead.json' })).newPage();
  const t = await (await lead.request.post('/api/tickets', { data: { title: `Break me down ${stamp}` } })).json();
  await lead.goto(`/tickets/${t.id}`);
  const work = lead.getByRole('region', { name: 'Work' });
  await work.getByRole('button', { name: 'Add the standard tasks' }).click();
  await expect(work).toContainText('0 of 6 done');

  await work.getByLabel('New task').fill('Check the vendor master');
  await work.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(work).toContainText('0 of 7 done');
  await work.getByLabel('State of Check the vendor master').selectOption('done');
  await work.getByLabel('Estimate in hours for Check the vendor master').fill('2');
  await expect(work).toContainText('1 of 7 done');
  await expect(work.getByRole('progressbar', { name: 'Work done' })).toHaveAttribute('aria-valuenow', '14');

  await work.getByRole('button', { name: /Suggest a breakdown/ }).click();
  const suggested = work.getByRole('group', { name: 'Suggested tasks' });
  await expect(suggested).toContainText('Standard tasks');
  await suggested.getByRole('button', { name: 'Dismiss' }).click();

  // the board card shows progress
  await lead.goto('/');
  await expect(lead.locator('article', { hasText: `Break me down ${stamp}` })).toContainText('1/7');
});
