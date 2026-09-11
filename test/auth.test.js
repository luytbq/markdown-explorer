import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { createAuth } from '../src/auth.js';
import { resolveRoot } from '../src/paths.js';
import { createApp, listen } from '../src/server.js';
import { clearTreeCache } from '../src/tree.js';

const PASSWORD = 'correct horse';

/**
 * Raw, not fetch: fetch drops Host and Origin silently, and two of these tests
 * are about the order this check runs in relative to those two.
 *
 * An event stream never ends, so a response is settled on its headers alone and
 * the socket dropped; a status is all any of these tests read from a stream.
 */
function request(port, reqPath, { method = 'GET', headers = {}, body, stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: body === undefined ? headers : { 'Content-Length': Buffer.byteLength(body), ...headers },
      },
      (res) => {
        const done = (text) => resolve({ status: res.statusCode, headers: res.headers, text });
        if (stream && res.statusCode === 200) {
          res.destroy();
          return done('');
        }
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => done(text));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const json = { 'Content-Type': 'application/json' };

const signIn = (port, password, { prefix = '', headers = {} } = {}) =>
  request(port, `${prefix}/api/login`, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify({ password }),
  });

/** The name=value half of a Set-Cookie, which is what a browser sends back. */
const sessionOf = (res) => res.headers['set-cookie'][0].split(';')[0];

async function start(opts = {}) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-auth-'));
  const root = await resolveRoot(tmp);
  await fs.mkdir(path.join(root, 'img'));
  await fs.writeFile(path.join(root, 'README.md'), '# Hello\n');
  await fs.writeFile(path.join(root, 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  clearTreeCache();
  const server = createApp({ root, password: PASSWORD, ...opts });
  const { port } = await listen(server, { port: 0, host: '127.0.0.1' });
  const stop = async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  };
  return { root, port, stop };
}

test('--password', async (t) => {
  const { root, port, stop } = await start();
  t.after(stop);

  await t.test('without a session the sign-in page is all that is served', async () => {
    for (const url of ['/', '/index.html?path=README.md']) {
      const res = await request(port, url);
      assert.equal(res.status, 401, url);
      assert.match(res.text, /<form id="login">/, url);
    }

    const gated = [
      '/api/tree',
      '/api/config',
      '/api/file?path=README.md',
      '/api/raw?path=README.md',
      '/api/search?q=hello',
      '/static/app.js',
      '/static/login.html',
      '/files/img/a.png',
    ];
    for (const url of gated) {
      const res = await request(port, url);
      assert.equal(res.status, 401, url);
      assert.doesNotMatch(res.text, /Hello|<form/, url);
    }
    const events = await request(port, '/api/events?path=README.md', { stream: true });
    assert.equal(events.status, 401);
  });

  await t.test('a write without a session is refused before its origin is looked at', async () => {
    const body = JSON.stringify({ source: '# Owned\n', version: 'x', eol: 'lf' });
    const withOrigin = await request(port, '/api/file?path=README.md', {
      method: 'PUT',
      headers: { ...json, Origin: `http://127.0.0.1:${port}` },
      body,
    });
    assert.equal(withOrigin.status, 401);

    // A missing Origin is the write lock's 403; this is still the sign-in's 401.
    const withoutOrigin = await request(port, '/api/file?path=README.md', { method: 'PUT', headers: json, body });
    assert.equal(withoutOrigin.status, 401);

    const created = await request(port, '/api/file?path=new.md', {
      method: 'POST',
      headers: { ...json, Origin: `http://127.0.0.1:${port}` },
      body: '{}',
    });
    assert.equal(created.status, 401);

    assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), '# Hello\n');
    await assert.rejects(fs.stat(path.join(root, 'new.md')));
  });

  await t.test('the Host check still runs before the sign-in', async () => {
    const res = await request(port, '/', { headers: { Host: 'evil.example' } });
    assert.equal(res.status, 403);
  });

  await t.test('a wrong password is a 401 and sets no cookie', async () => {
    const res = await signIn(port, 'correct horse ');
    assert.equal(res.status, 401);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  await t.test('a sign-in asks for json, which a cross-origin form cannot send without a preflight', async () => {
    const res = await request(port, '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(res.status, 415);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  await t.test('a sign-in through an https tunnel is not refused for its origin', async () => {
    const res = await signIn(port, PASSWORD, { headers: { Origin: 'https://docs.example.com' } });
    assert.equal(res.status, 204);
  });

  await t.test('the right password opens a session the rest of the app accepts', async () => {
    const res = await signIn(port, PASSWORD);
    assert.equal(res.status, 204);

    const cookie = res.headers['set-cookie'][0];
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, /; Path=\/;/);
    assert.match(cookie, /^mdx-session-\d+=/);

    const session = sessionOf(res);
    assert.equal((await request(port, '/api/tree', { headers: { Cookie: session } })).status, 200);
    assert.match((await request(port, '/', { headers: { Cookie: session } })).text, /id="app"/);

    const config = await request(port, '/api/config', { headers: { Cookie: `theme=dark; ${session}` } });
    assert.deepEqual(JSON.parse(config.text), { readOnly: false, auth: true });

    const events = await request(port, '/api/events?path=README.md', { headers: { Cookie: session }, stream: true });
    assert.equal(events.status, 200);
  });

  await t.test('a forged token is not a session', async () => {
    const forged = await request(port, '/api/tree', { headers: { Cookie: `mdx-session-${port}=forged` } });
    assert.equal(forged.status, 401);
  });

  await t.test('signing out ends the session on the server, not just in the browser', async () => {
    const session = sessionOf(await signIn(port, PASSWORD));

    const out = await request(port, '/api/logout', { method: 'POST', headers: { ...json, Cookie: session }, body: '{}' });
    assert.equal(out.status, 204);
    assert.match(out.headers['set-cookie'][0], /Max-Age=0/);

    // A client that ignores the cleared cookie and replays the old one.
    assert.equal((await request(port, '/api/tree', { headers: { Cookie: session } })).status, 401);
  });
});

