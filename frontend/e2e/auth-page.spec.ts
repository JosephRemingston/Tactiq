import { expect, test } from '@playwright/test';

test('serves the auth tester with a healthy API and Clerk sign-in', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Touchline' })).toBeVisible();
  await expect(page.getByText('API ready')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'What this page tests' })).toBeVisible();
  // Clerk renders its sign-in card once clerk-js has loaded from the instance's Frontend API.
  await expect(page.locator('.cl-signIn-root, .cl-rootBox').first()).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: process.env.SCREENSHOT ?? 'test-results/auth-tester.png', fullPage: true });
  expect(consoleErrors.filter((e) => !/favicon/i.test(e))).toEqual([]);
});

test('API routes are served from the same origin through Netlify rewrites', async ({ request }) => {
  expect((await request.get('/healthz')).status()).toBe(200);
  expect((await request.get('/v1/competitions')).status()).toBe(200);
  const me = await request.get('/v1/me');
  expect(me.status()).toBe(401);
  expect((await me.json()).error.code).toBe('UNAUTHENTICATED');
  const spa = await request.get('/deep/link');
  expect(spa.status()).toBe(200);
  expect(await spa.text()).toContain('<div id="root">');
});
