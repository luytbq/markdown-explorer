import { test, expect } from '@playwright/test';

import { launch, saveOnDisk, EDITABLE } from './helpers.js';

const PASSWORD = 'correct horse';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch({ password: PASSWORD }));
});

test.afterAll(() => stop());

async function signIn(page, password = PASSWORD) {
  await page.locator('#password').fill(password);
  await page.locator('#submit').click();
}

/** Stands in for a restart or a sign-out in another tab: the server forgets the session. */
const endSession = (page) =>
  page.request.post(`${base}/api/logout`, { headers: { 'Content-Type': 'application/json' }, data: '{}' });

/** loadTree also runs on window focus, which saves waiting out the ten-second poll. */
const pollTree = (page) => page.evaluate(() => dispatchEvent(new Event('focus')));

test('a deep link survives the sign-in it was sent through', async ({ page }) => {
  await page.goto(`${base}/?path=docs/guide.md#install`);
  await expect(page.locator('#login')).toBeVisible();

  await signIn(page, 'wrong');
  await expect(page.locator('#error')).toHaveText('Wrong password.');

  await signIn(page);
  await expect(page.locator('#doc h1')).toHaveText('Guide');
  expect(new URL(page.url()).searchParams.get('path')).toBe('docs/guide.md');
  await expect(page.locator('#sign-out')).toBeVisible();
});

test('signing out lands on the sign-in page with the session gone', async ({ page }) => {
  await page.goto(`${base}/`);
  await signIn(page);
  await expect(page.locator('#doc h1')).toHaveText('Application Design');

  await page.locator('#sign-out').click();
  await expect(page.locator('#login')).toBeVisible();
  expect((await page.request.get(`${base}/api/tree`)).status()).toBe(401);
});

test('a session that ends under an open page sends the reader back to sign in', async ({ page }) => {
  await page.goto(`${base}/`);
  await signIn(page);
  await expect(page.locator('#doc h1')).toHaveText('Application Design');

  await endSession(page);
  await pollTree(page);
  await expect(page.locator('#login')).toBeVisible();
});

test('an unsaved buffer is not reloaded away when the session ends', async ({ page }) => {
  await saveOnDisk(root, 'edit.md', EDITABLE);
  await page.goto(`${base}/?path=edit.md`);
  await signIn(page);
  await expect(page.locator('#doc h1')).toHaveText('Editable');

  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.locator('#editor').press('End');
  await page.locator('#editor').pressSequentially(' unsaved');

  await endSession(page);
  await pollTree(page);
  await expect(page.locator('#banner')).toContainText('session has ended');
  await expect(page.locator('#editor')).toHaveValue(/ unsaved/);
});
