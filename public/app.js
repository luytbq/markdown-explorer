const treeEl = document.getElementById('tree');
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
  events: null,
  eventsBroken: false,
  suppressSpy: false,

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
  const el = event.target;
  if (el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;

  if (event.key === '[') togglePane('left');
  else if (event.key === ']') togglePane('right');
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

function treeNode(node, depth) {
  const indent = `${8 + depth * 12}px`;

  if (node.type === 'file') {
    const link = document.createElement('a');
    link.className = 'file';
    link.href = urlFor(node.path);
    link.dataset.path = node.path;
    link.style.paddingLeft = indent;
    link.textContent = node.name;
    return link;
  }

  const details = document.createElement('details');
  details.open = expanded.has(node.path);

  const summary = document.createElement('summary');
  summary.style.paddingLeft = indent;
  summary.textContent = node.name;
  details.append(summary);

  for (const child of node.children) details.append(treeNode(child, depth + 1));

  details.addEventListener('toggle', () => {
    if (details.open) expanded.add(node.path);
    else expanded.delete(node.path);
    saveExpanded();
  });

  return details;
}

function renderTree(tree) {
  if (tree.children.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'pane-empty';
    empty.textContent = 'No markdown files here.';
    treeEl.replaceChildren(empty);
    return;
  }
  treeEl.replaceChildren(...tree.children.map((n) => treeNode(n, 0)));
}

function markActiveFile(rel) {
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
  expanded = loadExpanded(tree);
  renderTree(tree);
  markActiveFile(state.path);
  return tree;
}

treeEl.addEventListener('click', (event) => {
  // Leave the href alone for modified clicks: open-in-new-tab and copy-link
  // are the reason the tree renders real anchors in the first place.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

  const link = event.target.closest('a.file');
  if (!link) return;

  event.preventDefault();
  if (link.dataset.path === state.path || !mayDiscard()) return;
  loadFile(link.dataset.path);
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
async function loadFile(rel, { push = true, targetId = null, restoreRatio = null, capture = true } = {}) {
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

  state.path = rel;
  state.viewStale = false;
  document.title = `${data.title} · markdown-explorer`;
  refreshModebar();

  docEl.innerHTML = data.html; // 1. content in
  decorateCodeBlocks(); // 2. before mermaid, while the diagram source still exists
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

  if (event.key === 'e' && state.mode === 'view') {
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
