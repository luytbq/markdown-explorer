import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { clearTreeCache } from '../src/tree.js';
import { launch, saveOnDisk, files } from './helpers.js';

/**
 * Mounted under a url path, the whole app has to agree on where it lives, and
 * every disagreement is a request for the unmounted spelling, which is a 404 by
 * construction. So these tests watch the network rather than the screen: a call
 * site in app.js that kept its rooted url fails here even if the feature it
 * belongs to has no assertion of its own.
 */

const PREFIX = 'docs-site';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch({ prefix: PREFIX }));

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  );
  await fs.writeFile(path.join(root, 'dot.png'), png);
  await fs.writeFile(path.join(root, 'assets.md'), '# Assets\n\n![dot](./dot.png)\n\n[src](./src/index.js)\n');
  clearTreeCache();
});

test.afterAll(() => stop());

/** Every response the page took, so a request for an unmounted url cannot hide. */
function watchFailures(page) {
  const failures = [];
  page.on('response', (res) => {
    if (res.status() >= 400) failures.push(`${res.status()} ${new URL(res.url()).pathname}`);
  });
  return failures;
}

test('the bare mount point redirects, and the app boots inside it', async ({ page }) => {
  const failures = watchFailures(page);

  // No trailing slash: index.html reaches style.css and app.js relatively, so
  // this is the spelling from which they would resolve outside the mount.
  await page.goto(base);
  await expect(page).toHaveURL(`${base}/`);

  await expect(page.locator('#doc h1')).toHaveText('Application Design');
  // A top-level row: the ones inside docs/ are behind a closed details.
  await expect(files(page).filter({ hasText: 'README.md' })).toBeVisible();

  // The stylesheet arrived, not just its 200: an unstyled page still renders.
  expect(await page.locator('#explorer').evaluate((el) => getComputedStyle(el).display)).not.toBe('block');

  expect(failures).toEqual([]);
});

test('navigating keeps the mount point, and the tree, outline and search follow', async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(`${base}/`);

  await files(page).filter({ hasText: 'guide.md' }).click();
  await expect(page.locator('#doc h1')).toHaveText('Guide');
  // Scrollspy writes a hash of its own on the first frame, so the query is what
  // this pins; asserting the bare url instead would race it.
  await expect(page).toHaveURL(new RegExp(`^${base}/\\?path=docs%2Fguide\\.md(#|$)`));

  await page.locator('#toc a[data-id="install"]').click();
  await expect(page).toHaveURL(`${base}/?path=docs%2Fguide.md#install`);

  // Content search is its own endpoint, and a hit opens on its own section.
  await page.locator('#search-text').click();
  await page.locator('#search').fill('described');
  const hits = page.locator('#tree a.search-line');
  await expect(hits).toHaveCount(1);

  await hits.first().click();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');
  await expect(page).toHaveURL(new RegExp(`^${base}/\\?path=README\\.md#`));

  expect(failures).toEqual([]);
});

test('a rendered image and a non-markdown link carry the mount point', async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(`${base}/?path=assets.md`);

  const img = page.locator('#doc img');
  await expect(img).toHaveAttribute('src', `/${PREFIX}/files/dot.png`);
  expect(await img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);

  await expect(page.locator('#doc a[href$="index.js"]')).toHaveAttribute(
    'href',
    `/${PREFIX}/files/src/index.js`,
  );

  expect(failures).toEqual([]);
});

test('an in-app markdown link stays inside the mount point', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Flinks.md`);
  await page.locator('#doc a[data-md-link$="README.md"]').first().click();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');
  await expect(page).toHaveURL(new RegExp(`^${base}/\\?path=README\\.md`));
});

test('mermaid loads its bundle from under the mount point', async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(`${base}/`);

  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  expect(
    await page.evaluate(() => document.querySelector('script[src*="mermaid.min.js"]').getAttribute('src')),
  ).toContain(`/${PREFIX}/static/vendor/mermaid.min.js`);

  expect(failures).toEqual([]);
});

test('live reload reaches a mounted page', async ({ page }) => {
  const failures = watchFailures(page);
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await expect(page.locator('#doc h1')).toHaveText('Guide');
  // The stream is connected only once the app says so; writing before that races it.
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);

  await saveOnDisk(root, 'docs/guide.md', '# Guide\n\n## Install\n\nreloaded\n');
  await expect(page.locator('#doc')).toContainText('reloaded');

  expect(failures).toEqual([]);
});

test('saving from a mounted page writes the file', async ({ page }) => {
  const failures = watchFailures(page);
  await saveOnDisk(root, 'mounted-edit.md', '# Mounted\n\nbefore\n');
  clearTreeCache();

  await page.goto(`${base}/?path=mounted-edit.md`);
  await expect(page.locator('#doc h1')).toHaveText('Mounted');

  await page.locator('#mode-edit').click();
  await page.locator('#editor').fill('# Mounted\n\nafter\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#save-status')).toHaveText('Saved');

  expect(await fs.readFile(path.join(root, 'mounted-edit.md'), 'utf8')).toContain('after');
  expect(failures).toEqual([]);
});
