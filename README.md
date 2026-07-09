# markdown-explorer

Browse the markdown files under any directory, in your browser. Three panes: a file tree on the left, the rendered document in the middle, and a clickable heading outline on the right.

```bash
npx markdown-explorer
```

That serves the current directory and opens a tab. Nothing to configure.

## What you get

- A file tree of markdown only. Directories whose subtree contains no markdown are hidden, so you never click into a dead end.
- Switching between files puts you back where you stopped reading, down to the pixel. If the file changed while you were away, you land on the heading you were on instead.
- Live reload. Save in your editor, the document updates, and you stay on the heading you were reading rather than being thrown back to the top.
- An outline that tracks your scroll position, including the last section of a document even when it is too short to fill the screen.
- Mermaid diagrams, syntax highlighting, tables, and GitHub-compatible heading anchors, including non-ASCII ones. A heading of `## Café Menu` gets the id `café-menu`, the same one GitHub would give it.
- Both side panes collapse to a rail, with `[` and `]`, or the chevron in each header. The way back stays on screen, and the choice is remembered.
- Dark mode, following your system preference until you override it.
- Shareable URLs. `?path=docs/guide.md#setup` restores the file and the scroll position.
- Links between markdown files open in the app instead of navigating away.

## Usage

```
mdv [directory] [options]

  --port <n>        port to listen on (default 4321, falls back if taken)
  --host <addr>     address to bind (default 127.0.0.1)
  --allow-host <h>  accept requests carrying this Host header (repeatable)
  --serve-all       serve every file under the root, not only images
  --no-open         do not launch a browser
  -h, --help        show this
```

## Security

This is a web server that reads files out of whatever directory you point it at, so the defaults matter.

It binds to `127.0.0.1` and refuses any request whose `Host` header is not a loopback name. That second check is not decoration. Binding to loopback alone does not stop a page you visit from pointing its own hostname at `127.0.0.1` and reading the responses as same-origin, which is how local dev servers have historically leaked files. Use `--allow-host` if you genuinely need another name.

`/files/` serves images only. `--serve-all` opens it to every file under the root, which also means `.env` and `.git/config` become readable over HTTP. Turn it on when you know why you want it.

Every path from the browser is resolved and then checked for containment by path segment, after `realpath`, so neither `../` nor a symlink pointing outside the root will escape. Requests that try get a `403`, never a `404`, so the response cannot be used to probe for files outside the tree.

Rendered HTML is not sanitised. The server renders files you already own on a machine you already control, and `html: true` is what makes real documents render correctly. Do not point this at a directory of markdown you did not write and then expose it to a network.

## Requirements

Node 20 or newer. Linux, macOS and Windows.

## Development

```bash
npm install
npm test              # unit and server tests, no browser needed
npx playwright test   # browser tests: scrollspy, live reload, mermaid
```

Mermaid is vendored as a single self-contained 3.4 MB file under `public/vendor/`, rather than taken as a dependency. Depending on it would pull 111 packages and 154 MB onto every user of a CLI that needs exactly one browser bundle. To update it:

```bash
npm run vendor:mermaid          # latest
npm run vendor:mermaid 11.16.0  # a specific version
```

The script refuses to vendor a build that contains a dynamic `import()`, since that would mean the bundle is no longer self-contained.

## License

MIT. Bundled mermaid is MIT too; its license travels with it in `public/vendor/mermaid.LICENSE`.
