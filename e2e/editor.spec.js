import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { clearTreeCache } from '../src/tree.js';
import { launch, README, EDITABLE, saveOnDisk, openEditable, scrollTop, scrollPart, spySettled } from './helpers.js';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

test.afterEach(async () => {
  await fs.rm(path.join(root, 'edit.md'), { force: true });
  // The server holds the tree for a second, which is long enough for a file one
  // test made to still be in the tree the next test is handed.
  clearTreeCache();
});

test('edit mode shows the document as it is on disk, not as it renders', async ({ page }) => {
  await openEditable(page, { root, base });

  await page.locator('#mode-edit').click();
  const editor = page.locator('#editor');
  await expect(editor).toBeVisible();
  await expect(page.locator('#content')).toBeHidden();

  // The renderer eats both of these. The editor is the raw file or it is nothing.
  await expect(editor).toHaveValue(EDITABLE);
  await expect(editor).toHaveValue(/<!-- a comment, invisible in the rendered document -->/);
  await expect(editor).toHaveValue(/^---\ntitle: Editable\n---/);
});

test('saving writes the file, and the rendered view catches up', async ({ page }) => {
  await openEditable(page, { root, base });
  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();

  await page.locator('#editor').fill(EDITABLE.replace('Some prose.', 'Rewritten prose.'));
  await expect(page.locator('#dirty')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page.locator('#dirty')).toBeHidden();
  expect(await fs.readFile(path.join(root, 'edit.md'), 'utf8')).toContain('Rewritten prose.');

  await page.locator('#mode-view').click();
  await expect(page.locator('#content')).toBeVisible();
  await expect(page.locator('#doc')).toContainText('Rewritten prose.');
  await expect(page.locator('#doc')).not.toContainText('a comment, invisible');
});

/**
 * A save comes back to us through the watcher like any other change to the file.
 * The version on the event is the only thing that says it was ours, and without
 * it a reader who keeps typing while the write is in flight gets accused of a
 * conflict with themselves.
 */
test('our own save does not come back as somebody else changing the file', async ({ page }) => {
  await openEditable(page, { root, base });
  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();

  await page.locator('#editor').fill(EDITABLE.replace('Some prose.', 'Rewritten prose.'));
  await page.keyboard.press('ControlOrMeta+s');

  // Straight on typing, without waiting: the write is still in flight, so the
  // buffer is dirty again well before the watcher event for it can land.
  await page.keyboard.type(' Still typing.');
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page.locator('#dirty')).toBeVisible();

  await page.waitForTimeout(1200); // longer than the watcher debounce, by a lot
  await expect(page.locator('#banner')).toBeHidden();
  await expect(page.locator('#editor')).toHaveValue(/Still typing\./);
});

test('a change on disk while the editor is dirty asks rather than overwrites', async ({ page }) => {
  await openEditable(page, { root, base });
  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();

  await page.locator('#editor').fill(EDITABLE.replace('Some prose.', 'My unsaved work.'));
  await expect(page.locator('#dirty')).toBeVisible();

  await saveOnDisk(root, 'edit.md', EDITABLE.replace('Some prose.', 'Their work.'));

  await expect(page.locator('#banner')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#banner')).toContainText('changed on disk');
  await expect(page.locator('#editor')).toHaveValue(/My unsaved work\./); // untouched

  // Saving over it now is a conflict, and the way out of it is a click.
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#banner')).toContainText('since you started editing');
  await page.locator('#banner button', { hasText: 'Overwrite it' }).click();

  await expect(page.locator('#save-status')).toHaveText('Saved');
  expect(await fs.readFile(path.join(root, 'edit.md'), 'utf8')).toContain('My unsaved work.');
});

test('a change on disk while the editor is clean is simply picked up', async ({ page }) => {
  await openEditable(page, { root, base });
  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toHaveValue(EDITABLE);

  await saveOnDisk(root, 'edit.md', EDITABLE.replace('Some prose.', 'Rewritten elsewhere.'));

  await expect(page.locator('#editor')).toHaveValue(/Rewritten elsewhere\./, { timeout: 8000 });
  await expect(page.locator('#banner')).toBeHidden(); // nothing of the reader's was at stake
});

test('leaving the editor puts the reader back where they were reading', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  const where = await scrollPart(page, 0.6);
  expect(where).toBeGreaterThan(200);

  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();

  await page.locator('#mode-view').click();
  await expect(page.locator('#content')).toBeVisible();

  // The pane was display:none, which resets scrollTop to 0. Coming back has to
  // restore the position deliberately; nothing does it for us.
  await expect.poll(() => scrollTop(page)).toBe(where);
});

/**
 * The guarantee a reader actually cares about: fixing a typo does not cost them
 * their place in the document.
 *
 * This one does not pin the `capture: false` that exitEdit passes loadFile.
 * Chromium and Firefox both restore a pane's scroll offset when it comes back
 * from display:none (measured, not assumed), so the position is already right by
 * the time the reload could have captured a zero over it, and the test stays
 * green with the flag removed. It is kept because the behaviour is worth a
 * regression test, not because it covers that line. See CLAUDE.md.
 */
test('a save keeps the reader where they were, to the pixel', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  const where = await scrollPart(page, 0.6);
  expect(where).toBeGreaterThan(200);

  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();

  // A word for a word of the same width: the document comes back the height it
  // was, so the remembered pixel offset is still the honest answer and the exact
  // restore is the branch applyScroll takes.
  await page.locator('#editor').fill(README.replace('Second time.', 'Second pass.'));
  await page.keyboard.press('ControlOrMeta+s');
  await expect(page.locator('#save-status')).toHaveText('Saved');

  await page.locator('#mode-view').click();
  await expect(page.locator('#doc')).toContainText('Second pass.');
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => scrollTop(page)).toBe(where);

  await fs.writeFile(path.join(root, 'README.md'), README);
});

/**
 * Closing or reloading the tab mid-edit fires pagehide, which snapshots the
 * reading position. The document pane is display:none by then, so it measures a
 * scrollTop of 0 and would remember the top of the file as the place the reader
 * had got to.
 */
test('reloading while the editor is open does not forget the reading position', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  const where = await scrollPart(page, 0.6);
  expect(where).toBeGreaterThan(200);
  await spySettled(page);

  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();

  await page.reload();
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => scrollTop(page)).toBe(where);
});

test('--read-only takes the editor away entirely', async ({ page }) => {
  const readOnly = await launch({ readOnly: true });

  try {
    await page.goto(`${readOnly.base}/?path=docs%2Fguide.md`);
    await expect(page.locator('#doc h1')).toHaveText('Guide');

    await expect(page.locator('#mode-edit')).toBeHidden();
    await page.keyboard.press('e');
    await expect(page.locator('#editor')).toBeHidden();
  } finally {
    await readOnly.stop();
    clearTreeCache();
  }
});
