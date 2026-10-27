import { test as setup, request as pwRequest } from '@playwright/test';

setup('create demo accounts and a signed-in state per role', async ({ request }) => {
  const baseURL = setup.info().project.use.baseURL!;
  await request.post('/api/auth/bootstrap-demo');
  const users: { id: string; role: string }[] = await (await request.get('/api/auth/dev-users')).json();
  for (const u of users) {
    const ctx = await pwRequest.newContext({ baseURL });
    await ctx.post('/api/auth/dev-login', { data: { userId: u.id } });
    await ctx.storageState({ path: `.auth/${u.role}.json` });
    await ctx.dispose();
  }
});
