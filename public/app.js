const treeEl = document.getElementById('tree');
const searchEl = document.getElementById('search');
const searchNameBtn = document.getElementById('search-name');
const searchTextBtn = document.getElementById('search-text');
const docEl = document.getElementById('doc');
const tocEl = document.getElementById('toc');
const contentEl = document.getElementById('content');
const themeBtn = document.getElementById('theme');
const toggleLeftBtn = document.getElementById('toggle-left');
const toggleRightBtn = document.getElementById('toggle-right');

const editorEl = document.getElementById('editor');
const bannerEl = document.getElementById('banner');
const pathEl = document.getElementById('doc-path');
const dirtyEl = document.getElementById('dirty');
const saveStatusEl = document.getElementById('save-status');
const modeViewBtn = document.getElementById('mode-view');
const modeEditBtn = document.getElementById('mode-edit');
const saveBtn = document.getElementById('save');

const SPY_OFFSET = 80;
const TREE_POLL_MS = 10_000;
const MAX_REMEMBERED = 200;
const SAVED_FLASH_MS = 1500;

const state = {
  root: '',
  path: null,
  etag: null,
  activeId: null,
  headings: [],
  tree: null,
  query: '',
  searchMode: 'name', // 'name' filters paths on the client; 'text' searches contents on the server
  searchResults: null, // the last /api/search payload, so the 10s poll can re-render it
  events: null,
  eventsBroken: false,
  suppressSpy: false,

  treeEditing: false, // an inline input is open in the tree; renders are deferred
  renamePending: null, // old path of a rename in flight; its deletion event is ours

  mode: 'view', // 'view' | 'edit'
  readOnly: false,
  source: null, // the buffer as last read or written, so dirty is a comparison
  version: null, // content hash of what is on disk, and our optimistic lock
  eol: 'lf',
  saving: false,
  viewStale: false, // the rendered document behind the editor is out of date
};

let expanded = new Set();

const byId = (id) => docEl.querySelector(`[id="${CSS.escape(id)}"]`);
const urlFor = (rel, id) => `?path=${encodeURIComponent(rel)}${id ? `#${encodeURIComponent(id)}` : ''}`;
const parentDir = (rel) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

// Scroll memory ----------------------------------------------------------

/**
 * Where the reader was in each file, so switching back does not dump them at
 * the top. Keyed by path; insertion order doubles as a recency list.
 */
const positions = new Map();
let positionsLoaded = false;

const positionsKey = () => `mdx:scroll:${state.root}`;

function loadPositions() {
  if (positionsLoaded) return;
  positionsLoaded = true;
  try {
    const raw = sessionStorage.getItem(positionsKey());
    if (raw) for (const [rel, saved] of JSON.parse(raw)) positions.set(rel, saved);
  } catch {
    // Private mode can forbid storage. In-memory is a fine consolation.
  }
}

function savePositions() {
  if (!state.root) return; // no key yet; memory will do until the tree arrives
  try {
    sessionStorage.setItem(positionsKey(), JSON.stringify([...positions]));
  } catch {}
}

/** Snapshot the file we are about to leave. Call before state.path changes. */
function capturePosition() {
  if (!state.path) return;

  // In edit mode the document pane is display:none, so scrollTop and scrollHeight
  // both read 0. Capturing then would overwrite a real reading position with the
  // top of the file. pagehide fires here too: closing the tab mid-edit must not
  // erase where the reader was.
  if (state.mode === 'edit') return;

  positions.delete(state.path); // re-insert to move it to the recent end
  positions.set(state.path, {
    top: contentEl.scrollTop,
    height: contentEl.scrollHeight,
    id: state.activeId,
  });

  while (positions.size > MAX_REMEMBERED) positions.delete(positions.keys().next().value);
  savePositions();
}

// Theme -----------------------------------------------------------------

const currentTheme = () =>
  document.documentElement.dataset.theme ??
  (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

themeBtn.addEventListener('click', async () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('mdx:theme', next);
  } catch {}
  // Mermaid bakes its colours into the rendered SVG, so it has to run again. Not
  // while editing though: re-rendering the document would take the buffer with it.
  if (!docEl.querySelector('pre.mermaid, [data-processed]')) return;
  if (state.mode === 'edit') state.viewStale = true;
  else await reloadCurrent();
});

// Side drawers ------------------------------------------------------------

const PANE_LABEL = { left: 'explorer', right: 'outline' };
const PANE_KEY = { left: '[', right: ']' };

const readPanes = () => ({
  left: document.documentElement.dataset.left === 'closed' ? 'closed' : 'open',
  right: document.documentElement.dataset.right === 'closed' ? 'closed' : 'open',
});

function applyPanes(panes) {
  for (const [side, button] of [
    ['left', toggleLeftBtn],
    ['right', toggleRightBtn],
  ]) {
    const open = panes[side] === 'open';
    if (open) delete document.documentElement.dataset[side];
    else document.documentElement.dataset[side] = 'closed';

    const label = `${open ? 'Collapse' : 'Expand'} the ${PANE_LABEL[side]}`;
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', label);
    button.title = `${label}  ${PANE_KEY[side]}`;
  }

  try {
    localStorage.setItem('mdx:panes', JSON.stringify(panes));
  } catch {}
}

function togglePane(side) {
  const panes = readPanes();
  panes[side] = panes[side] === 'open' ? 'closed' : 'open';
  applyPanes(panes);

  // The content pane just changed width, and scrollspy only measures on scroll.
  // Nothing would recompute the highlight until the reader moved.
  setTimeout(updateSpy, 200);
}

toggleLeftBtn.addEventListener('click', () => togglePane('left'));
toggleRightBtn.addEventListener('click', () => togglePane('right'));

addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (!lightboxEl.hidden) return; // `e` must not open the editor under the overlay
  const el = event.target;
  if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;

  if (event.key === '[') togglePane('left');
  else if (event.key === ']') togglePane('right');
  else if (event.key === '/') focusSearch();
  else return;
  event.preventDefault();
});

applyPanes(readPanes()); // sync the buttons with what the inline script decided

// Mermaid ---------------------------------------------------------------

let mermaidLoader = null;

function loadMermaid() {
  mermaidLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/static/vendor/mermaid.min.js';
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => reject(new Error('mermaid failed to load'));
    document.head.append(script);
  });
  return mermaidLoader;
}

/** Only fetches the 3.5MB bundle for documents that actually contain a diagram. */
async function renderMermaid() {
  const nodes = docEl.querySelectorAll('pre.mermaid');
  if (nodes.length === 0) return;

  try {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      theme: currentTheme() === 'dark' ? 'dark' : 'default',
      securityLevel: 'strict',
    });
    await mermaid.run({ nodes });
  } catch {
    // A diagram that will not parse should not take the document down with it.
  }
}

// Copy buttons -----------------------------------------------------------

const COPIED_FLASH_MS = 1200;
const copyTimers = new WeakMap();

/**
 * A copy button on every code block and every diagram.
 *
 * Two constraints, both measured against the running page, and both the reason
 * this wraps rather than just appending a button to the <pre>.
 *
 * The button cannot live inside the <pre>. The <pre> is the horizontal scroll
 * container, so an absolutely positioned child of it scrolls away with the code
 * the moment the reader drags a long line sideways. And mermaid reads the
 * element's textContent as the diagram definition, so a button in there would
 * put the word "Copy" into the graph.
 *
 * This must run before renderMermaid. mermaid.run replaces the element's content
 * with the rendered SVG and the diagram source is gone for good, so it is taken
 * here, while it is still there. The <pre> itself survives with its attributes,
 * which is why the dataset is a safe place to keep it.
 */
function decorateCodeBlocks() {
  for (const pre of docEl.querySelectorAll('pre')) {
    const isDiagram = pre.classList.contains('mermaid');
    if (isDiagram) pre.dataset.source = pre.textContent;

    const block = document.createElement('div');
    block.className = 'code-block';
    pre.replaceWith(block);
    block.append(pre);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', isDiagram ? 'Copy the diagram source' : 'Copy the code');
    block.append(button);
  }
}

function sourceOf(block) {
  const pre = block.querySelector('pre');
  const text = pre.classList.contains('mermaid')
    ? (pre.dataset.source ?? '') // stashed before mermaid ate it
    : (pre.querySelector('code') ?? pre).textContent;

  // A fence always leaves one newline at the end. Nobody wants to paste it.
  return text.replace(/\n$/, '');
}

/**
 * navigator.clipboard exists only in a secure context. localhost is one, so the
 * default setup is fine. The machine on the other side of --host or --allow-host
 * is not, and those flags exist precisely so somebody reads this from another
 * machine. Without the fallback the button would do nothing at all, in silence,
 * for exactly the people who asked for that setup.
 */
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // no permission; the old way still works
    }
  }

  const staging = document.createElement('textarea');
  staging.value = text;
  staging.setAttribute('readonly', '');
  staging.style.position = 'fixed';
  staging.style.top = '0';
  staging.style.opacity = '0';
  document.body.append(staging);
  staging.select();

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    staging.remove();
  }
}

