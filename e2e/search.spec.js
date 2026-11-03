import fs from 'node:fs/promises';
import path from 'node:path';

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

  test('a hit far down a section scrolls to its own line, not the section top', async ({ page }) => {
    const filler = (from, n) => Array.from({ length: n }, (_, i) => `filler ${from + i}`).join('\n\n');
    const code = Array.from({ length: 60 }, (_, i) => (i === 45 ? 'needlecode()' : `noop(${i})`)).join('\n');
    await fs.writeFile(
      path.join(ctx.root, 'long.md'),
      `# Long\n\n${filler(0, 60)}\n\nthe needlepara sits here\n\n${filler(60, 60)}\n\n\`\`\`js\n${code}\n\`\`\`\n\n${filler(120, 30)}\n`,
    );
    await page.goto(ctx.base);
    await page.locator('#search-text').click();

    // Both hits are under "# Long", so the section top alone would leave them off screen.
    // The hit lands just above scrollspy's 80px line, a little lead-in above it.
    const nearTop = (locator) =>
      locator.evaluate((el) => {
        const top = el.getBoundingClientRect().top - document.getElementById('content').getBoundingClientRect().top;
        return top > 0 && top < 100;
      });
    const inView = (locator) =>
      locator.evaluate((el) => {
        const pane = document.getElementById('content').getBoundingClientRect();
        const box = el.getBoundingClientRect();
        return box.bottom > pane.top && box.top < pane.bottom;
      });

    await page.locator('#search').fill('needlepara');
    await expect(page.locator('#tree a.search-line mark')).toHaveText('needlepara');
    await page.locator('#tree a.search-line').first().click();
    await expect(page.locator('#doc h1')).toHaveText('Long');
    await expect.poll(() => nearTop(page.locator('#doc p', { hasText: 'needlepara' }))).toBe(true);
    expect(await inView(page.locator('#doc h1'))).toBe(false);

    // Inside a code block the line is found within the block, not at its top, and
    // 45 lines down any error in the per-line pitch has added up past the margin.
    await page.locator('#search').fill('needlecode');
    await expect(page.locator('#tree a.search-line mark')).toHaveText('needlecode');
    await page.locator('#tree a.search-line').first().click();
    await expect.poll(() => nearTop(page.locator('#doc pre .hljs-title', { hasText: 'needlecode' }))).toBe(true);
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

// A reload (F5) is the reader's tab carrying on, so the search box carries on too.
test.describe('the search box across a reload', () => {
  let ctx;

  test.beforeEach(async () => {
    ctx = await launch();
  });

  test.afterEach(async () => {
    await ctx.stop();
  });

  test('a name filter is still applied after a reload', async ({ page }) => {
    await page.goto(ctx.base);
    await expect(files(page)).toHaveCount(4);

    await page.locator('#search').fill('dcgui');
    await expect(files(page)).toHaveText(['guide.md']);

    await page.reload();
    await expect(page.locator('#search')).toHaveValue('dcgui');
    await expect(files(page)).toHaveText(['guide.md']);
  });

  test('a content search comes back in Text mode with its results', async ({ page }) => {
    await page.goto(ctx.base);
    await expect(files(page)).toHaveCount(4);

    await page.locator('#search-text').click();
    await page.locator('#search').fill('described');
    await expect(page.locator('#tree a.search-line')).toHaveCount(1);

    await page.reload();
    await expect(page.locator('#search-text')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#search')).toHaveAttribute('placeholder', 'Search text');
    await expect(page.locator('#search')).toHaveValue('described');
    await expect(page.locator('#tree a.search-line')).toHaveCount(1);
  });

  test('a search cleared with Escape stays cleared after a reload', async ({ page }) => {
    await page.goto(ctx.base);
    await expect(files(page)).toHaveCount(4);

    // Typed in Text mode and cleared through Escape, so only the clear itself can
    // have taken "described" back out of storage.
    await page.locator('#search-text').click();
    await page.locator('#search').fill('described');
    await expect(page.locator('#tree a.search-line')).toHaveCount(1);
    await page.locator('#search').press('Escape');
    await expect(page.locator('#search')).toHaveValue('');

    await page.reload();
    await expect(page.locator('#search-text')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#search')).toHaveValue('');
    await expect(page.locator('#tree a.search-line')).toHaveCount(0);
  });

  test('a new tab starts with an empty search', async ({ page, context }) => {
    await page.goto(ctx.base);
    await page.locator('#search').fill('dcgui');
    await expect(files(page)).toHaveText(['guide.md']);

    const other = await context.newPage();
    await other.goto(ctx.base);
    await expect(files(other)).toHaveCount(4);
    await expect(other.locator('#search')).toHaveValue('');
  });
});
