import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { resolveRoot } from '../src/paths.js';
import { createApp, listen } from '../src/server.js';
import { clearTreeCache } from '../src/tree.js';

/**
 * Same rule as write.test.js: fetch() drops Origin silently, so a CSRF check
 * tested through fetch is always green and never exercised. Go raw.
 */
function rawPost(port, reqPath, { headers = {}, body = '{}' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: `http://127.0.0.1:${port}`,
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-fsops-'));
  const root = await resolveRoot(tmp);
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Hello\n');
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n');
  await fs.writeFile(path.join(root, 'docs', 'other.md'), '# Other\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'plain');
  return root;
}

async function start(root, opts = {}) {
  clearTreeCache();
  const server = createApp({ root, ...opts });
  const address = await listen(server, { port: 0, host: '127.0.0.1' });
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
  return { base: `http://127.0.0.1:${address.port}`, port: address.port, stop };
}

const raw = async (base, rel) => (await fetch(`${base}/api/raw?path=${encodeURIComponent(rel)}`)).json();

const create = (port, rel, opts = {}) =>
  rawPost(port, `/api/file?path=${encodeURIComponent(rel)}`, opts);

const rename = (port, body, opts = {}) =>
  rawPost(port, '/api/rename', { body: JSON.stringify(body), ...opts });

const treePaths = async (base) => {
  const tree = await (await fetch(`${base}/api/tree`)).json();
  const out = [];
  const visit = (node) => {
    if (node.type === 'file') out.push(node.path);
    else node.children.forEach(visit);
  };
  visit(tree);
  return out;
};

test('create', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  await t.test('brings an empty file into existence and hands back its version', async () => {
    const res = await create(port, 'docs/new.md');
    assert.equal(res.status, 201);

    const body = JSON.parse(res.text);
    assert.equal(body.path, 'docs/new.md');

    assert.equal(await fs.readFile(path.join(root, 'docs', 'new.md'), 'utf8'), '');
    // The version is the one a save against this file must present.
    assert.equal((await raw(base, 'docs/new.md')).version, body.version);
  });

  await t.test('the explorer sees it immediately, not a cache-lifetime later', async () => {
    // getTree caches for a second, and the client refreshes the tree right after
    // a create. Without the cache being dropped on write, the refresh would
    // fetch the old second's tree and the new file would not be in it. The cache
    // only holds what has been asked for, so ask first.
    assert.ok(!(await treePaths(base)).includes('docs/fresh.md'));
    const res = await create(port, 'docs/fresh.md');
    assert.equal(res.status, 201);
    assert.ok((await treePaths(base)).includes('docs/fresh.md'));
  });

  await t.test('a file that already exists is a conflict, and is left alone', async () => {
    const res = await create(port, 'README.md');
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.text).error, 'exists');
    assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Hello\n');
  });

  await t.test('a directory that is not there is not conjured up', async () => {
    const res = await create(port, 'nowhere/new.md');
    assert.equal(res.status, 404);
  });

  await t.test('a path that escapes the root is 403, even a non-markdown one', async () => {
    for (const rel of ['../outside.md', '../outside.txt', 'docs/../../outside.md']) {
      assert.equal((await create(port, rel)).status, 403, rel);
    }
  });

  await t.test('a path that is not markdown is refused', async () => {
    const res = await create(port, 'script.sh');
    assert.equal(res.status, 400);
    await assert.rejects(fs.stat(path.join(root, 'script.sh')));
  });

  await t.test('a caller that is not our page is refused, and nothing is created', async () => {
    const bad = [
      { headers: { Origin: 'http://evil.example' }, want: 403 },
      { headers: { Origin: '' }, want: 403 },
      { headers: { 'Content-Type': 'text/plain' }, want: 415 },
    ];
    for (const { headers, want } of bad) {
      const res = await create(port, 'docs/owned.md', { headers });
      assert.equal(res.status, want, JSON.stringify(headers));
    }
    await assert.rejects(fs.stat(path.join(root, 'docs', 'owned.md')));
  });
});

