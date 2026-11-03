import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The only request this program ever makes off the machine. Everything here
// fails silently: an offline reader, a blocked registry or an unwritable cache
// must never stop the server or print anything.

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 3000;

/** Release versions only: a prerelease on the registry is never offered. */
function parse(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

export function isNewer(candidate, current) {
  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function updateCheckDisabled(env = process.env) {
  // NO_UPDATE_NOTIFIER is the convention update-notifier established, so a
  // reader who already set it for every other CLI is not asked again.
  return Boolean(env.MDV_NO_UPDATE_CHECK || env.NO_UPDATE_NOTIFIER || env.CI);
}

export function defaultCacheFile(env = process.env, platform = process.platform) {
  const home = os.homedir();
  let dir;
  if (platform === 'win32') dir = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  else if (platform === 'darwin') dir = path.join(home, 'Library', 'Caches');
  else dir = env.XDG_CACHE_HOME || path.join(home, '.cache');
  return path.join(dir, 'markdown-explorer', 'update-check.json');
}

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof data.checkedAt === 'number' && typeof data.latest === 'string') return data;
  } catch {}
  return null;
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {}
}

/**
 * Answers synchronously from the cache, so the page served right after startup
 * already knows, and refreshes in the background at most once a day. Both
 * latest() and refresh() answer with the newer version, or null when the one
 * running is already the latest or nothing is known.
 */
export function createUpdateCheck({
  name,
  current,
  cacheFile = defaultCacheFile(),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
}) {
  const cached = readCache(cacheFile);
  let latest = cached?.latest ?? null;

  async function refresh() {
    if (cached && now() - cached.checkedAt < DAY_MS) return latest;
    try {
      const res = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return latest;
      const { version } = await res.json();
      if (!parse(version)) return latest;
      latest = version;
      writeCache(cacheFile, { checkedAt: now(), latest });
    } catch {}
    return latest;
  }

  return {
    latest: () => (isNewer(latest, current) ? latest : null),
    refresh: async () => {
      await refresh();
      return isNewer(latest, current) ? latest : null;
    },
  };
}
