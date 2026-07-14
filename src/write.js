import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * The identity of a file's contents, and the only notion of "version" in the
 * app. It is the optimistic lock on a save, the receipt a save comes back with,
 * and the field on a watcher event that lets the browser tell its own write
 * apart from someone else's.
 *
 * A content hash, not mtime: mtime is one-second granular on some filesystems,
 * so two writes in the same second with the same size are indistinguishable,
 * which is exactly the case an editor has to get right.
 *
 * null means the file is not there.
 */
export const versionOf = (buf) => createHash('sha256').update(buf).digest('hex');

export async function fileVersion(abs) {
  try {
    return versionOf(await fsp.readFile(abs));
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
    throw err;
  }
}

/**
 * Which line ending this file is written with.
 *
 * The browser cannot tell us: the HTML spec has a textarea normalise its value
 * to LF, so a CRLF file read back out of one comes back LF and saving it would
 * silently rewrite every line of the file. The server remembers instead.
 */
export function detectEol(source) {
  const crlf = source.match(/\r\n/g)?.length ?? 0;
  const lf = source.match(/(?<!\r)\n/g)?.length ?? 0;
  return crlf > lf ? 'crlf' : 'lf';
}

export function applyEol(text, eol) {
  const lines = text.replace(/\r\n/g, '\n');
  return eol === 'crlf' ? lines.replace(/\n/g, '\r\n') : lines;
}

/**
 * Write via a temp file in the same directory and rename over the target, so a
 * reader never sees a half-written document and a crash never truncates one.
 *
 * The temp name starts with a dot because tree.js skips dotted entries, so it
 * cannot flash up in the explorer on its way past.
 *
 * rename() drops the old file's mode, so it is copied over first: saving a
 * read-only or group-writable document should not quietly reset its permissions.
 */
export async function atomicWrite(abs, text) {
  const dir = path.dirname(abs);
  const tmp = path.join(dir, `.${path.basename(abs)}.mdx-${randomBytes(6).toString('hex')}`);

  try {
    await fsp.writeFile(tmp, text, 'utf8');

    const stat = await fsp.stat(abs).catch(() => null);
    if (stat) await fsp.chmod(tmp, stat.mode & 0o777);

    await fsp.rename(tmp, abs);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}
