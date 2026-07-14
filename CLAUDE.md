# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

markdown-explorer is a zero-build CLI that serves the markdown files under any directory to a browser: file tree on the left, rendered document in the middle, heading outline on the right. The middle pane has two modes, view and edit, and edit can save. It is published to npm, so it must run on Linux, macOS and Windows, on Node 20 through 24.

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

A request walks bin/cli.js (flags, port, browser launch) into src/server.js, which routes to exactly one of: tree.js for the file tree, render.js for a document, write.js for the source of a document and for saving it, watcher.js for the live-reload event stream, or a raw file. Everything that takes a path from the network passes through paths.js first.

The browser side is a single ESM module, public/app.js, that fetches JSON and drives three panes. The server never renders a page beyond public/index.html.

Reading is GET. Saving is the only PUT, and the only write in the program.

## Invariants that span files

These are the things that will bite you. Each was found by running the thing, not by reading it.

### paths.js runs before any other rule

Every path from the network goes through safeResolve before anything reasons about it, including before checking whether it ends in .md. Anything that inspects a path first is a rule the guard has to be reached through. Escapes return 403, never 404, so the response cannot probe for files outside the root.

Containment is a segment comparison after path.relative, not a string prefix and not startsWith("..") on the relative path. A prefix check lets a null byte through; startsWith("..") rejects a file legitimately named ..hidden.md. Both wrong forms are pinned in test/paths.test.js against path.posix and path.win32.

safeResolve deliberately does not Unicode-normalise. On ext4 the NFC and NFD spellings of an accented filename like café.md are two different files, so normalising ENOENTs on exactly the names it looks like it is helping. test/paths.test.js pins this with both spellings of café.md, which is why the fixture cannot be renamed to something plain ASCII: ASCII has no NFC/NFD distinction, and the test would pass with the guard removed.

### The Host check does not stop a write

hostAllowed closes DNS rebinding: a page that points its own hostname at 127.0.0.1 arrives with Host: evil.example and is refused. It does not close CSRF. Any page on the web can PUT straight to http://localhost:4321 with a Host header that is perfectly legitimate. CORS stops it reading the response, which is why the read side was safe without ever thinking about this, but a write lands whether or not the attacker can see the answer.

So handleWrite checks Origin, and refuses a request that has none. The expected origin is derived from the request's own Host, which hostAllowed has already vetted by then, so --allow-host keeps working for free. The Content-Type must also be application/json, which forces a cross-origin caller into a preflight nobody answers. Two locks, one door.

Both are pinned in test/write.test.js, which has to use http.request rather than fetch: fetch treats Origin as a forbidden header and drops it silently, exactly as it does with Host, so a CSRF check tested through fetch is always green and never runs.

The order of the checks inside handleWrite is the shape of the function. Origin and content type are settled before the path is looked at, and safeResolve runs before anything asks whether the path is markdown, which is the same rule the read side follows.

### A textarea rewrites your line endings

The HTML spec has a textarea normalise its API value: CR and CRLF both come back as LF. Read a CRLF file into the editor, read .value back out, write it, and every line of the file has changed while the reader touched one word. On a Windows checkout that is a diff that touches the whole file.

The browser cannot fix this, because by the time the value exists the newlines are already gone. So /api/raw reports the eol it found, the client hands it back on save, and the server puts it on again. detectEol is majority-rules, so one stray CRLF in an LF file does not flip it.

### markdown-it hands you percent-encoded urls

By the time a renderer rule in render.js sees an href or src, markdown-it's normalizeLink has already percent-encoded it. Decode once before resolving, encode once after. Encoding twice turns café-menu.png into caf%25C3%25A9-menu.png and a 404. Decoding first also means an obfuscated %2e%2e%2f becomes ../ and is rejected in render.js rather than reaching the server disguised.

### The watcher watches the directory, never the file

fs.watch on a file stops firing after the first atomic save, and vim and VS Code both save atomically (write a temp file, rename over the target). watcher.js watches the containing directory and re-stats the file on any event.

It also ignores the filename argument entirely, because Node documents it as possibly null depending on the platform. A stat is cheap and always right.

Subscribing to a file that is already gone reports the deletion immediately: no watch event will ever fire for something that already happened.

