import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, stripFrontmatter, renderMarkdown } from '../src/render.js';

test('slugify keeps non-ASCII letters', () => {
  assert.equal(slugify('Café Menu'), 'café-menu');
  assert.equal(slugify('Café Menu: Step 1'), 'café-menu-step-1');
  assert.equal(slugify('Приложение'), 'приложение');
  assert.equal(slugify('日本語の見出し'), '日本語の見出し');
});

test('slugify strips punctuation and collapses whitespace', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world');
  assert.equal(slugify('  spaced   out  '), 'spaced-out');
  assert.equal(slugify('a -- b'), 'a-b');
});

test('slugify never returns an empty id', () => {
  assert.equal(slugify('!!!'), 'section');
  assert.equal(slugify(''), 'section');
});

test('duplicate headings get distinct ids', () => {
  const { headings } = renderMarkdown('# Setup\n## Setup\n### Setup\n', 'a.md');
  assert.deepEqual(headings.map((h) => h.id), ['setup', 'setup-1', 'setup-2']);
  assert.deepEqual(headings.map((h) => h.level), [1, 2, 3]);
});

test('heading text drops inline markup', () => {
  const { headings } = renderMarkdown('## The **fast** `path`\n', 'a.md');
  assert.equal(headings[0].text, 'The fast path');
  assert.equal(headings[0].id, 'the-fast-path');
});

test('each heading carries the source line it sits on', () => {
  const { headings } = renderMarkdown('# A\n\ntext\n\n## B\n', 'a.md');
  // Zero-based, no frontmatter to shift over.
  assert.deepEqual(headings.map((h) => h.line), [0, 4]);
});

test('heading lines survive frontmatter and a fenced hash', () => {
  const source = ['---', 'title: X', '---', '', '# One', '', '```', '# not a heading', '```', '', '## Two', ''].join(
    '\n',
  );
  const { headings } = renderMarkdown(source, 'a.md');
  const lines = source.split('\n');

  // The line each heading reports is that heading's own line in the raw file:
  // the frontmatter offset is added back, and the # inside the fence is not a
  // heading and does not throw the count off.
  assert.deepEqual(headings.map((h) => h.id), ['one', 'two']);
  assert.equal(lines[headings[0].line], '# One');
  assert.equal(lines[headings[1].line], '## Two');
});

test('heading ids land in the html', () => {
  const { html } = renderMarkdown('## Café Menu\n', 'a.md');
  assert.match(html, /<h2 id="café-menu">/);
});

test('stripFrontmatter removes the block and reads the title', () => {
  const { body, data } = stripFrontmatter('---\ntitle: "My Doc"\ntags: a\n---\n# Hi\n');
  assert.equal(body, '# Hi\n');
  assert.equal(data.title, 'My Doc');
  assert.equal(data.tags, 'a');
});

test('stripFrontmatter leaves a document without one alone', () => {
  const src = '# Hi\n\n---\n\nbelow\n';
  assert.equal(stripFrontmatter(src).body, src);
});

test('stripFrontmatter handles an empty block', () => {
  assert.equal(stripFrontmatter('---\n---\n# Hi\n').body, '# Hi\n');
});

test('title falls back to the first h1, then to the filename', () => {
  assert.equal(renderMarkdown('---\ntitle: From FM\n---\n# From H1\n', 'a.md').title, 'From FM');
  assert.equal(renderMarkdown('# From H1\n', 'a.md').title, 'From H1');
  assert.equal(renderMarkdown('no headings here\n', 'docs/a.md').title, 'a.md');
});

test('mermaid fences are not syntax highlighted', () => {
  const { html, hasMermaid } = renderMarkdown('```mermaid\ngraph TD;\nA-->B;\n```\n', 'a.md');
  assert.equal(hasMermaid, true);
  assert.match(html, /<pre class="mermaid">graph TD;\nA--&gt;B;\n<\/pre>/);
  assert.doesNotMatch(html, /hljs/);
});

