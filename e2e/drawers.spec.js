import { test, expect } from '@playwright/test';

import { launch, activeOutlineId, paneWidth } from './helpers.js';

let base;
let stop;

test.beforeAll(async () => {
  ({ base, stop } = await launch());
});

test.afterAll(() => stop());

test('the explorer collapses to a rail and keeps its way back on screen', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await expect(page.locator('#doc h1')).toHaveText('Guide');

  const openWidth = await paneWidth(page, 'explorer');
  const openContent = await paneWidth(page, 'content');
  expect(openWidth).toBeGreaterThan(200);

  await page.locator('#toggle-left').click();

  await expect.poll(() => paneWidth(page, 'explorer')).toBeLessThan(40);
  await expect(page.locator('#tree')).toBeHidden();
  await expect(page.locator('#toggle-left')).toBeVisible();
  await expect(page.locator('#toggle-left')).toHaveAttribute('aria-expanded', 'false');
  // The theme button lives in the explorer header, and must survive its collapse.
  await expect(page.locator('#theme')).toBeVisible();
  expect(await paneWidth(page, 'content')).toBeGreaterThan(openContent);

  await page.locator('#toggle-left').click();
  await expect.poll(() => paneWidth(page, 'explorer')).toBe(openWidth);
  await expect(page.locator('#tree')).toBeVisible();
  await expect(page.locator('#toggle-left')).toHaveAttribute('aria-expanded', 'true');
});

test('the outline collapses without breaking scrollspy', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

  await page.locator('#toggle-right').click();
  await expect.poll(() => paneWidth(page, 'outline')).toBeLessThan(40);
  await expect(page.locator('#toc')).toBeHidden();

  await page.evaluate(() => {
    const pane = document.getElementById('content');
    pane.scrollTop = pane.scrollHeight;
  });
  // Hidden, but still tracking: reopening must not show a stale highlight.
  await expect.poll(() => activeOutlineId(page)).toBe('very-short-final-section');

  await page.locator('#toggle-right').click();
  await expect(page.locator('#toc a.active')).toBeVisible();
});

test('square brackets toggle the two drawers', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await expect(page.locator('#doc h1')).toHaveText('Guide');

  await page.keyboard.press('[');
  await expect.poll(() => paneWidth(page, 'explorer')).toBeLessThan(40);

  await page.keyboard.press(']');
  await expect.poll(() => paneWidth(page, 'outline')).toBeLessThan(40);

  await page.keyboard.press('[');
  await page.keyboard.press(']');
  await expect.poll(() => paneWidth(page, 'explorer')).toBeGreaterThan(200);
  await expect.poll(() => paneWidth(page, 'outline')).toBeGreaterThan(200);
});

/**
 * At 1150px the content column is narrower than its 820px cap, so collapsing the
 * drawers genuinely reflows the prose rather than just re-centring it.
 */
test.describe('with a content column narrow enough to reflow', () => {
  test.use({ viewport: { width: 1150, height: 700 } });

  test('collapsing a drawer recomputes the outline highlight', async ({ page }) => {
    await page.goto(base);
    await expect(page.locator('#doc pre.mermaid svg')).toBeVisible({ timeout: 15_000 });

    // Park "Naïve Approach" three pixels below the scrollspy line, so it is not yet active.
    await page.evaluate(() => {
      const pane = document.getElementById('content');
      const target = document.getElementById('naïve-approach');
      pane.scrollTop += target.getBoundingClientRect().top - (pane.getBoundingClientRect().top + 80) - 3;
    });
    await expect.poll(() => activeOutlineId(page)).toBe('application-design');

    // Widening the content reflows the prose above it, so the heading crosses the
    // line. Not one scroll event fires: only the toggle knows the layout moved.
    await page.locator('#toggle-left').click();
    await page.locator('#toggle-right').click();

    await expect.poll(() => activeOutlineId(page), { timeout: 3000 }).toBe('naïve-approach');
  });
});

test('collapsed drawers survive a reload', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await page.locator('#toggle-left').click();
  await page.locator('#toggle-right').click();
  await expect.poll(() => paneWidth(page, 'explorer')).toBeLessThan(40);

  await page.reload();
  await expect(page.locator('#doc h1')).toHaveText('Guide');

  // Applied by the inline script, before app.js and before first paint.
  expect(await page.evaluate(() => document.documentElement.dataset.left)).toBe('closed');
  expect(await page.evaluate(() => document.documentElement.dataset.right)).toBe('closed');
  expect(await paneWidth(page, 'explorer')).toBeLessThan(40);
  expect(await paneWidth(page, 'outline')).toBeLessThan(40);
});
