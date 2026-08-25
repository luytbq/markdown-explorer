import fsp from 'node:fs/promises';
import path from 'node:path';

import { toNative } from './paths.js';
import { getTree } from './tree.js';

const MAX_BYTES = 5 * 1024 * 1024; // same ceiling handleFile/handleRaw put on a document
const MIN_QUERY = 2; // one folded code point over a whole tree matches nearly everything
const MAX_MATCHES_PER_FILE = 10;
const MAX_TOTAL_LINES = 200; // budget across all files, so a common word stays cheap

// What a hit is worth, for the order the results come back in. The reader is
// looking for a document, not a line, so the signals are about the document:
// its own name saying the word, the word standing as a heading in it, and the
// word standing on its own rather than buried inside a longer one.
const IN_PATH = 50;
const IN_HEADING = 30;
const AT_BOUNDARY = 15;
const PER_MATCH = 1;
const MOST_MATCHES = 10; // past this, one more matching line says nothing more

const HEADING_RE = /^ {0,3}#{1,6}\s/;
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * One code point in, one code point out: lower case, and stripped of its accents.
 *
 * This is the browser's fold() from public/app.js, kept in step on purpose so that
 * "tai lieu" finds a line containing "tài liệu" here exactly as it finds the file by
 * name there. Returning one code point per input code point is what lets an index
 * found in the folded line map straight back onto the line the reader is shown.
 *
 * The opposite of paths.js, which must never normalise: nothing here opens a file by
 * this text. The path used to read the file is the one the tree already vetted.
 */
const foldChar = (c) => {
  const base = c.normalize('NFD').replace(/\p{Diacritic}/gu, '') || c;
  const lower = base.toLowerCase();
  return [...lower].length === 1 ? lower : base; // İ lowercases to two; keep the count
};

/** Fold `text` to an array of code points, aligned one-to-one with its NFC form. */
export const fold = (text) => [...text.normalize('NFC')].map(foldChar);

/**
 * Every code-point index in `lineCps` where `queryCps` begins. Both are folded
 * arrays, so the comparison is accent- and case-insensitive, and the indices it
 * returns are code-point offsets into the NFC line - the same units the client
 * slices with, so a highlight lands on the right characters even past an emoji.
 */
function matchOffsets(lineCps, queryCps) {
  const out = [];
  const last = lineCps.length - queryCps.length;
  outer: for (let i = 0; i <= last; i++) {
    for (let j = 0; j < queryCps.length; j++) {
      if (lineCps[i + j] !== queryCps[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/** Flatten the (cached) tree into its markdown file paths, depth-first. */
function treeFiles(node, out) {
  for (const child of node.children ?? []) {
    if (child.type === 'file') out.push(child.path);
    else treeFiles(child, out);
  }
  return out;
}

/**
 * Search the contents of every markdown file the explorer shows, for `query`.
 *
 * The file set is the tree itself, flattened, so IGNORED_DIRS, dotfiles, symlink
 * containment and the depth/file caps are the tree's and cannot drift from what the
 * reader sees. No path from the network reaches disk here: the paths come from our
 * own vetted walk.
 */
export async function searchContents(root, rawQuery) {
  const queryCps = fold(rawQuery ?? '');
  if (queryCps.length < MIN_QUERY) return { results: [], truncated: false };

  const { tree } = await getTree(root);
  const files = treeFiles(tree, []);

  const results = [];
  let budget = MAX_TOTAL_LINES;
  let truncated = false;

  for (const rel of files) {
    if (budget <= 0) {
      truncated = true;
      break;
    }

    const abs = path.join(root, toNative(rel));
    let source;
    try {
      const stat = await fsp.stat(abs);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_BYTES) continue; // too big to scan; the reader can open it
      source = await fsp.readFile(abs, 'utf8');
    } catch {
      continue; // vanished or unreadable since the tree was built
    }

    const matches = [];
    let best = 0;
    const lines = source.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i].normalize('NFC');
      const folded = [...text].map(foldChar);
      const offsets = matchOffsets(folded, queryCps);
      if (offsets.length === 0) continue;

      let line = HEADING_RE.test(text) ? IN_HEADING : 0;
      if (offsets.some((o) => o === 0 || !WORDISH.test(folded[o - 1]))) line += AT_BOUNDARY;
      best = Math.max(best, line);

      const ranges = offsets.map((o) => [o, o + queryCps.length]);
      matches.push({ line: i + 1, text, ranges });

      if (matches.length >= MAX_MATCHES_PER_FILE) {
        truncated = true;
        break;
      }
      if (--budget <= 0) break;
    }

    if (matches.length === 0) continue;

    const inPath = matchOffsets(fold(rel), queryCps).length > 0 ? IN_PATH : 0;
    const score = inPath + best + Math.min(matches.length, MOST_MATCHES) * PER_MATCH;
    results.push({ path: rel, matches, score });
  }

  // Stable, and treeFiles walked in the order the explorer shows, so files that
  // score alike come back in the order the reader already knows.
  //
  // This orders what was scanned, not the whole tree: the line budget above
  // breaks out of the file loop, so a query common enough to spend it leaves the
  // rest of the tree unread, and `truncated` is how the reader is told. A query
  // rare enough to be worth ranking never spends it, because a file with no
  // match costs a read and no budget.
  results.sort((a, b) => b.score - a.score);
  for (const r of results) delete r.score; // a rank, not part of the payload

  return { results, truncated };
}
