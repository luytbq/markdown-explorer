import { test, expect } from '@playwright/test';

import { launch, files, docsSummary } from './helpers.js';

/**
 * Narrow screens. A pane too wide for the grid does not disappear, it floats over
 * it: the reader on a phone must still be able to reach another file, which is
 * exactly what the old display:none took away.
 *
 * These run at a phone viewport, and the geometry assertions are the point - the
 * drawer is decided entirely by a media query, so a test at the default 1280px
 * would pass with the whole feature deleted.
 */

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 1000, height: 800 };

const drawer = (page) => page.evaluate(() => document.documentElement.dataset.drawer ?? null);
const position = (page, id) => page.evaluate((el) => getComputedStyle(document.getElementById(el)).position, id);
const rowHeight = (page, sel) =>
  page.locator(sel).evaluate((el) => Math.round(el.getBoundingClientRect().height));

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

test.describe('on a phone', () => {
  test.use({ viewport: PHONE });

  test('both panes leave the grid and the document takes the whole width', async ({ page }) => {
    await page.goto(base);
    await expect(page.locator('#doc h1')).toHaveText('Application Design');

    expect(await position(page, 'explorer')).toBe('fixed');
    expect(await position(page, 'outline')).toBe('fixed');

    // The two triggers are the only way back into a pane that took its own toggle
    // off-canvas with it, so their visibility is load-bearing, not decoration.
    await expect(page.locator('#open-left')).toBeVisible();
    await expect(page.locator('#open-right')).toBeVisible();

    const width = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      content: Math.round(document.getElementById('content').getBoundingClientRect().width),
    }));
    expect(width.content).toBe(width.viewport);
    expect(width.page).toBe(width.viewport); // nothing may push the page sideways
  });

  test('the explorer opens as a drawer with its tree and its filter box', async ({ page }) => {
    await page.goto(base);
    expect(await drawer(page)).toBeNull();

    await page.locator('#open-left').click();
    expect(await drawer(page)).toBe('left');
    await expect(page.locator('#tree a.file[data-path="README.md"]')).toBeVisible();
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('body > #drawer-scrim')).toBeVisible();
  });

  test('the scrim, the pane toggle and Escape all close it', async ({ page }) => {
    await page.goto(base);

    await page.locator('#open-left').click();
    // A tap on the scrim must not also reach whatever it landed on underneath.
    await page.locator('body > #drawer-scrim').click({ position: { x: 360, y: 500 } });
    expect(await drawer(page)).toBeNull();

    await page.locator('#open-left').click();
    await page.locator('#toggle-left').click(); // inside the drawer, the way out of it
    expect(await drawer(page)).toBeNull();

    await page.locator('#open-left').click();
    await page.keyboard.press('Escape');
    expect(await drawer(page)).toBeNull();
  });

  test('picking a file closes the drawer covering it', async ({ page }) => {
    await page.goto(base);
    await page.locator('#open-left').click();

    await docsSummary(page).click(); // docs starts open, so this closes it
    await docsSummary(page).click();
    await files(page).filter({ hasText: 'guide.md' }).click();

    expect(await drawer(page)).toBeNull();
    await expect(page.locator('#doc h1')).toHaveText('Guide');
  });

  /**
   * openTreeLink returns early for the file already on screen, so loadFile - where
   * the drawer is closed for every other navigation - never runs. Without its own
   * close, a tap on the file you are reading answers with nothing at all while the
   * drawer keeps sitting over that very document.
   */
  test('picking the file already open closes it too', async ({ page }) => {
    await page.goto(`${base}/?path=README.md`);
    await expect(page.locator('#doc h1')).toHaveText('Application Design');

    await page.locator('#open-left').click();
    await page.locator('#tree a.file[data-path="README.md"]').click();
    expect(await drawer(page)).toBeNull();
  });

  /**
   * The one navigation that can happen with a drawer up: everything else the reader
   * could tap - a pinned tab, a link in the document - is behind the scrim, but the
   * phone's own back button is not. Without loadFile closing the drawer, back lands
   * on a document the drawer is still covering.
   */
  test('going back closes the drawer over the document it lands on', async ({ page }) => {
    await page.goto(base);
    await page.locator('#open-left').click();
    await files(page).filter({ hasText: 'guide.md' }).click();
    await expect(page.locator('#doc h1')).toHaveText('Guide');

    await page.locator('#open-left').click();
    expect(await drawer(page)).toBe('left');

    await page.goBack();
    await expect(page.locator('#doc h1')).toHaveText('Application Design');
    expect(await drawer(page)).toBeNull();
  });

  test('picking a heading closes the outline and jumps to it', async ({ page }) => {
    await page.goto(base);
    await page.locator('#open-right').click();
    expect(await drawer(page)).toBe('right');

    await page.locator('#toc a[data-id="setup"]').click();
    expect(await drawer(page)).toBeNull();
    await expect.poll(() => page.evaluate(() => decodeURIComponent(location.hash.slice(1)))).toBe('setup');
  });

  /**
   * mdx:panes is the reader's column-width preference, made at a desk. Tapping a
   * drawer shut says nothing about it, and writing it would mean a phone session
   * silently collapsing the desktop layout.
   */
  test('a drawer does not touch the stored pane preference', async ({ page }) => {
    await page.goto(base);
    const stored = () => page.evaluate(() => localStorage.getItem('mdx:panes'));
    const before = await stored();

    // The scrim is modal, so the trigger is behind it while its drawer is up: the
    // way out is the scrim, the toggle inside the drawer, or Escape.
    await page.locator('#open-left').click();
    await page.locator('#toggle-left').click();
    await page.locator('#open-right').click();
    await page.keyboard.press('Escape');

    expect(await stored()).toBe(before);
  });

  /**
   * The rail rules key on data-left='closed', which a desktop session leaves in
   * mdx:panes. They hide the filter box and the tree, so reaching a drawer through
   * them opens an empty panel - which is why they are scoped to the widths where
   * the rail exists at all.
   */
  test('a collapsed desktop preference does not open an empty drawer', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('mdx:panes', JSON.stringify({ left: 'closed', right: 'closed' }));
    });
    await page.goto(base);

    await page.locator('#open-left').click();
    await expect(page.locator('#search')).toBeVisible();
    await expect(page.locator('#tree a.file[data-path="README.md"]')).toBeVisible();
    await expect(page.locator('#explorer .pane-title')).toBeVisible();

    await page.locator('#toggle-left').click(); // the trigger is behind the scrim
    await page.locator('#open-right').click();
    await expect(page.locator('#toc a').first()).toBeVisible();
    await expect(page.locator('#outline .pane-title')).toBeVisible();
  });

  test('rows are sized for a fingertip', async ({ page }) => {
    await page.goto(base);
    await page.locator('#open-left').click();

    expect(await rowHeight(page, '#tree a.file[data-path="README.md"]')).toBeGreaterThanOrEqual(36);
    expect(await rowHeight(page, '#tree > details > summary')).toBeGreaterThanOrEqual(36);
  });
});

