# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

markdown-explorer is a zero-build CLI that serves the markdown files under any directory to a browser: file tree on the left, rendered document in the middle, heading outline on the right. It is published to npm, so it must run on Linux, macOS and Windows, on Node 20 through 24.

Two dependencies only: markdown-it and highlight.js. There is no bundler, no transpiler, and no framework. Everything under public/ is served to the browser exactly as it sits on disk.

## Commands

```bash
npm test                                        # node:test, every test/*.test.js
node --test test/paths.test.js                  # one file
node --test --test-name-pattern="slugify"       # one test by name

npx playwright test                             # browser tests in e2e/
npx playwright test -g "prunes empty branches"  # one browser test by name
npx playwright install chromium                 # first time only

node bin/cli.js <dir> --no-open --port 4321     # run it against a directory
npm link && mdv                                 # install the CLI globally, run in cwd

npm run vendor:mermaid            # refresh public/vendor/mermaid.min.js to latest
npm run vendor:mermaid 11.16.0    # or to a pinned version
```

## Architecture

A request walks bin/cli.js (flags, port, browser launch) into src/server.js, which routes to exactly one of: tree.js for the file tree, render.js for a document, watcher.js for the live-reload event stream, or a raw file. Everything that takes a path from the network passes through paths.js first.

The browser side is a single ESM module, public/app.js, that fetches JSON and drives three panes. The server never renders a page beyond public/index.html.

## Invariants that span files

These are the things that will bite you. Each was found by running the thing, not by reading it.

### paths.js runs before any other rule

Every path from the network goes through safeResolve before anything reasons about it, including before checking whether it ends in .md. Anything that inspects a path first is a rule the guard has to be reached through. Escapes return 403, never 404, so the response cannot probe for files outside the root.

Containment is a segment comparison after path.relative, not a string prefix and not startsWith("..") on the relative path. A prefix check lets a null byte through; startsWith("..") rejects a file legitimately named ..hidden.md. Both wrong forms are pinned in test/paths.test.js against path.posix and path.win32.

safeResolve deliberately does not Unicode-normalise. On ext4 the NFC and NFD spellings of an accented filename like café.md are two different files, so normalising ENOENTs on exactly the names it looks like it is helping. test/paths.test.js pins this with both spellings of café.md, which is why the fixture cannot be renamed to something plain ASCII: ASCII has no NFC/NFD distinction, and the test would pass with the guard removed.

### markdown-it hands you percent-encoded urls

By the time a renderer rule in render.js sees an href or src, markdown-it's normalizeLink has already percent-encoded it. Decode once before resolving, encode once after. Encoding twice turns café-menu.png into caf%25C3%25A9-menu.png and a 404. Decoding first also means an obfuscated %2e%2e%2f becomes ../ and is rejected in render.js rather than reaching the server disguised.

### The watcher watches the directory, never the file

fs.watch on a file stops firing after the first atomic save, and vim and VS Code both save atomically (write a temp file, rename over the target). watcher.js watches the containing directory and re-stats the file on any event.

It also ignores the filename argument entirely, because Node documents it as possibly null depending on the platform. A stat is cheap and always right.

Subscribing to a file that is already gone reports the deletion immediately: no watch event will ever fire for something that already happened.

### The order inside loadFile in public/app.js is load-bearing

```
capture position --> fetch --> innerHTML --> pushState --> await mermaid --> applyScroll --> updateSpy
```

pushState must come before updateSpy, because updateSpy's replaceState writes the current path into whatever history entry is current, which is otherwise still the previous document's. It must also come before the mermaid await, or a reader who presses back while a diagram renders goes back past an entry that does not exist yet.

applyScroll must come after mermaid, because diagrams render asynchronously and change the page height.

Two loads can be in flight at once (click a file, then another). A generation token makes stragglers bail at each await. Without it the overtaken load's last act, connectEvents, points the live-reload stream at a document that is no longer on screen.

### Scrollspy

It is a rAF-throttled linear scan, not an IntersectionObserver. A final section shorter than the viewport never crosses an observer band, so the last heading would never highlight. The scan needs its own bottom clamp for the same reason.

Two things must recompute it besides scrolling: when the post-outline-click suppression window lifts (a scroll that landed inside the window was swallowed and nothing else will fire), and after a drawer toggle (the content column reflows, and no scroll event fires).

That second claim holds only while the reflow stays inside the viewport. Chrome's scroll anchoring compensates for content that changes height above the viewport top, and the compensation fires a scroll event, which re-runs scrollspy on its own. The e2e fixture keeps every paragraph before the parked heading to a single line so the only paragraph that can rewrap is the one below the fold. Reword that prose so an earlier paragraph gains a line and the drawer-toggle test starts passing with its fix removed, which is how it was caught.

setActive uses replaceState, never pushState. Scrolling one long document would otherwise stack dozens of history entries.

### Scroll memory

positions in app.js remembers scrollTop, scrollHeight and the active heading id per file, in sessionStorage keyed by root. Restoring prefers exact pixels when scrollHeight still matches, and falls back to the heading when it does not. scrollHeight, not mtime, is the signal: it measures the thing that makes scrollTop meaningful, so it also catches a window resize.

An explicit anchor beats the remembered position, but a hash that scrollspy wrote on the way out does not. They are told apart by whether the hash equals the remembered heading id.

### Mermaid is vendored, not depended on

Depending on mermaid pulls 111 packages and 154 MB to serve one self-contained 3.5 MB browser bundle. public/vendor/mermaid.min.js is copied out of the tarball by scripts/vendor-mermaid.mjs, which refuses any build containing a dynamic import() because that would mean the bundle needs its 542 sibling chunks. It is loaded lazily, only for documents that actually contain a diagram.

### Test layout

npm test runs bare `node --test`, with no path argument. Node's discovery treats every .js file inside a directory named test as a test file, which is why the Playwright specs live in e2e/ rather than test/e2e/. Passing a glob breaks on Windows (cmd.exe does not expand it) and passing a directory is read as a module path.

Server-side tests are node:test with no dependencies and run on all three operating systems in CI. Browser tests are Playwright, Linux only, and cover the three behaviours node:test cannot reach: scrollspy geometry, live reload with a document that reflows, and the drawers.

### CLI flags

node:util parseArgs has no --no-<flag> support. --no-open is declared as its own boolean option; declaring open and hoping does not work, it throws at startup.

### Security defaults

The server binds loopback and rejects any Host header that is not a loopback name, which is what actually stops DNS rebinding from a page the user visits. /files serves images only. Both open up behind --serve-all and --allow-host. Rendered HTML is deliberately not sanitised; the threat model is documented in README.md.

### Tree indentation

Rows in the explorer indent by depth, but a directory's disclosure triangle occupies about 16px inside the summary's own content box. File rows reserve an empty gutter of the same width, otherwise every child file renders to the left of the directory containing it and the nesting reads backwards.

## A house rule for tests

When you add a test for a fix, remove the fix and confirm the test goes red. Three tests written in this repository passed with their fix reverted, and were rewritten or deleted. A test that cannot fail is worse than no test, because it claims coverage.

The corollary: when a browser test is flaky, find the race before relaxing the assertion. e2e/app.spec.js has a spySettled helper for exactly one such race, where a reload can beat scrollspy's next animation frame.
