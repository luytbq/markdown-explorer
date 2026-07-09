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
