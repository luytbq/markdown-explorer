import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { launch, README, offsetFromPaneTop, activeOutlineId } from './helpers.js';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

test('opens README by default, with a frontmatter title and unicode anchors', async ({ page }) => {
  await page.goto(base);
  await expect(page).toHaveTitle(/^Fixture ·/);
  await expect(page.locator('#doc h2#naïve-approach')).toBeVisible();
  // Duplicate heading text still yields distinct ids.
  await expect(page.locator('#doc h2#setup')).toHaveCount(1);
  await expect(page.locator('#doc h2#setup-1')).toHaveCount(1);
});

test('mermaid renders to svg, and only for documents that use it', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  const scriptLoaded = () =>
    page.evaluate(() => Boolean(document.querySelector('script[src*="mermaid.min.js"]')));
  expect(await scriptLoaded()).toBe(true);

  // guide.md has no diagram; a fresh page must not fetch the 3.4MB bundle.
  const fresh = await page.context().newPage();
  await fresh.goto(`${base}/?path=docs%2Fguide.md`);
  await expect(fresh.locator('#doc h1')).toHaveText('Guide');
  expect(await fresh.evaluate(() => Boolean(document.querySelector('script[src*="mermaid.min.js"]')))).toBe(false);
  await fresh.close();
});

test('clicking an outline entry scrolls that heading to the top of the pane', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  await page.locator('#toc a[data-id="setup-1"]').click();
  await expect.poll(() => offsetFromPaneTop(page, 'setup-1')).toBeLessThan(24);
  expect(await activeOutlineId(page)).toBe('setup-1');
  await expect(page).toHaveURL(/#setup-1$/);
});

/**
 * Scrollspy is suppressed for up to 800ms after an outline click so the outline
 * does not flicker through every heading the smooth scroll passes. A scroll that
 * lands inside that window is swallowed, and if nothing scrolls afterwards there
 * is no second chance: the highlight, and the heading we remember the reader at,
 * both freeze on the old value.
 */
test('a scroll swallowed by the suppression window is reconciled afterwards', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  await page.locator('#toc a[data-id="long-section"]').click();
  await expect.poll(() => activeOutlineId(page)).toBe('long-section');

  // One instant jump to the bottom, inside the window, and then nothing.
  await page.evaluate(() => {
    const pane = document.getElementById('content');
    pane.scrollTop = pane.scrollHeight;
  });

  await expect.poll(() => activeOutlineId(page), { timeout: 3000 }).toBe('very-short-final-section');
});

test('scrollspy reaches the final heading even though its section is shorter than the viewport', async ({
  page,
}) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  const lastId = 'very-short-final-section';

  // The section is genuinely too short to ever fill the viewport. This is the
  // case an IntersectionObserver band never fires for.
  const shortEnough = await page.evaluate((id) => {
    const pane = document.getElementById('content');
    const el = document.getElementById(id);
    const sectionHeight = pane.scrollHeight - el.offsetTop;
    return sectionHeight < pane.clientHeight;
  }, lastId);
  expect(shortEnough).toBe(true);

  await page.evaluate(() => {
    const pane = document.getElementById('content');
    pane.scrollTop = pane.scrollHeight;
  });

  await expect.poll(() => activeOutlineId(page)).toBe(lastId);
});

test('live reload keeps the reader on the heading they were reading', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);

  await page.locator('#toc a[data-id="long-section"]').click();
  await expect.poll(() => offsetFromPaneTop(page, 'long-section')).toBeLessThan(24);
  expect(await activeOutlineId(page)).toBe('long-section');

  const heightBefore = await page.evaluate(() => document.getElementById('content').scrollHeight);

  // Grow the document *above* the anchor: raw scrollTop restore would drift.
  const grown = README.replace(
    'INTRO_MARKER',
    Array.from({ length: 20 }, (_, i) => `Inserted paragraph ${i + 1}, making the page longer.`).join('\n\n'),
  );
  const tmp = path.join(root, '.README.md.tmp');
  await fs.writeFile(tmp, grown);
  await fs.rename(tmp, path.join(root, 'README.md')); // atomic save, the way vim does it

  await expect(page.locator('#doc')).toContainText('Inserted paragraph 1', { timeout: 10_000 });

  const heightAfter = await page.evaluate(() => document.getElementById('content').scrollHeight);
  expect(heightAfter).toBeGreaterThan(heightBefore);

  // Still on the same heading, still pinned to the top of the pane, and the
  // mermaid diagram re-rendered rather than reverting to a code block.
  await expect.poll(() => offsetFromPaneTop(page, 'long-section')).toBeLessThan(24);
  expect(await activeOutlineId(page)).toBe('long-section');
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  await fs.writeFile(path.join(root, 'README.md'), README);
});