async function onCopy(button) {
  const ok = await copyText(sourceOf(button.closest('.code-block')));

  button.textContent = ok ? 'Copied' : 'Failed';
  button.classList.toggle('copied', ok);

  clearTimeout(copyTimers.get(button));
  copyTimers.set(
    button,
    setTimeout(() => {
      button.textContent = 'Copy';
      button.classList.remove('copied');
    }, COPIED_FLASH_MS),
  );
}

// Lightbox ---------------------------------------------------------------

/**
 * The overlay lives outside #doc, so a live reload or theme repaint replacing
 * the document cannot take it down. What it shows is its own copy: a fresh
 * <img> on the same src, or a deep clone of a mermaid SVG. The clone's
 * url(#id) references still resolve against the original SVG's defs, which is
 * fine exactly because the original is still in the DOM behind the overlay.
 *
 * Fit mode scales to ~92% of the viewport: an image never above its natural
 * size (upscaled pixels are just blur), a diagram freely (vectors stay crisp).
 * When the natural size is larger than the fit, a click zooms to natural
 * pixels and the overlay scrolls to pan, centred on the point that was
 * clicked. Otherwise there is nothing to zoom and a click closes.
 */
const lightboxEl = document.createElement('div');
lightboxEl.id = 'lightbox';
lightboxEl.hidden = true;
document.body.append(lightboxEl);

let lightboxFull = { width: 0, height: 0 };

function sizeLightbox() {
  const media = lightboxEl.firstElementChild;
  if (!media) return;
  const { width, height } = lightboxFull;

  let scale = Math.min((innerWidth * 0.92) / width, (innerHeight * 0.92) / height);
  if (!(media instanceof SVGSVGElement)) scale = Math.min(1, scale);
  lightboxEl.classList.toggle('zoomable', scale < 1);

  const zoomed = lightboxEl.classList.contains('zoomed');
  media.style.width = `${zoomed ? width : width * scale}px`;
  media.style.height = `${zoomed ? height : height * scale}px`;
}

function closeLightbox() {
  lightboxEl.hidden = true;
  lightboxEl.classList.remove('zoomed');
  lightboxEl.replaceChildren();
  removeEventListener('keydown', onLightboxKey);
}

function onLightboxKey(event) {
  if (event.key !== 'Escape') return;
  closeLightbox();
  // Scoped: added on open, removed on close, so it never joins the
  // registration-order contest the ctx-menu Escape handler documents.
  event.stopImmediatePropagation();
}

function openLightbox(node) {
  let media;
  if (node instanceof SVGSVGElement) {
    media = node.cloneNode(true);
    media.style.maxWidth = ''; // mermaid pins one; the overlay sizes the clone itself
    const box = node.viewBox.baseVal;
    lightboxFull = box?.width
      ? { width: box.width, height: box.height }
      : { width: node.clientWidth, height: node.clientHeight };
  } else {
    media = document.createElement('img');
    media.src = node.currentSrc || node.src;
    media.alt = node.alt;
    lightboxFull = { width: node.naturalWidth, height: node.naturalHeight };
  }

  lightboxEl.classList.remove('zoomed');
  lightboxEl.replaceChildren(media);
  lightboxEl.hidden = false;
  sizeLightbox();
  addEventListener('keydown', onLightboxKey);
}

lightboxEl.addEventListener('click', (event) => {
  const media = lightboxEl.firstElementChild;
  if (!media || !media.contains(event.target)) return closeLightbox(); // backdrop

  if (lightboxEl.classList.contains('zoomed')) {
    lightboxEl.classList.remove('zoomed');
    sizeLightbox();
    return;
  }
  if (!lightboxEl.classList.contains('zoomable')) return closeLightbox();

  // Zoom to natural pixels, keeping the clicked point in the middle.
  const rect = media.getBoundingClientRect();
  const rx = (event.clientX - rect.left) / rect.width;
  const ry = (event.clientY - rect.top) / rect.height;
  lightboxEl.classList.add('zoomed');
  sizeLightbox();
  lightboxEl.scrollLeft = rx * lightboxFull.width - lightboxEl.clientWidth / 2;
  lightboxEl.scrollTop = ry * lightboxFull.height - lightboxEl.clientHeight / 2;
});

addEventListener('resize', () => {
  if (!lightboxEl.hidden) sizeLightbox();
});

// Filtering the tree -------------------------------------------------------

/**
 * One code point in, one code point out: lower case, and stripped of its accents.
 *
 * The array is the point. Keeping the folded text aligned with the original,
 * character for character, is what lets a match index found in the folded path be
 * used to embolden a letter of the name the reader is actually looking at.
 * NFC first, because a filename read off macOS arrives decomposed, and there "é"
 * is two code points rather than one.
 *
 * Note this is the exact opposite of the rule in paths.js, which must never
 * normalise, because on ext4 the two spellings of café.md are two different
 * files. The difference is that nothing here ever opens anything: it compares
 * text for the reader's eyes, and the path used to fetch the file is untouched.
 * Which is also why someone typing "tai lieu" finds tài-liệu.md, as they should.
 */
const foldChar = (c) => {
  const base = c.normalize('NFD').replace(/\p{Diacritic}/gu, '') || c;
  const lower = base.toLowerCase();
  return [...lower].length === 1 ? lower : base; // İ lowercases to two; keep the count
};

const fold = (text) => [...text.normalize('NFC')].map(foldChar);

/** Subsequence match. The indices it hits, or null for no match at all. */
function fuzzyMatch(query, text) {
  const hits = [];
  let i = 0;
  for (const wanted of query) {
    while (i < text.length && text[i] !== wanted) i++;
    if (i === text.length) return null;
    hits.push(i++);
  }
  return hits;
}

/**
 * Prune to what matches, keeping the shape of the tree.
 *
 * Matching runs against the whole path, so "dcgui" finds docs/guide.md and
 * "docs" narrows to a directory without either being a special case. A directory
 * survives if anything under it did, which is the same rule tree.js already
 * applies on the server to hide branches with no markdown in them.
 */
function filterNode(node, query) {
  if (node.type === 'file') {
    const hits = fuzzyMatch(query, fold(node.path));
    return hits ? { ...node, hits } : null;
  }
  const children = node.children.map((child) => filterNode(child, query)).filter(Boolean);
  return children.length > 0 ? { ...node, children } : null;
}

/** The name, with the letters that earned the match picked out. */
function labelFor(node) {
  const chars = [...node.name.normalize('NFC')];
  if (!node.hits) return document.createTextNode(node.name);

  // The hits index into the folded *path*; the name is its tail, and folding
  // preserved the count, so the offset is just the difference in length.
  const start = fold(node.path).length - chars.length;
  const inName = new Set(node.hits.filter((h) => h >= start).map((h) => h - start));

  const frag = document.createDocumentFragment();
  let run = '';
  let runIsHit = false;

  const flush = () => {
    if (!run) return;
    if (runIsHit) {
      const mark = document.createElement('mark');
      mark.textContent = run; // never innerHTML: a filename is data off the disk
      frag.append(mark);
    } else {
      frag.append(run);
    }
    run = '';
  };

  chars.forEach((char, i) => {
    if (inName.has(i) !== runIsHit) {
      flush();
      runIsHit = !runIsHit;
    }
    run += char;
  });
  flush();

  return frag;
}

// Explorer --------------------------------------------------------------

const expandedKey = () => `mdx:expanded:${state.root}`;

function saveExpanded() {
  try {
    localStorage.setItem(expandedKey(), JSON.stringify([...expanded]));
  } catch {}
}

