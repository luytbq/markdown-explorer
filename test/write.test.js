import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { resolveRoot } from '../src/paths.js';
import { createApp, listen } from '../src/server.js';
import { clearTreeCache } from '../src/tree.js';
import { applyEol, atomicWrite, detectEol, fileVersion } from '../src/write.js';

/**
 * fetch() treats Origin as a forbidden header and drops it silently, exactly as
 * it does with Host. A CSRF check tested through fetch is always green and never
 * exercised, which is the whole point of the check. Go raw.
 */
function rawPut(port, reqPath, { headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method: 'PUT',
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
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-write-'));
  const root = await resolveRoot(tmp);
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Hello\n\n<!-- a note to self -->\n');
  await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Guide\n');
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

const save = (port, rel, body) =>
  rawPut(port, `/api/file?path=${encodeURIComponent(rel)}`, { body: JSON.stringify(body) });

test('the raw endpoint hands back the file, not a rendering of it', async (t) => {
  const root = await fixture();
  const { base, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  await fs.writeFile(
    path.join(root, 'README.md'),
    '---\ntitle: Notes\n---\n\n# Hello\n\n<!-- a note to self -->\n',
  );

  const data = await raw(base, 'README.md');

  // The editor shows the document as it is on disk. The renderer eats frontmatter
  // and HTML comments; here they have to survive.
  assert.match(data.source, /^---\ntitle: Notes\n---\n/);
  assert.match(data.source, /<!-- a note to self -->/);
  assert.equal(data.eol, 'lf');
  assert.match(data.version, /^[0-9a-f]{64}$/);
});

test('save', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  await t.test('writes the file and returns the version it now has', async () => {
    const before = await raw(base, 'docs/guide.md');
    const res = await save(port, 'docs/guide.md', {
      source: '# Guide\n\nNow with words.\n',
      version: before.version,
      eol: 'lf',
    });

    assert.equal(res.status, 200);
    const after = await raw(base, 'docs/guide.md');
    assert.equal(after.source, '# Guide\n\nNow with words.\n');
    assert.equal(JSON.parse(res.text).version, after.version);
    assert.notEqual(after.version, before.version);
  });

  await t.test('a stale version is a conflict, and the file is left alone', async () => {
    const stale = await raw(base, 'docs/guide.md');
    await fs.writeFile(path.join(root, 'docs', 'guide.md'), '# Someone else got here first\n');

    const res = await save(port, 'docs/guide.md', {
      source: '# Mine\n',
      version: stale.version,
      eol: 'lf',
    });

    assert.equal(res.status, 409);
    const body = JSON.parse(res.text);
    assert.equal(body.error, 'conflict');

    const onDisk = await fs.readFile(path.join(root, 'docs', 'guide.md'), 'utf8');
    assert.equal(onDisk, '# Someone else got here first\n');

    // The 409 carries the version to save against, so an overwrite is one click.
    const forced = await save(port, 'docs/guide.md', {
      source: '# Mine\n',
      version: body.version,
      eol: 'lf',
    });
    assert.equal(forced.status, 200);
    assert.equal(await fs.readFile(path.join(root, 'docs', 'guide.md'), 'utf8'), '# Mine\n');
  });

  await t.test('a file that is not there is a conflict, not a creation', async () => {
    const res = await save(port, 'docs/new.md', { source: '# New\n', version: 'whatever', eol: 'lf' });

    assert.equal(res.status, 409);
    assert.equal(JSON.parse(res.text).error, 'missing');
    await assert.rejects(fs.stat(path.join(root, 'docs', 'new.md')));
  });

  await t.test('a path that escapes the root is 403, never 404', async () => {
    for (const rel of ['../outside.md', '/etc/passwd.md', 'docs/../../outside.md']) {
      const res = await save(port, rel, { source: 'x', version: 'v', eol: 'lf' });
      assert.equal(res.status, 403, rel);
    }

    // Containment is settled before anything asks what kind of file the path
    // names. Ask the other way round and this one answers 400, which is a rule
    // the guard was reached through rather than after.
    const res = await save(port, '../outside.txt', { source: 'x', version: 'v', eol: 'lf' });
    assert.equal(res.status, 403);
  });

  await t.test('a path that is not markdown is refused', async () => {
    const res = await save(port, 'notes.txt', { source: 'x', version: 'v', eol: 'lf' });
    assert.equal(res.status, 400);
    assert.equal(await fs.readFile(path.join(root, 'notes.txt'), 'utf8'), 'plain');
  });

  await t.test('a malformed body is refused', async () => {
    const { version } = await raw(base, 'README.md');
    for (const body of [
      { source: 42, version, eol: 'lf' },
      { source: 'x', eol: 'lf' },
      { source: 'x', version, eol: 'cr' },
    ]) {
      const res = await save(port, 'README.md', body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});

/**
 * The Host check does not stop a page on the web from POSTing to localhost with
 * a perfectly good Host header. CORS keeps it from reading the answer, but the
 * write would still land. Origin is the only thing standing in the way.
 */
test('a save from anywhere but our own page is refused', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const { version } = await raw(base, 'README.md');
  const body = JSON.stringify({ source: '# Owned\n', version, eol: 'lf' });
  const attempt = (headers) => rawPut(port, '/api/file?path=README.md', { headers, body });

  assert.equal((await attempt({ Origin: 'http://evil.example' })).status, 403);
  assert.equal((await attempt({ Origin: 'null' })).status, 403);
  assert.equal((await attempt({ Origin: `http://127.0.0.1:${port + 1}` })).status, 403);

  // No Origin at all is a refusal too. A browser always sends one on a write, so
  // the caller without one is not a browser, and can set the header if it means it.
  const bare = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/file?path=README.md',
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(bare, 403);

  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Hello\n\n<!-- a note to self -->\n');

  // And the same door, locked again: this content type forces a cross-origin
  // caller into a preflight, which we never answer.
  const wrongType = await attempt({ 'Content-Type': 'text/plain' });
  assert.equal(wrongType.status, 415);
});

test('a body over the cap is refused before it is buffered', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const { version } = await raw(base, 'README.md');
  const body = JSON.stringify({ source: 'x'.repeat(6 * 1024 * 1024), version, eol: 'lf' });

  const res = await rawPut(port, '/api/file?path=README.md', { body });
  assert.equal(res.status, 413);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Hello\n\n<!-- a note to self -->\n');
});

test('--read-only serves but does not save', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root, { readOnly: true });
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/api/config`)).status, 200);
  assert.deepEqual(await (await fetch(`${base}/api/config`)).json(), { readOnly: true });

  const { version } = await raw(base, 'README.md');
  const res = await save(port, 'README.md', { source: '# Changed\n', version, eol: 'lf' });

  assert.equal(res.status, 403);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Hello\n\n<!-- a note to self -->\n');
});

/**
 * The HTML spec has a textarea normalise its value to LF, so a CRLF file comes
 * back out of the browser with every line ending rewritten. Saving that verbatim
 * would turn a one-word edit into a diff touching every line of the file. The
 * server remembers what the file was written with and puts it back.
 */
test('a CRLF file survives the round trip through a textarea', async (t) => {
  const root = await fixture();
  const { base, port, stop } = await start(root);
  t.after(async () => {
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  const dos = path.join(root, 'dos.md');
  await fs.writeFile(dos, '# Title\r\n\r\nA line.\r\n');

  const before = await raw(base, 'dos.md');
  assert.equal(before.eol, 'crlf');

  // What the browser would hand back: the same document, LF, one word changed.
  const fromTextarea = before.source.replace(/\r\n/g, '\n').replace('A line.', 'Another line.');
  const res = await save(port, 'dos.md', {
    source: fromTextarea,
    version: before.version,
    eol: before.eol,
  });
  assert.equal(res.status, 200);

  assert.equal(await fs.readFile(dos, 'utf8'), '# Title\r\n\r\nAnother line.\r\n');
});

test('an atomic write leaves nothing behind and keeps the file it replaced', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const target = path.join(root, 'README.md');
  await fs.chmod(target, 0o640);

  await atomicWrite(target, '# Replaced\n');
  assert.equal(await fs.readFile(target, 'utf8'), '# Replaced\n');

  // The temp file is a sibling, so a save that crashed would leave litter in the
  // reader's own directory.
  assert.deepEqual((await fs.readdir(root)).sort(), ['README.md', 'docs', 'notes.txt']);

  if (process.platform !== 'win32') {
    // rename() gives the new file default permissions. A document that was not
    // world-readable before a save must not become world-readable because of one.
    const stat = await fs.stat(target);
    assert.equal(stat.mode & 0o777, 0o640);
  }
});

test('a version is the content, and eol survives a round trip', () => {
  assert.equal(detectEol('# Title\r\n\r\nText\r\n'), 'crlf');
  assert.equal(detectEol('# Title\n\nText\n'), 'lf');
  assert.equal(detectEol('no newlines at all'), 'lf');

  // A file that is mostly LF with one stray CRLF is an LF file.
  assert.equal(detectEol('a\nb\nc\r\nd\n'), 'lf');

  assert.equal(applyEol('a\nb\n', 'crlf'), 'a\r\nb\r\n');
  assert.equal(applyEol('a\r\nb\r\n', 'lf'), 'a\nb\n');
  assert.equal(applyEol('a\r\nb\r\n', 'crlf'), 'a\r\nb\r\n'); // idempotent, not doubled
});

test('a missing file has no version', async (t) => {
  const root = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  assert.equal(await fileVersion(path.join(root, 'nope.md')), null);
  assert.match(await fileVersion(path.join(root, 'README.md')), /^[0-9a-f]{64}$/);
});
