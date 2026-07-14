import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { clearTreeCache } from '../src/tree.js';
import { launch, files, docsSummary, inlineInput, menuItem, saveOnDisk, openEditable } from './helpers.js';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

test.afterEach(async () => {
  for (const rel of ['subject.md', 'renamed-subject.md', 'appeared.md', 'edit.md']) {
    await fs.rm(path.join(root, rel), { force: true });
  }
  await fs.rm(path.join(root, 'docs', 'scratch.md'), { force: true });
  clearTreeCache();
});

test('the context menu creates a file that opens straight into the editor', async ({ page }) => {
  await page.goto(base);
  await expect(files(page)).toHaveCount(4);

  await docsSummary(page).click({ button: 'right' });
  await menuItem(page, 'New file').click();

  await expect(inlineInput(page)).toBeVisible();
  await inlineInput(page).fill('scratch'); // no extension: the client supplies .md
  await page.keyboard.press('Enter');

  // An empty document has nothing worth viewing, so the editor opens on it.
  await expect(page.locator('#editor')).toBeVisible();
  await expect(page.locator('#doc-path')).toHaveText('docs/scratch.md');
  await expect(page.locator('#tree a.file[data-path="docs/scratch.md"]')).toHaveClass(/active/);
  expect(await fs.readFile(path.join(root, 'docs', 'scratch.md'), 'utf8')).toBe('');

  // And the version it was created with is the one a save needs.
  await page.keyboard.type('# Scratch');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  expect(await fs.readFile(path.join(root, 'docs', 'scratch.md'), 'utf8')).toContain('# Scratch');
});

test('a name that is already taken is refused in place, and nothing is created', async ({ page }) => {
  await page.goto(base);
  await expect(files(page)).toHaveCount(4);

  await docsSummary(page).click({ button: 'right' });
  await menuItem(page, 'New file').click();
  await inlineInput(page).fill('guide');
  await page.keyboard.press('Enter');

  await expect(page.locator('#tree .tree-input-error')).toContainText('already exists');
  await expect(inlineInput(page)).toBeVisible(); // still there, still correctable

  await page.keyboard.press('Escape');
  await expect(inlineInput(page)).toHaveCount(0);
  await expect(page.locator('#editor')).toBeHidden();
});

/**
 * The inline input lives inside #tree, which renderTree wipes with
 * replaceChildren whenever a poll finds a change. While the input is open the
 * fresh tree is kept but not rendered; closing the input applies it. Remove that
 * guard and the first poll takes the input, and the half-typed name in it, out
 * from under the reader.
 */
test('the inline input survives the tree being rebuilt underneath it', async ({ page }) => {
  await page.goto(base);
  await expect(files(page)).toHaveCount(4);

  await docsSummary(page).click({ button: 'right' });
  await menuItem(page, 'New file').click();
  await inlineInput(page).fill('dra');

  // A file appears on disk, and a poll fires while the input is open. Waiting
  // for the response, not just dispatching, is what makes this a real test: the
  // render this guard suppresses happens right after that response lands.
  await fs.writeFile(path.join(root, 'appeared.md'), '# Appeared\n');
  await page.waitForTimeout(1200); // the server caches the tree for a second
  const refetched = page.waitForResponse((res) => res.url().includes('/api/tree') && res.status() === 200);
  await page.evaluate(() => dispatchEvent(new Event('focus')));
  await refetched;
  await page.waitForTimeout(100); // and let the handler behind the fetch run

  await page.keyboard.type('ft');
  await expect(inlineInput(page)).toHaveValue('draft');
  await expect(page.locator('#tree a.file[data-path="appeared.md"]')).toHaveCount(0);

  // Closing the input is what applies the tree the poll brought.
  await page.keyboard.press('Escape');
  await expect(inlineInput(page)).toHaveCount(0);
  await expect(page.locator('#tree a.file[data-path="appeared.md"]')).toHaveCount(1);
  await assert404(page, 'docs/draft.md');
});

async function assert404(page, rel) {
  const res = await page.request.get(`${base}/api/raw?path=${encodeURIComponent(rel)}`);
  expect(res.status()).toBe(404);
}

test('renaming the open file keeps the page, the url and the live stream', async ({ page }) => {
  await saveOnDisk(root, 'subject.md', '# Subject\n\nProse to keep.\n');
  await page.goto(`${base}/?path=subject.md`);
  await expect(page.locator('#doc h1')).toHaveText('Subject');
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);

  // Hold the 200 until after the watcher has spoken. The disk rename happens at
  // fetch time, so the deletion event for the old name reaches the page while it
  // still believes in that name, which is the race the renamePending flag closes.
  // Without the hold, the response beats the watcher's 100ms debounce and the
  // event is filtered as being about some other file, fix or no fix.
  await page.route('**/api/rename', async (route) => {
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ response });
  });

  await page.locator('#tree a.file[data-path="subject.md"]').click({ button: 'right' });
  await menuItem(page, 'Rename').click();
  await expect(inlineInput(page)).toHaveValue('subject.md');
  await inlineInput(page).fill('renamed-subject');
  await page.keyboard.press('Enter');

  // The document never went anywhere: same rendering, new name everywhere.
  await expect(page.locator('#doc-path')).toHaveText('renamed-subject.md');
  await expect.poll(() => page.url()).toContain('renamed-subject.md');
  await expect(page.locator('#tree a.file[data-path="renamed-subject.md"]')).toHaveClass(/active/);
  await expect(page.locator('#doc')).toContainText('Prose to keep.');
  expect(await fs.readFile(path.join(root, 'renamed-subject.md'), 'utf8')).toContain('Prose to keep.');

  // The watcher saw our rename as a deletion of the old name. It was ours, and
  // it must not be reported as the file vanishing under the reader.
  await page.waitForTimeout(1500); // longer than the watcher debounce
  await expect(page.locator('#doc .notice')).toHaveCount(0);

  // And the stream follows the new name: a change on disk still reaches the page.
  await saveOnDisk(root, 'renamed-subject.md', '# Subject\n\nChanged after the rename.\n');
  await expect(page.locator('#doc')).toContainText('Changed after the rename.', { timeout: 8000 });
});

test('a dirty editor refuses the rename rather than orphaning the buffer', async ({ page }) => {
  await openEditable(page, { root, base });
  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();
  await page.keyboard.type('unsaved words ');
  await expect(page.locator('#dirty')).toBeVisible();

  await page.locator('#tree a.file[data-path="edit.md"]').click({ button: 'right' });
  await menuItem(page, 'Rename').click();

  await expect(page.locator('#banner')).toContainText('Save or discard');
  await expect(inlineInput(page)).toHaveCount(0);
  await expect(page.locator('#editor')).toHaveValue(/unsaved words /); // untouched

  await page.locator('#banner button', { hasText: 'OK' }).click();
  await expect(page.locator('#banner')).toBeHidden();
});
