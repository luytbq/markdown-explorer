import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isContained } from './paths.js';
import { MARKDOWN_RE } from './render.js';

export const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  'vendor',
  '__pycache__',
]);

const MAX_DEPTH = 12;
const MAX_FILES = 5000;
const CACHE_MS = 1000;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

async function walk(root, absDir, relDir, depth, state) {
  if (depth > state.maxDepth) return [];

  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return []; // unreadable directory: skip it rather than fail the whole tree
  }

  const dirs = [];
  const files = [];

  for (const entry of entries) {
    if (state.fileCount >= state.maxFiles) {
      state.truncated = true;
      break;
    }

    const abs = path.join(absDir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;

    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const stat = await fs.stat(abs);
        isDir = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue; // broken link
      }
    }

    if (isDir) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;

      let real;
      try {
        real = await fs.realpath(abs);
      } catch {
        continue;
      }
      if (!isContained(path, root, real)) continue; // symlink pointing out of the tree
      if (state.visited.has(real)) continue; // symlink cycle
      state.visited.add(real);

      const children = await walk(root, abs, rel, depth + 1, state);
      if (children.length > 0) {
        dirs.push({ name: entry.name, path: rel, type: 'dir', children });
      }
    } else if (isFile && MARKDOWN_RE.test(entry.name)) {
      state.fileCount++;
      files.push({ name: entry.name, path: rel, type: 'file' });
    }
  }

  dirs.sort(byName);
  files.sort(byName);
  return [...dirs, ...files];
}

/**
 * Markdown-only view of the tree. Directories whose whole subtree holds no
 * markdown are pruned, so the explorer never shows a branch that leads nowhere.
 */
export async function buildTree(root, { maxDepth = MAX_DEPTH, maxFiles = MAX_FILES } = {}) {
  const state = {
    fileCount: 0,
    truncated: false,
    visited: new Set([root]),
    maxDepth,
    maxFiles,
  };
  const children = await walk(root, root, '', 0, state);
  return {
    name: path.basename(root),
    path: '',
    root, // the client keys its per-project ui state off this
    type: 'dir',
    children,
    fileCount: state.fileCount,
    truncated: state.truncated,
  };
}

let cache = null;

/** Cached for a second, with an ETag so the client's 10s poll costs a 304. */
export async function getTree(root) {
  const now = Date.now();
  if (cache && cache.root === root && now - cache.at < CACHE_MS) return cache.value;

  const tree = await buildTree(root);
  const json = JSON.stringify(tree);
  const etag = `"${createHash('sha1').update(json).digest('base64url').slice(0, 16)}"`;

  cache = { root, at: now, value: { tree, json, etag } };
  return cache.value;
}

export function clearTreeCache() {
  cache = null;
}
