#!/usr/bin/env node
/**
 * Record docs/demo.gif: a real browser driving the real server over a staged
 * demo directory. Re-run it whenever the UI changes and the README's picture
 * goes stale: node scripts/record-demo.mjs
 *
 * Playwright records the session as webm; its own bundled ffmpeg (the one it
 * uses to produce that webm) then turns it into a palette-optimised gif, so
 * nothing beyond the repo's devDependencies is needed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { resolveRoot } from '../src/paths.js';
import { createApp, listen } from '../src/server.js';
import { clearTreeCache } from '../src/tree.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'demo.gif');
const SIZE = { width: 1280, height: 720 };
const GIF_WIDTH = 960;
const FPS = 10;

// The demo directory -------------------------------------------------------

const README = `# markdown-explorer

Browse the markdown under any directory: tree on the left, rendered document
in the middle, a live outline on the right.

## Reading

The outline follows your scroll. Click a heading there and the document jumps
to it; leave a file and come back, and you are exactly where you stopped.

Code is highlighted, with a copy button on every block:

\`\`\`js
export function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

## How a request flows

Diagrams render with mermaid. Click one to zoom it.

\`\`\`mermaid
graph LR
    A[Browser] --> B[server.js] --> C[render.js] --> D[markdown-it] --> E[HTML]
    B --> F[tree.js] --> G[File tree]
    B --> H[watcher.js] --> I[Live reload]
\`\`\`

## Searching

The filter box matches loose letters anywhere along a path, and it ignores
accents: typing \`cafe\` finds \`café-notes.md\`, because nobody reaches for
the accented letter while searching.

## Editing

Press \`e\` and the raw file opens in place, on the very section you were
reading. \`Ctrl+S\` saves it back to disk, through the same atomic write your
editor uses.

## And more

Live reload, dark mode, pinned tabs, drag-to-move, shareable URLs. One
\`npx markdown-explorer\` and no configuration.
`;

const CAFE_NOTES = `# Café notes

## Espresso

Accented filenames and headings just work: this file was found by typing
plain \`cafe\`, and this heading has a GitHub-compatible id, accents included.

## Scratchpad

Edit this file right in the browser.
`;

async function makeFixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-demo-'));
  const root = await resolveRoot(tmp);
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), README);
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n\n## Install\n\n```bash\nnpx markdown-explorer\n```\n');
  await fs.writeFile(path.join(root, 'docs', 'api.md'), '# API\n\n## Endpoints\n\nGET /api/tree, GET /api/file.\n');
  await fs.writeFile(path.join(root, 'notes', 'café-notes.md'), CAFE_NOTES);
  clearTreeCache();
  return root;
}

// Camera work ---------------------------------------------------------------

/** Playwright does not record a cursor, so the page draws one for the camera. */
const CURSOR_SCRIPT = () => {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    dot.style.cssText =
      'position:fixed;z-index:2147483647;width:18px;height:18px;border-radius:50%;' +
      'background:rgba(255,130,20,.5);border:2px solid rgba(255,255,255,.95);' +
      'box-shadow:0 1px 5px rgba(0,0,0,.45);pointer-events:none;left:-60px;top:-60px;' +
      'transform:translate(-50%,-50%);transition:width .08s,height .08s';
    document.body.append(dot);
    addEventListener(
      'mousemove',
      (e) => {
        dot.style.left = `${e.clientX}px`;
        dot.style.top = `${e.clientY}px`;
      },
      true,
    );
    addEventListener('mousedown', () => {
      dot.style.width = '12px';
      dot.style.height = '12px';
    }, true);
    addEventListener('mouseup', () => {
      dot.style.width = '18px';
      dot.style.height = '18px';
    }, true);
  });
};

const pause = (page, ms) => page.waitForTimeout(ms);

/** Glide the mouse to the element, settle, then click: watchable, not teleporting. */
async function glideClick(page, locator, { settle = 350 } = {}) {
  const box = await locator.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 30 });
  await pause(page, settle);
  await page.mouse.down();
  await page.mouse.up();
}

async function smoothScroll(page, top) {
  await page.evaluate((t) => {
    document.getElementById('content').scrollTo({ top: t, behavior: 'smooth' });
  }, top);
  await pause(page, 1100);
}

// The scenario ---------------------------------------------------------------

