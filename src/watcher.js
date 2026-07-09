import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DEBOUNCE_MS = 100;
const KEEPALIVE_MS = 25_000;

/** Cheap identity for "has this file changed". null means it is gone. */
async function snapshot(abs) {
  try {
    const stat = await fsp.stat(abs);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

function send(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Live reload for whichever file each connected client currently has open.
 *
 * Two deliberate choices, both load-bearing:
 *
 * 1. We watch the *directory* holding the file, not the file. Watching a file
 *    directly stops firing after the first atomic save, and vim, VS Code and
 *    friends all save atomically (write a temp file, rename over the target).
 *
 * 2. We ignore the `filename` the callback hands us. Node documents it as
 *    possibly null depending on the platform, so instead any event in the
 *    directory makes us re-stat the files we care about. A stat is cheap and
 *    the answer is always right.
 */
export class Watcher {
  #dirs = new Map(); // absolute dir -> { watcher, clients:Set, timer }
  #keepalive;

  constructor() {
    this.#keepalive = setInterval(() => {
      for (const entry of this.#dirs.values()) {
        for (const client of entry.clients) client.res.write(': keepalive\n\n');
      }
    }, KEEPALIVE_MS);
    this.#keepalive.unref?.();
  }

  async subscribe(res, { absPath, relPath }) {
    const dir = path.dirname(absPath);
    const client = { res, absPath, relPath, snap: await snapshot(absPath) };

    let entry = this.#dirs.get(dir);
    if (!entry) {
      entry = { clients: new Set(), timer: null, watcher: null };
      try {
        entry.watcher = fs.watch(dir, () => this.#schedule(dir));
        entry.watcher.on('error', () => this.#closeDir(dir));
      } catch {
        entry.watcher = null; // degrade to no live reload rather than crash
      }
      this.#dirs.set(dir, entry);
    }
    entry.clients.add(client);

    // The file can vanish between the render that produced the page and this
    // subscription. Nothing will fire a watch event for something that already
    // happened, so say so now rather than leaving the reader on a stale page.
    if (client.snap === null) {
      queueMicrotask(() => send(res, { type: 'file-deleted', path: relPath }));
    }

    return client;
  }

  unsubscribe(client) {
    const dir = path.dirname(client.absPath);
    const entry = this.#dirs.get(dir);
    if (!entry) return;
    entry.clients.delete(client);
    if (entry.clients.size === 0) this.#closeDir(dir);
  }

  #schedule(dir) {
    const entry = this.#dirs.get(dir);
    if (!entry || entry.timer) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.#check(dir);
    }, DEBOUNCE_MS);
  }

  async #check(dir) {
    const entry = this.#dirs.get(dir);
    if (!entry) return;

    for (const client of entry.clients) {
      const next = await snapshot(client.absPath);
      if (next === client.snap) continue; // the directory changed, but not this file
      client.snap = next;
      send(client.res, {
        type: next === null ? 'file-deleted' : 'file-changed',
        path: client.relPath,
      });
    }
  }

  #closeDir(dir) {
    const entry = this.#dirs.get(dir);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    this.#dirs.delete(dir);
  }

  close() {
    clearInterval(this.#keepalive);
    for (const dir of [...this.#dirs.keys()]) this.#closeDir(dir);
  }
}
