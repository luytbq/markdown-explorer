import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { launch, offsetFromPaneTop, scrollTop, scrollPart, spySettled } from './helpers.js';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

/** The tree used to render bare anchors, so every file click reloaded the page. */
test('clicking a file in the tree does not reload the page', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    window.__survived = true;
  });

  await page.locator('#tree a[data-path="docs/guide.md"]').click();
  await expect(page.locator('#doc h1')).toHaveText('Guide');

  expect(await page.evaluate(() => window.__survived)).toBe(true);
  await expect(page).toHaveURL(/\?path=docs%2Fguide\.md/);
});

test('switching away and back restores the exact scroll position', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  const where = await scrollPart(page, 0.6);
  expect(where).toBeGreaterThan(200);

  await page.locator('#tree a[data-path="docs/guide.md"]').click();
  await expect(page.locator('#doc h1')).toHaveText('Guide');
  expect(await scrollTop(page)).toBe(0);

  await page.locator('#tree a[data-path="README.md"]').click();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  await expect.poll(() => scrollTop(page)).toBe(where);
});

test('an explicit anchor beats the remembered position', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await scrollPart(page, 0.6);

  await page.locator('#tree a[data-path="docs/guide.md"]').click();
  await expect(page.locator('#doc h1')).toHaveText('Guide');

  // The reader asked for a specific heading; memory must not override that.
  await page.goto(`${base}/?path=README.md#${encodeURIComponent('naïve-approach')}`);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => offsetFromPaneTop(page, 'naïve-approach')).toBeLessThan(24);
});

test('the remembered position survives a reload', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  const where = await scrollPart(page, 0.5);
  expect(where).toBeGreaterThan(200);
  await spySettled(page);

  await page.reload();
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => scrollTop(page)).toBe(where);
});

test('a document that changed while you were away restores by heading, not by pixel', async ({ page }) => {
  const filler = (text, n) => `${text}\n\n`.repeat(n);
  const long =
    `# Guide\n\n## Install\n\n${filler('install details.', 40)}` +
    `## Configuration\n\n${filler('configuration details.', 40)}` +
    `## Ending\n\n${filler('final words.', 40)}`;
  const shortened =
    `# Guide\n\n## Install\n\nbrief.\n\n` +
    `## Configuration\n\n${filler('configuration details.', 40)}` +
    `## Ending\n\n${filler('final words.', 40)}`;

  await fs.writeFile(path.join(root, 'docs', 'guide.md'), long);
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await expect(page.locator('#doc')).toContainText('configuration details');

  await page.locator('#toc a[data-id="configuration"]').click();
  await expect.poll(() => offsetFromPaneTop(page, 'configuration')).toBeLessThan(24);
  const deepTop = await scrollTop(page);
  expect(deepTop).toBeGreaterThan(800);

  await page.locator('#tree a[data-path="README.md"]').click();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');

  // Cut most of the first section out while the reader is elsewhere. The saved
  // scrollTop is now meaningless; the heading they were on is not.
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), shortened);

  await page.locator('#tree a[data-path="docs/guide.md"]').click();
  await expect(page.locator('#doc')).toContainText('brief');

  await expect.poll(() => offsetFromPaneTop(page, 'configuration')).toBeLessThan(24);
  expect(await scrollTop(page)).toBeLessThan(deepTop - 500);

  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\n## Install\n\nhello\n');
});

/**
 * Mermaid makes loadFile await mid-flight, so a second click can overtake the
 * first. The overtaken load has already written its innerHTML, so the damage it
 * does on resuming is quieter: its last act is connectEvents(its own path), which
 * points the live-reload stream at a file that is no longer on screen.
 */
test('a slower load cannot steal the live-reload stream from a newer one', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await expect(page.locator('#doc h1')).toHaveText('Guide');

  await page.locator('#tree a[data-path="README.md"]').click(); // slow: renders mermaid
  await page.locator('#tree a[data-path="docs/links.md"]').click(); // fast, and started later

  await expect(page.locator('#doc h1')).toHaveText('Links');
  await page.waitForTimeout(1500); // long enough for the README load to finish behind us

  await expect(page.locator('#doc h1')).toHaveText('Links');
  await expect(page).toHaveURL(/\?path=docs%2Flinks\.md/);
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);

  // The document on screen must be the one the event stream is watching.
  const original = await fs.readFile(path.join(root, 'docs', 'links.md'), 'utf8');
  await fs.writeFile(path.join(root, 'docs', 'links.md'), `${original}\nSTILL ALIVE.\n`);
  await expect(page.locator('#doc')).toContainText('STILL ALIVE', { timeout: 8000 });
  await fs.writeFile(path.join(root, 'docs', 'links.md'), original);
});