test('guesses are limited globally, and a session already open outlives the limit', async (t) => {
  const { port, stop } = await start();
  t.after(stop);

  const session = sessionOf(await signIn(port, PASSWORD));

  for (let i = 0; i < 5; i += 1) assert.equal((await signIn(port, `guess ${i}`)).status, 401);

  const limited = await signIn(port, PASSWORD);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['set-cookie'], undefined);
  const wait = Number(limited.headers['retry-after']);
  assert.ok(wait > 0 && wait <= 60, `retry-after ${wait}`);

  assert.equal((await request(port, '/api/tree', { headers: { Cookie: session } })).status, 200);
});

// Cookies ignore the port, so two servers on one machine sharing a cookie name
// would each sign the other's reader out on every sign-in.
test('two servers on one machine keep their sessions under different names', async (t) => {
  const a = await start();
  const b = await start();
  t.after(() => Promise.all([a.stop(), b.stop()]));

  const nameA = sessionOf(await signIn(a.port, PASSWORD)).split('=')[0];
  const nameB = sessionOf(await signIn(b.port, PASSWORD)).split('=')[0];
  assert.notEqual(nameA, nameB);
});

test('under a mount point the sign-in and its cookie stay inside it', async (t) => {
  const { port, stop } = await start({ prefix: 'docs' });
  t.after(stop);

  assert.equal((await request(port, '/docs')).status, 302);

  const page = await request(port, '/docs/');
  assert.equal(page.status, 401);
  assert.match(page.text, /<form id="login">/);

  const res = await signIn(port, PASSWORD, { prefix: '/docs' });
  assert.equal(res.status, 204);
  assert.match(res.headers['set-cookie'][0], /; Path=\/docs\/;/);
  assert.equal((await request(port, '/docs/api/tree', { headers: { Cookie: sessionOf(res) } })).status, 200);
});

test('without --password nothing asks for a session', async (t) => {
  const { port, stop } = await start({ password: null });
  t.after(stop);

  assert.equal((await request(port, '/api/tree')).status, 200);
  assert.deepEqual(JSON.parse((await request(port, '/api/config')).text), { readOnly: false, auth: false });
  assert.equal((await signIn(port, PASSWORD)).status, 405);
});

// The clock-driven half, which a live server cannot wait out.

const fakeRequest = (cookie) => ({ headers: cookie ? { cookie } : {}, socket: { localPort: 4321 } });

test('an empty password is refused rather than opening the door to anyone', () => {
  assert.throws(() => createAuth({ password: '' }));
});

test('the guess limit lifts once its window has passed', () => {
  let clock = 0;
  const auth = createAuth({ password: PASSWORD, now: () => clock });

  for (let i = 0; i < 5; i += 1) assert.equal(auth.login(fakeRequest(), 'wrong'), null);
  assert.equal(auth.retryAfter(), 60);
  clock += 59_000;
  assert.equal(auth.retryAfter(), 1);
  clock += 1_000;
  assert.equal(auth.retryAfter(), 0);

  // Five a minute, slowly enough to dodge that limit, still meets the hourly one.
  for (let round = 1; round < 6; round += 1) {
    for (let i = 0; i < 5; i += 1) auth.login(fakeRequest(), 'wrong');
    clock += 60_000;
  }
  assert.ok(auth.retryAfter() > 60);
  clock += 60 * 60 * 1000;
  assert.equal(auth.retryAfter(), 0);
});

test('retry-after waits for the failure holding the limit, not the oldest one', () => {
  let clock = 0;
  const auth = createAuth({ password: PASSWORD, now: () => clock });
  for (let i = 0; i < 10; i += 1) {
    auth.login(fakeRequest(), 'wrong');
    clock += 1000;
  }

  // Failures at 0s..9s, and it is now 10s. The one at 0s leaves the minute at
  // 60s, but five newer ones are still inside it until the one at 5s leaves, at 65s.
  assert.equal(auth.retryAfter(), 55);
  clock = 64_000;
  assert.equal(auth.retryAfter(), 1);
  clock = 65_000;
  assert.equal(auth.retryAfter(), 0);
});

test('a session expires after a week', () => {
  let clock = 0;
  const auth = createAuth({ password: PASSWORD, now: () => clock });
  const cookie = auth.login(fakeRequest(), PASSWORD).split(';')[0];

  assert.equal(auth.authenticated(fakeRequest(cookie)), true);
  clock += 7 * 24 * 60 * 60 * 1000 - 1;
  assert.equal(auth.authenticated(fakeRequest(cookie)), true);
  clock += 1;
  assert.equal(auth.authenticated(fakeRequest(cookie)), false);
});
