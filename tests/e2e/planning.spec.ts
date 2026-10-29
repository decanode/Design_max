import { test, expect, type Browser, type Page } from './fixtures';

const MOCK = 'http://localhost:4300';
const stamp = Date.now();
let n = 0;

/** A fresh project with its own Project Admin and a Project Manager, both signed in. The Planning module starts OFF. */
async function newProject(browser: Browser) {
  const id = `${stamp}${++n}`;
  const sup = await (await browser.newContext({ storageState: '.auth/Super Admin.json' })).newPage();
  const adminName = `Ann Admin ${id}`, pmName = `Pat Planner ${id}`;
  const made = await sup.request.post('/api/platform/projects', { data: { name: `Plan ${id}`, admin: { email: `ann${id}@corp.com`, name: adminName } } });
  expect(made.status()).toBe(201);
  const login = async (name: string) => {
    const p = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
    await p.goto('/login'); await p.getByRole('button', { name: new RegExp(name) }).click(); await expect(p.locator('.proj-name')).toHaveText(`Plan ${id}`);
    return p;
  };
  const admin = await login(adminName);
  const roles: { id: number; name: string }[] = (await (await admin.request.get('/api/project/roles')).json()).roles;
  const added = await admin.request.post('/api/project/members', { data: { email: `pat${id}@corp.com`, name: pmName, roleId: roles.find((r) => r.name === 'Project Manager')!.id } });
  expect(added.status()).toBe(201);
  const pm = await login(pmName);
  const enable = async (on = true) => expect((await admin.request.put('/api/project/modules', { data: { key: 'planning_module', enabled: on } })).status()).toBe(200);
  return { admin, pm, enable, id };
}
const editor = (p: Page) => p.getByRole('textbox', { name: 'Project charter' });
const board = (p: Page) => p.getByRole('region', { name: 'Work breakdown structure' });

async function runWizard(pm: Page, o: { problem: string; sponsor: string; goals: string; constraints?: string }) {
  await pm.goto('/planning');
  await expect(pm.getByRole('heading', { name: 'What is the business problem?' })).toBeVisible();
  await pm.getByLabel('Business problem').fill(o.problem); await pm.getByRole('button', { name: 'Continue' }).click();
  await pm.getByLabel('Sponsor', { exact: true }).fill(o.sponsor); await pm.getByRole('button', { name: 'Continue' }).click();
  await pm.getByLabel('High-level goals').fill(o.goals); await pm.getByLabel('Known constraints (optional)').fill(o.constraints ?? ''); await pm.getByRole('button', { name: 'Continue' }).click();
}