Saving from the browser goes through the same door: write.js writes a temp file and renames over the target, which is what vim does, which is what the watcher was already built to survive. The temp name starts with a dot so tree.js's dotfile filter keeps it out of the explorer, and the old file's mode is copied onto it before the rename, because rename gives the replacement default permissions and a document that was not group-readable should not become so because someone fixed a typo in it.

### A watch event carries the version, and that is how a save is told from a stranger

The watcher cannot know who wrote the file, so the browser's own save comes back to it as a change like any other. Without something to tell the two apart, every save would raise "this file changed on disk" against the person who changed it.

The something is version: a sha256 of the contents, computed in write.js, and the single notion of version in the app. It is the optimistic lock on a save, the receipt a save comes back with, and the field on the watch event. The client ignores an event whose version is the one it just wrote.

It is a content hash rather than an mtime because mtime is one-second granular on some filesystems, so two writes in the same second with the same size are indistinguishable, and that is precisely the case an editor has to get right.

Detection in watcher.js is still a stat, and still cheap. The hash is only paid for once the stat has already said the file really changed.

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

### The document pane measures zero while the editor is open

Edit mode hides #content with display:none, and #content is the scroll container everything measures against. A hidden element has no box, so scrollTop reads 0. Measured, in both Chromium and Firefox.

capturePosition therefore returns early in edit mode. It has to: pagehide calls it, so closing or reloading the tab mid-edit would otherwise write "the reader was at the top of the file" into sessionStorage over a perfectly good position. That one is pinned by an e2e test, and removing the guard turns it red.

Coming back the other way, both engines hand the pane its scroll offset back when it stops being display:none. Which means the explicit restore in exitEdit, and the capture: false it passes loadFile, are no-ops in both, and no test in this repo can make them fail. They stay anyway: nothing in the spec promises that restoration (scrollTop is defined to return 0 for an element with no box, and says nothing about what happens when the box returns), and a browser that starts the pane at zero would drop the reader at the top of the document every time they glanced at the source. WebKit could not be measured here; it is a supported platform.

Do not "simplify" those two lines away because the tests stay green. That is what this note is for.

### The editor owns its own reloads

reloadCurrent re-renders the document, and in edit mode that would take the buffer with it. So an open editor intercepts everything that would otherwise re-render: the watch event, the theme toggle's mermaid repaint, and the event-stream reconnect. Each one either updates the buffer, raises a banner, or does nothing, and marks the view behind the editor stale so it is rebuilt on the way out.

An unsaved buffer is never overwritten by anything the reader did not ask for. A save that lands on a file which moved underneath it is a 409, and the 409 carries the version to save against, so "overwrite it" is one click and still an explicit act.

### A copy button cannot live inside the pre it copies

Two unrelated reasons, one conclusion, which is why decorateCodeBlocks wraps every pre in a div and makes the button a sibling rather than a child.

The pre is the horizontal scroll container. An absolutely positioned child of a scroll container is positioned against the content and scrolls with it, so the button slides off to the left the moment the reader drags a long line sideways, which is the exact moment they wanted it. Pinned by an e2e test that scrolls the block and asserts the button has not moved.

And mermaid reads the element's textContent as the diagram definition. A button in there puts the word "Copy" into the graph.

decorateCodeBlocks also has to run before renderMermaid, and that is the third thing. mermaid.run replaces the element's content with the rendered SVG, and the diagram source is gone: textContent afterwards is the stylesheet mermaid injects into the SVG, beginning "#mermaid-1784003312619{font-family:". So the source is taken while it still exists and kept in the pre's dataset, which survives because mermaid replaces the content and leaves the element and its attributes alone. A copy button that reads textContent when it is clicked copies that stylesheet, and there is a test that goes red if it does.

The wrapper carries the margin the pre used to have and the pre gives it up, so a decorated document is exactly as tall as an undecorated one. The scrollspy and drawer fixtures are calibrated against that height.

### The clipboard is not always there

navigator.clipboard exists only in a secure context. localhost and 127.0.0.1 count as one, so the default setup never notices. But --host and --allow-host exist so somebody can read this from another machine, and http://192.168.1.5:4321 is not a secure context: navigator.clipboard is undefined, and a copy button built on it alone does nothing at all, in silence, for exactly the people who asked for that setup.

So copyText falls back to a staging textarea and document.execCommand('copy'). It is deprecated and it works everywhere. Pinned by an e2e test that deletes navigator.clipboard before the app loads.

### Mermaid is vendored, not depended on

