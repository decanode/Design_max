import { test, expect } from './fixtures';

test('a Project Admin limits the project to SAP: off-stack requests are flagged and blocked, SAP ones go through', async ({ browser }) => {
  const [paCtx, custCtx] = await Promise.all(['Project Admin', 'Customer'].map((r) => browser.newContext({ storageState: `.auth/${r}.json` })));
  const pa = await paCtx.newPage();
  try {
    // The Project Admin ticks SAP for their project
    await pa.goto('/admin');
    await pa.getByRole('tab', { name: 'Technology' }).click();
    await pa.getByLabel('SAP').check();
    await expect(pa.getByRole('status')).toContainText('only in the ticked technologies');

    // The customer asks for something that needs another technology
    const cp = await custCtx.newPage();
    await cp.goto('/chat');
    await cp.getByRole('button', { name: 'Start a conversation' }).click();
    await expect(cp.getByRole('heading', { name: /^Conversation/ })).toContainText('SAP only');
    const say = async (text: string) => { await cp.getByLabel('Message').fill(text); await cp.getByRole('button', { name: 'Send' }).click(); };
    const scope = cp.getByRole('complementary', { name: 'Scope' });
    await cp.getByRole('button', { name: 'Request a change or new feature' }).click();
    await say('Please build a C# ASP.NET web API for our vendor data');
    await say('Procurement uses it daily, needed by quarter end');
    await expect(scope.getByRole('alert')).toContainText('Outside this project’s technology');
    await expect(scope.getByRole('alert')).toContainText('limited to SAP');
    await expect(scope.getByRole('button', { name: 'Create ticket' })).toBeDisabled();

    // …and then a request inside the stack, in a fresh conversation
    await cp.getByRole('button', { name: 'Start a conversation' }).click();
    await cp.getByRole('button', { name: 'Request a change or new feature' }).click();
    await say('Block vendor Acme in the purchase order BAPI');
    await say('Procurement uses it daily, needed by quarter end');
    await expect(scope.getByRole('heading', { level: 3 })).toContainText('Block vendor Acme');
    await expect(scope.getByRole('alert')).toHaveCount(0);
    await scope.getByRole('button', { name: 'Create ticket' }).click();
    await expect(scope.getByText('Ticket created')).toBeVisible();
  } finally {
    await pa.reload();
    await pa.getByRole('tab', { name: 'Technology' }).click();
    await pa.getByLabel('SAP').uncheck();
    await expect(pa.getByRole('status')).toContainText('no technology restriction');
    await Promise.all([paCtx, custCtx].map((c) => c.close()));
  }
});
