const treeEl = document.getElementById('tree');
const docEl = document.getElementById('doc');
const tocEl = document.getElementById('toc');
const contentEl = document.getElementById('content');
const themeBtn = document.getElementById('theme');
const toggleLeftBtn = document.getElementById('toggle-left');
const toggleRightBtn = document.getElementById('toggle-right');

const SPY_OFFSET = 80;
const TREE_POLL_MS = 10_000;
const MAX_REMEMBERED = 200;

const state = {
  root: '',
  path: null,
  etag: null,
  activeId: null,
  events: null,
  eventsBroken: false,
  suppressSpy: false,
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
  // Mermaid bakes its colours into the rendered SVG, so it has to run again.
  if (docEl.querySelector('pre.mermaid, [data-processed]')) await reloadCurrent();
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
  if (link.dataset.path !== state.path) loadFile(link.dataset.path);
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
 */
async function loadFile(rel, { push = true, targetId = null, restoreRatio = null } = {}) {
  const token = ++loadToken;
  capturePosition(); // snapshot the file we are leaving, while state.path still names it

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
  document.title = `${data.title} · markdown-explorer`;

  docEl.innerHTML = data.html; // 1. content in
  renderOutline(data.headings);
  markActiveFile(rel);

  if (push) history.pushState({ path: rel }, '', urlFor(rel, targetId)); // 2. own the entry

  if (data.hasMermaid) await renderMermaid(); // 3. heights settle
  if (token !== loadToken) return;

  applyScroll(rel, targetId, restoreRatio); // 4. only now, scroll

  state.activeId = null; // 5. and recompute the outline highlight
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

// Live reload -------------------------------------------------------------

function connectEvents(rel) {
  state.events?.close();
  const events = new EventSource(`/api/events?path=${encodeURIComponent(rel)}`);
  state.events = events;

  events.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.path !== state.path) return;
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
    reloadCurrent();
  };
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
  if (rel) loadFile(rel, { push: false, targetId: id });
});

function findReadme(tree) {
  return tree.children.find((n) => n.type === 'file' && /^readme\.(md|markdown)$/i.test(n.name))?.path;
}

async function init() {
  const tree = await loadTree();
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
