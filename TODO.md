# TODO

Feature backlog, written from a user's perspective after running the app against a
directory of nested, non-ASCII, mixed-content markdown. Ordered by how much a real
reader feels the gap, not by how easy each is. Every item is weighed against the
thing that makes this tool pleasant: zero build, exactly two runtime dependencies
(markdown-it and highlight.js), local-first, reader-first. Items that would add a
dependency say so.

## Priority 1 - biggest user-facing gaps, little or no new dependency


- [ ] Keyboard command palette / quick open. A floating, keyboard-first jump-to-file
      (something like Ctrl+K) that searches every file without reaching for the mouse.
      The current filter is close but requires focusing the tree first; a palette scales
      to a large document set. Can share the fold/accent-folding logic the filter already
      has.

## Priority 2 - clear value, weigh the added asset or complexity

- [ ] Math rendering (KaTeX) for technical documents. Trade-off: it means vendoring an
      asset the way mermaid already is, loaded lazily only for documents that contain
      math. Many technical notes use inline and block LaTeX.

- [ ] Editor niceties, still a plain textarea. Auto-continue a list on Enter, Ctrl+B and
      Ctrl+I for bold and italic, Tab to indent, and an optional line-number gutter. No
      preview, no rich text - that stays deliberately out.

## Priority 3 - polish

- [ ] Export or print to PDF via print CSS, or a copy-as-HTML button, so a rendered
      document can leave the app.

- [ ] Keyboard tree navigation (j / k / Enter) and a recent-files list.

- [x] Image lightbox: click an inline image to zoom it. (also zooms mermaid diagrams)

## Bigger bet - changes the product's identity, decide deliberately

- [ ] Wikilinks (double-bracket links) plus backlinks, in the direction of an
      Obsidian-style note graph. This repositions the tool from a reader into a note
      system, pulls in link-resolution and a backlink index, and should be a conscious
      product decision rather than a feature added because it looks nice.

## Explicitly out of scope, to keep it lean

- WYSIWYG editing. The raw textarea is the point: what you see is what is on disk.
- Multi-user collaboration or cloud sync.
- A general plugin ecosystem. Each of these pulls in dependencies and complexity that
  work against what makes the tool light.
