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
 * fetch() treats Host as a forbidden header and drops it silently, so a Host
 * check tested through fetch is always green and never exercised. Go raw.
 */
function rawGet(port, reqPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: reqPath, method: 'GET', headers },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function fixture() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-server-'));
  const root = await resolveRoot(tmp);
  await fs.mkdir(path.join(root, 'docs', 'img'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Xin chào\n\n## Bước 1\n');
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n');
  await fs.writeFile(path.join(root, 'notes.txt'), 'plain');
  await fs.writeFile(path.join(root, '.env'), 'SECRET=hunter2');
  await fs.writeFile(path.join(root, 'docs', 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}

async function start(root, opts = {}) {
  clearTreeCache();
  const server = createApp({ root, ...opts });
  const address = await listen(server, { port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${address.port}`;
  const stop = () =>
    new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(resolve);
    });
  return { base, port: address.port, stop };
}

test('server', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  await t.test('serves the tree with an etag, then a 304', async () => {
    const first = await fetch(`${base}/api/tree`);
    assert.equal(first.status, 200);
    const etag = first.headers.get('etag');
    assert.ok(etag);

    const tree = await first.json();
    assert.deepEqual(tree.children.map((n) => n.name), ['docs', 'README.md']);

    const second = await fetch(`${base}/api/tree`, { headers: { 'If-None-Match': etag } });
    assert.equal(second.status, 304);
  });

  await t.test('renders a markdown file', async () => {
    const res = await fetch(`${base}/api/file?path=README.md`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Xin chào');
    assert.deepEqual(body.headings.map((h) => h.id), ['xin-chào', 'bước-1']);
    assert.match(body.html, /<h2 id="bước-1">/);
  });

  await t.test('404 for a missing file, 400 for a non-markdown one', async () => {
    assert.equal((await fetch(`${base}/api/file?path=nope.md`)).status, 404);
    assert.equal((await fetch(`${base}/api/file?path=notes.txt`)).status, 400);
    assert.equal((await fetch(`${base}/api/file`)).status, 400);
  });

  // 403 not 400: the guard runs before the "is it markdown" rule, so an escape
  // is reported as an escape even when it does not look like a document.
  await t.test('rejects path traversal', async () => {
    assert.equal((await fetch(`${base}/api/file?path=../../../etc/passwd`)).status, 403);
    assert.equal((await fetch(`${base}/api/file?path=..%2f..%2f..%2fetc%2fpasswd`)).status, 403);
    assert.equal((await fetch(`${base}/api/file?path=/etc/passwd`)).status, 403);
    assert.equal((await fetch(`${base}/api/file?path=../outside.md`)).status, 403);
  });

  await t.test('rejects a symlink escaping root', async (st) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-out-'));
    await fs.writeFile(path.join(outside, 'secret.md'), '# leak');
    st.after(() => fs.rm(outside, { recursive: true, force: true }));

    try {
      await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'escape.md'));
    } catch (err) {
      if (err.code === 'EPERM') return st.skip('symlinks need privileges here');
      throw err;
    }
    assert.equal((await fetch(`${base}/api/file?path=escape.md`)).status, 403);
    await fs.rm(path.join(root, 'escape.md'));
  });

  await t.test('rejects an unexpected Host header', async () => {
    assert.equal(await rawGet(port, '/api/tree', { Host: 'evil.com' }), 403);
    assert.equal(await rawGet(port, '/api/tree', { Host: 'attacker.test:4321' }), 403);
    // And the loopback names still work.
    assert.equal(await rawGet(port, '/api/tree', { Host: `localhost:${port}` }), 200);
    assert.equal(await rawGet(port, '/api/tree', { Host: `127.0.0.1:${port}` }), 200);
  });

  await t.test('serves images through /files', async () => {
    const res = await fetch(`${base}/files/docs/img/a.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
  });

  await t.test('refuses non-images through /files by default', async () => {
    assert.equal((await fetch(`${base}/files/.env`)).status, 403);
    assert.equal((await fetch(`${base}/files/notes.txt`)).status, 403);
  });

  await t.test('refuses traversal through /files', async () => {
    assert.equal((await fetch(`${base}/files/%2e%2e%2fpackage.json`)).status, 403);
  });

  await t.test('refuses non-GET methods', async () => {
    assert.equal((await fetch(`${base}/api/tree`, { method: 'POST' })).status, 405);
  });
});

test('server with --allow-host', async (t) => {
  const root = await fixture();
  const { port, stop } = await start(root, { allowHosts: ['dev.local'] });
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal(await rawGet(port, '/api/tree', { Host: 'dev.local' }), 200);
  assert.equal(await rawGet(port, '/api/tree', { Host: 'dev.local:8080' }), 200);
  assert.equal(await rawGet(port, '/api/tree', { Host: 'other.local' }), 403);
});

test('server with --serve-all', async (t) => {
  const root = await fixture();
  const { base, stop } = await start(root, { serveAll: true });
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/files/.env`)).status, 200);
  // Opening the allowlist must not open the root.
  assert.equal((await fetch(`${base}/files/%2e%2e%2fpackage.json`)).status, 403);
});

test('live reload survives three consecutive atomic saves', async (t) => {
  const root = await fixture();
  const { base, stop } = await start(root);
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const res = await fetch(`${base}/api/events?path=README.md`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];

  const pump = (async () => {
    let buffer = '';
    while (events.length < 3) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)));
      }
      buffer = '';
    }
  })();

  // Exactly how vim and VS Code save: write a temp file, rename over the target.
  const target = path.join(root, 'README.md');
  for (let i = 1; i <= 3; i++) {
    await new Promise((r) => setTimeout(r, 150));
    const tmp = path.join(root, `.README.md.${i}.tmp`);
    await fs.writeFile(tmp, `# Xin chào\n\n## Bước ${i}\n`);
    await fs.rename(tmp, target);
  }

  await Promise.race([pump, new Promise((r) => setTimeout(r, 4000))]);

  assert.equal(events.length, 3, `expected 3 change events, got ${events.length}`);
  assert.ok(events.every((e) => e.type === 'file-changed' && e.path === 'README.md'));
});

test('subscribing to an already-missing file reports it immediately', async (t) => {
  const root = await fixture();
  const { base, stop } = await start(root);
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  // No watch event can ever fire for a deletion that already happened.
  const res = await fetch(`${base}/api/events?path=docs/never.md`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  const deadline = Date.now() + 3000;
  let seen = null;
  while (!seen && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split('\n')) {
      if (line.startsWith('data: ')) seen = JSON.parse(line.slice(6));
    }
  }
  assert.deepEqual(seen, { type: 'file-deleted', path: 'docs/never.md' });
});

test('deleting the open file emits file-deleted', async (t) => {
  const root = await fixture();
  const { base, stop } = await start(root);
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const res = await fetch(`${base}/api/events?path=docs/guide.md`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  setTimeout(() => fs.rm(path.join(root, 'docs', 'guide.md')), 150);

  const deadline = Date.now() + 4000;
  let seen = null;
  while (!seen && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value, { stream: true }).split('\n')) {
      if (line.startsWith('data: ')) seen = JSON.parse(line.slice(6));
    }
  }
  assert.deepEqual(seen, { type: 'file-deleted', path: 'docs/guide.md' });
});
