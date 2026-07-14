import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

import { clearTreeCache } from '../src/tree.js';
import { launch, files, docsDetails, docsSummary, paneWidth } from './helpers.js';

let root;
let base;
let stop;

test.beforeAll(async () => {
  ({ root, base, stop } = await launch());
});

test.afterAll(() => stop());

test.afterEach(async () => {
  await fs.rm(path.join(root, 'tài-liệu.md'), { force: true });
  await fs.rm(path.join(root, 'docs', 'guidance.md'), { force: true });
  // The server holds the tree for a second, which is long enough for a file one
  // test made to still be in the tree the next test is handed.
  clearTreeCache();
});

test('explorer lists markdown only and prunes empty branches', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#tree summary')).toHaveText(['docs', 'deep']);
  await expect(page.locator('#tree a.file')).toHaveText(['nested.md', 'guide.md', 'links.md', 'README.md']);
  await expect(page.locator('#tree')).not.toContainText('src');
});

/**
 * A directory's disclosure triangle used to occupy 16px inside the summary's own
 * content box, with nothing reserving that space on file rows. Every child file
 * then rendered to the left of the directory containing it, and the tree read as
 * though the nesting ran the other way.
 */
test('the tree indents every node to the right of its parent', async ({ page }) => {
  await page.goto(base);
  await page.waitForSelector('#tree details', { state: 'attached' });
  await page.evaluate(() => {
    for (const details of document.querySelectorAll('#tree details')) details.open = true;
  });

  const rows = await page.evaluate(() => {
    const textLeft = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return Math.round(range.getBoundingClientRect().left);
    };
    const out = [];
    const walk = (el, depth, parentLeft) => {
      for (const child of el.children) {
        if (child.tagName === 'DETAILS') {
          const summary = child.querySelector(':scope > summary');
          const left = textLeft(summary);
          out.push({ name: summary.textContent, depth, left, parentLeft });
          walk(child, depth + 1, left);
        } else if (child.tagName === 'A') {
          out.push({ name: child.textContent, depth, left: textLeft(child), parentLeft });
        }
      }
    };
    walk(document.getElementById('tree'), 0, null);
    return out;
  });

  expect(rows.length).toBeGreaterThan(4);
  expect(rows.some((r) => r.depth === 2)).toBe(true); // the fixture really does nest twice

  for (const row of rows) {
    if (row.parentLeft === null) continue;
    expect(row.left, `${row.name} must sit right of its parent`).toBeGreaterThan(row.parentLeft);
  }

  // Siblings line up whether they are files or directories.
  const leftsByDepth = new Map();
  for (const row of rows) {
    if (!leftsByDepth.has(row.depth)) leftsByDepth.set(row.depth, new Set());
    leftsByDepth.get(row.depth).add(row.left);
  }
  for (const [depth, lefts] of leftsByDepth) {
    expect([...lefts], `everything at depth ${depth} shares one left edge`).toHaveLength(1);
  }
});

// Filtering the tree --------------------------------------------------------

async function filter(page, query) {
  await page.locator('#search').fill(query);
}

test('a filter matches loose letters anywhere along the path', async ({ page }) => {
  await page.goto(base);
  await expect(files(page)).toHaveCount(4);

  // Not a substring of anything: d-c from "docs", g-u-i from "guide".
  await filter(page, 'dcgui');
  await expect(files(page)).toHaveText(['guide.md']);

  // A directory narrows without being a special case, because the whole path matches.
  await filter(page, 'deep');
  await expect(files(page)).toHaveText(['nested.md']);

  await filter(page, '');
  await expect(files(page)).toHaveCount(4);
});

test('the filter prunes the branches that do not match and opens the ones that do', async ({ page }) => {
  await page.goto(base);

  await filter(page, 'nested');
  await expect(files(page)).toHaveText(['nested.md']);

  // Every directory on the way down to a survivor is open, or the match is
  // pruned in name only and the reader still cannot see it.
  for (const details of await page.locator('#tree details').all()) {
    await expect(details).toHaveAttribute('open', '');
  }
  await expect(page.locator('#tree a.file')).toBeVisible();
});

test('the letters that earned the match are picked out', async ({ page }) => {
  await page.goto(base);
  await filter(page, 'gd');

  await expect(files(page)).toHaveText(['guide.md']);
  await expect(files(page).locator('mark')).toHaveText(['g', 'd']);
});

