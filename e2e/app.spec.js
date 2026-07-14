import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveRoot } from '../src/paths.js';
import { createApp, listen } from '../src/server.js';
import { clearTreeCache } from '../src/tree.js';

const LONG_SECTION = Array.from(
  { length: 12 },
  (_, i) => `Paragraph ${i + 1}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.`,
).join('\n\n');

/**
 * Only the paragraph immediately above "Naïve Approach" may change height when the
 * drawers collapse, and it must lose exactly one line. Chrome's scroll anchoring
 * compensates for content that reflows *above* the viewport top, and that
 * compensation fires a scroll event, which is enough to re-run scrollspy on its
 * own. The relayout test would then pass with its fix removed. Keeping the earlier
 * paragraphs to a single line pins the reflow inside the viewport, where anchoring
 * leaves scrollTop alone.
 */
const README = `---
title: Fixture
---

# Application Design

INTRO_MARKER

A short line, one line wide at every width the tests use.

This paragraph is deliberately long, so it wraps to a different number of lines at different
widths. When the two drawers collapse, the content column widens, it loses a line, and the
heading below it moves up.

## Naïve Approach

The naïve approach, described in one line.

## Setup

First time.

\`\`\`js
const a = 1;
\`\`\`

## Setup

Second time.

## Diagram

\`\`\`mermaid
graph TD
    A[Browser] --> B[Server]
    B --> C[markdown-it]
\`\`\`

## Long Section

${LONG_SECTION}

## Very Short Final Section

A single line.
`;

let root;
let server;
let base;

test.beforeAll(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-e2e-'));
  root = await resolveRoot(tmp);

  await fs.mkdir(path.join(root, 'docs', 'deep'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'deep', 'nested.md'), '# Deeply Nested\n');
  await fs.writeFile(path.join(root, 'README.md'), README);
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\n## Install\n\nhello\n');
  await fs.writeFile(
    path.join(root, 'docs', 'links.md'),
    '# Links\n\n' +
      '- [to the second Setup](../README.md#setup-1)\n' +
      '- [to the naïve approach](../README.md#naïve-approach)\n' +
      '- [outbound](https://example.com)\n',
  );
  await fs.writeFile(path.join(root, 'src', 'index.js'), 'console.log(1)'); // no markdown: must be pruned

  clearTreeCache();
  server = createApp({ root });
  const address = await listen(server, { port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

/** Distance from the top of the scroll pane to the top of an element. */
const offsetFromPaneTop = (page, id) =>
  page.evaluate((headingId) => {
    const pane = document.getElementById('content');
    const el = document.getElementById(headingId);
    return el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, id);

const activeOutlineId = (page) => page.locator('#toc a.active').getAttribute('data-id');

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

// Scroll memory ----------------------------------------------------------

const scrollTop = (page) => page.evaluate(() => document.getElementById('content').scrollTop);

/** Scroll to a fraction of the way down, so the test does not depend on fixture height. */
async function scrollPart(page, fraction) {
  return page.evaluate((f) => {
    const pane = document.getElementById('content');
    pane.scrollTop = Math.round((pane.scrollHeight - pane.clientHeight) * f);
    return pane.scrollTop;
  }, fraction);
}

/**
 * Scrollspy catches up on the next animation frame, writing both the highlight
 * and the url hash. Reload before that and the url disagrees with what we
 * remembered, so the explicit-anchor rule wins and the reader lands at a heading.
 *
 * Waiting for highlight and hash to merely agree is not enough: before the first
 * frame they agree on the *old* value. Wait until both match live geometry, which
 * means no frame is still pending. A human cannot press F5 inside one frame of a
 * scroll; a test can.
 */
async function spySettled(page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const pane = document.getElementById('content');
        const headings = [...document.querySelectorAll('#doc :is(h1,h2,h3,h4,h5,h6)[id]')];
        if (headings.length === 0) return true;

        const line = pane.getBoundingClientRect().top + 80;
        let expected = headings[0];
        for (const heading of headings) {
          if (heading.getBoundingClientRect().top > line) break;
          expected = heading;
        }
        if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 2) expected = headings.at(-1);

        const hash = location.hash ? decodeURIComponent(location.hash.slice(1)) : null;
        const active = document.querySelector('#toc a.active')?.dataset.id ?? null;
        return expected.id === active && expected.id === hash;
      }),
    )
    .toBe(true);
}

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

