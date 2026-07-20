import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/common';
import { posix } from 'node:path';

export const MARKDOWN_RE = /\.(md|markdown|mdown|mkd)$/i;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const FRONTMATTER_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m;

/**
 * GitHub-compatible heading slug.
 *
 * \p{L}\p{N} with the u flag, not \w: `\w` is ASCII-only and would turn
 * "Café Menu" into "caf-menu". Normalising to NFC here is safe and wanted,
 * because this produces an HTML id, never a filesystem path.
 */
export function slugify(text) {
  const slug = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-');
  return slug || 'section';
}

export function stripFrontmatter(source) {
  const match = FRONTMATTER_RE.exec(source);
  // The `m` flag the closing `---` needs also lets the opening one match at any
  // line start, so a horizontal rule mid-document opens a block that was never
  // frontmatter. Frontmatter is the first thing in the file or it is not
  // frontmatter, and the slice below trusts that: it cuts match[0].length off
  // the front, which is the match's end only when the match began at 0.
  if (!match || match.index !== 0) return { body: source, data: {} };

  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
  return { body: source.slice(match[0].length), data };
}

/** Heading text with the markup taken off, so `## The **fast** path` slugs cleanly. */
function plainText(inline) {
  let out = '';
  const walk = (children) => {
    for (const token of children ?? []) {
      if (token.type === 'text' || token.type === 'code_inline') out += token.content;
      else if (token.children) walk(token.children);
    }
  };
  walk(inline?.children);
  return out.trim();
}

const countNewlines = (s) => (s.match(/\n/g) ?? []).length;

const isExternal = (href) => SCHEME_RE.test(href) || href.startsWith('//');

/** Resolve a document-relative link to a root-relative POSIX path, or null to leave it alone. */
function resolveRel(target, dir) {
  if (!target) return null;
  const rel = target.startsWith('/')
    ? posix.normalize(target.slice(1))
    : posix.normalize(posix.join(dir, target));
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../')) return null;
  return rel;
}

const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

/**
 * markdown-it runs every href and src through normalizeLink, so by the time a
 * renderer rule sees them they are already percent-encoded. Decode once before
 * resolving, or "./café-menu.png" gets encoded twice and 404s.
 *
 * Decoding first also means an obfuscated "%2e%2e%2f" becomes "../" and is
 * caught by resolveRel rather than being handed to the server still disguised.
 */
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const splitHash = (href) => {
  const i = href.indexOf('#');
  return i === -1 ? [href, ''] : [href.slice(0, i), href.slice(i)];
};

function createRenderer() {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    typographer: false,
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const out = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
          return `<pre><code class="hljs language-${md.utils.escapeHtml(lang)}">${out}</code></pre>`;
        } catch {
          // fall through to the escaped form
        }
      }
      return `<pre><code class="hljs">${md.utils.escapeHtml(code)}</code></pre>`;
    },
  });

  // One pass over the token stream gives both the anchor ids and the outline.
  md.core.ruler.push('collect_headings', (state) => {
    const headings = [];
    const seen = new Map();

    for (let i = 0; i < state.tokens.length; i++) {
      const open = state.tokens[i];
      if (open.type !== 'heading_open') continue;

      const text = plainText(state.tokens[i + 1]);
      const base = slugify(text);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      const id = count === 0 ? base : `${base}-${count}`;

      open.attrSet('id', id);
      // The parser's own line for this heading (body-relative; renderMarkdown
      // shifts it back over the frontmatter). Taken here, in the same pass as the
      // id, so the id and the line the editor jumps to cannot drift apart.
      headings.push({ level: Number(open.tag.slice(1)), text, id, line: open.map ? open.map[0] : 0 });
    }

    state.env.headings = headings;
  });

  const defaultFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const info = tokens[idx].info.trim().split(/\s+/)[0] ?? '';
    if (info.toLowerCase() === 'mermaid') {
      env.hasMermaid = true;
      return `<pre class="mermaid">${md.utils.escapeHtml(tokens[idx].content)}</pre>\n`;
    }
    return defaultFence(tokens, idx, options, env, self);
  };

  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const src = tokens[idx].attrGet('src') ?? '';
    if (!isExternal(src)) {
      const rel = resolveRel(safeDecode(src), env.dir);
      if (rel) tokens[idx].attrSet('src', `/files/${encodePath(rel)}`);
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = token.attrGet('href') ?? '';

    if (href.startsWith('#')) {
      // A bare fragment already points at one of our heading ids.
    } else if (isExternal(href)) {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    } else {
      const [pathPart, hash] = splitHash(href);
      const rel = resolveRel(safeDecode(pathPart), env.dir);
      if (rel && MARKDOWN_RE.test(rel)) {
        // Real href so middle-click and copy-link work; the app intercepts the click.
        token.attrSet('data-md-link', rel);
        token.attrSet('href', `?path=${encodeURIComponent(rel)}${hash}`);
      } else if (rel) {
        token.attrSet('href', `/files/${encodePath(rel)}${hash}`);
      }
    }
    return self.renderToken(tokens, idx, options);
  };

  return md;
}

const md = createRenderer();

/**
 * @param {string} source  raw markdown
 * @param {string} relPosix  path of the document relative to root, POSIX-style
 */
export function renderMarkdown(source, relPosix) {
  const { body, data } = stripFrontmatter(source);
  const dir = posix.dirname(relPosix);
  const env = { dir: dir === '.' ? '' : dir, headings: [], hasMermaid: false };

  const html = md.render(body, env);
  const title =
    data.title ||
    env.headings.find((h) => h.level === 1)?.text ||
    posix.basename(relPosix);

  // Heading lines are body-relative; shift them over however many lines the
  // frontmatter took, so they index the raw file the editor loads, not the body.
  const strippedLines = countNewlines(source.slice(0, source.length - body.length));
  const headings = env.headings.map((h) => ({ ...h, line: h.line + strippedLines }));

  return { html, headings, title, hasMermaid: env.hasMermaid };
}