/**
 * Typing without accents has to find the file that has them. A Vietnamese or
 * French filename is otherwise unreachable from the keyboard people actually use.
 *
 * This folds, where paths.js must never normalise: on ext4 the two spellings of
 * café.md really are two files. The difference is that nothing here opens
 * anything. It compares text for the reader's eyes, and the path used to fetch
 * the document is the untouched one.
 */
test('a filter without accents finds the file with them', async ({ page }) => {
  await fs.writeFile(path.join(root, 'tài-liệu.md'), '# Tài liệu\n');
  clearTreeCache(); // or the page is served the tree from before the file existed
  await page.goto(base);
  await expect(files(page)).toHaveCount(5);

  await filter(page, 'tailieu');
  await expect(files(page)).toHaveText(['tài-liệu.md']);

  await filter(page, 'TAI LIEU'); // case and spaces are nothing to go on
  await expect(files(page)).toHaveText(['tài-liệu.md']);
});

/**
 * The toggle event of a <details> is queued, not fired in place, so the `open`
 * set while building a filtered tree still reaches the listener that persists
 * which directories the reader had expanded. Without a guard, one keystroke in
 * the filter box rewrites that, in localStorage, permanently: the reader closes
 * a directory, searches for something, clears the search, and it is open again.
 */
test('filtering does not rewrite which directories the reader had open', async ({ page }) => {
  await page.goto(base);

  const docs = docsDetails(page);
  await expect(docs).toHaveAttribute('open', ''); // top-level directories start open

  await docsSummary(page).click();
  await expect(docs).not.toHaveAttribute('open', '');

  await filter(page, 'guide'); // this opens docs, because the filter needs it open
  await expect(files(page)).toHaveText(['guide.md']);
  await expect(docsDetails(page)).toHaveAttribute('open', '');

  await filter(page, '');

  // Back to the tree the reader left, not the one the filter made.
  await expect(files(page)).toHaveCount(4);
  await expect(docsDetails(page)).not.toHaveAttribute('open', '');

  const remembered = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('mdx:expanded:'));
    return JSON.parse(localStorage.getItem(key) ?? '[]');
  });
  expect(remembered).not.toContain('docs');
});

/**
 * The tree is polled, and a poll that finds a change replaces the whole of #tree.
 * The filter has to be reapplied to what comes back, and the box has to still be
 * there with the caret in it, which is why it lives outside the element that is
 * being replaced.
 */
test('a filter survives the tree being rebuilt underneath it', async ({ page }) => {
  await page.goto(base);

  await page.locator('#search').focus();
  await filter(page, 'guid');
  await expect(files(page)).toHaveText(['guide.md']);

  // A file appears on disk, and it happens to match what is being typed.
  await fs.writeFile(path.join(root, 'docs', 'guidance.md'), '# Guidance\n');
  await page.waitForTimeout(1200); // the server caches the tree for a second
  await page.evaluate(() => dispatchEvent(new Event('focus')));

  await expect(files(page)).toHaveText(['guidance.md', 'guide.md']);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
});

test('a filter that matches nothing says so', async ({ page }) => {
  await page.goto(base);
  await filter(page, 'zzzz');

  await expect(files(page)).toHaveCount(0);
  await expect(page.locator('#tree .pane-empty')).toHaveText('No files match.');
});

test('slash focuses the filter, escape clears it', async ({ page }) => {
  await page.goto(base);
  await expect(page.locator('#doc h1')).toHaveText('Application Design');

  await page.keyboard.press('/');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');

  await page.keyboard.type('guide');
  await expect(files(page)).toHaveText(['guide.md']);

  await page.keyboard.press('Escape');
  await expect(page.locator('#search')).toHaveValue('');
  await expect(files(page)).toHaveCount(4);
});

test('slash opens the explorer if it was collapsed, since a hidden box cannot take focus', async ({ page }) => {
  await page.goto(base);
  await page.locator('#toggle-left').click();
  await expect.poll(() => paneWidth(page, 'explorer')).toBeLessThan(40);

  await page.keyboard.press('/');

  await expect.poll(() => paneWidth(page, 'explorer')).toBeGreaterThan(200);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('search');
});