// Side drawers ------------------------------------------------------------

const paneWidth = (page, id) =>
  page.evaluate((paneId) => Math.round(document.getElementById(paneId).getBoundingClientRect().width), id);

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

// Editing ------------------------------------------------------------------

const EDITABLE = `---
title: Editable
---

# Editable

<!-- a comment, invisible in the rendered document -->

Some prose.
`;

/** Write it the way an editor would: temp file, rename over the target. */
async function saveOnDisk(rel, text) {
  const target = path.join(root, rel);
  const tmp = path.join(root, `.${path.basename(rel)}.e2e.tmp`);
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, target);
}

async function openEditable(page) {
  await saveOnDisk('edit.md', EDITABLE);
  await page.goto(`${base}/?path=edit.md`);
  await expect(page.locator('#doc h1')).toHaveText('Editable');
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);
}

test.afterEach(async () => {
  await fs.rm(path.join(root, 'edit.md'), { force: true });
  await fs.rm(path.join(root, 'copy.md'), { force: true });
  await fs.rm(path.join(root, 'tài-liệu.md'), { force: true });
  await fs.rm(path.join(root, 'docs', 'guidance.md'), { force: true });
  // The server holds the tree for a second, which is long enough for a file one
  // test made to still be in the tree the next test is handed.
  clearTreeCache();
});

test('edit mode shows the document as it is on disk, not as it renders', async ({ page }) => {
  await openEditable(page);

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
  await openEditable(page);
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
  await openEditable(page);
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
  await openEditable(page);
  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toBeVisible();

  await page.locator('#editor').fill(EDITABLE.replace('Some prose.', 'My unsaved work.'));
  await expect(page.locator('#dirty')).toBeVisible();

  await saveOnDisk('edit.md', EDITABLE.replace('Some prose.', 'Their work.'));

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
  await openEditable(page);
  await page.locator('#mode-edit').click();
  await expect(page.locator('#editor')).toHaveValue(EDITABLE);

  await saveOnDisk('edit.md', EDITABLE.replace('Some prose.', 'Rewritten elsewhere.'));

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
  clearTreeCache();
  const readOnly = createApp({ root, readOnly: true });
  const address = await listen(readOnly, { port: 0, host: '127.0.0.1' });

  try {
    await page.goto(`http://127.0.0.1:${address.port}/?path=docs%2Fguide.md`);
    await expect(page.locator('#doc h1')).toHaveText('Guide');

    await expect(page.locator('#mode-edit')).toBeHidden();
    await page.keyboard.press('e');
    await expect(page.locator('#editor')).toBeHidden();
  } finally {
    readOnly.closeAllConnections?.();
    await new Promise((resolve) => readOnly.close(resolve));
    clearTreeCache();
  }
});

// Filtering the tree --------------------------------------------------------

const files = (page) => page.locator('#tree a.file');

// docs is the only directory at the top of the fixture. Its own summary, not the
// one belonging to the "deep" directory nested inside it.
const docsDetails = (page) => page.locator('#tree > details');
const docsSummary = (page) => docsDetails(page).locator(':scope > summary');

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

// Copy buttons -------------------------------------------------------------

const WIDE_LINE = `const wide = "${'x'.repeat(400)}";`;
const CODE = `const answer = 42;\n${WIDE_LINE}`;
const DIAGRAM = 'graph TD\n    A[Browser] --> B[Server]';

