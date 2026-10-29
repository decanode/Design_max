import { test, expect } from './fixtures';

test.use({ storageState: '.auth/Super Admin.json' });

test('Super Admin adds a technology with keywords, tests a sentence against them, and deletes it', async ({ page }) => {
  const name = `Tech${Date.now()}`;
  await page.goto('/platform#stacks');
  await page.getByRole('button', { name: '+ Add technology' }).click();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel('What it covers').fill('A test technology');
  const kw = page.getByLabel('Add a keyword');
  await kw.fill('apex'); await kw.press('Enter');
  await kw.fill('soql, lightning'); 
  await expect(page.getByRole('list', { name: 'Keywords' }).getByText('lightning')).toBeVisible();

  await page.getByLabel('Sentence to test').fill('Write an Apex trigger for accounts');
  await expect(page.getByRole('status').filter({ hasText: 'Recognised' })).toBeVisible();
  await page.getByLabel('Sentence to test').fill('Write a javascript snippet');
  await expect(page.getByRole('status').filter({ hasText: 'Not recognised' })).toBeVisible();

  await page.getByRole('button', { name: 'Add technology', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText(`Added the ${name} technology`);
  await page.getByRole('button', { name: `Open technology ${name}` }).click();
  await page.getByRole('button', { name: 'Remove keyword soql' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText(`Saved ${name}`);

  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText(`Deleted ${name}`);
});