function loadExpanded(tree) {
  try {
    const raw = localStorage.getItem(expandedKey());
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set(tree.children.filter((n) => n.type === 'dir').map((n) => n.path));
}

function treeNode(node, depth, filtering) {
  const indent = `${8 + depth * 12}px`;

  if (node.type === 'file') {
    const link = document.createElement('a');
    link.className = 'file';
    link.href = urlFor(node.path);
    link.dataset.path = node.path;
    link.draggable = true; // dragged onto a directory to move it there
    link.style.paddingLeft = indent;
    link.append(labelFor(node));
    return link;
  }

  const details = document.createElement('details');
  details.dataset.path = node.path; // the inline "new file" input finds its directory by this
  details.open = filtering || expanded.has(node.path);

  const summary = document.createElement('summary');
  summary.style.paddingLeft = indent;
  summary.textContent = node.name; // no marks here: one row, many files, many matches
  details.append(summary);

  for (const child of node.children) details.append(treeNode(child, depth + 1, filtering));

  details.addEventListener('toggle', () => {
    // A filtered tree is open because the filter opened it, not because the
    // reader asked for it, and remembering that would be remembering a lie.
    //
    // This guard is not decoration. The toggle event is queued rather than fired
    // in place, so even the `open` set above, before this listener existed, still
    // arrives here. Without it, one keystroke in the filter box would rewrite
    // which directories the reader had open, in localStorage, for good.
    //
    // `filtering` is captured rather than read off state, so the answer cannot
    // change between the render that opened the node and the task that reports it.
    if (filtering) return;

    if (details.open) expanded.add(node.path);
    else expanded.delete(node.path);
    saveExpanded();
  });

  return details;
}

function renderTree() {
  // Content search shares this pane, and shares the 10s poll's call into here, so
  // its results re-render harmlessly on a poll just as the tree does.
  if (state.searchMode === 'text') return renderSearchResults();

  const tree = state.tree;
  if (!tree) return;

  const query = fold(state.query.replace(/\s+/g, ''));
  const filtering = query.length > 0;
  const children = filtering
    ? tree.children.map((n) => filterNode(n, query)).filter(Boolean)
    : tree.children;

  if (children.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pane-empty';
    empty.textContent = filtering ? 'No files match.' : 'No markdown files here.';
    treeEl.replaceChildren(empty);
    return;
  }

  treeEl.replaceChildren(...children.map((n) => treeNode(n, 0, filtering)));
}

function markActiveFile(rel) {
  // The tab bar highlights the same file the tree does, and this is the one
  // place every load already passes through.
  for (const tab of tabbarEl.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.path === rel);
  }

  for (const link of treeEl.querySelectorAll('a.file')) {
    link.classList.toggle('active', link.dataset.path === rel);
  }
  const active = treeEl.querySelector('a.file.active');
  if (!active) return;

  for (let el = active.parentElement; el && el !== treeEl; el = el.parentElement) {
    if (el.tagName === 'DETAILS') el.open = true;
  }
  active.scrollIntoView({ block: 'nearest' });
}

async function loadTree() {
  const headers = state.etag ? { 'If-None-Match': state.etag } : {};
  let res;
  try {
    res = await fetch('/api/tree', { headers });
  } catch {
    return; // server restarting; the next poll will pick it up
  }
  if (res.status === 304 || !res.ok) return;

  state.etag = res.headers.get('etag');
  const tree = await res.json();
  state.root = tree.root ?? tree.name;
  loadPositions(); // needs state.root for its key
  loadPins(); // same key discipline
  expanded = loadExpanded(tree);
  state.tree = tree; // kept, so a keystroke in the filter box costs no round trip

  // The tab bar lives outside #tree, so unlike the render below it is safe to
  // refresh even while an inline input holds the tree.
  prunePins(tree);

  // An inline input (new file, rename) lives inside #tree, and renderTree is
  // replaceChildren: applying this poll now would take the caret out from under
  // whoever is typing. The fresh tree is kept; the input's close re-renders it.
  if (state.treeEditing) return tree;

  renderTree();
  markActiveFile(state.path);
  return tree;
}

// Content search -----------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 200;
const MIN_SEARCH = 2; // one folded code point over a whole tree matches nearly everything

let searchGen = 0; // a newer keystroke's response wins; older ones bail, like loadFile
let searchTimer = null;

function showTreeMessage(text) {
  const p = document.createElement('p');
  p.className = 'pane-empty';
  p.textContent = text;
  treeEl.replaceChildren(p);
}

/** The matched line, with each hit range in a <mark>, from data off the disk. */
function appendHighlighted(el, text, ranges) {
  const cps = [...text];
  const hot = new Set();
  for (const [start, end] of ranges) for (let i = start; i < end; i++) hot.add(i);

  let run = '';
  let runIsHit = false;
  const flush = () => {
    if (!run) return;
    if (runIsHit) {
      const mark = document.createElement('mark');
      mark.textContent = run; // never innerHTML: this is file content, not markup
      el.append(mark);
    } else {
      el.append(document.createTextNode(run));
    }
    run = '';
  };

  cps.forEach((char, i) => {
    if (hot.has(i) !== runIsHit) {
      flush();
      runIsHit = !runIsHit;
    }
    run += char;
  });
  flush();
}

function renderSearchResults() {
  const query = searchEl.value.trim();
  if (fold(query).length < MIN_SEARCH) {
    return showTreeMessage('Type at least two characters to search file contents.');
  }
  const data = state.searchResults;
  if (!data) return showTreeMessage('Searching…');
  if (data.results.length === 0) return showTreeMessage('No matches.');

  const container = document.createElement('div');
  container.className = 'search-results';

  for (const file of data.results) {
    const head = document.createElement('a');
    head.className = 'search-file';
    head.href = urlFor(file.path);
    head.dataset.path = file.path;
    head.textContent = file.path;
    container.append(head);

    for (const m of file.matches) {
      const row = document.createElement('a');
      row.className = 'search-line';
      row.href = urlFor(file.path); // a real anchor, so ctrl/cmd-click opens a tab
      row.dataset.path = file.path;
      row.dataset.line = m.line;

      const num = document.createElement('span');
      num.className = 'search-lineno';
      num.textContent = m.line;

      const txt = document.createElement('span');
      txt.className = 'search-linetext';
      appendHighlighted(txt, m.text, m.ranges);

      row.append(num, txt);
      container.append(row);
    }
  }

  if (data.truncated) {
    const note = document.createElement('p');
    note.className = 'pane-empty search-note';
    note.textContent = 'Showing the first matches. Narrow the search to see more.';
    container.append(note);
  }

  treeEl.replaceChildren(container);
}

async function runTextSearch() {
  const query = searchEl.value.trim();
  if (fold(query).length < MIN_SEARCH) {
    state.searchResults = null;
    return renderTree();
  }

  const gen = ++searchGen;
  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return; // server restarting; the next keystroke retries
  }
  if (gen !== searchGen || state.searchMode !== 'text') return;

  state.searchResults = data;
  renderTree();
}

function scheduleTextSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runTextSearch, SEARCH_DEBOUNCE_MS);
}

function setSearchMode(mode) {
  if (state.searchMode === mode) return;
  state.searchMode = mode;
  searchNameBtn.setAttribute('aria-pressed', String(mode === 'name'));
  searchTextBtn.setAttribute('aria-pressed', String(mode === 'text'));
  searchEl.placeholder = mode === 'text' ? 'Search text' : 'Filter files';
  searchEl.setAttribute('aria-label', mode === 'text' ? 'Search text' : 'Filter files');
  state.searchResults = null;

  renderTree();
  if (mode === 'text') scheduleTextSearch();
  else markActiveFile(state.path);
}

searchNameBtn.addEventListener('click', () => setSearchMode('name'));
searchTextBtn.addEventListener('click', () => setSearchMode('text'));

/** The nearest heading at or above a source line, so a hit opens on its section. */
function nearestHeadingId(headings, line) {
  let id = null;
  for (const h of headings) {
    if (h.line <= line) id = h.id;
    else break; // collect_headings emits them in document order, so lines ascend
  }
  return id;
}

// The filter box ----------------------------------------------------------

function applyQuery(value) {
  closeTreeInput({ render: false }); // the render two lines down would eat it anyway
  state.query = value;
  searchEl.value = value;
  renderTree();
  markActiveFile(state.path);
}

function focusSearch() {
  // The box is display:none behind a collapsed rail, and nothing can focus that.
  const panes = readPanes();
  if (panes.left === 'closed') {
    panes.left = 'open';
    applyPanes(panes);
  }
  searchEl.focus();
  searchEl.select();
}

searchEl.addEventListener('input', () => {
  if (state.searchMode === 'text') {
    state.query = searchEl.value;
    renderTree(); // reflect the box now (hint, or the previous results while the fetch runs)
    scheduleTextSearch();
    return;
  }
  applyQuery(searchEl.value);
});

searchEl.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (searchEl.value) applyQuery('');
    else searchEl.blur();
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();
    openTreeLink(treeEl.querySelector('a.search-line, a.search-file, a.file'));
  }
});

/** Open a tree or search-result anchor, jumping to its line's section when it has one. */
function openTreeLink(link) {
  if (!link) return;
  const rel = link.dataset.path;
  const line = link.dataset.line ? Number(link.dataset.line) : null;
  if (rel === state.path && line === null) return; // already here, nowhere in particular to go
  if (!mayDiscard()) return;
  // dataset.line is 1-based for the reader; heading lines are 0-based file lines.
  loadFile(rel, line === null ? {} : { targetLine: line - 1 });
}

treeEl.addEventListener('click', (event) => {
  // Leave the href alone for modified clicks: open-in-new-tab and copy-link
  // are the reason the tree renders real anchors in the first place.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest('a.file, a.search-line, a.search-file');
  if (!link) return;

  event.preventDefault();
  openTreeLink(link);
});

// Pinned files ---------------------------------------------------------------

const tabbarEl = document.getElementById('tabbar');

/**
 * The files the reader asked to keep at hand, as tabs above the mode bar.
 * Order is pin order. The list is a set of bookmarks, not open buffers:
 * unpinning the file on screen removes its tab and nothing else.
 */
