import fs from 'node:fs/promises';
import path from 'node:path';

export class PathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathError';
  }
}

/**
 * Is `target` the root itself, or inside it?
 *
 * `P` is path.posix or path.win32 so this can be tested for both platforms
 * from either one. `target` may be relative to root, or absolute.
 *
 * The segment comparison at the end is the whole point. `r.startsWith('..')`
 * is the obvious thing to write and it rejects a file legitimately named
 * "..hidden.md".
 */
export function isContained(P, root, target) {
  if (typeof target !== 'string' || target.includes('\0')) return false;
  const rel = P.relative(root, P.resolve(root, target));
  if (rel === '') return true;
  if (P.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith('..' + P.sep);
}

export const toPosix = (nativeRel) => nativeRel.split(path.sep).join('/');
export const toNative = (posixRel) => posixRel.split('/').join(path.sep);

export async function resolveRoot(dir) {
  return fs.realpath(path.resolve(dir));
}

/** Walk up until realpath succeeds, so we can vet the parent of a missing file. */
async function realpathNearest(abs) {
  let cur = abs;
  for (;;) {
    try {
      return await fs.realpath(cur);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(cur);
      if (parent === cur) throw new PathError('no existing ancestor');
      cur = parent;
    }
  }
}

/**
 * Turn a client-supplied POSIX path into an absolute native path inside root,
 * or throw PathError.
 *
 * Deliberately does NOT Unicode-normalise. On ext4 the NFC and NFD spellings of
 * "café.md" are two different files, so normalising here would ENOENT on
 * exactly the filenames it looks like it is helping.
 */
export async function safeResolve(root, relPosix) {
  if (typeof relPosix !== 'string') throw new PathError('path must be a string');
  if (relPosix.includes('\0')) throw new PathError('path contains a null byte');

  const relNative = toNative(relPosix);
  if (!isContained(path, root, relNative)) throw new PathError('path escapes root');

  const abs = path.resolve(root, relNative);

  // Re-check after following symlinks: a link inside the tree can point outside it.
  let real;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const parent = await realpathNearest(path.dirname(abs));
    if (!isContained(path, root, parent)) throw new PathError('path escapes root');
    return abs; // let the caller's read produce the ENOENT
  }

  if (!isContained(path, root, real)) throw new PathError('path escapes root');
  return real;
}
