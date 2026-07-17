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

Reading is GET. The writes are: PUT /api/file saves, POST /api/file creates an empty document, DELETE /api/file removes one, POST /api/folder creates a directory, POST /api/duplicate copies a document within its directory, POST /api/rename renames one within its directory, POST /api/move carries one into another directory. They all share the same locks, in the same order (read-only, Origin, content type, then the path), and nothing else in the program writes.

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

The order of the checks inside handleWrite is the shape of the function. Origin and content type are settled before the path is looked at, and safeResolve runs before anything asks whether the path is markdown, which is the same rule the read side follows. handleCreate and handleRename repeat that shape lock for lock, and test/fs-ops.test.js pins them the same way write.test.js pins the save.

### PUT refuses to create, POST refuses to overwrite

A save that races a deletion must land as a 409, never as a quiet resurrection, so PUT demands the file already exist. Creation is therefore its own request, and it holds the mirrored promise: POST /api/file opens with the 'wx' flag, so existence and creation are one syscall and two racing creates cannot both win. Each endpoint's refusal is the other one's contract.

A rename carries the same optimistic lock a save does: the version of the source file rides in the body, and a file that changed since the reader looked at it is a 409, not a move.

### safeResolve canonicalises the one name a rename must keep literal

safeResolve realpaths, and on APFS and NTFS the realpath of "Readme.md" is the on-disk "README.md". Resolve a rename's destination through it and a case-only rename quietly becomes a no-op rename of the file onto itself. So handleRename uses safeResolve on the destination for containment only, and rebuilds the name it actually writes from the literal final segment, joined onto the vetted source directory, with a dirname comparison after the join to catch a segment that smuggled a separator the platform understands.

The "target already exists" check has the same filesystem to survive: stat(readme.md) answers for README.md, so existence alone would refuse the case-only rename against the very file being renamed. The check compares identity instead, dev+ino as bigints, and only a target that is a *different* file is a 409. Both halves fail on a case-insensitive filesystem only, so a green Linux run says nothing about them; macOS CI or a local mac run is what exercises them.

### Our own rename comes back as a deletion

The watcher cannot tell a rename from a deletion: the old name is simply gone. A deletion event carries no version (there is nothing to hash), so the version trick that lets the client ignore its own save cannot work here. Instead the client sets state.renamePending around the rename request and swallows a deletion event for exactly that path.

The flag looks redundant, because state.path is updated as soon as the 200 lands and the stream handler already ignores events for other paths. It is not: the watcher debounces 100ms, and a response slower than that arrives after the deletion event, which then lands on a page that still believes in the old name. The e2e test pins this by holding the 200 in page.route until the watcher has spoken; remove the flag and the reader is told their file was deleted by their own rename.

### The inline input lives inside the tree it cannot survive

The filter box solved "renderTree wipes #tree on every poll" by living outside #tree. The new-file and rename input belongs to a row, so it cannot. The answer is inverted instead: while state.treeEditing is set, loadTree still polls and still stores the fresh tree, but does not render it; closing the input, by commit or by escape, applies the deferred render. Pinned by an e2e test that must wait for the poll's /api/tree response before asserting the input still holds its caret, because an assertion that races the fetch passes with the guard removed, which is how the first version of that test was caught lying.

Every write invalidates the server's one-second tree cache (clearTreeCache in the handlers), because the client refreshes the explorer immediately after a create or rename, and a refresh inside the cached second would hand back the tree from before the write. The test that pins this has to GET /api/tree once *before* the write, since the cache only holds what has been asked for.

A rename of the open file also moves the client state keyed by path: the scroll-memory entry, state.path, the URL (replaceState, the document did not change, only its name), and the event stream. A dirty editor refuses the rename outright, so an unsaved buffer can never point at a path that no longer exists.

### A pinned tab is pruned by the tree, so a rename must move its pin first