let pins = [];
let pinsLoaded = false;

const pinsKey = () => `mdx:pins:${state.root}`;

function loadPins() {
  if (pinsLoaded) return;
  pinsLoaded = true;
  try {
    const raw = localStorage.getItem(pinsKey());
    if (raw) pins = JSON.parse(raw).filter((rel) => typeof rel === 'string');
  } catch {}
}

function savePins() {
  try {
    localStorage.setItem(pinsKey(), JSON.stringify(pins));
  } catch {}
}

const isPinned = (rel) => pins.includes(rel);

function pinFile(rel) {
  if (isPinned(rel)) return;
  pins.push(rel);
  savePins();
  renderTabs();
}

function unpinFile(rel) {
  const at = pins.indexOf(rel);
  if (at === -1) return;
  pins.splice(at, 1);
  savePins();
  renderTabs();
}

/** Basename alone, until two pins share one; then each shows its parent too. */
function tabLabel(rel) {
  const name = rel.split('/').pop();
  if (pins.filter((p) => p.split('/').pop() === name).length === 1) return name;
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')).split('/').pop() : '';
  return parent ? `${parent}/${name}` : name;
}

function renderTabs() {
  const wasHidden = tabbarEl.hidden;
  tabbarEl.hidden = pins.length === 0;

  tabbarEl.replaceChildren(
    ...pins.map((rel) => {
      const tab = document.createElement('div');
      tab.className = 'tab';
      tab.dataset.path = rel;
      tab.classList.toggle('active', rel === state.path);

      // A real anchor, same as the tree: open-in-new-tab and copy-link keep working.
      const link = document.createElement('a');
      link.className = 'tab-link';
      link.href = urlFor(rel);
      link.title = rel; // the full path, whatever the label had room for
      link.textContent = tabLabel(rel);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Unpin';
      close.setAttribute('aria-label', `Unpin ${rel}`);

      tab.append(link, close);
      return tab;
    }),
  );

  // The bar appearing or vanishing reflows #content, and no scroll event fires
  // for a reflow. Same rule, same delay, as the drawer toggles.
  if (wasHidden !== tabbarEl.hidden) setTimeout(updateSpy, 200);
}

/**
 * A pin whose file has left the tree (deleted, or renamed by another tool) is
 * dropped, from the bar and from storage, so no tab ever points at a 404. A
 * rename made through this app never gets here: renameTo moves the pin to the
 * new name before it refreshes the tree.
 */
function prunePins(tree) {
  const present = new Set();
  (function visit(node) {
    if (node.type === 'file') present.add(node.path);
    else node.children.forEach(visit);
  })(tree);

  const kept = pins.filter((rel) => present.has(rel));
  if (kept.length !== pins.length) {
    pins = kept;
    savePins();
  }
  renderTabs();
}

tabbarEl.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const close = event.target.closest('button.tab-close');
  if (close) {
    unpinFile(close.closest('.tab').dataset.path);
    return;
  }

  const link = event.target.closest('a.tab-link');
  if (!link) return;
  event.preventDefault();

  const rel = link.closest('.tab').dataset.path;
  if (rel === state.path || !mayDiscard()) return;
  loadFile(rel);
});

// New file and rename ------------------------------------------------------

/** Client-side copy of the server's MARKDOWN_RE, for appending .md before asking. */
const MD_EXT_RE = /\.(md|markdown|mdown|mkd)$/i;

const menuEl = document.createElement('div');
menuEl.id = 'ctx-menu';
menuEl.hidden = true;
document.body.append(menuEl);

function closeMenu() {
  menuEl.hidden = true;
  menuEl.replaceChildren();
}

function openMenu(x, y, items) {
  menuEl.replaceChildren(
    ...items.map(({ label, run }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        closeMenu();
        run();
      });
      return button;
    }),
  );
  menuEl.hidden = false;

  // Position after it has a size, so the clamp measures the real thing.
  menuEl.style.left = `${Math.max(0, Math.min(x, innerWidth - menuEl.offsetWidth - 4))}px`;
  menuEl.style.top = `${Math.max(0, Math.min(y, innerHeight - menuEl.offsetHeight - 4))}px`;
}

addEventListener('pointerdown', (event) => {
  if (!menuEl.hidden && !menuEl.contains(event.target)) closeMenu();
});
addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || menuEl.hidden) return;
  closeMenu();
  // Registered before the editor's own Escape handler, so this stops one press
  // from closing the menu and throwing the reader out of edit mode in one go.
  event.stopImmediatePropagation();
});
addEventListener('blur', closeMenu);
addEventListener('scroll', closeMenu, true);
addEventListener('resize', closeMenu);

treeEl.addEventListener('contextmenu', (event) => {
  const link = event.target.closest('a.file');

  // Pinning never writes to the server, so it survives --read-only; the write
  // operations do not. A read-only menu anywhere but a file row would be empty,
  // and there the browser's own menu is more honest.
  if (state.readOnly && !link) return;
  event.preventDefault();

  const summary = event.target.closest('summary');
  const items = [];

  if (link) {
    const rel = link.dataset.path;
    if (!state.readOnly) {
      const dir = parentDir(rel);
      items.push({ label: 'New file', run: () => startCreate(dir) });
      items.push({ label: 'New folder', run: () => startFolder(dir) });
      items.push({ label: 'Rename', run: () => startRename(rel) });
      items.push({ label: 'Duplicate', run: () => startDuplicate(rel) });
      items.push({ label: 'Delete', run: () => startDelete(rel) });
    }
    items.push(
      isPinned(rel)
        ? { label: 'Unpin', run: () => unpinFile(rel) }
        : { label: 'Pin', run: () => pinFile(rel) },
    );
  } else if (summary) {
    const dir = summary.parentElement.dataset.path;
    items.push({ label: 'New file', run: () => startCreate(dir) });
    items.push({ label: 'New folder', run: () => startFolder(dir) });
  } else {
    items.push({ label: 'New file', run: () => startCreate('') });
    items.push({ label: 'New folder', run: () => startFolder('') });
  }

  openMenu(event.clientX, event.clientY, items);
});

/**
 * The inline input lives inside #tree, which renderTree wipes with
 * replaceChildren on every poll that finds a change. While one of these is open,
 * loadTree keeps the fresh tree in state and does not render it; closing the
 * input (either way) is what applies the deferred render. That is the same
 * lesson the filter box learned, answered the other way round: the filter box
 * moved out of #tree, the input here belongs to a row and cannot.
 */
let treeInput = null; // { row, restore }

function closeTreeInput({ render = true } = {}) {
  if (!treeInput) return;
  const { row, restore } = treeInput;
  treeInput = null; // before row.remove(): removal blurs the input, and blur commits
  state.treeEditing = false;
  row.remove();
  restore?.();
  if (render) {
    renderTree(); // apply whatever the poll brought while the input was open
    markActiveFile(state.path);
  }
}

/**
 * One inline input, shared by create and rename.
 *
 * `commit` receives the final name (extension appended) and returns null when it
 * has taken over, or a message to show the reader. Enter shows failures inline;
 * blur treats any failure as a cancel, because holding focus hostage to an error
 * the reader has already clicked away from helps nobody.
 */
function openTreeInput({
  indentDepth,
  initial,
  place,
  commit,
  appendExt = true, // false for a folder name: nothing is appended
  sameIsCancel = true, // false for duplicate, where the prefilled name is the wanted one
  label = 'File name',
}) {
  closeTreeInput({ render: false });
  state.treeEditing = true;

  const row = document.createElement('div');
  row.className = 'tree-input-row';
  row.style.paddingLeft = `${8 + indentDepth * 12}px`;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tree-input';
  input.value = initial;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', label);

  const error = document.createElement('p');
  error.className = 'tree-input-error';
  error.hidden = true;

  row.append(input, error);
  const restore = place(row);
  treeInput = { row, restore };

  const fail = (message) => {
    error.textContent = message;
    error.hidden = false;
    input.disabled = false;
    input.focus();
  };

  let committing = false;
  const attempt = async (fromBlur = false) => {
    if (committing || treeInput?.row !== row) return;

    const name = input.value.trim();
    if (!name) return closeTreeInput();
    if (sameIsCancel && name === initial) return closeTreeInput();
    if (/[/\\]/.test(name)) {
      return fromBlur ? closeTreeInput() : fail('A name cannot contain slashes.');
    }

    committing = true;
    input.disabled = true; // also drops focus; the blur listener must not re-enter
    const finalName = appendExt && !MD_EXT_RE.test(name) ? `${name}.md` : name;
    const message = await commit(finalName);
    committing = false;

    if (message === null) return closeTreeInput({ render: false });
    if (fromBlur) return closeTreeInput();
    fail(message);
  };

  input.addEventListener('keydown', (event) => {
    event.stopPropagation(); // the app's shortcuts have no business firing from here
    if (event.key === 'Enter') attempt();
    else if (event.key === 'Escape') closeTreeInput();
  });
  input.addEventListener('blur', () => attempt(true));

  input.focus();
  // Renaming, the reader nearly always wants a new stem, not a new extension.
  const stem = initial.search(MD_EXT_RE);
  input.setSelectionRange(0, stem === -1 ? initial.length : stem);
}

