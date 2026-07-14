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
  await fs.rm(path.join(root, 'copy.md'), { force: true });
  clearTreeCache();
});

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
