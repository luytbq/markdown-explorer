import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { searchContents, fold } from '../src/search.js';
import { clearTreeCache } from '../src/tree.js';
import { resolveRoot } from '../src/paths.js';

async function fixture(files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-search-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return resolveRoot(tmp);
}

// searchContents reads through the (cached) tree, so a fresh root per test is not
// enough on its own if a root were reused; clearing keeps every case independent.
async function search(root, query) {
  clearTreeCache();
  return searchContents(root, query);
}

test('finds a term in file contents with 1-based line numbers', async (t) => {
  const root = await fixture({
    'a.md': '# Title\n\nsome coffee here\nand more\n',
    'b.md': 'nothing to see\n',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { results, truncated } = await search(root, 'coffee');
  assert.equal(truncated, false);
  assert.equal(results.length, 1);
  assert.equal(results[0].path, 'a.md');
  assert.deepEqual(
    results[0].matches.map((m) => m.line),
    [3],
  );
  assert.equal(results[0].matches[0].text, 'some coffee here');
});

test('matching is case- and accent-insensitive, the way the filter folds names', async (t) => {
  const root = await fixture({
    'menu.md': '# Menu\n\nUống Cà Phê Sữa\n',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { results } = await search(root, 'ca phe');
  assert.equal(results.length, 1);
  const match = results[0].matches[0];
  assert.equal(match.line, 3);

  // The range indexes the NFC line in code points, so slicing it lands on the
  // accented substring, not one letter off.
  const cps = [...match.text];
  const [start, end] = match.ranges[0];
  assert.equal(cps.slice(start, end).join(''), 'Cà Phê');
});

test('a query shorter than two folded code points finds nothing', async (t) => {
  const root = await fixture({ 'a.md': 'aaaa bbbb\n' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.deepEqual((await search(root, 'a')).results, []);
  assert.deepEqual((await search(root, '')).results, []);
  assert.deepEqual((await search(root, '  ')).results, []); // folds to spaces, still short
});

test('only the files the tree shows are searched', async (t) => {
  const root = await fixture({
    'keep.md': 'find the needle here\n',
    'node_modules/pkg/dep.md': 'needle in a dependency\n',
    '.hidden/secret.md': 'needle in a dotfile dir\n',
    'notes.txt': 'needle in a non-markdown file\n',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { results } = await search(root, 'needle');
  assert.deepEqual(
    results.map((r) => r.path),
    ['keep.md'],
  );
});

test('matches per file are capped, and the cap marks the result truncated', async (t) => {
  const many = Array.from({ length: 15 }, (_, i) => `line ${i} has target`).join('\n');
  const root = await fixture({ 'big.md': `${many}\n` });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { results, truncated } = await search(root, 'target');
  assert.equal(results.length, 1);
  assert.equal(results[0].matches.length, 10);
  assert.equal(truncated, true);
});

test('a file over the size ceiling is skipped, not scanned', async (t) => {
  const huge = 'x\n'.repeat(3 * 1024 * 1024) + 'the target line\n'; // > 5 MiB
  const root = await fixture({ 'huge.md': huge, 'small.md': 'the target line\n' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { results } = await search(root, 'target');
  assert.deepEqual(
    results.map((r) => r.path),
    ['small.md'],
  );
});

test('fold agrees with the browser filter on a Vietnamese example', () => {
  assert.equal(fold('Tài Liệu').join(''), 'tai lieu');
  assert.equal(fold('Café').join(''), 'cafe');
});
