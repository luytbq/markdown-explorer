import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cli.js');

function run(args, { waitFor, timeout = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Make sure a stray BROWSER never launches anything during tests.
      env: { ...process.env, BROWSER: '' },
    });

    let stdout = '';
    let stderr = '';
    const done = (result) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, timeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (waitFor && waitFor.test(stdout)) done({ stdout, stderr, code: null });
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (waitFor && !waitFor.test(stdout)) return done({ stdout, stderr, code });
      done({ stdout, stderr, code });
    });
  });
}

test('--help exits cleanly and documents the flags', async () => {
  const { stdout, code } = await run(['--help']);
  assert.equal(code, 0);
  for (const flag of ['--port', '--host', '--allow-host', '--prefix', '--serve-all', '--password', '--no-open']) {
    assert.ok(stdout.includes(flag), `help should mention ${flag}`);
  }
});

// parseArgs has no built-in --no-<flag> handling, so this once crashed on startup.
test('--no-open starts the server instead of erroring', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-cli-'));
  await fs.writeFile(path.join(dir, 'a.md'), '# a\n');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { stdout, stderr } = await run([dir, '--no-open', '--port', '0'], {
    waitFor: /http:\/\/127\.0\.0\.1:\d+\//,
  });
  assert.match(stdout, /http:\/\/127\.0\.0\.1:\d+\//);
  assert.equal(stderr, '');
});

test('every documented flag is actually accepted', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-cli-'));
  await fs.writeFile(path.join(dir, 'a.md'), '# a\n');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // Wait for the *last* line the process prints, not the first: waiting on the
  // url and killing there races the serve-all notice that follows it.
  const { stdout } = await run(
    [dir, '--no-open', '--port', '0', '--host', '127.0.0.1', '--allow-host', 'dev.local', '--serve-all'],
    { waitFor: /serve-all/ },
  );
  assert.match(stdout, /http:\/\/127\.0\.0\.1:\d+\//);
});

// The url it prints has to be one a reader can paste: the mount point, and the
// trailing slash the bare mount point would only redirect to.
test('--prefix moves the url it prints and opens', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-cli-'));
  await fs.writeFile(path.join(dir, 'a.md'), '# a\n');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { stdout } = await run([dir, '--no-open', '--port', '0', '--prefix', 'docs/site/'], {
    waitFor: /--prefix/,
  });
  assert.match(stdout, /http:\/\/127\.0\.0\.1:\d+\/docs\/site\/$/m);
});

test('--password announces itself, and an empty one is refused before anything starts', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-cli-'));
  await fs.writeFile(path.join(dir, 'a.md'), '# a\n');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { stdout } = await run([dir, '--no-open', '--port', '0', '--password', 'hunter2'], { waitFor: /--password/ });
  assert.ok(!stdout.includes('hunter2'), 'the password must not be printed');

  const { code, stderr } = await run([dir, '--no-open', '--port', '0', '--password', '']);
  assert.equal(code, 2);
  assert.match(stderr, /--password must not be empty/);
});

// A mount point that cannot be routed to must fail at the command line, not as a
// 404 the reader has no way to explain.
test('a bad prefix is rejected before anything starts', async () => {
  const { code, stderr } = await run(['--prefix', 'a b']);
  assert.equal(code, 2);
  assert.match(stderr, /Invalid --prefix/);
});

test('an unknown flag fails loudly', async () => {
  const { code, stderr } = await run(['--nonsense']);
  assert.equal(code, 2);
  assert.match(stderr, /nonsense/);
});

test('a bad port is rejected', async () => {
  const { code, stderr } = await run(['--port', 'abc']);
  assert.equal(code, 2);
  assert.match(stderr, /Invalid port/);
});

test('a missing directory is reported', async () => {
  const { code, stderr } = await run([path.join(os.tmpdir(), 'mdx-does-not-exist-12345')]);
  assert.equal(code, 1);
  assert.match(stderr, /No such directory/);
});

test('binding a non-loopback host warns', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mdx-cli-'));
  await fs.writeFile(path.join(dir, 'a.md'), '# a\n');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const { stderr } = await run([dir, '--no-open', '--port', '0', '--host', '0.0.0.0'], {
    waitFor: /http:\/\/0\.0\.0\.0:\d+\//,
  });
  assert.match(stderr, /exposes the contents of this directory/);
});