test.describe('between the two breakpoints', () => {
  test.use({ viewport: TABLET });

  /**
   * There is room for the explorer here and not for the outline, so exactly one of
   * them is a drawer. A single breakpoint for both would either waste the width or
   * take the tree away early.
   */
  test('the outline is a drawer while the explorer is still a column', async ({ page }) => {
    await page.goto(base);
    await expect(page.locator('#doc h1')).toHaveText('Application Design');

    expect(await position(page, 'explorer')).not.toBe('fixed');
    expect(await position(page, 'outline')).toBe('fixed');

    await expect(page.locator('#open-left')).toBeHidden();
    await expect(page.locator('#open-right')).toBeVisible();

    await page.locator('#open-right').click();
    expect(await drawer(page)).toBe('right');
    await expect(page.locator('#toc a').first()).toBeVisible();
  });

  // The attribute means nothing once the pane is a column again, and a stale one
  // would leave the scrim over a perfectly wide layout.
  test('widening past the breakpoint drops an open drawer', async ({ page }) => {
    await page.goto(base);
    await page.locator('#open-right').click();
    expect(await drawer(page)).toBe('right');

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect.poll(() => drawer(page)).toBeNull();
    await expect(page.locator('body > #drawer-scrim')).toBeHidden();
  });
});
