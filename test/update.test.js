import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createUpdateCheck, defaultCacheFile, isNewer, updateCheckDisabled } from '../src/update.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

async function tmpCache(t, contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-update-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'update-check.json');
  if (contents) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(contents));
  }
  return file;
}

function fakeFetch(answer) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { impl, calls };
}

const ok = (body) => ({ ok: true, json: async () => body });

test('isNewer compares numerically and never offers a prerelease', () => {
  assert.equal(isNewer('0.1.10', '0.1.9'), true);
  assert.equal(isNewer('0.2.0', '0.1.99'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.1.11', '0.1.11'), false);
  assert.equal(isNewer('0.1.9', '0.1.10'), false);
  assert.equal(isNewer('0.2.0-beta.1', '0.1.11'), false);
  assert.equal(isNewer(null, '0.1.11'), false);
});

test('the check is off under CI and under either opt-out variable', () => {
  assert.equal(updateCheckDisabled({}), false);
  assert.equal(updateCheckDisabled({ CI: 'true' }), true);
  assert.equal(updateCheckDisabled({ MDV_NO_UPDATE_CHECK: '1' }), true);
  assert.equal(updateCheckDisabled({ NO_UPDATE_NOTIFIER: '1' }), true);
});

test('the cache lives in the cache directory of each platform', () => {
  assert.match(defaultCacheFile({ XDG_CACHE_HOME: '/x/cache' }, 'linux'), /^\/x\/cache[\\/]markdown-explorer[\\/]update-check\.json$/);
  assert.match(defaultCacheFile({}, 'darwin'), /Library[\\/]Caches[\\/]markdown-explorer/);
  assert.match(defaultCacheFile({ LOCALAPPDATA: 'C:\\L' }, 'win32'), /^C:\\L[\\/]markdown-explorer/);
});

test('a cache younger than a day answers at once and is not refreshed', async (t) => {
  const cacheFile = await tmpCache(t, { checkedAt: NOW - DAY_MS + 1000, latest: '0.2.0' });
  const { impl, calls } = fakeFetch(ok({ version: '0.3.0' }));
  const check = createUpdateCheck({ name: 'markdown-explorer', current: '0.1.11', cacheFile, fetchImpl: impl, now: () => NOW });

  assert.equal(check.latest(), '0.2.0');
  assert.equal(await check.refresh(), '0.2.0');
  assert.equal(calls.length, 0);
});

test('a stale cache is refreshed from the registry and rewritten', async (t) => {
  const cacheFile = await tmpCache(t, { checkedAt: NOW - DAY_MS - 1, latest: '0.1.11' });
  const { impl, calls } = fakeFetch(ok({ version: '0.1.12' }));
  const check = createUpdateCheck({ name: 'markdown-explorer', current: '0.1.11', cacheFile, fetchImpl: impl, now: () => NOW });

  assert.equal(check.latest(), null);
  assert.equal(await check.refresh(), '0.1.12');
  assert.equal(check.latest(), '0.1.12');
  assert.deepEqual(calls, ['https://registry.npmjs.org/markdown-explorer/latest']);
  assert.deepEqual(JSON.parse(await fs.readFile(cacheFile, 'utf8')), { checkedAt: NOW, latest: '0.1.12' });
});

test('no cache at all fetches, and creates the cache directory', async (t) => {
  const cacheFile = await tmpCache(t);
  const { impl } = fakeFetch(ok({ version: '0.1.11' }));
  const check = createUpdateCheck({ name: 'markdown-explorer', current: '0.1.11', cacheFile, fetchImpl: impl, now: () => NOW });

  assert.equal(await check.refresh(), null);
  assert.equal(JSON.parse(await fs.readFile(cacheFile, 'utf8')).latest, '0.1.11');
});

test('an offline, failing or nonsensical registry is silent and keeps what the cache knew', async (t) => {
  for (const answer of [new Error('ENOTFOUND'), { ok: false }, ok({ version: 'not-a-version' }), ok({})]) {
    const cacheFile = await tmpCache(t, { checkedAt: 0, latest: '0.2.0' });
    const { impl } = fakeFetch(answer);
    const check = createUpdateCheck({ name: 'markdown-explorer', current: '0.1.11', cacheFile, fetchImpl: impl, now: () => NOW });

    assert.equal(await check.refresh(), '0.2.0');
    assert.equal(JSON.parse(await fs.readFile(cacheFile, 'utf8')).checkedAt, 0);
  }
});

test('an unreadable cache is treated as no cache', async (t) => {
  const cacheFile = await tmpCache(t);
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, '{ not json');
  const { impl, calls } = fakeFetch(ok({ version: '0.1.12' }));
  const check = createUpdateCheck({ name: 'markdown-explorer', current: '0.1.11', cacheFile, fetchImpl: impl, now: () => NOW });

  assert.equal(check.latest(), null);
  assert.equal(await check.refresh(), '0.1.12');
  assert.equal(calls.length, 1);
});
