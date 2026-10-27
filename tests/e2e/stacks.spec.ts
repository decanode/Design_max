import { test, expect } from '@playwright/test';

test('a project limited to SAP: off-stack requests are flagged and blocked, SAP ones go through', async ({ page }) => {
  const project = `SAP Rollout ${Date.now()}`;

  // Admin creates a project and restricts it to SAP
  await page.goto('/admin');
  await page.getByRole('tab', { name: 'Projects & stacks' }).click();
  await page.getByLabel('Project name').fill(project);
  await page.getByRole('form', { name: 'Create a project' }).getByLabel('SAP').check();
  await page.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('status')).toContainText(`“${project}” created`);
  await expect(page.getByRole('group', { name: `Project ${project}` }).getByText('The AI works only in')).toBeVisible();

  // A request that needs another technology
  await page.goto('/chat');
  await page.getByLabel('Project').selectOption({ label: `${project} · SAP` });
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`Conversation · ${project}`) })).toContainText('SAP only');
  await page.getByLabel('Message').fill('Please build a C# ASP.NET web API for our vendor data');
  await page.getByRole('button', { name: 'Send' }).click();

  const summary = page.getByRole('complementary', { name: 'AI requirement summary' });
  await expect(summary.getByRole('alert')).toContainText('Outside this project’s technology');
  await expect(summary.getByRole('alert')).toContainText('limited to SAP');
  await expect(summary.getByRole('button', { name: 'Verify & Approve' })).toBeDisabled();

  // A request inside the stack, in a fresh conversation
  await page.getByLabel('Project').selectOption({ label: `${project} · SAP` });
  await page.getByRole('button', { name: 'Start a conversation' }).click();
  await page.getByLabel('Message').fill('Block vendor Acme in the purchase order BAPI');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(summary.getByRole('heading', { level: 3 })).toContainText('Block vendor Acme');
  await expect(summary.getByRole('alert')).toHaveCount(0);
  await summary.getByRole('button', { name: 'Verify & Approve' }).click();
  await expect(summary.getByText('Verified & logged')).toBeVisible();
});
