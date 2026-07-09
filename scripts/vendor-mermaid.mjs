#!/usr/bin/env node
/**
 * Copy exactly one file out of the mermaid tarball into public/vendor/.
 *
 * Depending on mermaid instead would pull 111 packages and 154 MB onto every
 * user of this CLI, to serve a single self-contained 3.5 MB browser bundle.
 * dist/mermaid.min.js has no dynamic import() calls, so one file is all it is.
 *
 *   npm run vendor:mermaid            latest
 *   npm run vendor:mermaid 11.16.0    a specific version
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor');
const WANT = ['dist/mermaid.min.js', 'LICENSE'];

async function registry(spec) {
  const res = await fetch(`https://registry.npmjs.org/mermaid/${spec}`);
  if (!res.ok) throw new Error(`registry says ${res.status} for mermaid@${spec}`);
  return res.json();
}

/** Extract one member to a Buffer using the system tar (bsdtar on macOS/Windows). */
function extract(tarball, member) {
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzO', '-f', '-', `package/${member}`], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const chunks = [];
    tar.stdout.on('data', (c) => chunks.push(c));
    tar.on('error', reject);
    tar.on('close', (code) => {
      if (code !== 0) return reject(new Error(`tar exited ${code} extracting ${member}`));
      resolve(Buffer.concat(chunks));
    });
    tar.stdin.end(tarball);
  });
}

const version = process.argv[2] ?? 'latest';
const meta = await registry(version);

const res = await fetch(meta.dist.tarball);
if (!res.ok) throw new Error(`tarball download failed: ${res.status}`);
const tarball = Buffer.from(await res.arrayBuffer());

await fs.mkdir(VENDOR_DIR, { recursive: true });

for (const member of WANT) {
  const body = await extract(tarball, member);
  if (body.length === 0) throw new Error(`${member} is empty; did the tarball layout change?`);

  const out = member === 'LICENSE' ? 'mermaid.LICENSE' : path.basename(member);
  await fs.writeFile(path.join(VENDOR_DIR, out), body);
  console.log(`  ${out.padEnd(20)} ${(body.length / 1024 / 1024).toFixed(2)} MB`);
}

const bundle = await fs.readFile(path.join(VENDOR_DIR, 'mermaid.min.js'), 'utf8');
if (/\bimport\s*\(/.test(bundle)) {
  throw new Error('This build of mermaid.min.js uses dynamic import(); it is no longer self-contained.');
}

await fs.writeFile(path.join(VENDOR_DIR, 'VERSION'), `${meta.version}\n`);
console.log(`\nvendored mermaid ${meta.version}`);