Depending on mermaid pulls 111 packages and 154 MB to serve one self-contained 3.5 MB browser bundle. public/vendor/mermaid.min.js is copied out of the tarball by scripts/vendor-mermaid.mjs, which refuses any build containing a dynamic import() because that would mean the bundle needs its 542 sibling chunks. It is loaded lazily, only for documents that actually contain a diagram.

### Test layout

npm test runs bare `node --test`, with no path argument. Node's discovery treats every .js file inside a directory named test as a test file, which is why the Playwright specs live in e2e/ rather than test/e2e/. Passing a glob breaks on Windows (cmd.exe does not expand it) and passing a directory is read as a module path.

Server-side tests are node:test with no dependencies and run on all three operating systems in CI. Browser tests are Playwright, Linux only, and cover the three behaviours node:test cannot reach: scrollspy geometry, live reload with a document that reflows, and the drawers.

### CLI flags

node:util parseArgs has no --no-<flag> support. --no-open is declared as its own boolean option; declaring open and hoping does not work, it throws at startup.

### Security defaults

The server binds loopback and rejects any Host header that is not a loopback name, which is what actually stops DNS rebinding from a page the user visits. /files serves images only. Both open up behind --serve-all and --allow-host. Rendered HTML is deliberately not sanitised; the threat model is documented in README.md.

Saving is on by default and closes behind --read-only. It is the only write, it is guarded by Origin rather than by Host, and it refuses to create files: a PUT to a path that is not already there is a 409, not a new document. The client asks /api/config once at boot so --read-only takes the Edit button off the bar instead of leaving it there to earn a 403.

### The toggle event of a details is queued, and the tree filter has to know that

Filtering opens every directory on the way down to a match. Measured: the toggle event of a details is queued rather than fired in place, so even setting open while building the node, before the listener exists, still reaches that listener afterwards.

The listener is the one that persists which directories the reader had expanded. So without a guard, one keystroke in the filter box writes the filter's own expansion into localStorage, permanently: close a directory, search for something, clear the search, and it is open again, for good.

treeNode captures `filtering` in the closure rather than reading state.query inside the listener, so the answer cannot change between the render that opened the node and the task that reports it. Pinned by an e2e test that closes a directory, filters, clears, and demands the directory still be closed.

markActiveFile opens the ancestors of the current file, and lands in the same listener. That one is deliberate: navigating into a directory is a reason to remember it open.

### The filter box lives outside the tree it filters

renderTree calls replaceChildren on #tree, and loadTree polls every ten seconds. An input inside #tree would lose its focus and its caret out from under whoever was typing into it, every ten seconds, but only when the tree actually changed, which is exactly the sort of thing that survives review and shows up as a bug report about "the search box eats letters".

renderTree also reads state.query rather than being handed a tree, so a rebuild reapplies the filter instead of dropping it.

### The filter folds accents, where paths.js must not

fold() strips diacritics and lowercases so that typing tai lieu finds tài-liệu.md, which is the only way anyone actually types a Vietnamese filename.

That is the exact opposite of the rule in paths.js, and the difference is what the string is for. paths.js resolves a name to a file on disk, where the NFC and NFD spellings of café.md are two different files, so normalising there ENOENTs on the names it looks like it is helping. Nothing in the filter ever opens anything: it compares text for the reader's eyes, and node.path, untouched, is still what fetches the document. Same licence slugify has in render.js, for the same reason.

fold returns an array of code points, one out for each one in, and normalises to NFC first. That is what keeps a match index found in the folded path usable as an index into the name being displayed, which is how the matched letters get emboldened. A filename off macOS arrives decomposed, and there é is two code points, so without the NFC the highlight lands on the wrong letter.

### Tree indentation

Rows in the explorer indent by depth, but a directory's disclosure triangle occupies about 16px inside the summary's own content box. File rows reserve an empty gutter of the same width, otherwise every child file renders to the left of the directory containing it and the nesting reads backwards.

## A house rule for tests

When you add a test for a fix, remove the fix and confirm the test goes red. Three tests written in this repository passed with their fix reverted, and were rewritten or deleted. A test that cannot fail is worse than no test, because it claims coverage.

The corollary: when a browser test is flaky, find the race before relaxing the assertion. e2e/app.spec.js has a spySettled helper for exactly one such race, where a reload can beat scrollspy's next animation frame.
