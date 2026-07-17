import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PathError, safeResolve, toNative, toPosix } from './paths.js';
import { MARKDOWN_RE, renderMarkdown } from './render.js';
import { searchContents } from './search.js';
import { clearTreeCache, getTree } from './tree.js';
import { Watcher } from './watcher.js';
import { applyEol, atomicWrite, detectEol, fileVersion, versionOf } from './write.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MAX_MARKDOWN_BYTES = 5 * 1024 * 1024;

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico', '.bmp']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
};
const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';

const sendJson = (res, code, body) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
};

const sendText = (res, code, message) => {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(message);
};

/**
 * Bind to loopback and this is still reachable: a page you visit can point its
 * own hostname at 127.0.0.1 (DNS rebinding) and the browser will treat the
 * response as same-origin. Checking Host is what actually closes that.
 */
function hostAllowed(host, allowHosts) {
  if (!host) return false;
  if (LOOPBACK_HOST_RE.test(host)) return true;
  const bare = host.replace(/:\d+$/, '').toLowerCase();
  return allowHosts.some((h) => h.toLowerCase() === bare || h.toLowerCase() === host.toLowerCase());
}

/**
 * The Host check above does not stop this, and a write endpoint is where that
 * starts to matter. Any page on the web can POST to http://localhost:4321 with
 * a perfectly legitimate Host header; CORS stops it reading the response, but
 * the write still happens. That is plain CSRF, and Origin is what closes it.
 *
 * Host has already been vetted by the time we get here, so deriving the origin
 * we expect from it is safe, and it stays correct under --allow-host for free.
 *
 * A missing Origin is a refusal, not a pass. Browsers always send one on a
 * write; a tool that does not is a tool that can set the header.
 */
const originAllowed = (req) => req.headers.origin === `http://${req.headers.host}`;