/**
 * The <details> for `dir`, synthesizing a transient one under its nearest
 * existing ancestor when the tree has no node for it. A freshly created folder is
 * empty, and the tree prunes empty directories, so it has no node yet; this gives
 * the chained new-file input a home. The next loadTree renders the real
 * folder+file and discards the synthetic node.
 */
function ensureDirNode(dir) {
  if (dir === '') return null;
  const existing = treeEl.querySelector(`details[data-path="${CSS.escape(dir)}"]`);
  if (existing) return existing;

  const parentEl = ensureDirNode(parentDir(dir)); // up to the nearest real ancestor
  const depth = dir.split('/').length - 1;

  const details = document.createElement('details');
  details.dataset.path = dir;
  details.open = true;
  const summary = document.createElement('summary');
  summary.style.paddingLeft = `${8 + depth * 12}px`;
  summary.textContent = dir.split('/').pop();
  details.append(summary);

  if (parentEl) parentEl.querySelector('summary').after(details);
  else treeEl.prepend(details);
  return details;
}

function startCreate(dir) {
  // A filtered tree may not even show the target directory, and the input row
  // should appear where the file will. The filter has done its job by now.
  if (state.query) applyQuery('');

  openTreeInput({
    indentDepth: dir === '' ? 0 : dir.split('/').length,
    initial: '',
    place: (row) => {
      const details = ensureDirNode(dir);
      if (!details) {
        treeEl.prepend(row);
        return null;
      }
      // Deliberately remembered open, the same licence markActiveFile has:
      // asking to create a file in a directory is a reason to keep it open.
      for (let el = details; el && el !== treeEl; el = el.parentElement) {
        if (el.tagName === 'DETAILS') el.open = true;
      }
      details.querySelector('summary').after(row);
      return null;
    },
    commit: async (name) => {
      const rel = dir ? `${dir}/${name}` : name;

      let res;
      try {
        res = await fetch(`/api/file?path=${encodeURIComponent(rel)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch {
        return 'Lost the server.';
      }
      if (res.status === 409) return 'A file with this name already exists.';
      if (!res.ok) return `Could not create the file (${res.status}).`;

      closeTreeInput({ render: false });
      await loadTree();
      if (mayDiscard()) {
        await loadFile(rel);
        enterEdit(); // an empty document has nothing worth viewing
      }
      return null;
    },
  });
}

/**
 * Create a directory. Because empty directories are pruned from the tree, a new
 * folder is invisible until it holds a file, so this chains straight into a new
 * file inside it: ensureDirNode synthesizes a home for that input, and the file's
 * creation is what makes the whole thing appear.
 */
function startFolder(dir) {
  if (state.query) applyQuery('');

  openTreeInput({
    indentDepth: dir === '' ? 0 : dir.split('/').length,
    initial: '',
    appendExt: false, // a folder name is not a markdown file
    label: 'Folder name',
    place: (row) => {
      const details = ensureDirNode(dir);
      if (!details) {
        treeEl.prepend(row);
        return null;
      }
      for (let el = details; el && el !== treeEl; el = el.parentElement) {
        if (el.tagName === 'DETAILS') el.open = true;
      }
      details.querySelector('summary').after(row);
      return null;
    },
    commit: async (name) => {
      const rel = dir ? `${dir}/${name}` : name;

      let res;
      try {
        res = await fetch(`/api/folder?path=${encodeURIComponent(rel)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
      } catch {
        return 'Lost the server.';
      }
      if (res.status === 409) return 'A folder with this name already exists.';
      if (!res.ok) return `Could not create the folder (${res.status}).`;

      // Chain into a new file inside the folder, so the (otherwise invisible)
      // empty folder appears with its first file. A macrotask, so it opens after
      // openTreeInput's own closeTreeInput has torn this input down: opening it
      // inline would have that teardown close the new input straight away.
      setTimeout(() => startCreate(rel), 0);
      return null;
    },
  });
}

/** guide.md -> guide-copy.md, then guide-copy-2.md, avoiding what the folder holds. */
function siblingNames(dir) {
  let node = state.tree;
  if (!node) return new Set();
  if (dir !== '') {
    for (const seg of dir.split('/')) {
      node = node.children?.find((c) => c.type === 'dir' && c.name === seg);
      if (!node) return new Set();
    }
  }
  return new Set((node.children ?? []).map((c) => c.name));
}

function suggestCopyName(name, dir) {
  const ext = (name.match(MD_EXT_RE) ?? ['.md'])[0];
  const stem = name.slice(0, name.length - ext.length);
  const taken = siblingNames(dir);
  let candidate = `${stem}-copy${ext}`;
  for (let n = 2; taken.has(candidate); n++) candidate = `${stem}-copy-${n}${ext}`;
  return candidate;
}

/** Copy a file to a sibling name. The prefilled suggestion is the wanted name, so
 * keeping it commits (sameIsCancel: false), unlike a rename. */
function startDuplicate(rel) {
  const dir = parentDir(rel);
  const link = treeEl.querySelector(`a.file[data-path="${CSS.escape(rel)}"]`);

  openTreeInput({
    indentDepth: dir === '' ? 0 : dir.split('/').length,
    initial: suggestCopyName(rel.split('/').pop(), dir),
    sameIsCancel: false,
    place: (row) => {
      if (link) {
        link.after(row);
        return null;
      }
      treeEl.prepend(row);
      return null;
    },
    commit: async (name) => {
      const to = dir ? `${dir}/${name}` : name;

      let res;
      try {
        res = await fetch('/api/duplicate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: rel, to }),
        });
      } catch {
        return 'Lost the server.';
      }
      if (res.status === 409) return 'A file with this name already exists.';
      if (!res.ok) return `Could not duplicate (${res.status}).`;

      closeTreeInput({ render: false });
      await loadTree();
      if (mayDiscard()) await loadFile(to);
      return null;
    },
  });
}

/**
 * Delete a file, behind a confirmation. The pin and the reading position go with
 * it, and if it is the open file the pane is emptied: announcing a file the reader
 * just removed as "deleted" through the live stream would be absurd, so the stream
 * is closed and the path cleared before its own deletion event can arrive.
 */
function startDelete(rel) {
  showBanner(`Delete ${rel.split('/').pop()}? This cannot be undone.`, [
    {
      label: 'Delete',
      run: () => {
        hideBanner();
        deleteFile(rel);
      },
    },
    { label: 'Cancel', run: hideBanner },
  ]);
}

async function deleteFile(rel) {
  let res;
  try {
    res = await fetch(`/api/file?path=${encodeURIComponent(rel)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return showBanner('Lost the server.', [{ label: 'OK', run: hideBanner }]);
  }
  if (!res.ok) {
    return showBanner(`Could not delete (${res.status}).`, [{ label: 'OK', run: hideBanner }]);
  }

  positions.delete(rel);
  savePositions();
  const pinAt = pins.indexOf(rel);
  if (pinAt !== -1) {
    pins.splice(pinAt, 1);
    savePins();
  }

  if (state.path === rel) {
    state.events?.close();
    state.events = null;
    state.path = null;
    if (state.mode === 'edit') {
      state.mode = 'view';
      applyMode();
    }
    history.replaceState({}, '', location.pathname);
    refreshModebar();
    showNotice('<p>Pick a file on the left.</p>');
  }

  await loadTree();
}

function startRename(rel) {
  // A dirty buffer must never end up pointed at a path that no longer exists,
  // so the one file that cannot be renamed is the one with unsaved changes.
  if (rel === state.path && isDirty()) {
    return showBanner('Save or discard your changes before renaming this file.', [
      { label: 'OK', run: hideBanner },
    ]);
  }

  const link = treeEl.querySelector(`a.file[data-path="${CSS.escape(rel)}"]`);
  if (!link) return;

  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

  openTreeInput({
    indentDepth: dir === '' ? 0 : dir.split('/').length,
    initial: rel.split('/').pop(),
    place: (row) => {
      // style.display, not hidden: the stylesheet's display:block wins over [hidden]
      link.style.display = 'none';
      link.before(row);
      return () => {
        link.style.display = '';
      };
    },
    commit: (name) => renameTo(rel, dir ? `${dir}/${name}` : name),
  });
}

/**
 * Move the client state a file carries when it changes name or directory: its
 * reading position, its pin, and - if it is the open file - the path, the url and
 * the live stream. Shared by rename and move, which differ only in how the server
 * builds the destination.
 */
function applyRelocated(from, newRel) {
  // The reading position belongs to the document, and the document just moved.
  const saved = positions.get(from);
  if (saved) {
    positions.delete(from);
    positions.set(newRel, saved);
    savePositions();
  }

  // So does its pin, and it has to move before the loadTree that follows: the
  // prune there drops any pin absent from the tree, which the old name now is.
  const pinAt = pins.indexOf(from);
  if (pinAt !== -1) {
    pins[pinAt] = newRel;
    savePins();
  }

  if (state.path === from) {
    state.path = newRel;
    history.replaceState({ path: newRel }, '', urlFor(newRel, state.activeId));
    refreshModebar(); // the path label on the mode bar
    connectEvents(newRel); // and only now is the old stream, still named `from`, let go
  }
}

/**
 * POST a rename or a move: both send { from, to, version } and both come back as
 * a deletion of the old name on the live stream, which renamePending swallows.
 *
 * @returns {Promise<{ newRel: string } | { error: string }>}
 */
async function relocate(from, to, endpoint) {
  // The same optimistic lock a save uses. The editor already holds the version
  // it is editing against; for everything else, ask.
  let version;
  if (from === state.path && state.mode === 'edit') {
    version = state.version;
  } else {
    try {
      version = (await fetchRaw(from)).version;
    } catch {
      return { error: 'This file is gone from disk.' };
    }
  }

  state.renamePending = from; // the old stream will report this as a deletion
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, version }),
    });
  } catch {
    state.renamePending = null;
    return { error: 'Lost the server.' };
  }

  if (!res.ok) {
    state.renamePending = null;
    const verb = endpoint === '/api/move' ? 'move' : 'rename';
    if (res.status !== 409) return { error: `Could not ${verb} (${res.status}).` };
    const { error } = await res.json();
    if (error === 'exists') return { error: 'A file with this name already exists.' };
    if (error === 'missing') return { error: 'This file is gone from disk.' };
    return { error: 'This file changed on disk. Close and try again.' };
  }

  const { path: newRel } = await res.json();
  applyRelocated(from, newRel);
  state.renamePending = null;
  return { newRel };
}

/** @returns {Promise<string|null>} null on success, a message for the reader otherwise */
async function renameTo(from, to) {
  const result = await relocate(from, to, '/api/rename');
  if (result.error) return result.error;

  closeTreeInput({ render: false });
  await loadTree();
  return null;
}

/** Move a file into another directory, keeping its name. Driven by a drop, not an
 * inline input, so it raises its own banner on failure. */
async function moveTo(from, destDir) {
  // A dirty buffer must never end up pointed at a path that moved, the same rule
  // rename holds. dragstart already refuses, but a drop can still arrive.
  if (from === state.path && isDirty()) {
    return showBanner('Save or discard your changes before moving this file.', [
      { label: 'OK', run: hideBanner },
    ]);
  }

  const to = destDir ? `${destDir}/${from.split('/').pop()}` : from.split('/').pop();
  const result = await relocate(from, to, '/api/move');
  if (result.error) {
    return showBanner(result.error, [{ label: 'OK', run: hideBanner }]);
  }
  await loadTree();
}

// Move a file by dragging it onto a directory --------------------------------

let dragSrc = null; // path of the file being dragged, or null
let dropTargetEl = null; // the summary/tree element currently highlighted

function clearDropTarget() {
  dropTargetEl?.classList.remove('drop-target');
  dropTargetEl = null;
}

/** The directory a drop at `target` lands in: a summary's own, a file row's
 * parent, or the root for the tree background. */
function dropDir(target) {
  const summary = target.closest('summary');
  if (summary) return summary.parentElement.dataset.path;
  const link = target.closest('a.file');
  if (link) return parentDir(link.dataset.path);
  return '';
}

treeEl.addEventListener('dragstart', (event) => {
  const link = event.target.closest('a.file');
  if (!link || state.readOnly) return;
  const rel = link.dataset.path;
  if (rel === state.path && isDirty()) {
    event.preventDefault(); // no dragging a file whose buffer would be orphaned
    return;
  }
  dragSrc = rel;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', rel); // some engines refuse a drag with no data
});

treeEl.addEventListener('dragend', () => {
  dragSrc = null;
  clearDropTarget();
});

treeEl.addEventListener('dragover', (event) => {
  if (dragSrc === null) return;
  const dest = dropDir(event.target);
  if (dest === parentDir(dragSrc)) return clearDropTarget(); // a no-op move: no drop here

  event.preventDefault(); // this is what makes the element a drop target
  event.dataTransfer.dropEffect = 'move';

  const el = dest === '' ? treeEl : treeEl.querySelector(`details[data-path="${CSS.escape(dest)}"] > summary`);
  if (el !== dropTargetEl) {
    clearDropTarget();
    dropTargetEl = el;
    el?.classList.add('drop-target');
  }
});

treeEl.addEventListener('dragleave', (event) => {
  // Only when the pointer leaves the tree, not when it crosses between rows.
  if (event.target === treeEl && !treeEl.contains(event.relatedTarget)) clearDropTarget();
});

treeEl.addEventListener('drop', (event) => {
  if (dragSrc === null) return;
  const from = dragSrc;
  const dest = dropDir(event.target);
  dragSrc = null;
  clearDropTarget();
  if (dest === parentDir(from)) return; // dropped back where it started

  event.preventDefault();
  moveTo(from, dest);
});

// Outline and scrollspy --------------------------------------------------

function renderOutline(headings) {
  if (headings.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pane-empty';
    empty.textContent = 'No headings.';
    tocEl.replaceChildren(empty);
    return;
  }

  tocEl.replaceChildren(
    ...headings.map((h) => {
      const link = document.createElement('a');
      link.href = `#${encodeURIComponent(h.id)}`;
      link.dataset.id = h.id;
      link.style.paddingLeft = `${8 + (h.level - 1) * 12}px`;
      link.textContent = h.text;
      return link;
    }),
  );
}

