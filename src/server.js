import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PathError, safeResolve, toPosix } from './paths.js';
import { MARKDOWN_RE, renderMarkdown } from './render.js';
import { getTree } from './tree.js';
import { Watcher } from './watcher.js';

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

export function createApp({ root, serveAll = false, allowHosts = [] }) {
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
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return sendText(res, 405, 'Method not allowed');
      }

      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

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

      if (pathname === '/api/file') {
        const rel = url.searchParams.get('path');
        if (rel === null) return sendText(res, 400, 'Missing path');
        return await handleFile(res, rel);
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
