import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { clearTreeCache } from '../src/tree.js';
import { launch, files, docsSummary, inlineInput, menuItem, saveOnDisk, tabs, tab } from './helpers.js';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

test.afterEach(async () => {
  for (const rel of ['victim.md', 'guide.md', 'pinme.md', 'pinned-new.md']) {
    await fs.rm(path.join(root, rel), { force: true });
  }
  clearTreeCache();
});

test('pin, switch, unpin: the whole life of a tab', async ({ page }) => {
  await page.goto(base);
  await expect(files(page)).toHaveCount(4);

  // Nothing pinned: the bar does not exist as far as layout is concerned.
  await expect(page.locator('#tabbar')).toBeHidden();

  await page.locator('#tree a.file[data-path="docs/guide.md"]').click({ button: 'right' });
  await menuItem(page, 'Pin').click();
  await page.locator('#tree a.file[data-path="README.md"]').click({ button: 'right' });
  await menuItem(page, 'Pin').click();

  await expect(tabs(page)).toHaveCount(2);
  await expect(tabs(page).locator('.tab-link')).toHaveText(['guide.md', 'README.md']); // pin order

  // Clicking a tab loads its file, and the highlight follows.
  await tab(page, 'docs/guide.md').locator('.tab-link').click();
  await expect(page.locator('#doc h1')).toHaveText('Guide');
  await expect(tab(page, 'docs/guide.md')).toHaveClass(/active/);
  await expect(tab(page, 'README.md')).not.toHaveClass(/active/);

  // Unpinning the file on screen removes its tab and nothing else.
  await tab(page, 'docs/guide.md').locator('.tab-close').click();
  await expect(tabs(page)).toHaveCount(1);
  await expect(page.locator('#doc h1')).toHaveText('Guide'); // still open

  // A pinned row's menu offers Unpin instead.
  await page.locator('#tree a.file[data-path="README.md"]').click({ button: 'right' });
  await menuItem(page, 'Unpin').click();
  await expect(page.locator('#tabbar')).toBeHidden();
});

test('pins survive a reload', async ({ page }) => {
  await page.goto(base);
  await expect(files(page)).toHaveCount(4);

  await page.locator('#tree a.file[data-path="docs/links.md"]').click({ button: 'right' });
  await menuItem(page, 'Pin').click();
  await expect(tabs(page)).toHaveCount(1);

  await page.reload();
  await expect(tabs(page)).toHaveCount(1);
  await expect(tab(page, 'docs/links.md').locator('.tab-link')).toHaveText('links.md');
});

/**
 * A pin whose file left the disk is dropped the next time the tree is fetched,
 * from the bar and from storage, so no tab ever points at a 404.
 */
test('a pin is dropped when its file vanishes from the tree', async ({ page }) => {
  await saveOnDisk(root, 'victim.md', '# Victim\n');
  clearTreeCache();

  await page.goto(base);
  await expect(page.locator('#tree a.file[data-path="victim.md"]')).toHaveCount(1);
  await page.locator('#tree a.file[data-path="victim.md"]').click({ button: 'right' });
  await menuItem(page, 'Pin').click();
  await expect(tabs(page)).toHaveCount(1);

  await fs.rm(path.join(root, 'victim.md'));
  clearTreeCache(); // deletion outside the app does not clear the server's cache
  const refetched = page.waitForResponse((res) => res.url().includes('/api/tree') && res.status() === 200);
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await refetched;

  await expect(page.locator('#tabbar')).toBeHidden();

  // And from storage, or the dead tab would be back on the next reload.
  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('mdx:pins:'));
    return JSON.parse(localStorage.getItem(key) ?? '[]');
  });
  expect(stored).toEqual([]);
});

/**
 * renameTo moves the pin to the new name before it refreshes the tree; the
 * refresh prunes pins absent from the tree, which the old name now is. Move
 * that remap after the refresh and the pin is not renamed but silently lost.
 */
test('a pin follows a rename made through the app', async ({ page }) => {
  await saveOnDisk(root, 'pinme.md', '# Pin Me\n');
  clearTreeCache();

  await page.goto(base);
  await expect(page.locator('#tree a.file[data-path="pinme.md"]')).toHaveCount(1);
  await page.locator('#tree a.file[data-path="pinme.md"]').click({ button: 'right' });
  await menuItem(page, 'Pin').click();
  await expect(tabs(page)).toHaveCount(1);

  await page.locator('#tree a.file[data-path="pinme.md"]').click({ button: 'right' });
  await menuItem(page, 'Rename').click();
  await inlineInput(page).fill('pinned-new');
  await page.keyboard.press('Enter');

  await expect(tab(page, 'pinned-new.md')).toHaveCount(1);
  await expect(tab(page, 'pinme.md')).toHaveCount(0);
});

test('two pins sharing a basename each show their parent', async ({ page }) => {
  await saveOnDisk(root, 'guide.md', '# Root Guide\n'); // a twin of docs/guide.md
  clearTreeCache();

  await page.goto(base);
  await expect(page.locator('#tree a.file[data-path="guide.md"]')).toHaveCount(1);

  await page.locator('#tree a.file[data-path="docs/guide.md"]').click({ button: 'right' });
  await menuItem(page, 'Pin').click();
  await expect(tab(page, 'docs/guide.md').locator('.tab-link')).toHaveText('guide.md');

  await page.locator('#tree a.file[data-path="guide.md"]').click({ button: 'right' });
  await menuItem(page, 'Pin').click();

  // The collision renames both, not just the newcomer.
  await expect(tab(page, 'docs/guide.md').locator('.tab-link')).toHaveText('docs/guide.md');
  await expect(tab(page, 'guide.md').locator('.tab-link')).toHaveText('guide.md');
  await expect(tab(page, 'guide.md').locator('.tab-link')).toHaveAttribute('title', 'guide.md');

  // Unpinning one collapses the other back to its basename.
  await tab(page, 'guide.md').locator('.tab-close').click();
  await expect(tab(page, 'docs/guide.md').locator('.tab-link')).toHaveText('guide.md');
});

test('--read-only offers pinning and nothing else', async ({ page }) => {
  const readOnly = await launch({ readOnly: true });

  try {
    await page.goto(`${readOnly.base}/?path=docs%2Fguide.md`);
    await expect(page.locator('#doc h1')).toHaveText('Guide');

    // Pinning never writes to the server, so it survives read-only. The writes
    // do not, and their menu items go with them.
    await page.locator('#tree a.file[data-path="docs/guide.md"]').click({ button: 'right' });
    await expect(menuItem(page, 'Pin')).toBeVisible();
    await expect(menuItem(page, 'New file')).toHaveCount(0);
    await expect(menuItem(page, 'Rename')).toHaveCount(0);
    await menuItem(page, 'Pin').click();
    await expect(page.locator('#tabbar .tab')).toHaveCount(1);

    // A directory row has only write operations to offer, so no menu at all.
    await docsSummary(page).click({ button: 'right' });
    await expect(page.locator('#ctx-menu')).toBeHidden();
  } finally {
    await readOnly.stop();
    clearTreeCache();
  }
});