test('rename', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  await t.test('moves the name, keeps the contents, and the version rides along', async () => {
    const { version } = await raw(base, 'docs/guide.md');
    const res = await rename(port, { from: 'docs/guide.md', to: 'docs/handbook.md', version });

    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.text), { path: 'docs/handbook.md', version });

    await assert.rejects(fs.stat(path.join(root, 'docs', 'guide.md')));
    assert.equal(await fs.readFile(path.join(root, 'docs', 'handbook.md'), 'utf8'), '# Guide\n');
    assert.ok((await treePaths(base)).includes('docs/handbook.md'));
  });

  await t.test('a stale version is a conflict, and nothing moves', async () => {
    const { version } = await raw(base, 'docs/other.md');
    await fs.writeFile(path.join(root, 'docs', 'other.md'), '# Changed underneath\n');

    const res = await rename(port, { from: 'docs/other.md', to: 'docs/renamed.md', version });
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.text).error, 'conflict');
    assert.ok(await fs.stat(path.join(root, 'docs', 'other.md')));
  });

  await t.test('a source that is not there is missing, not an invention', async () => {
    const res = await rename(port, { from: 'docs/ghost.md', to: 'docs/real.md', version: 'x' });
    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.text).error, 'missing');
  });

  await t.test('a target that already exists is never overwritten', async () => {
    const { version } = await raw(base, 'docs/other.md');
    const res = await rename(port, { from: 'docs/other.md', to: 'docs/handbook.md', version });

    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.text).error, 'exists');
    assert.equal(await fs.readFile(path.join(root, 'docs', 'handbook.md'), 'utf8'), '# Guide\n');
  });

  await t.test('a case-only rename is the file itself, not a collision', async () => {
    // On APFS and NTFS, stat('readme.md') answers for README.md, so an existence
    // check would refuse the rename against the very file being renamed. The
    // identity comparison (same dev+ino) is what lets this through. On ext4 the
    // target genuinely does not exist and the rename is plain; this test can
    // only catch the removed fix on a case-insensitive filesystem.
    const { version } = await raw(base, 'README.md');
    const res = await rename(port, { from: 'README.md', to: 'Readme.md', version });

    assert.equal(res.status, 200);
    assert.ok((await fs.readdir(root)).includes('Readme.md'));
  });

  await t.test('a rename does not cross directories', async () => {
    const { version } = await raw(base, 'docs/handbook.md');
    for (const to of ['handbook.md', 'docs/deeper/handbook.md']) {
      const res = await rename(port, { from: 'docs/handbook.md', to, version });
      assert.equal(res.status, 400, to);
    }
    assert.ok(await fs.stat(path.join(root, 'docs', 'handbook.md')));
  });

  await t.test('both names pass containment before anything else', async () => {
    for (const body of [
      { from: '../outside.md', to: '../elsewhere.md', version: 'x' },
      { from: 'docs/handbook.md', to: '../stolen.md', version: 'x' },
    ]) {
      assert.equal((await rename(port, body)).status, 403, JSON.stringify(body));
    }
  });

  await t.test('markdown in, markdown out', async () => {
    const { version } = await raw(base, 'docs/handbook.md');
    const res = await rename(port, { from: 'docs/handbook.md', to: 'docs/handbook.txt', version });
    assert.equal(res.status, 400);
    assert.equal((await rename(port, { from: 'notes.txt', to: 'notes.md', version: 'x' })).status, 400);
  });

  await t.test('a malformed body is refused', async () => {
    for (const body of [{ from: 'a.md' }, { from: 'a.md', to: 'b.md' }, null, 42]) {
      const res = await rename(port, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  await t.test('a caller that is not our page is refused, and nothing moves', async () => {
    const { version } = await raw(base, 'docs/handbook.md');
    const body = { from: 'docs/handbook.md', to: 'docs/taken.md', version };

    const bad = await rename(port, body, { headers: { Origin: 'http://evil.example' } });
    assert.equal(bad.status, 403);
    const wrongType = await rename(port, body, { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(wrongType.status, 415);

    assert.ok(await fs.stat(path.join(root, 'docs', 'handbook.md')));
  });
});

test('--read-only refuses to create or rename', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root, { readOnly: true });
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal((await create(port, 'new.md')).status, 403);

  const { version } = await raw(base, 'README.md');
  const res = await rename(port, { from: 'README.md', to: 'HELLO.md', version });
  assert.equal(res.status, 403);

  assert.ok(await fs.stat(path.join(root, 'README.md')));
  await assert.rejects(fs.stat(path.join(root, 'new.md')));
});