The pinned-file tabs (mdx:pins in localStorage, keyed by root like mdx:expanded) are client-only bookmarks: nothing about them touches the server, which is why pinning is the one thing the tree's context menu still offers under --read-only. Every loadTree prunes pins whose file is absent from the tree, so a tab can never point at a 404. That prune is also a trap: renameTo refreshes the tree after a rename, so it must move the pin to the new name *before* that refresh, or the prune reads the old name as a deletion and the pin is not renamed but silently lost. Pinned by an e2e test that goes red if the remap moves below the loadTree.

The bar itself (#tabbar) sits outside #content like the mode bar, hidden entirely while nothing is pinned. Appearing or vanishing therefore reflows #content with no scroll event, which is the drawer-toggle problem again, answered the same way: renderTabs calls updateSpy after the same 200ms. Tab labels are basenames until two pins collide, then each shows its parent directory, and the collision is recomputed per render so unpinning one collapses the other back.

### Move is a rename that crosses a directory, and that is why it is a second endpoint

Rename and move are one fs.rename with one optimistic version lock, and refuse to clobber a file that is not the source under another spelling; relocate() in server.js is that shared tail, and handleRename and handleMove differ only in how they build the destination before calling it. They stay two endpoints because /api/rename deliberately refuses to leave a file's directory (a cross-directory rename is a 400), and both that refusal and the within-directory realpath rebuild are pinned. handleMove rebuilds the destination from the literal final segment joined onto the *destination* directory that safeResolve vetted, with the same basename check against a smuggled separator, and leans on relocate turning a rename onto a missing directory into a 404 rather than pre-checking it.

On the client the mirror is applyRelocated: the reading position, the pin, and - if it is the open file - state.path, the url and the event stream all move by path, and rename and move both go through it, so a move updates exactly what a rename does. A move is driven by a drop, not by the inline input, so moveTo raises its own banner on failure instead of returning a message; the dirty-buffer refusal is duplicated onto dragstart *and* moveTo, because a drop can still arrive after a drag the guard let start.

### Delete carries no version, and the open file's own deletion is swallowed

A save and a rename lock against a version; a delete does not. Deleting is "make it gone" whatever the contents now are, and the reader has already confirmed it in a banner, so demanding the on-disk version match would only turn a file that changed underneath into a confusing refusal. handleDelete is files only: it is a plain fs.rm, and a directory's EISDIR/EPERM is the fence, because the tree offers Delete on a file row alone.

Deleting the open file is the one that bites: the watcher reports it as a deletion on that file's own stream, and announcing "this file was deleted" to the reader who just deleted it is absurd. So deleteFile closes the stream and nulls state.path before the event can land, and empties the pane. Pinned by an e2e test that deletes the open file and asserts the pane says "Pick a file", never "was deleted".

### New folder chains into a new file, because an empty directory is invisible

The tree prunes directories whose subtree holds no markdown, so a folder just created is not in it. startFolder therefore creates the directory and then chains straight into startCreate for a file inside it, and that new-file input is hosted by ensureDirNode, which synthesizes a transient <details> for the folder under its nearest real ancestor. The real folder and file arrive together on the loadTree that the file's creation triggers, and the synthetic node is thrown away with the rest of the old tree. The chain is deferred a macrotask (setTimeout 0), because openTreeInput tears its own input down after commit resolves, and opening the next input inline would have that teardown close it immediately. Escaping the file step leaves an empty folder on disk; it stays invisible until any file lands in it, which is honest for a markdown explorer.

### Duplicate keeps its prefilled name, unlike rename

The inline input treats "the name is unchanged" as a cancel, which is right for rename: renaming a file to its own name is a no-op. Duplicate prefills the input with the suggested copy name (guide.md -> guide-copy.md, then -copy-2, skipping what the directory already holds), and there the prefilled name *is* the wanted one, so startDuplicate passes sameIsCancel:false and folders pass appendExt:false so a directory name keeps its bare form. The server copies with the 'wx' flag, so an existing target is a 409 and two racing duplicates cannot both win, exactly as create does.

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

### Entering edit lands on the section you were reading, and neither half is free

The view is rendered HTML and the editor is raw markdown; they share no geometry, because a diagram is tall rendered and three lines in the source. The active heading is the one landmark in the same logical place in both, so it is the anchor, the same one scroll memory and exitEdit already use.

Which source line a heading is on comes from markdown-it's token.map, recorded in collect_headings in render.js in the same pass that assigns the id, so the id and the line the editor jumps to cannot drift. The parser is also right where a hand scan would not be: it does not count a `#` inside a fenced or indented code block, and it handles setext headings. render.js parses the frontmatter-stripped body, so those lines are body-relative; renderMarkdown adds back the stripped line count so the number indexes the raw file the editor actually loads. Forget that offset and the caret lands in the frontmatter; test/render.test.js pins it.

Scrolling a textarea to a line needs a measuring mirror, a hidden div with the textarea's font, wrapping and content width, because line number times line height drifts the moment a long line soft-wraps, which markdown does constantly. The width is clientWidth minus padding, so it matches the real wrap once a scrollbar has narrowed it. scrollTop is set after focus(), because focusing a textarea whose caret is still at 0 can scroll it back to the top.

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

Saving is on by default and closes behind --read-only, along with every other write: create, delete, create-folder, duplicate, rename, and move. All are guarded by Origin rather than by Host, all pass safeResolve before they reason about the path, and save itself refuses to create files: a PUT to a path that is not already there is a 409, not a new document. The client asks /api/config once at boot so --read-only takes the Edit button off the bar, and the tree's context menu down to Pin/Unpin alone, instead of leaving either there to earn a 403.

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

### Content search is the tree, read, and folded the same way

The Text mode of the search box searches file contents, in src/search.js behind GET /api/search. It does not walk the disk: it flattens the cached tree from getTree, so IGNORED_DIRS, dotfiles, symlink containment and the depth and file caps are the tree's, and the search set can never drift from what the reader sees or reach a file outside the root. No path from the network touches the filesystem here; the paths come from that vetted walk. It is a read, so unlike a save it carries no Origin lock, exactly as /api/tree does not.

search.js has its own copy of the browser's fold(), and the two must stay in step: typing ca phe finds a line that says cà phê only because the server folds contents the same way the filter folds names. It is the same licence, and the same opposite-of-paths.js rule: nothing here opens a file by the folded text. The match ranges are code-point offsets into the NFC line, which is the unit the client slices with, so a highlight lands right even past an astral character. A test pins fold on both sides against a Vietnamese example, because a server that folded differently would answer with matches the client cannot embolden.

Results render inside #tree, so renderTree branches on state.searchMode: the ten-second poll re-renders the stored results harmlessly, and the box keeps its caret because it already lives outside #tree. A hit opens on its section by the same heading lines the editor jump and the outline use: loadFile takes a source line, finds the nearest heading at or above it from the headings /api/file already returns, and scrolls to that id. Forget that headings carry a line and a hit would land at the top of the file instead; the e2e test pins the anchor it lands on.

### Tree indentation

Rows in the explorer indent by depth, but a directory's disclosure triangle occupies about 16px inside the summary's own content box. File rows reserve an empty gutter of the same width, otherwise every child file renders to the left of the directory containing it and the nesting reads backwards.

## A house rule for tests

When you add a test for a fix, remove the fix and confirm the test goes red. Three tests written in this repository passed with their fix reverted, and were rewritten or deleted. A test that cannot fail is worse than no test, because it claims coverage.

The corollary: when a browser test is flaky, find the race before relaxing the assertion. e2e/helpers.js has a spySettled helper for exactly one such race, where a reload can beat scrollspy's next animation frame.

The browser specs are split by feature (explorer, document, scroll-memory, drawers, editor, copy, fs-ops, pins), each launching its own server against its own temp root via launch() in e2e/helpers.js. That file is a module, not a spec, and it lives in e2e/ so node's test discovery never sees it. The isolation is the point: a top-level test.afterEach applies to every test in its file, so cleanup hooks stay scoped to the feature whose files they delete, and the calibrated README fixture (see the comment above it in helpers.js) is shared by reference instead of by copy.
