#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { resolveRoot } from '../src/paths.js';
import { createApp, listen } from '../src/server.js';

const USAGE = `
  mdv [directory] [options]

  Browse the markdown files under a directory in your browser.

  Options
    --port <n>        port to listen on (default 4321, falls back if taken)
    --host <addr>     address to bind (default 127.0.0.1)
    --allow-host <h>  accept requests with this Host header (repeatable)
    --serve-all       serve every file under the root, not only images
    --no-open         do not launch a browser
    -h, --help        show this
`;

const isWsl = () => {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
};

function openBrowser(url) {
  const [command, args] = (() => {
    if (process.env.BROWSER) return [process.env.BROWSER, [url]];
    if (isWsl()) return ['wslview', [url]];
    if (process.platform === 'darwin') return ['open', [url]];
    if (process.platform === 'win32') return ['cmd', ['/c', 'start', '""', url]];
    return ['xdg-open', [url]];
  })();

  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.on('error', () => {
    console.error(`Could not open a browser. Visit ${url}`);
  });
  child.unref();
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'allow-host': { type: 'string', multiple: true, default: [] },
        'serve-all': { type: 'boolean', default: false },
        // parseArgs has no --no-<flag> support, so the negation is its own option.
        'no-open': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    console.error(err.message);
    console.error(USAGE);
    process.exit(2);
  }

  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return;
  }

  const port = values.port === undefined ? 4321 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid port: ${values.port}`);
    process.exit(2);
  }

  const host = values.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.error(`Warning: binding ${host} exposes the contents of this directory to your network.`);
  }

  let root;
  try {
    root = await resolveRoot(positionals[0] ?? process.cwd());
  } catch {
    console.error(`No such directory: ${positionals[0]}`);
    process.exit(1);
  }

  const server = createApp({ root, serveAll: values['serve-all'], allowHosts: values['allow-host'] });
  const address = await listen(server, { port, host });

  const shown = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${shown}:${address.port}/`;

  console.log(`markdown-explorer serving ${root}`);
  console.log(`  ${url}`);
  if (values['serve-all']) console.log('  --serve-all: every file under the root is readable over HTTP');

  if (!values['no-open']) openBrowser(url);

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
