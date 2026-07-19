import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { clearTreeCache } from '../src/tree.js';
import { launch } from './helpers.js';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

test.afterEach(async () => {
  await fs.rm(path.join(root, 'lightbox.md'), { force: true });
  await fs.rm(path.join(root, 'pic.svg'), { force: true });
  clearTreeCache();
});

// An SVG image file: any size we like without shipping binary bytes, and
// /files serves it (IMAGE_EXT in server.js includes .svg).
const PIC = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="teal"/></svg>';

// Wide on purpose: the viewBox has to beat 92% of the viewport for the zoom
// toggle to exist, which is what the pan test is about.
const WIDE_DIAGRAM = `graph LR\n    ${Array.from({ length: 16 }, (_, i) => `N${i}[Step number ${i}]`).join(' --> ')}`;

const DOC = `# Lightbox

![tiny](pic.svg)

[![linked](pic.svg)](#lightbox)

\`\`\`mermaid
${WIDE_DIAGRAM}
\`\`\`
`;

async function openDoc(page) {
  await fs.writeFile(path.join(root, 'pic.svg'), PIC);
  await fs.writeFile(path.join(root, 'lightbox.md'), DOC);
  await page.goto(`${base}/?path=lightbox.md`);
  await expect(page.locator('#doc h1')).toHaveText('Lightbox');
}

const inlineImg = (page) => page.locator('#doc p > img').first();

async function openOnImage(page) {
  await openDoc(page);
  const img = inlineImg(page);
  // The click handler refuses a broken image, so a click that races the load
  // would silently do nothing and the test would time out lying about why.
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBe(200);
  await img.click();
  await expect(page.locator('body > #lightbox')).toBeVisible();
}

test('clicking an inline image opens the lightbox, escape closes it', async ({ page }) => {
  await openOnImage(page);

  const shown = page.locator('body > #lightbox > img');
  await expect(shown).toBeVisible();
  expect(await shown.getAttribute('src')).toContain('/files/pic.svg');

  await page.keyboard.press('Escape');
  await expect(page.locator('body > #lightbox')).toBeHidden();
});

test('clicking the backdrop closes the lightbox', async ({ page }) => {
  await openOnImage(page);

  await page.locator('body > #lightbox').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('body > #lightbox')).toBeHidden();
});

test('an image inside a link stays a link', async ({ page }) => {
  await openDoc(page);

  await page.locator('#doc a img').click();
  await expect(page.locator('body > #lightbox')).toBeHidden();
});

test('a mermaid diagram zooms, pans, and unzooms', async ({ page }) => {
  await openDoc(page);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  await page.locator('#doc pre.mermaid svg').click();
  const box = page.locator('body > #lightbox');
  const shown = box.locator('svg');
  await expect(shown).toBeVisible();

  // Fit mode: the whole diagram is on screen, nothing to pan.
  const overflow = (el) => el.scrollWidth - el.clientWidth;
  expect(await box.evaluate(overflow)).toBe(0);

  // Zoom to natural pixels: the wide diagram now overflows and pans by scroll.
  await shown.click();
  expect(await box.evaluate(overflow)).toBeGreaterThan(100);
  await box.evaluate((el) => {
    el.scrollLeft = 50;
  });
  expect(await box.evaluate((el) => el.scrollLeft)).toBe(50);

  // A second click is back to fit, escape is out.
  await shown.click();
  expect(await box.evaluate(overflow)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(box).toBeHidden();
});

/**
 * enterEdit awaits /api/raw before it shows the editor, so "press e, assert
 * the editor is hidden" races that fetch and always passes. But the fetch is
 * *initiated* synchronously inside the keydown dispatch, and press() resolves
 * after the dispatch, so an in-page counter around window.fetch is already
 * settled when it is read: a heard press counts 1, a dead one 0, no race.
 */
test('the edit shortcut is dead while the lightbox is open', async ({ page }) => {
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.__rawCalls = 0;
    window.fetch = (...args) => {
      if (String(args[0]).includes('/api/raw')) window.__rawCalls += 1;
      return orig(...args);
    };
  });
  await openOnImage(page);
  const rawCalls = () => page.evaluate(() => window.__rawCalls);

  await page.keyboard.press('e'); // must be swallowed by the open lightbox
  expect(await rawCalls()).toBe(0);

  await page.keyboard.press('Escape');
  await expect(page.locator('body > #lightbox')).toBeHidden();

  await page.keyboard.press('e'); // now it is a shortcut again
  await expect(page.locator('#editor')).toBeVisible();
  expect(await rawCalls()).toBe(1);
});