function setActive(id) {
  if (state.activeId === id) return;
  state.activeId = id;

  for (const link of tocEl.children) {
    link.classList?.toggle('active', link.dataset.id === id);
  }
  tocEl.querySelector('.active')?.scrollIntoView({ block: 'nearest' });

  // replaceState, never pushState: scrolling one long document would otherwise
  // stack dozens of history entries and make the back button useless.
  if (state.path) history.replaceState(history.state, '', urlFor(state.path, id));
}

function updateSpy() {
  const headings = docEl.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]');
  if (headings.length === 0) return;

  const line = contentEl.getBoundingClientRect().top + SPY_OFFSET;
  let active = headings[0];
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top > line) break;
    active = heading;
  }

  // A final section shorter than the viewport can never reach the line. Once the
  // pane is scrolled to the bottom, the last heading is the honest answer.
  const atBottom = contentEl.scrollTop + contentEl.clientHeight >= contentEl.scrollHeight - 2;
  if (atBottom) active = headings[headings.length - 1];

  setActive(active.id);
}

let spyQueued = false;
contentEl.addEventListener('scroll', () => {
  if (state.suppressSpy || spyQueued) return;
  spyQueued = true;
  requestAnimationFrame(() => {
    spyQueued = false;
    updateSpy();
  });
});

/** Resolve once the smooth scroll settles, whether or not `scrollend` exists. */
function onScrollSettled(callback) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    contentEl.removeEventListener('scrollend', finish);
    callback();
  };
  const timer = setTimeout(finish, 800);
  contentEl.addEventListener('scrollend', finish, { once: true });
}

function jumpTo(id) {
  const target = byId(id);
  if (!target) return;

  // Without this the outline flickers through every heading the smooth scroll
  // passes over on its way down.
  state.suppressSpy = true;
  setActive(id);
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  onScrollSettled(() => {
    state.suppressSpy = false;
    // Any scroll that happened inside the suppression window was swallowed, and
    // nothing else will fire to reconcile it. Recompute once, here.
    updateSpy();
  });
}

tocEl.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-id]');
  if (!link) return;
  event.preventDefault();
  jumpTo(link.dataset.id);
});

// Document ---------------------------------------------------------------

function showNotice(html) {
  docEl.innerHTML = `<div class="notice">${html}</div>`;
  tocEl.replaceChildren();
  state.activeId = null;
}

docEl.addEventListener('click', (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const copy = event.target.closest('button.copy');
  if (copy) {
    onCopy(copy);
    return;
  }

  // A linked image belongs to its link; a broken one has nothing to show.
  const img = event.target.closest('img');
  if (img && !img.closest('a') && img.naturalWidth) {
    openLightbox(img);
    return;
  }

  const diagram = event.target.closest('pre.mermaid');
  const svg = diagram?.hasAttribute('data-processed') && diagram.querySelector(':scope > svg');
  if (svg) {
    openLightbox(svg);
    return;
  }

  const internal = event.target.closest('a[data-md-link]');
  if (internal) {
    event.preventDefault();
    const url = new URL(internal.href, location.href);
    const rel = url.searchParams.get('path');
    const id = url.hash ? decodeURIComponent(url.hash.slice(1)) : null;
    if (rel) loadFile(rel, { targetId: id });
    return;
  }

  const anchor = event.target.closest('a[href^="#"]');
  if (anchor) {
    event.preventDefault();
    jumpTo(decodeURIComponent(anchor.getAttribute('href').slice(1)));
  }
});

