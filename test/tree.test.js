import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildTree, getTree, clearTreeCache } from '../src/tree.js';
import { resolveRoot } from '../src/paths.js';

async function fixture(files) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-tree-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(tmp, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
  }
  return resolveRoot(tmp);
}

const names = (nodes) => nodes.map((n) => n.name);

test('lists markdown and ignores everything else', async (t) => {
  const root = await fixture({
    'README.md': '# r',
    'notes.markdown': '# n',
    'old.mkd': '# o',
    'legacy.mdown': '# l',
    'script.js': 'x',
    'image.png': 'x',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Case-insensitive, the way a file explorer orders things: README.md sorts on
  // "r", not on the fact that it happens to be uppercase.
  const tree = await buildTree(root);
  assert.deepEqual(names(tree.children), ['legacy.mdown', 'notes.markdown', 'old.mkd', 'README.md']);
  assert.equal(tree.fileCount, 4);
});

test('prunes directories with no markdown anywhere beneath them', async (t) => {
  const root = await fixture({
    'docs/guide.md': '# g',
    'src/index.js': 'x',
    'src/util/helper.js': 'x',
    'assets/logo.png': 'x',
    'deep/a/b/c/found.md': '# f',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const tree = await buildTree(root);
  assert.deepEqual(names(tree.children), ['deep', 'docs']);

  const deep = tree.children.find((n) => n.name === 'deep');
  assert.equal(deep.children[0].children[0].children[0].children[0].path, 'deep/a/b/c/found.md');
});

test('skips ignored and dotted directories', async (t) => {
  const root = await fixture({
    'node_modules/pkg/README.md': '# no',
    'dist/out.md': '# no',
    'coverage/report.md': '# no',
    '.git/notes.md': '# no',
    '.github/PULL_REQUEST_TEMPLATE.md': '# no',
    'keep.md': '# yes',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const tree = await buildTree(root);
  assert.deepEqual(names(tree.children), ['keep.md']);
});

test('directories sort before files, with numeric collation', async (t) => {
  const root = await fixture({
    '9.md': '# 9',
    '10.md': '# 10',
    'zeta/a.md': '# a',
    'alpha/a.md': '# a',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const tree = await buildTree(root);
  assert.deepEqual(names(tree.children), ['alpha', 'zeta', '9.md', '10.md']);
});

test('a symlink cycle does not hang the walk', async (t) => {
  const root = await fixture({ 'docs/a.md': '# a' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  try {
    await fs.symlink(root, path.join(root, 'docs', 'loop'), 'dir');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('symlinks need privileges here');
    throw err;
  }

  const tree = await buildTree(root);
  assert.deepEqual(names(tree.children), ['docs']);
});

test('a symlink escaping root is skipped', async (t) => {
  const root = await fixture({ 'a.md': '# a' });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-out-'));
  await fs.mkdir(path.join(outside, 'secret'));
  await fs.writeFile(path.join(outside, 'secret', 'leak.md'), '# leak');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  try {
    await fs.symlink(path.join(outside, 'secret'), path.join(root, 'linked'), 'dir');
  } catch (err) {
    if (err.code === 'EPERM') return t.skip('symlinks need privileges here');
    throw err;
  }

  const tree = await buildTree(root);
  assert.deepEqual(names(tree.children), ['a.md']);
});

test('depth and file caps are honoured', async (t) => {
  const root = await fixture({
    'a/b/c/deep.md': '# d',
    'one.md': '# 1',
    'two.md': '# 2',
    'three.md': '# 3',
  });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const shallow = await buildTree(root, { maxDepth: 1 });
  assert.deepEqual(names(shallow.children), ['one.md', 'three.md', 'two.md']);

  const capped = await buildTree(root, { maxFiles: 2 });
  assert.equal(capped.truncated, true);
  assert.ok(capped.fileCount <= 2);
});

test('an empty directory yields an empty tree, not an error', async (t) => {
  const root = await fixture({});
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const tree = await buildTree(root);
  assert.deepEqual(tree.children, []);
  assert.equal(tree.fileCount, 0);
});

test('the etag is stable for an unchanged tree and moves when it changes', async (t) => {
  const root = await fixture({ 'a.md': '# a' });
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  clearTreeCache();
  const first = await getTree(root);
  clearTreeCache();
  const again = await getTree(root);
  assert.equal(first.etag, again.etag);

  await fs.writeFile(path.join(root, 'b.md'), '# b');
  clearTreeCache();
  const changed = await getTree(root);
  assert.notEqual(changed.etag, first.etag);
});
