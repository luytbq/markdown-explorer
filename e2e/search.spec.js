import { test, expect } from '@playwright/test';

import { launch, files } from './helpers.js';

// Content search: the Text mode of the explorer's search box. It scans file
// contents on the server and renders the hits into #tree, where a click opens the
// file on the section that holds the match.
test.describe('content search', () => {
  let ctx;

  test.beforeEach(async () => {
    ctx = await launch();
  });

  test.afterEach(async () => {
    await ctx.stop();
  });

  const hash = (page) => page.evaluate(() => (location.hash ? decodeURIComponent(location.hash.slice(1)) : ''));

  test('searches contents and a hit opens on its nearest section', async ({ page }) => {
    await page.goto(ctx.base);
    await expect(files(page)).toHaveCount(4);

    await page.locator('#search-text').click();
    await expect(page.locator('#search-text')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search text');

    // "described" occurs once, in the line under the "Naïve Approach" heading.
    await page.locator('#search').fill('described');

    const lines = page.locator('#tree a.search-line');
    await expect(lines).toHaveCount(1);
    await expect(page.locator('#tree a.search-file')).toHaveText('README.md');
    await expect(lines.first().locator('mark')).toHaveText('described');

    await lines.first().click();
    await expect(page.locator('#doc h1')).toHaveText('Application Design');
    // The match sits under "## Naïve Approach", so that is where it lands.
    await expect.poll(() => hash(page)).toBe('naïve-approach');
  });

  test('folds accents like the name filter, and Text finds what Name cannot', async ({ page }) => {
    await page.goto(ctx.base);
    await expect(files(page)).toHaveCount(4);

    await page.locator('#search-text').click();

    // No filename contains "naive", but the accented word appears in the contents.
    await page.locator('#search').fill('naive');
    await expect(page.locator('#tree a.search-line').first()).toBeVisible();
    await expect(page.locator('#tree a.search-line mark').first()).toHaveText(/na.?ve/i);
  });

  test('a one-character query shows the hint, not a whole-tree dump', async ({ page }) => {
    await page.goto(ctx.base);
    await expect(files(page)).toHaveCount(4);

    await page.locator('#search-text').click();
    await page.locator('#search').fill('a');

    await expect(page.locator('#tree .pane-empty')).toContainText('at least two');
    await expect(page.locator('#tree a.search-line')).toHaveCount(0);
  });

  test('switching back to Name leaves content search behind', async ({ page }) => {
    await page.goto(ctx.base);
    await expect(files(page)).toHaveCount(4);

    await page.locator('#search-text').click();
    await page.locator('#search').fill('described');
    await expect(page.locator('#tree a.search-line')).toHaveCount(1);

    await page.locator('#search-name').click();
    await expect(page.locator('#search-name')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#tree a.search-line')).toHaveCount(0);

    // The box still holds "described"; clearing it brings the whole tree back.
    await page.locator('#search').fill('');
    await expect(files(page)).toHaveCount(4);
  });
});