const maxScroll = () => Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);

/**
 * Where to land, in order of how much we trust the source.
 *
 * A live reload (restoreRatio set) is a document that just changed under the
 * reader, so it keeps its own rule and the remembered position stays out of it.
 */
function applyScroll(rel, targetId, restoreRatio) {
  const target = targetId ? byId(targetId) : null;

  if (restoreRatio !== null) {
    if (target) target.scrollIntoView({ block: 'start' });
    else contentEl.scrollTop = restoreRatio * contentEl.scrollHeight;
    return;
  }

  const saved = positions.get(rel);
  // A hash we wrote ourselves on the way out agrees with what we remembered. An
  // anchor the reader actually asked for does not, and it wins.
  const trustSaved = saved && (!targetId || saved.id === targetId);

  if (trustSaved && saved.height === contentEl.scrollHeight) {
    contentEl.scrollTop = saved.top; // document unchanged: exact pixels
  } else if (target) {
    target.scrollIntoView({ block: 'start' });
  } else if (trustSaved && saved.id && byId(saved.id)) {
    byId(saved.id).scrollIntoView({ block: 'start' }); // document changed: the heading
  } else if (trustSaved) {
    contentEl.scrollTop = Math.min(saved.top, maxScroll());
  } else {
    contentEl.scrollTop = 0;
  }
}

/**
 * Two loads can be in flight at once: click a file, then click another before
 * the first one's fetch or mermaid render has finished. Whoever started last
 * owns the page, and the stragglers bail at their next checkpoint rather than
 * writing their document, their history entry and their scroll over the winner.
 */
let loadToken = 0;

/**
 * The order below is load-bearing.
 *
 * Mermaid renders asynchronously and changes the page height, so scrolling
 * before it finishes lands in the wrong place.
 *
 * pushState sits between them, and both sides matter. It has to come before
 * updateSpy, whose replaceState writes state.path into whatever entry is
 * current, which is otherwise still the previous document's. And it has to come
 * before the mermaid await, or a reader who hits back while a diagram is still
 * rendering goes back past the entry we had not created yet.
 *
 * decorateCodeBlocks also has to be on the near side of mermaid, for a different
 * reason: it is the last moment a diagram's source text still exists.
 */
async function loadFile(
  rel,
  { push = true, targetId = null, targetLine = null, restoreRatio = null, capture = true } = {},
) {
  const token = ++loadToken;
  if (capture) capturePosition(); // snapshot the file we are leaving, while state.path still names it

  // Opening a document is always a return to view mode. Note this runs after the
  // capture above, which the guard inside capturePosition depends on.
  if (state.mode === 'edit') {
    state.mode = 'view';
    applyMode();
  }

  let res;
  try {
    res = await fetch(`/api/file?path=${encodeURIComponent(rel)}`);
  } catch {
    return showNotice('<p>Lost the server.</p>');
  }
  if (token !== loadToken) return;

  if (!res.ok) {
    const message =
      res.status === 404
        ? `<p>${escapeHtml(rel)} is gone.</p>`
        : `<p>Could not open ${escapeHtml(rel)} (${res.status}).</p>`;
    return showNotice(message);
  }

  const data = await res.json();
  if (token !== loadToken) return;

  // A content-search hit lands on the section that holds it, using the source line
  // each heading already carries. An explicit anchor, if given, still wins.
  if (targetId === null && targetLine !== null) targetId = nearestHeadingId(data.headings, targetLine);

  state.path = rel;
  state.viewStale = false;
  document.title = `${data.title} · markdown-explorer`;
  refreshModebar();

  docEl.innerHTML = data.html; // 1. content in
  decorateCodeBlocks(); // 2. before mermaid, while the diagram source still exists
  state.headings = data.headings; // each carries its source line, for the jump into edit
  renderOutline(data.headings);
  markActiveFile(rel);

  if (push) history.pushState({ path: rel }, '', urlFor(rel, targetId)); // 3. own the entry

  if (data.hasMermaid) await renderMermaid(); // 4. heights settle
  if (token !== loadToken) return;

  applyScroll(rel, targetId, restoreRatio); // 5. only now, scroll

  state.activeId = null; // 6. and recompute the outline highlight
  updateSpy();

  connectEvents(rel);
}

/** Live reload: keep the reader where they were reading, not where they had scrolled. */
async function reloadCurrent() {
  if (!state.path) return;
  const anchor = state.activeId;
  const ratio = contentEl.scrollHeight > 0 ? contentEl.scrollTop / contentEl.scrollHeight : 0;
  await loadFile(state.path, { push: false, targetId: anchor, restoreRatio: ratio });
}

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Editing ------------------------------------------------------------------

const isDirty = () => state.mode === 'edit' && editorEl.value !== state.source;

function applyMode() {
  const editing = state.mode === 'edit';
  contentEl.hidden = editing;
  editorEl.hidden = !editing;
  saveBtn.hidden = !editing;
  document.documentElement.dataset.mode = state.mode;
  refreshModebar();
}

function refreshModebar() {
  const editing = state.mode === 'edit';
  const dirty = isDirty();

  pathEl.textContent = state.path ?? '';
  dirtyEl.hidden = !dirty;
  saveBtn.disabled = !dirty || state.saving;

  modeViewBtn.setAttribute('aria-pressed', String(!editing));
  modeEditBtn.setAttribute('aria-pressed', String(editing));
  modeViewBtn.disabled = !state.path;
  modeEditBtn.disabled = !state.path || state.readOnly;
  modeEditBtn.hidden = state.readOnly;
}

/** Everything that leaves the current buffer behind goes through here first. */
function mayDiscard() {
  return !isDirty() || confirm('Discard unsaved changes?');
}

function showBanner(text, actions = []) {
  const paragraph = document.createElement('p');
  paragraph.textContent = text;

  bannerEl.replaceChildren(
    paragraph,
    ...actions.map(({ label, run }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', run);
      return button;
    }),
  );
  bannerEl.hidden = false;
}

function hideBanner() {
  bannerEl.hidden = true;
  bannerEl.replaceChildren();
}

function setBuffer({ source, version, eol }) {
  state.source = source;
  state.version = version;
  state.eol = eol;
  editorEl.value = source;
  refreshModebar();
}

async function fetchRaw(rel) {
  const res = await fetch(`/api/raw?path=${encodeURIComponent(rel)}`);
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

async function enterEdit() {
  if (state.readOnly || !state.path || state.mode === 'edit') return;

  const rel = state.path;
  capturePosition(); // while the document pane can still be measured
  const token = ++loadToken; // an in-flight load must not paint over the editor

  let data;
  try {
    data = await fetchRaw(rel);
  } catch (err) {
    return showBanner(`Could not open ${rel} for editing (${err.message}).`);
  }
  if (token !== loadToken) return;

  hideBanner();
  setBuffer(data);
  state.mode = 'edit';
  applyMode();
  editorEl.focus();
  openAtReadingPosition();
}

/**
 * Open the editor on the section the reader had on screen.
 *
 * The view and the source share no geometry: a diagram is tall rendered and
 * three lines in the source. The active heading is the one landmark that sits in
 * the same logical place in both, so it is the anchor, exactly as scroll memory
 * and exitEdit already use it. With no heading to anchor to, the top is the
 * honest answer, which is also where the app lands a headingless document
 * everywhere else.
 *
 * The caret goes to the heading too, so typing begins in that section. scrollTop
 * is set last: focusing a textarea whose caret is at 0 can scroll it back up.
 */
function openAtReadingPosition() {
  const heading = state.headings.find((h) => h.id === state.activeId);
  const offset = heading ? lineOffset(editorEl.value, heading.line) : 0;

  editorEl.setSelectionRange(offset, offset);
  const max = editorEl.scrollHeight - editorEl.clientHeight;
  editorEl.scrollTop = Math.max(0, Math.min(editorTopForOffset(offset), max));
}

/** Character index where line `n` (zero-based, LF) starts. */
function lineOffset(text, n) {
  let at = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf('\n', at);
    if (nl === -1) return text.length;
    at = nl + 1;
  }
  return at;
}

/**
 * The pixel height of the text above `offset` in the editor, and so the scrollTop
 * that brings that line to the top. A hidden div mirrors the textarea's font,
 * wrapping and content width, because line number times line height drifts the
 * moment a long line soft-wraps, which markdown does constantly. The width comes
 * from clientWidth minus padding, so it matches the real wrap even once a
 * scrollbar has narrowed it.
 */