const isJson = (req) =>
  (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() === 'application/json';

class BodyTooLarge extends Error {}

/** Buffer the request body, refusing to grow past `limit` bytes. */
async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res, absFile) {
  let stat;
  try {
    stat = await fsp.stat(absFile);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not found');

  res.writeHead(200, {
    'Content-Type': mimeFor(absFile),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(absFile).pipe(res);
}

export function createApp({ root, serveAll = false, allowHosts = [], readOnly = false }) {
  const watcher = new Watcher();

  async function handleTree(req, res) {
    const { json, etag } = await getTree(root);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      ETag: etag,
      'Cache-Control': 'no-cache',
    });
    res.end(json);
  }

  /** Content search over the files the tree shows. A read, so no Origin lock. */
  async function handleSearch(res, query) {
    sendJson(res, 200, await searchContents(root, query));
  }

  async function handleFile(res, relPosix) {
    // Containment first, always. Anything that reasons about the path before
    // vetting it is a rule the guard has to be reached through.
    const abs = await safeResolve(root, relPosix);
    if (!MARKDOWN_RE.test(relPosix)) return sendText(res, 400, 'Not a markdown file');

    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      return sendText(res, 404, 'Not found');
    }
    if (!stat.isFile()) return sendText(res, 404, 'Not found');
    if (stat.size > MAX_MARKDOWN_BYTES) return sendText(res, 413, 'File too large');

    const source = await fsp.readFile(abs, 'utf8');
    const { html, headings, title, hasMermaid } = renderMarkdown(source, relPosix);
    sendJson(res, 200, { path: relPosix, html, headings, title, hasMermaid, mtime: stat.mtimeMs });
  }

  /** The document exactly as it sits on disk: frontmatter, HTML comments, all of it. */
  async function handleRaw(res, relPosix) {
    const abs = await safeResolve(root, relPosix);
    if (!MARKDOWN_RE.test(relPosix)) return sendText(res, 400, 'Not a markdown file');

    let buf;
    try {
      buf = await fsp.readFile(abs);
    } catch {
      return sendText(res, 404, 'Not found');
    }
    if (buf.length > MAX_MARKDOWN_BYTES) return sendText(res, 413, 'File too large');

    // Hash the same bytes we are about to hand out, rather than re-reading: the
    // source and the version the editor saves against must describe one file.
    const source = buf.toString('utf8');
    sendJson(res, 200, { path: relPosix, source, version: versionOf(buf), eol: detectEol(source) });
  }

  /**
   * Save a document. The order of the checks below is the point of the function.
   *
   * Origin and content type are settled before the path is even looked at, and
   * the path is resolved before anything asks what kind of file it names, which
   * is the same rule the read side follows: containment is not something other
   * rules get to be reached through.
   */
  async function handleWrite(req, res, relPosix) {
    if (readOnly) return sendText(res, 403, 'Read-only. Restart without --read-only to save.');
    if (!originAllowed(req)) return sendText(res, 403, 'Forbidden origin');
    if (!isJson(req)) return sendText(res, 415, 'Expected application/json');

    const abs = await safeResolve(root, relPosix);
    if (!MARKDOWN_RE.test(relPosix)) return sendText(res, 400, 'Not a markdown file');

    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_MARKDOWN_BYTES));
    } catch (err) {
      if (!(err instanceof BodyTooLarge)) return sendText(res, 400, 'Bad request');
      sendText(res, 413, 'File too large');
      return req.resume(); // drain what is still coming, so the refusal gets out cleanly
    }

    const { source, version, eol } = body ?? {};
    if (typeof source !== 'string' || typeof version !== 'string') {
      return sendText(res, 400, 'Expected { source, version, eol }');
    }
    if (eol !== 'lf' && eol !== 'crlf') return sendText(res, 400, 'eol must be "lf" or "crlf"');

    // Optimistic lock. A file that has gone missing has no version either, so
    // "deleted under the editor" lands here too rather than being recreated.
    const current = await fileVersion(abs);
    if (current !== version) {
      return sendJson(res, 409, { error: current === null ? 'missing' : 'conflict', version: current });
    }

    const text = applyEol(source, eol);
    try {
      await atomicWrite(abs, text);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') return sendText(res, 403, 'Cannot write this file');
      throw err;
    }

    sendJson(res, 200, { path: relPosix, version: versionOf(Buffer.from(text, 'utf8')) });
  }

  /**
   * Create an empty document. Its own endpoint, because PUT deliberately refuses
   * to bring files into existence: a save that raced a deletion must land as a
   * 409, never as a quiet resurrection. Creation is asked for by name instead.
   *
   * Same locks as handleWrite, same order: read-only, Origin, content type, and
   * only then the path.
   */
  async function handleCreate(req, res, relPosix) {
    if (readOnly) return sendText(res, 403, 'Read-only. Restart without --read-only to save.');
    if (!originAllowed(req)) return sendText(res, 403, 'Forbidden origin');
    if (!isJson(req)) return sendText(res, 415, 'Expected application/json');

    const abs = await safeResolve(root, relPosix);
    if (!MARKDOWN_RE.test(relPosix)) return sendText(res, 400, 'Not a markdown file');

    try {
      await readBody(req, 4096); // the body carries nothing yet; drain it anyway
    } catch (err) {
      if (!(err instanceof BodyTooLarge)) throw err;
      sendText(res, 413, 'Body too large');
      return req.resume();
    }

    try {
      // 'wx' makes existence and creation one syscall, so two racing creates
      // cannot both win: the second gets EEXIST rather than a truncated file.
      await fsp.writeFile(abs, '', { flag: 'wx' });
    } catch (err) {
      if (err.code === 'EEXIST') return sendJson(res, 409, { error: 'exists' });
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return sendText(res, 404, 'No such directory');
      if (err.code === 'EACCES' || err.code === 'EPERM') return sendText(res, 403, 'Cannot write here');
      throw err;
    }

    clearTreeCache(); // the explorer refreshes right after; it must not see the old second
    sendJson(res, 201, { path: relPosix, version: versionOf(Buffer.alloc(0)) });
  }

  /**
   * Rename a document, within its own directory. Both names pass safeResolve and
   * the markdown check, and the version is the same optimistic lock a save uses,
   * so a rename cannot land on a file that changed since the reader looked at it.
   */
  async function handleRename(req, res) {
    if (readOnly) return sendText(res, 403, 'Read-only. Restart without --read-only to save.');
    if (!originAllowed(req)) return sendText(res, 403, 'Forbidden origin');
    if (!isJson(req)) return sendText(res, 415, 'Expected application/json');

    let body;
    try {
      body = JSON.parse(await readBody(req, 4096));
    } catch (err) {
      if (!(err instanceof BodyTooLarge)) return sendText(res, 400, 'Bad request');
      sendText(res, 413, 'Body too large');
      return req.resume();
    }

    const { from, to, version } = body ?? {};
    if (typeof from !== 'string' || typeof to !== 'string' || typeof version !== 'string') {
      return sendText(res, 400, 'Expected { from, to, version }');
    }

    // Containment before anything reasons about either name, as always.
    const absFrom = await safeResolve(root, from);
    const vettedTo = await safeResolve(root, to);
    if (!MARKDOWN_RE.test(from) || !MARKDOWN_RE.test(to)) return sendText(res, 400, 'Not a markdown file');
    if (path.dirname(absFrom) !== path.dirname(vettedTo)) {
      return sendText(res, 400, 'Rename stays within its directory');
    }

    // vettedTo proved the destination is contained, but it cannot be the name we
    // write: safeResolve realpaths, and on a case-insensitive filesystem the
    // realpath of "Readme.md" is the on-disk "README.md", which would quietly
    // turn a case-only rename into a no-op. The destination is rebuilt from the
    // literal final segment instead, joined onto the vetted source directory,
    // and the dirname comparison below pins it to that directory even if the
    // segment smuggled a separator this platform understands and POSIX does not.
    const toName = toNative(to.slice(to.lastIndexOf('/') + 1));
    const absTo = path.join(path.dirname(absFrom), toName);
    if (path.dirname(absTo) !== path.dirname(absFrom) || path.basename(absTo) !== toName) {
      return sendText(res, 403, 'Forbidden');
    }

    const current = await fileVersion(absFrom);
    if (current !== version) {
      return sendJson(res, 409, { error: current === null ? 'missing' : 'conflict', version: current });
    }

    // "The target exists" must not block a case-only rename. On APFS and NTFS,
    // stat(README.md) and stat(readme.md) answer for the same file, so the check
    // compares identity, not presence: the same dev+ino is the source itself
    // under its other spelling, and the rename may proceed. On ext4 those are
    // two real files and the 409 stands. bigint, because Windows file ids do
    // not fit safely in a double.
    let fromStat;
    try {
      fromStat = await fsp.stat(absFrom, { bigint: true });
    } catch {
      return sendJson(res, 409, { error: 'missing', version: null });
    }
    const toStat = await fsp.stat(absTo, { bigint: true }).catch(() => null);
    if (toStat && !(toStat.dev === fromStat.dev && toStat.ino === fromStat.ino)) {
      return sendJson(res, 409, { error: 'exists' });
    }

    try {
      await fsp.rename(absFrom, absTo);
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') return sendText(res, 403, 'Cannot rename this file');
      throw err;
    }

    clearTreeCache();
    sendJson(res, 200, { path: toPosix(path.relative(root, absTo)), version: current });
  }

  async function handleAsset(res, relPosix) {
    const abs = await safeResolve(root, relPosix);
    if (!serveAll && !IMAGE_EXT.has(path.extname(relPosix).toLowerCase())) {
      return sendText(res, 403, 'Only images are served. Restart with --serve-all to allow every file.');
    }
    await serveStatic(res, abs);
  }

  async function handleEvents(req, res, relPosix) {
    const abs = await safeResolve(root, relPosix);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const client = await watcher.subscribe(res, { absPath: abs, relPath: relPosix });
    req.on('close', () => watcher.unsubscribe(client));
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, allowHosts)) {
        return sendText(res, 403, 'Forbidden host');
      }
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      // The writes in the app: save, create, rename. Everything else is read-only.
      if (req.method === 'PUT') {
        if (pathname !== '/api/file') return sendText(res, 405, 'Method not allowed');
        const rel = url.searchParams.get('path');
        if (rel === null) return sendText(res, 400, 'Missing path');
        return await handleWrite(req, res, rel);
      }
      if (req.method === 'POST') {
        if (pathname === '/api/file') {
          const rel = url.searchParams.get('path');
          if (rel === null) return sendText(res, 400, 'Missing path');
          return await handleCreate(req, res, rel);
        }
        if (pathname === '/api/rename') return await handleRename(req, res);
        return sendText(res, 405, 'Method not allowed');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'Method not allowed');
      }

      if (pathname === '/' || pathname === '/index.html') {
        return await serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
      }

      if (pathname.startsWith('/static/')) {
        const rel = pathname.slice('/static/'.length);
        const abs = path.resolve(PUBLIC_DIR, rel);
        // PUBLIC_DIR is ours, but the path still arrives from the network.
        if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
          return sendText(res, 403, 'Forbidden');
        }
        return await serveStatic(res, abs);
      }

      if (pathname === '/api/tree') return await handleTree(req, res);

      if (pathname === '/api/search') return await handleSearch(res, url.searchParams.get('q') ?? '');

      if (pathname === '/api/config') return sendJson(res, 200, { readOnly });

      if (pathname === '/api/file') {
        const rel = url.searchParams.get('path');
        if (rel === null) return sendText(res, 400, 'Missing path');
        return await handleFile(res, rel);
      }

      if (pathname === '/api/raw') {
        const rel = url.searchParams.get('path');
        if (rel === null) return sendText(res, 400, 'Missing path');
        return await handleRaw(res, rel);
      }

      if (pathname === '/api/events') {
        const rel = url.searchParams.get('path');
        if (rel === null) return sendText(res, 400, 'Missing path');
        return await handleEvents(req, res, rel);
      }

      if (pathname.startsWith('/files/')) {
        return await handleAsset(res, pathname.slice('/files/'.length));
      }

      sendText(res, 404, 'Not found');
    } catch (err) {
      if (err instanceof PathError) return sendText(res, 403, 'Forbidden');
      if (err instanceof URIError) return sendText(res, 400, 'Bad request');
      sendText(res, 500, 'Internal error');
    }
  });

  server.on('close', () => watcher.close());
  return server;
}

/** Listen on `port`, falling back to an ephemeral port if it is taken. */
export function listen(server, { port, host }) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onError);
        server.listen(0, host, () => resolve(server.address()));
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(server.address());
    });
  });
}

export { toPosix };
