import { test, expect } from '@playwright/test';

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
    await cp.getByLabel('Message').fill('Please build a C# ASP.NET web API for our vendor data');
    await cp.getByRole('button', { name: 'Send' }).click();
    const summary = cp.getByRole('complementary', { name: 'AI requirement summary' });
    await expect(summary.getByRole('alert')).toContainText('Outside this project’s technology');
    await expect(summary.getByRole('alert')).toContainText('limited to SAP');
    await expect(summary.getByRole('button', { name: 'Verify & Approve' })).toBeDisabled();

    // …and then a request inside the stack, in a fresh conversation
    await cp.getByRole('button', { name: 'Start a conversation' }).click();
    await cp.getByLabel('Message').fill('Block vendor Acme in the purchase order BAPI');
    await cp.getByRole('button', { name: 'Send' }).click();
    await expect(summary.getByRole('heading', { level: 3 })).toContainText('Block vendor Acme');
    await expect(summary.getByRole('alert')).toHaveCount(0);
    await summary.getByRole('button', { name: 'Verify & Approve' }).click();
    await expect(summary.getByText('Verified & logged')).toBeVisible();
  } finally {
    await pa.reload();
    await pa.getByRole('tab', { name: 'Technology' }).click();
    await pa.getByLabel('SAP').uncheck();
    await expect(pa.getByRole('status')).toContainText('no technology restriction');
    await Promise.all([paCtx, custCtx].map((c) => c.close()));
  }
});