const COPY_DOC = `# Copy

\`\`\`js
${CODE}
\`\`\`

\`\`\`mermaid
${DIAGRAM}
\`\`\`
`;

async function openCopyDoc(page) {
  await fs.writeFile(path.join(root, 'copy.md'), COPY_DOC);
  await page.goto(`${base}/?path=copy.md`);
  await expect(page.locator('#doc h1')).toHaveText('Copy');
}

const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());

const codeBlock = (page) => page.locator('.code-block').filter({ has: page.locator('pre:not(.mermaid)') });
const diagramBlock = (page) => page.locator('.code-block').filter({ has: page.locator('pre.mermaid') });

test('the copy button on a code block copies the code', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCopyDoc(page);

  const block = codeBlock(page);
  await block.hover();
  await block.locator('button.copy').click();

  await expect(block.locator('button.copy')).toHaveText('Copied');
  expect(await clipboard(page)).toBe(CODE); // the trailing newline of the fence is not part of it
});

/**
 * mermaid.run replaces the element's content with the rendered SVG, and the
 * diagram source is gone: reading textContent afterwards hands back the stylesheet
 * mermaid injects into the SVG, which starts "#mermaid-1784003312619{font-family:".
 * The source has to be taken before mermaid runs, or the button copies that.
 */
test('the copy button on a diagram copies the diagram, not the svg', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCopyDoc(page);

  const block = diagramBlock(page);
  await expect(block.locator('svg')).toBeVisible({ timeout: 15_000 });

  await block.hover();
  await block.locator('button.copy').click();
  await expect(block.locator('button.copy')).toHaveText('Copied');

  const copied = await clipboard(page);
  expect(copied).toBe(DIAGRAM);
  expect(copied).not.toContain('font-family');
  expect(copied).not.toContain('svg');
});

/**
 * The <pre> is the horizontal scroll container. A button positioned inside it is
 * positioned against the content, so it slides off to the left as soon as the
 * reader drags a long line sideways, which is the exact moment they wanted it.
 */
test('the copy button stays put when the code is scrolled sideways', async ({ page }) => {
  await openCopyDoc(page);

  const block = codeBlock(page);
  const pre = block.locator('pre');
  const button = block.locator('button.copy');

  // The line really is wider than the column; otherwise this test proves nothing.
  const overflows = await pre.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflows).toBeGreaterThan(200);

  const before = await button.boundingBox();
  await pre.evaluate((el) => {
    el.scrollLeft = el.scrollWidth;
  });
  expect(await pre.evaluate((el) => el.scrollLeft)).toBeGreaterThan(200);

  const after = await button.boundingBox();
  expect(after.x).toBe(before.x);
  expect(after.y).toBe(before.y);
});

/**
 * navigator.clipboard is only there in a secure context. localhost is one, but
 * --host and --allow-host exist so that another machine can read this, and over
 * http://192.168.x.x it is not. Without the fallback the button does nothing at
 * all, in silence, for precisely the people who asked for that setup.
 */
test('the copy button still works where there is no clipboard api', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    document.execCommand = (command) => {
      if (command !== 'copy') return false;
      window.__staged = document.activeElement?.value;
      return true;
    };
  });

  await openCopyDoc(page);

  const block = codeBlock(page);
  await block.hover();
  await block.locator('button.copy').click();

  await expect(block.locator('button.copy')).toHaveText('Copied');
  expect(await page.evaluate(() => window.__staged)).toBe(CODE);
});

test('theme toggle repaints the page and the code block, and survives a reload', async ({ page }) => {
  await page.goto(`${base}/?path=docs%2Fguide.md`);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    localStorage.setItem('mdx:theme', 'light');
  });

  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const lightBg = await bg();

  await page.locator('#theme').click();
  await expect.poll(bg).not.toBe(lightBg);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');

  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  expect(await bg()).not.toBe(lightBg);
});