async function record(base, videoDir) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: videoDir, size: SIZE },
    colorScheme: 'light',
  });
  await context.addInitScript(CURSOR_SCRIPT);
  const page = await context.newPage();

  await page.goto(`${base}/?path=README.md`);
  await page.getByRole('heading', { name: 'markdown-explorer' }).waitFor();
  await page.locator('#doc pre.mermaid svg').waitFor({ state: 'visible', timeout: 20_000 });
  await page.mouse.move(640, 300);
  await pause(page, 1500);

  // The outline follows a scroll, and a click in it jumps.
  await smoothScroll(page, 500);
  await glideClick(page, page.locator('#toc a', { hasText: 'How a request flows' }));
  await pause(page, 900);

  // The diagram zooms into a lightbox. Mermaid can still be settling its
  // layout when the glide lands (seen once: the svg moved between measuring
  // and clicking), so a click that missed gets one straight retry.
  await glideClick(page, page.locator('#doc pre.mermaid svg'));
  await pause(page, 200);
  if (await page.evaluate(() => document.querySelector('body > #lightbox').hidden)) {
    await page.locator('#doc pre.mermaid svg').click();
  }
  await pause(page, 1300);
  await page.keyboard.press('Escape');
  await pause(page, 600);

  // The filter ignores accents: cafe finds café-notes.md.
  await glideClick(page, page.locator('#search'));
  await page.keyboard.type('cafe', { delay: 140 });
  await pause(page, 1100);
  await glideClick(page, page.locator('#tree a.file', { hasText: 'café-notes.md' }));
  await page.getByRole('heading', { name: 'Café notes' }).waitFor();
  await pause(page, 1200);

  // Edit in place, save to disk, land back in the rendered view.
  await page.keyboard.press('e');
  await page.locator('#editor').waitFor({ state: 'visible' });
  await pause(page, 700);
  await page.evaluate(() => {
    const editor = document.getElementById('editor');
    editor.setSelectionRange(editor.value.length, editor.value.length);
    editor.scrollTop = editor.scrollHeight;
  });
  await page.keyboard.type('\nEdited right here in the browser.\n', { delay: 60 });
  await pause(page, 500);
  await page.keyboard.press('ControlOrMeta+s');
  await pause(page, 900);
  await page.keyboard.press('Escape');
  await pause(page, 500);
  await smoothScroll(page, await page.evaluate(() => document.getElementById('content').scrollHeight));
  await pause(page, 400);

  // Dark mode, and the diagram repaints for it.
  await glideClick(page, page.locator('#theme'));
  await pause(page, 1800);

  await page.close();
  const video = await page.video().path();
  await context.close();
  await browser.close();
  return video;
}

// webm -> gif ----------------------------------------------------------------

/** Playwright keeps its ffmpeg in its browser cache; find it rather than depend on one. */
async function findFfmpeg() {
  const cache =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright');
  for (const dir of await fs.readdir(cache)) {
    if (!dir.startsWith('ffmpeg')) continue;
    for (const file of await fs.readdir(path.join(cache, dir))) {
      if (file.startsWith('ffmpeg')) return path.join(cache, dir, file);
    }
  }
  throw new Error(`no ffmpeg under ${cache}; run: npx playwright install`);
}

/**
 * Playwright's ffmpeg is built with --disable-everything and re-enables only
 * what recording needs: scale/pad/crop, png, image2. No fps filter, no
 * palettegen, no gif muxer. So it decodes the webm into png frames (-r does
 * the 10fps without the filter), and ImageMagick assembles and optimises the
 * gif. magick is the one tool this script expects on the machine.
 */
async function toGif(ffmpeg, webm, gif) {
  const frames = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-demo-frames-'));
  try {
    execFileSync(ffmpeg, [
      '-y', '-i', webm,
      '-r', String(FPS), '-vf', `scale=${GIF_WIDTH}:-2`,
      path.join(frames, '%04d.png'),
    ], { stdio: 'pipe' });
    execFileSync('magick', [
      '-delay', String(100 / FPS), '-loop', '0',
      path.join(frames, '*.png'),
      '-layers', 'optimize',
      gif,
    ], { stdio: 'pipe' });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('needs ImageMagick: brew install imagemagick');
    throw new Error(err.stderr?.toString() || err.message);
  } finally {
    await fs.rm(frames, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

const root = await makeFixture();
const server = createApp({ root });
const address = await listen(server, { port: 0, host: '127.0.0.1' });
const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-demo-video-'));

try {
  const webm = await record(`http://127.0.0.1:${address.port}`, videoDir);
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await toGif(await findFfmpeg(), webm, OUT);
  const { size } = await fs.stat(OUT);
  console.log(`${path.relative(process.cwd(), OUT)}: ${(size / 1024 / 1024).toFixed(1)} MB`);
} finally {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(videoDir, { recursive: true, force: true });
}
