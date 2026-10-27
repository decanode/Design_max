import { test, expect } from '@playwright/test';

test('a Project Admin hides and locks ticket fields per role for their project, and the role\'s screens change at once', async ({ browser }) => {
  const stamp = Date.now();
  const title = `Column security ${stamp}`;
  const [adminCtx, samCtx, leoCtx] = await Promise.all(['Project Admin', 'Consultant', 'Lead'].map((r) => browser.newContext({ storageState: `.auth/${r}.json` })));
  const admin = await adminCtx.newPage();

  // A ticket assigned to Sam, with notes only some roles should see
  const sam = (await (await admin.request.get('/api/auth/dev-users')).json()).find((u: any) => u.role === 'Consultant');
  const t = await (await admin.request.post('/api/tickets', { data: { title } })).json();
  await admin.request.post(`/api/tickets/${t.id}/assign`, { data: { consultantId: sam.id } });
  await admin.request.patch(`/api/tickets/${t.id}`, { data: { resolutionNotes: `SECRET-NOTES-${stamp}`, acceptanceCriteria: 'Must reconcile to ledger' } });

  const setLevel = async (role: string, field: string, level: string, expected: string) => {
    await admin.getByLabel(`${role} role: ${field}`, { exact: true }).selectOption(level);
    await expect(admin.getByRole('status')).toContainText(expected);
  };
  const sp = await samCtx.newPage();

  try {
    // Sam can read AND edit the details by default
    await sp.goto(`/tickets/${t.id}`);
    const details = sp.getByRole('region', { name: 'Ticket details' });
    await expect(details).toContainText(`SECRET-NOTES-${stamp}`);
    await details.getByRole('button', { name: 'Edit details' }).click();
    await details.getByLabel('Acceptance criteria').fill('Must reconcile to the ledger and the bank');
    await details.getByRole('button', { name: 'Save details' }).click();
    await expect(details).toContainText('Must reconcile to the ledger and the bank');

    // The Admin hides resolution notes from Consultants (new grid on the Admin page)
    await admin.goto('/admin');
    await admin.getByRole('tab', { name: 'Ticket fields' }).click();
    await expect(admin.getByLabel('Project Admin role: Resolution notes', { exact: true })).toBeDisabled();   // Project Admin is locked
    await expect(admin.getByLabel('Consultant role: Title', { exact: true }).locator('option[value=hidden]')).toHaveCount(0);   // title can't be hidden
    await expect(admin.getByLabel('Consultant role: Customer', { exact: true }).locator('option[value=write]')).toHaveCount(0); // customer is never editable
    await setLevel('Consultant', 'Resolution notes', 'hidden', 'resolution notes is now hidden');

    // Sam reloads: the notes and even their label are gone from the page
    await sp.reload();
    await expect(sp.getByRole('region', { name: 'Ticket details' })).toBeVisible();
    await expect(sp.getByText(`SECRET-NOTES-${stamp}`)).toHaveCount(0);
    await expect(sp.getByText('Resolution notes')).toHaveCount(0);
    await expect(sp.getByText('Acceptance criteria')).toBeVisible();                                     // other fields unaffected

    // Read-only acceptance criteria: visible, tagged, and not offered for editing
    await setLevel('Consultant', 'Acceptance criteria', 'read', 'acceptance criteria is now read only');
    await sp.reload();
    const d2 = sp.getByRole('region', { name: 'Ticket details' });
    await d2.getByRole('button', { name: 'Edit details' }).click();
    await expect(d2.getByLabel('Acceptance criteria')).toHaveCount(0);
    await expect(d2.getByLabel('Requirement summary')).toBeVisible();                                    // still editable
    await expect(d2.getByText('read only')).toBeVisible();

    // A shared report grouped by consultant stops working for a Lead who can no longer see consultants
    const lp = await leoCtx.newPage();
    await lp.goto('/dashboards');
    const widget = lp.getByRole('article', { name: 'Open workload by consultant' });
    await expect(widget.locator('svg')).toBeVisible();
    await setLevel('Lead', 'Assigned consultant', 'hidden', 'assigned consultant is now hidden');
    await lp.reload();
    await expect(widget.getByRole('alert')).toContainText('consultant');
    await expect(widget.locator('svg')).toHaveCount(0);
    await lp.goto('/');
    await expect(lp.locator('.tag[title="Assigned consultant"]')).toHaveCount(0);                     // no consultant name on any card
  } finally {
    // leave the roles exactly as they were for the other tests: reset each tuned role to the standard one
    await admin.goto('/admin');
    await admin.getByRole('tab', { name: 'Ticket fields' }).click();
    for (const role of ['Consultant', 'Lead']) {
      await admin.getByRole('button', { name: `Reset ${role} to the standard role` }).click();
      await expect(admin.getByRole('status')).toContainText(`${role} is back to the standard role`);
    }
    await Promise.all([adminCtx, samCtx, leoCtx].map((c) => c.close()));
  }
});