test('live reload survives three consecutive atomic saves', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await expect(page.locator('#doc h1')).toHaveText('Guide');
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);

  const target = path.join(root, 'docs', 'guide.md');
  for (let i = 1; i <= 3; i++) {
    const tmp = path.join(root, 'docs', `.guide.md.${i}.tmp`);
    await fs.writeFile(tmp, `# Guide\n\n## Install\n\nsave ${i}\n`);
    await fs.rename(tmp, target);
    await expect(page.locator('#doc')).toContainText(`save ${i}`, { timeout: 8000 });
  }
});

test('deleting the open file says so', async ({ page }) => {
  await fs.writeFile(path.join(root, 'docs', 'doomed.md'), '# Doomed\n');
  await page.goto(`${base}/?path=docs%2Fdoomed.md`);
  await expect(page.locator('#doc h1')).toHaveText('Doomed');
  // The page renders before the event stream is up; deleting inside that window
  // is a race, and the reader would sit on a stale page.
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);

  await fs.rm(path.join(root, 'docs', 'doomed.md'));
  await expect(page.locator('#doc .notice')).toContainText('was deleted', { timeout: 8000 });
});

test('a file deleted before the event stream connects is still reported', async ({ page }) => {
  await fs.writeFile(path.join(root, 'docs', 'ghost.md'), '# Ghost\n');
  await page.goto(`${base}/?path=docs%2Fghost.md`);
  await expect(page.locator('#doc h1')).toHaveText('Ghost');
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);
  await fs.rm(path.join(root, 'docs', 'ghost.md'));
  await expect(page.locator('#doc .notice')).toContainText('was deleted', { timeout: 8000 });

  // Reconnecting to an already-missing file must report it immediately, rather
  // than waiting for a watch event that can never arrive.
  await page.goto(`${base}/?path=docs%2Fghost.md`);
  await expect(page.locator('#doc .notice')).toContainText('is gone', { timeout: 8000 });
});

test('markdown links open in the app instead of navigating away', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Flinks.md`);
  await expect(page.locator('#doc h1')).toHaveText('Links');

  // A sibling link resolved against the document's own directory.
  const first = page.locator('#doc a[data-md-link]').first();
  await expect(first).toHaveAttribute('data-md-link', 'README.md');

  await first.click();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');
  await expect.poll(() => offsetFromPaneTop(page, 'setup-1')).toBeLessThan(24);
  await expect(page).toHaveURL(/\?path=README\.md#setup-1$/);
});

test('a link to a unicode anchor survives the encode and decode round trip', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Flinks.md`);
  await page.locator('#doc a[data-md-link]').nth(1).click();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');
  await expect.poll(() => offsetFromPaneTop(page, 'naïve-approach')).toBeLessThan(24);
});

// Regression: setActive() calls replaceState with the *new* path while the
// current history entry still belongs to the old one, so following an in-document
// link used to overwrite the entry it was leaving.
test('back returns to the document you followed a link from', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Flinks.md`);
  await expect(page.locator('#doc h1')).toHaveText('Links');

  await page.locator('#doc a[data-md-link]').first().click();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');

  await page.goBack();
  await expect(page.locator('#doc h1')).toHaveText('Links');
});

test('external links are marked safe and are not intercepted', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Flinks.md`);
  const external = page.locator('#doc a[href="https://example.com"]');
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(external).not.toHaveAttribute('data-md-link', /.*/);
});

test('the url round-trips through a fresh tab and through history', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await page.locator('#toc a[data-id="setup-1"]').click();
  await expect(page).toHaveURL(/#setup-1$/);

  const url = page.url();
  const fresh = await page.context().newPage();
  await fresh.goto(url);
  await expect(fresh.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => offsetFromPaneTop(fresh, 'setup-1')).toBeLessThan(24);
  await fresh.close();

  // Scrollspy uses replaceState, so one back step leaves the document entirely.
  await page.locator('#tree a[data-path="docs/guide.md"]').click();
  await expect(page.locator('#doc h1')).toHaveText('Guide');
  await page.goBack();
  await expect(page.locator('#doc h1')).toHaveText('Application Design');
});
