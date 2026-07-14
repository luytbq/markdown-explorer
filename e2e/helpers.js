import { expect } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveRoot } from '../src/paths.js';
import { createApp, listen } from '../src/server.js';
import { clearTreeCache } from '../src/tree.js';

// The shared fixture ---------------------------------------------------------

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
export const README = `---
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

export const EDITABLE = `---
title: Editable
---

# Editable

<!-- a comment, invisible in the rendered document -->

Some prose.
`;

/**
 * A private root and a private server per spec file: an afterEach cleaning up
 * one feature's files can no longer reach into another feature's fixture, which
 * is the reason the one big spec was split in the first place.
 */
export async function launch({ readOnly = false } = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-e2e-'));
  const root = await resolveRoot(tmp);

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
  const server = createApp({ root, readOnly });
  const address = await listen(server, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;

  const stop = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  };

  return { root, base, server, stop };
}

/** Write it the way an editor would: temp file, rename over the target. */
export async function saveOnDisk(root, rel, text) {
  const target = path.join(root, rel);
  const tmp = path.join(root, `.${path.basename(rel)}.e2e.tmp`);
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, target);
}

export async function openEditable(page, { root, base }) {
  await saveOnDisk(root, 'edit.md', EDITABLE);
  await page.goto(`${base}/?path=edit.md`);
  await expect(page.locator('#doc h1')).toHaveText('Editable');
  await expect(page.locator('html[data-live="on"]')).toHaveCount(1);
}

// Page geometry --------------------------------------------------------------

/** Distance from the top of the scroll pane to the top of an element. */
export const offsetFromPaneTop = (page, id) =>
  page.evaluate((headingId) => {
    const pane = document.getElementById('content');
    const el = document.getElementById(headingId);
    return el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  }, id);

export const activeOutlineId = (page) => page.locator('#toc a.active').getAttribute('data-id');

export const paneWidth = (page, id) =>
  page.evaluate((paneId) => Math.round(document.getElementById(paneId).getBoundingClientRect().width), id);

export const scrollTop = (page) => page.evaluate(() => document.getElementById('content').scrollTop);

/** Scroll to a fraction of the way down, so the test does not depend on fixture height. */
export async function scrollPart(page, fraction) {
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
export async function spySettled(page) {
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

// The explorer and its menus ---------------------------------------------------

export const files = (page) => page.locator('#tree a.file');

// docs is the only directory at the top of the fixture. Its own summary, not the
// one belonging to the "deep" directory nested inside it.
export const docsDetails = (page) => page.locator('#tree > details');
export const docsSummary = (page) => docsDetails(page).locator(':scope > summary');

export const inlineInput = (page) => page.locator('#tree .tree-input');
export const menuItem = (page, label) => page.locator('#ctx-menu button', { hasText: label });

export const tabs = (page) => page.locator('#tabbar .tab');
export const tab = (page, rel) => page.locator(`#tabbar .tab[data-path="${rel}"]`);