test('other fences are syntax highlighted', () => {
  const { html, hasMermaid } = renderMarkdown('```js\nconst a = 1;\n```\n', 'a.md');
  assert.equal(hasMermaid, false);
  assert.match(html, /class="hljs language-js"/);
  assert.match(html, /hljs-keyword/);
});

test('an unknown language is escaped, not highlighted', () => {
  const { html } = renderMarkdown('```nosuchlang\n<script>x</script>\n```\n', 'a.md');
  assert.match(html, /&lt;script&gt;/);
});

test('relative images resolve against the document directory', () => {
  const { html } = renderMarkdown('![a](./img/a.png)\n', 'docs/guide.md');
  assert.match(html, /src="\/files\/docs\/img\/a\.png"/);
});

test('root-relative and absolute image sources', () => {
  assert.match(renderMarkdown('![a](/img/a.png)\n', 'docs/g.md').html, /src="\/files\/img\/a\.png"/);
  assert.match(renderMarkdown('![a](https://x/a.png)\n', 'a.md').html, /src="https:\/\/x\/a\.png"/);
  assert.match(renderMarkdown('![a](data:image/gif;base64,R0lGOD)\n', 'a.md').html, /src="data:image/);
});

test('an image escaping root is left untouched', () => {
  assert.match(renderMarkdown('![a](../../secret.png)\n', 'a.md').html, /src="\.\.\/\.\.\/secret\.png"/);
});

// markdown-it percent-encodes src/href before a renderer rule ever sees them.
// These pin the round-trip so a future edit cannot reintroduce double encoding.
test('unicode image paths are encoded exactly once', () => {
  const { html } = renderMarkdown('![a](./café-menu.png)\n', 'docs/g.md');
  assert.match(html, /src="\/files\/docs\/caf%C3%A9-menu\.png"/);
  assert.doesNotMatch(html, /%25/);
});

test('image paths with spaces are encoded exactly once', () => {
  const { html } = renderMarkdown('![a](<./café menu.png>)\n', 'docs/g.md');
  assert.match(html, /src="\/files\/docs\/caf%C3%A9%20menu\.png"/);
  assert.doesNotMatch(html, /%25/);
});

test('unicode markdown links carry a decoded data-md-link', () => {
  const { html } = renderMarkdown('[x](./café.md)\n', 'docs/g.md');
  assert.match(html, /data-md-link="docs\/café\.md"/);
  assert.doesNotMatch(html, /%25/);
});

test('percent-encoded traversal is caught before it reaches a url', () => {
  const { html } = renderMarkdown('![a](%2e%2e%2f%2e%2e%2fsecret.png)\n', 'docs/g.md');
  assert.doesNotMatch(html, /\/files\//);
});

test('markdown links become in-app navigations', () => {
  const { html } = renderMarkdown('[x](./other.md)\n', 'docs/g.md');
  assert.match(html, /data-md-link="docs\/other\.md"/);
  assert.match(html, /href="\?path=docs%2Fother\.md"/);
});

test('a markdown link keeps its fragment', () => {
  const { html } = renderMarkdown('[x](./other.md#usage)\n', 'docs/g.md');
  assert.match(html, /href="\?path=docs%2Fother\.md#usage"/);
});

test('bare fragments are left alone', () => {
  const { html } = renderMarkdown('[x](#usage)\n', 'a.md');
  assert.match(html, /href="#usage"/);
  assert.doesNotMatch(html, /data-md-link/);
});

test('external links open in a new tab, safely', () => {
  const { html } = renderMarkdown('[x](https://example.com)\n', 'a.md');
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('relative non-markdown links go through /files', () => {
  const { html } = renderMarkdown('[x](./report.pdf)\n', 'docs/g.md');
  assert.match(html, /href="\/files\/docs\/report\.pdf"/);
});

test('tables and strikethrough are on', () => {
  const { html } = renderMarkdown('| a |\n|---|\n| 1 |\n\n~~gone~~\n', 'a.md');
  assert.match(html, /<table>/);
  assert.match(html, /<s>gone<\/s>/);
});
