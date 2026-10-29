import { test, expect } from './fixtures';

const say = async (page: import('@playwright/test').Page, text: string) => {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
};

test.describe('customer', () => {
test.use({ storageState: '.auth/Customer.json' });

test('customer is greeted, chooses a goal, reviews the full scope and confirms the ticket', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  const log = page.getByRole('log');
  await expect(log).toContainText('What would you like to do');
  await page.getByRole('group', { name: 'Quick replies' }).getByRole('button', { name: 'Report a problem' }).click();
  await expect(log).toContainText('what were you trying to do');

  const unique = `Acme${Date.now()}`;
  await say(page, `Invoices for vendor ${unique} fail to post with a message`);
  await expect(log).toContainText('try these first');          // self-help is offered before an incident
  await page.getByRole('button', { name: 'Raise the incident now' }).click();
  await page.getByRole('button', { name: 'High, my whole team' }).click();
  await expect(log).toContainText('Shall I create this ticket');

  const scope = page.getByRole('complementary', { name: 'Scope' });
  await expect(scope.getByRole('heading', { level: 3 })).toContainText(unique);
  await expect(scope.getByRole('heading', { name: 'Impact and urgency' })).toBeVisible();

  await scope.getByRole('button', { name: 'Create ticket' }).click();
  await expect(scope.getByText('Ticket created')).toBeVisible();
  await expect(scope.getByRole('button', { name: 'Create ticket' })).toHaveCount(0);

  await scope.getByRole('link', { name: /View ticket/ }).click();
  await expect(page.getByRole('heading', { level: 2 }).first()).toContainText(unique);
});

test('a customer who fixes it themselves raises nothing', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await page.getByRole('button', { name: 'Report a problem' }).click();
  await expect(page.getByRole('log')).toContainText('what were you trying to do');
  await say(page, 'The monthly report shows no rows');
  await page.getByRole('button', { name: 'Let me try that first' }).click();
  await page.getByRole('button', { name: 'It worked, thanks' }).click();
  await expect(page.getByRole('log')).toContainText('not raised anything');
  await expect(page.getByRole('complementary', { name: 'Scope' })).toContainText('Solved on your own');
});

});

test.describe('team member', () => {
  test.use({ storageState: '.auth/Consultant.json' });
  test('is offered scoping choices and can finish with a solution, no ticket', async ({ page }) => {
    await page.goto('/chat');
    await page.getByRole('button', { name: 'Start a conversation' }).click();
    await page.getByRole('button', { name: 'Design a solution or logic' }).click();
    await expect(page.getByRole('log')).toContainText('What exactly needs to happen');
    await say(page, 'Block vendor payments when bank details changed recently');
    await expect(page.getByRole('log')).toContainText('Edge cases');
    await say(page, 'No payment run on changed vendors; FI signs off; table LFBK');
    await page.getByRole('button', { name: 'The outline is enough' }).click();
    await expect(page.getByRole('log')).toContainText('Nothing has been raised');
    await expect(page.getByRole('complementary', { name: 'Scope' })).toContainText('Answered without a ticket');
  });
});

test.describe('anyone', () => {
test('conversation survives reload', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await say(page, 'Persistent hello');
  await expect(page.getByRole('log').getByText('Persistent hello')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('log').getByText('Persistent hello')).toBeVisible();
});
});