function editorTopForOffset(offset) {
  const cs = getComputedStyle(editorEl);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);

  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'absolute',
    top: '0',
    left: '-9999px',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
    boxSizing: 'content-box',
    width: `${editorEl.clientWidth - padX}px`,
    font: cs.font,
    fontFamily: cs.fontFamily,
    fontSize: cs.fontSize,
    lineHeight: cs.lineHeight,
    letterSpacing: cs.letterSpacing,
    tabSize: cs.tabSize,
  });

  mirror.textContent = editorEl.value.slice(0, offset);
  const marker = document.createElement('span');
  marker.textContent = '\u200b'; // a box on the target line, to read its offsetTop
  mirror.append(marker);

  document.body.append(mirror);
  const top = marker.offsetTop;
  mirror.remove();
  return top;
}

/**
 * Back to the rendered document.
 *
 * The pane has to be visible before anything measures it, so the mode flips
 * first, and the position enterEdit saved on the way in is what we come back to.
 *
 * Chromium and Firefox both hand a pane its scroll offset back when it returns
 * from display:none, so in those two the restore below is a no-op and no test in
 * this repo can turn it red. It stays because nothing promises that: a browser
 * that starts the pane at zero would otherwise drop the reader at the top of the
 * file every time they looked at the source. capture: false is there for the same
 * reason, so the reload cannot write that zero over the entry it is about to read.
 */
function exitEdit() {
  if (state.mode !== 'edit' || !mayDiscard()) return false;

  state.mode = 'view';
  applyMode();
  hideBanner();

  const rel = state.path;
  if (state.viewStale) {
    state.viewStale = false;
    loadFile(rel, { push: false, capture: false });
  } else {
    applyScroll(rel, null, null);
    updateSpy();
  }
  return true;
}

async function reloadBuffer() {
  if (!state.path) return;
  const rel = state.path;

  let data;
  try {
    data = await fetchRaw(rel);
  } catch (err) {
    return showBanner(`Could not reload ${rel} (${err.message}).`);
  }
  if (rel !== state.path) return;

  hideBanner();
  setBuffer(data);
  state.viewStale = true;
}

function flashSaved() {
  saveStatusEl.textContent = 'Saved';
  clearTimeout(flashSaved.timer);
  flashSaved.timer = setTimeout(() => {
    saveStatusEl.textContent = '';
  }, SAVED_FLASH_MS);
}

/** @param {string|null} version  the lock to save against; null forces an overwrite. */
async function save(version = state.version) {
  if (state.mode !== 'edit' || !state.path || state.saving) return;

  const rel = state.path;
  const source = editorEl.value; // what we send is what we will call saved
  state.saving = true;
  refreshModebar();

  let res;
  try {
    res = await fetch(`/api/file?path=${encodeURIComponent(rel)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, version, eol: state.eol }),
    });
  } catch {
    state.saving = false;
    refreshModebar();
    return showBanner('Lost the server.');
  }

  state.saving = false;
  // The reader may have moved on while the write was in flight. It landed on
  // disk either way, but this buffer is no longer the one it belongs to.
  if (rel !== state.path || state.mode !== 'edit') return;
  refreshModebar();

  if (res.status === 409) {
    const { error, version: current } = await res.json();
    return error === 'missing'
      ? showBanner(`${rel} was deleted on disk.`, [
          { label: 'Discard mine and reload', run: reloadBuffer },
        ])
      : showBanner('This file changed on disk since you started editing.', [
          { label: 'Overwrite it', run: () => save(current) },
          { label: 'Discard mine and reload', run: reloadBuffer },
        ]);
  }

  if (!res.ok) return showBanner(`Could not save ${rel} (${res.status}).`);

  const data = await res.json();
  state.source = source;
  state.version = data.version;
  state.viewStale = true; // the render behind the editor is a document ago
  refreshModebar();
  hideBanner();
  flashSaved();
}

/**
 * A change on disk while the editor is open. Our own save arrives here too: the
 * watcher cannot know who wrote the file, but the version says whether it was us.
 */
function onDiskChangeWhileEditing(message) {
  if (message.version === state.version) return; // our own save, coming back to us

  state.viewStale = true;

  if (message.type === 'file-deleted') {
    return showBanner(`${state.path} was deleted on disk.`);
  }
  if (!isDirty()) return reloadBuffer(); // nothing of the reader's to lose

  showBanner('This file changed on disk. Your unsaved changes are still here.', [
    { label: 'Keep mine', run: hideBanner },
    { label: 'Discard mine and reload', run: reloadBuffer },
  ]);
}

editorEl.addEventListener('input', refreshModebar);
saveBtn.addEventListener('click', () => save());
modeEditBtn.addEventListener('click', enterEdit);
modeViewBtn.addEventListener('click', exitEdit);

addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault(); // or the browser offers to save the page itself
    if (state.mode === 'edit') save();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'Escape' && state.mode === 'edit') {
    event.preventDefault();
    exitEdit();
    return;
  }

  const el = event.target;
  if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;

  if (event.key === 'e' && state.mode === 'view' && lightboxEl.hidden) {
    event.preventDefault();
    enterEdit();
  }
});

// A tab closed mid-edit is the one case the in-app guards cannot cover.
addEventListener('beforeunload', (event) => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

// Live reload -------------------------------------------------------------

function connectEvents(rel) {
  state.events?.close();
  const events = new EventSource(`/api/events?path=${encodeURIComponent(rel)}`);
  state.events = events;

  events.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.path !== state.path) return;

    // A rename is a deletion as far as the watcher can tell, and our own rename
    // comes back to this stream as one before the 200 has told us to move over.
    // The deletion event carries no version (there is no content to hash), so
    // the version trick a save uses cannot work here; a flag set around the
    // request is what tells our rename from somebody really deleting the file.
    if (message.type === 'file-deleted' && message.path === state.renamePending) return;

    // reloadCurrent re-renders the document and would throw the editor away with
    // it, so an open editor handles its own changes.
    if (state.mode === 'edit') return onDiskChangeWhileEditing(message);

    if (message.type === 'file-changed') reloadCurrent();
    else if (message.type === 'file-deleted') showNotice(`<p>${escapeHtml(rel)} was deleted.</p>`);
  };

  events.onerror = () => {
    state.eventsBroken = true;
    document.documentElement.dataset.live = 'off';
  };

  // EventSource reconnects on its own. Whatever changed while we were away is
  // invisible to us, so resync both panes.
  events.onopen = () => {
    document.documentElement.dataset.live = 'on';
    if (!state.eventsBroken) return;
    state.eventsBroken = false;
    loadTree();
    if (state.mode === 'edit') resyncEditor();
    else reloadCurrent();
  };
}

/**
 * The stream was down, so whatever happened to the file while we were away never
 * reached us. Ask once, and route the answer through the same handler a live
 * event would have taken.
 */
async function resyncEditor() {
  if (state.mode !== 'edit' || !state.path) return;

  let data = null;
  try {
    data = await fetchRaw(state.path);
  } catch {
    // gone, or no longer readable
  }
  if (state.mode !== 'edit') return;

  onDiskChangeWhileEditing(
    data ? { type: 'file-changed', version: data.version } : { type: 'file-deleted', version: null },
  );
}

// Tree freshness ----------------------------------------------------------

addEventListener('focus', loadTree);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) loadTree();
});
setInterval(() => {
  if (!document.hidden) loadTree();
}, TREE_POLL_MS);

// A refresh should come back to the same place, so snapshot on the way out.
addEventListener('pagehide', capturePosition);

// Routing -----------------------------------------------------------------

function routeFromUrl() {
  const params = new URLSearchParams(location.search);
  return {
    rel: params.get('path'),
    id: location.hash ? decodeURIComponent(location.hash.slice(1)) : null,
  };
}

addEventListener('popstate', () => {
  const { rel, id } = routeFromUrl();
  if (!rel) return;

  // The entry has already moved by the time we hear about it, so declining to
  // leave means putting it back.
  if (!mayDiscard()) {
    history.pushState({ path: state.path }, '', urlFor(state.path, state.activeId));
    return;
  }
  loadFile(rel, { push: false, targetId: id });
});

function findReadme(tree) {
  return tree.children.find((n) => n.type === 'file' && /^readme\.(md|markdown)$/i.test(n.name))?.path;
}

/** --read-only takes the Edit button off the bar rather than letting it 403. */
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (res.ok) state.readOnly = (await res.json()).readOnly === true;
  } catch {
    // the server will be back; the button is only a shortcut to a 403 anyway
  }
  refreshModebar();
}

async function init() {
  applyMode();
  const [tree] = await Promise.all([loadTree(), loadConfig()]);
  const { rel, id } = routeFromUrl();

  if (rel) return loadFile(rel, { push: false, targetId: id });

  const readme = tree ? findReadme(tree) : null;
  if (readme) return loadFile(readme, { push: false });

  showNotice(
    tree && tree.children.length > 0
      ? '<p>Pick a file on the left.</p>'
      : '<p>No markdown files under this directory.</p>',
  );
}

init();
