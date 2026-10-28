import { test as base } from '@playwright/test';

export * from '@playwright/test';

/**
 * Specs open extra browser contexts (one per person in the scenario). Playwright only closes the default one,
 * so over a long run they pile up and the browser runs out of memory. Close whatever a test left behind.
 */
export const test = base.extend<{ closeStrays: void }>({
  closeStrays: [async ({ browser }, use) => { await use(); for (const c of browser.contexts()) await c.close().catch(() => {}); }, { auto: true }],
});