test('Admin toggle: the Planning tab is hidden until a Project Admin switches the module on', async ({ browser }) => {
  const { admin, pm, enable } = await newProject(browser);
  const planningLink = (p: Page) => p.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Planning' });

  // OFF by default: the Project Manager has no tab, and the page explains why
  await pm.goto('/');
  await expect(pm.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Board', exact: true })).toBeVisible();
  await expect(planningLink(pm)).toHaveCount(0);
  await pm.goto('/planning');
  await expect(pm.getByRole('heading', { name: 'Planning is not switched on' })).toBeVisible();
  expect((await pm.request.get('/api/planning')).status()).toBe(403);                 // the server refuses too, not just the screen

  // the admin finds the switch in Project settings → Modules
  await admin.goto('/admin');
  await admin.getByRole('tab', { name: 'Modules' }).click();
  const sw = admin.getByRole('switch', { name: 'Enable Project charter' });
  await expect(sw).not.toBeChecked();
  await sw.click({ force: true });
  await expect(admin.getByRole('status')).toContainText('is on');
  await expect(sw).toBeChecked();
  await expect(admin.getByRole('switch', { name: 'Enable Work breakdown structure (WBS)' })).not.toBeChecked();   // each part is its own switch

  // the tab appears for the PM
  await pm.goto('/');
  await expect(planningLink(pm)).toBeVisible();
  await planningLink(pm).click();
  await expect(pm.getByRole('heading', { name: 'What is the business problem?' })).toBeVisible();

  // a person without planning rights never gets the tab, even with the module on
  const roles: { id: number; name: string }[] = (await (await admin.request.get('/api/project/roles')).json()).roles;
  await admin.request.post('/api/project/members', { data: { email: `con${stamp}${n}@corp.com`, name: `Cora Consultant ${stamp}${n}`, roleId: roles.find((r) => r.name === 'Consultant')!.id } });
  const cons = await (await browser.newContext({ storageState: { cookies: [], origins: [] } })).newPage();
  await cons.goto('/login'); await cons.getByRole('button', { name: new RegExp(`Cora Consultant ${stamp}${n}`) }).click();
  await expect(planningLink(cons)).toHaveCount(0);

  // switching it off again hides the tab (nothing is deleted)
  await enable(false);
  await pm.goto('/');
  await expect(planningLink(pm)).toHaveCount(0);
});

test('Gemini: the intake wizard sends the answers to the (mocked) Gemini API and the draft lands in the charter editor', async ({ browser }) => {
  const { pm, enable } = await newProject(browser); await enable();
  await pm.request.get(`${MOCK}/__reset`);

  // validation before anything is sent
  await pm.goto('/planning');
  await pm.getByLabel('Business problem').fill('Too short');
  await pm.getByRole('button', { name: 'Continue' }).click();
  await expect(pm.getByText('Describe the business problem in a sentence or two')).toBeVisible();

  // a failing call keeps the answers and says so
  await runWizard(pm, { problem: 'Vendors are paid late, causing supply disruptions and penalties.', sponsor: 'Sue Sponsor, CFO', goals: 'Pay 95% of invoices on time. Halve disputes.', constraints: 'FORCE-FAIL go-live before year end' });
  await expect(pm.getByRole('heading', { name: 'Ready to draft the charter?' })).toBeVisible();
  await pm.getByRole('button', { name: /Draft the charter with Gemini/ }).click();
  await expect(pm.getByRole('status').filter({ hasText: /Drafting|Reading your answers/ })).toBeVisible();     // a visible loading state
  await expect(pm.getByRole('alert').filter({ hasText: 'rejected the request' })).toContainText('Your answers are kept');
  await pm.getByRole('button', { name: 'Edit' }).last().click();                                                // back to goals & constraints
  await pm.getByLabel('Known constraints (optional)').fill('Go-live before year end');
  await pm.getByRole('button', { name: 'Continue' }).click();
  await pm.getByRole('button', { name: /Draft the charter with Gemini/ }).click();

  // the mocked Gemini reply is in the editor, ready to edit
  await expect(editor(pm)).toContainText('GEMINI-MOCK summary for sponsor Sue Sponsor, CFO', { timeout: 30_000 });
  await expect(editor(pm)).toContainText('Automated payment run');                        // scope
  await expect(editor(pm)).toContainText('Poor vendor master data');                      // risks table
  await expect(pm.getByText(/Drafted by gemini-e2e/)).toBeVisible();
  await expect(pm.locator('.rte-status')).toContainText('Live');

  // what Gemini was sent: the key stays server-side, JSON mode, the PM's text fenced as data
  const seen: any[] = await (await pm.request.get(`${MOCK}/__requests`)).json();
  const last = seen[seen.length - 1];
  expect(last.key).toBe('e2e-test-key'); expect(last.json).toBe('application/json');
  expect(last.user).toContain('<intake>'); expect(last.user).toContain('Go-live before year end'); expect(last.user).toContain('Sue Sponsor, CFO');
  const html = await pm.content(); expect(html).not.toContain('e2e-test-key');             // never reaches the browser

  // the PM rewrites the draft by typing in the rich-text editor, then approves
  await editor(pm).click(); await pm.keyboard.press('Control+End'); await pm.keyboard.type(' PM-REWRITE-MARKER');
  await pm.getByRole('button', { name: 'Approve charter' }).click();
  await expect(pm.getByRole('status').filter({ hasText: 'Charter approved' })).toBeVisible();
  await expect(pm.locator('.status-chip')).toHaveText('Approved');
  await expect(editor(pm)).toHaveAttribute('contenteditable', 'false');
  const saved = await (await pm.request.get('/api/planning')).json();
  expect(JSON.stringify(saved.charter.sections)).toContain('PM-REWRITE-MARKER');           // typing was saved, section by section
  expect(saved.charter.sections.executiveSummary).toContain('GEMINI-MOCK');
});

test('WBS: Gemini drafts the breakdown, the PM adds a phase and a work package by hand, and converts it into a ticket', async ({ browser }) => {
  const { pm, enable } = await newProject(browser); await enable();
  // a charter that is already approved (via the API: the wizard is covered above)
  expect((await pm.request.post('/api/planning/charter/generate', { data: { problem: 'Vendors are paid late and complain.', sponsor: 'Sue Sponsor', goals: 'Pay invoices on time' } })).status()).toBe(201);
  expect((await pm.request.post('/api/planning/charter/approve')).status()).toBe(200);

  await pm.goto('/planning');
  await pm.getByRole('list', { name: 'Planning steps' }).getByRole('button', { name: /Work breakdown/ }).click();
  await expect(pm.getByRole('button', { name: 'Generate WBS with Gemini' })).toBeEnabled();
  await pm.getByRole('button', { name: 'Generate WBS with Gemini' }).click();
  await expect(board(pm).getByRole('group', { name: 'Phase Design' })).toBeVisible({ timeout: 30_000 });
  await expect(board(pm).getByRole('group', { name: 'Phase Build' })).toBeVisible();
  await expect(board(pm).getByRole('group', { name: 'Work package Configure the payment run' })).toBeVisible();
  await expect(pm.getByText(/2 phases · 3 deliverables · 4 work packages · 18 person-days/)).toBeVisible();

  // add a parent phase, a child deliverable and a work package, naming each as it appears
  await pm.getByRole('button', { name: '+ Add phase' }).click();
  await pm.getByRole('textbox', { name: 'phase title' }).fill('Mobilise'); await pm.keyboard.press('Enter');
  const phase = board(pm).getByRole('group', { name: 'Phase Mobilise' });
  await expect(phase).toBeVisible();
  await phase.getByRole('button', { name: '+ Add deliverable' }).click();
  await pm.getByRole('textbox', { name: 'deliverable title' }).fill('Kick-off pack'); await pm.keyboard.press('Enter');
  const del = phase.getByRole('group', { name: 'Deliverable Kick-off pack' });
  await expect(del).toBeVisible();
  await del.getByRole('button', { name: '+ Add work package' }).click();
  await pm.getByRole('textbox', { name: 'work package title' }).fill('Run the kick-off'); await pm.keyboard.press('Enter');
  const wp = del.getByRole('group', { name: 'Work package Run the kick-off' });
  await expect(wp).toBeVisible();
  await wp.getByRole('button', { name: 'Edit effort in person-days' }).click();
  await pm.getByRole('spinbutton', { name: 'effort in person-days' }).fill('2'); await pm.keyboard.press('Enter');
  await expect(phase.locator('.chip').first()).toHaveText('2d');                           // effort rolls up to the phase
  await wp.getByRole('button', { name: /Edit work package title/ }).click();                // inline editing of the title
  await pm.getByRole('textbox', { name: 'work package title' }).fill('Run the project kick-off'); await pm.keyboard.press('Enter');
  await expect(del.getByRole('group', { name: 'Work package Run the project kick-off' })).toBeVisible();
  // it was saved on the server
  expect(((await (await pm.request.get('/api/planning')).json()).wbs as any[]).map((e) => e.title)).toContain('Run the project kick-off');

  // convert it into a ticket
  await pm.getByRole('checkbox', { name: 'Select Run the project kick-off' }).check();
  await pm.getByRole('button', { name: 'Convert 1 to tickets' }).click();
  const dialog = pm.getByRole('dialog', { name: 'Convert to tickets' });
  await expect(dialog.getByLabel('Ticket type')).toBeVisible();
  await dialog.getByRole('button', { name: /^Create 1 / }).click();
  await expect(pm.getByRole('status').filter({ hasText: '1 ticket created' })).toBeVisible();
  const row = pm.getByRole('region', { name: 'Tickets from the plan' }).getByRole('row', { name: /Run the project kick-off/ });
  await expect(row).toContainText('Mobilise › Kick-off pack');
  await expect(row).toContainText('Requirement Verified');

  // the ticket is real: on the board, linked back from the plan, and stays converted
  await pm.goto('/');
  await expect(pm.getByRole('region', { name: 'Requirement Verified', exact: true }).getByRole('link', { name: 'Run the project kick-off' })).toBeVisible();
  const tickets: any[] = await (await pm.request.get('/api/tickets')).json();
  const t = tickets.find((x) => x.title === 'Run the project kick-off');
  expect(t.ai_summary).toContain('Mobilise › Kick-off pack'); expect(t.ai_summary).toContain('2 person-days');
  await pm.goto('/planning');
  await expect(board(pm).getByRole('group', { name: 'Work package Run the project kick-off' }).getByRole('link', { name: /Ticket · Requirement Verified/ })).toBeVisible();
  await expect(board(pm).getByRole('checkbox', { name: 'Select Run the project kick-off' })).toBeDisabled();
});

test('WBS: work packages and deliverables move by drag and drop and through the Move to… menu, and the shape rules hold', async ({ browser }) => {
  const { pm, enable } = await newProject(browser); await enable();
  await pm.request.post('/api/planning/charter/generate', { data: { problem: 'Vendors are paid late and complain.', sponsor: 'Sue Sponsor', goals: 'Pay invoices on time' } });
  await pm.request.post('/api/planning/charter/approve');
  await pm.request.post('/api/planning/wbs/generate', { data: {} });
  await pm.setViewportSize({ width: 1600, height: 1500 });                       // the board is tall: both ends of a drag must be on screen
  await pm.goto('/planning');
  const wbs = async () => (await (await pm.request.get('/api/planning')).json()).wbs as any[];
  const parentTitle = async (title: string) => { const all = await wbs(); const e = all.find((x) => x.title === title); return all.find((x) => x.id === e.parentId)?.title; };

  // the keyboard-friendly menu
  await board(pm).getByRole('combobox', { name: 'Move work package Build the portal to' }).selectOption({ label: 'Design › Blueprint' });
  await expect.poll(() => parentTitle('Build the portal')).toBe('Blueprint');
  await expect(board(pm).getByRole('group', { name: 'Deliverable Blueprint' }).getByRole('group', { name: 'Work package Build the portal' })).toBeVisible();

  // drag and drop with the mouse: a work package from one deliverable onto another deliverable's list
  const drag = async (from: ReturnType<Page['locator']>, to: ReturnType<Page['locator']>) => {
    await from.scrollIntoViewIfNeeded();
    const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
    await pm.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await pm.mouse.down();
    await pm.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 4 });
    await pm.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 20 });
    await pm.mouse.up();
  };
  await drag(board(pm).getByRole('button', { name: 'Drag work package Write the blueprint' }), board(pm).getByRole('group', { name: 'Work package Configure the payment run' }));
  await expect.poll(() => parentTitle('Write the blueprint')).toBe('Payment run');

  // a whole deliverable (with its work packages) onto another phase
  await drag(board(pm).getByRole('button', { name: 'Drag deliverable Blueprint' }), board(pm).getByRole('group', { name: 'Deliverable Vendor portal' }));
  await expect.poll(() => parentTitle('Blueprint')).toBe('Build');
  await expect(board(pm).getByRole('group', { name: 'Phase Build' }).getByRole('group', { name: 'Deliverable Blueprint' })).toBeVisible();
  expect((await wbs()).find((e) => e.title === 'Build the portal').level).toBe(3);                     // children came along, still three levels

  // phases reorder with the arrows; a reload shows the saved order
  await board(pm).getByRole('button', { name: 'Move phase Build earlier' }).click();
  await expect.poll(async () => (await wbs()).filter((e) => e.level === 1).sort((a, b) => a.order - b.order).map((e) => e.title)).toEqual(['Build', 'Design']);
  await pm.reload();
  await expect(board(pm).getByRole('group', { name: 'Phase Build' })).toBeVisible();
  expect(await board(pm).locator('[role=group][aria-label^="Phase "]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).toEqual(['Phase Build', 'Phase Design']);

  // the shape rules: the database refuses a fourth level even if the screen were bypassed
  const phaseDesign = (await wbs()).find((e) => e.title === 'Design');
  const refused = await pm.request.post(`/api/planning/wbs/${(await wbs()).find((e) => e.title === 'Build').id}/move`, { data: { parentId: phaseDesign.id, index: 0 } });
  expect(refused.status()).toBe(400);
});
