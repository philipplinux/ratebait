// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
'use strict';

// ── state ──
const state = {
  // Custom names and button overrides stay per browser; folder labels come from the review.
  customNames: {},
  folderLabels: {},
  btnStyle: {},
  picked: new Set(), // multi-select, see pick()
  pickWait: null, // rating/flag waiting for the shared comment
  dir: '',
  files: [],
  items: {},
  index: 0,
  busy: false,
  subfolders: [],
  subCounts: {},
  grid: false,
};

const $ = (id) => document.getElementById(id);

// Per-browser settings. Storage can be blocked (private windows, site data off); then defaults apply.
function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storedJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
// null removes the key.
function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

const flags = ['redo', 'broken', 'trash', 'custom7', 'custom8', 'custom9'];

const customs = flags.slice(3);

const nameOf = (v) =>
  state.customNames[v] ||
  state.folderLabels[v] ||
  state.btnStyle[v]?.name ||
  (v === 'mvp'
    ? 'MVP'
    : v.startsWith('custom')
      ? 'Custom ' + v.slice(6)
      : titleCase(v));
let toastTimer;

const current = () => state.files[state.index];

const titleCase = (s) => s[0].toUpperCase() + s.slice(1);

// File-list date: time for today, day and month this year, else with a two-digit year.
const shortDate = (t) => {
  if (!t) return '';
  const d = new Date(t * 1000),
    now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(
    [],
    d.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: '2-digit' },
  );
};

const mediaUrl = (f) =>
  '/media?' + new URLSearchParams({ dir: state.dir, name: f.name, v: f.mtime });

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').hidden = true), 4000);
}

async function api(url, data) {
  const response = await fetch(
    url,
    data === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}

async function transact(action) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('busy');
  $('comment').readOnly = true;
  try {
    await action();
  } catch (e) {
    toast(e.message);
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
    $('comment').readOnly = false;
  }
  // Drain queued rating keys one per save; a comment bar opened by the last one (e.g. Redo) cancels the rest.
  if (keyQueue.length)
    setTimeout(() => {
      if (state.busy) return;
      if (document.body.classList.contains('comment-open')) {
        keyQueue.length = 0;
        return;
      }
      const k = keyQueue.shift();
      if (!document.querySelector(`#ratings button[data-key="${k}"]`)?.hidden)
        keyAction[k]();
    });
}

const keyQueue = [];

const keyAction = {};

function initState() {
  state.customNames = storedJSON('customNames') || {};
  state.btnStyle = storedJSON('btnStyle') || {};
}

// ── review ──

function paintRating() {
  const flag = state.items[current()?.name]?.flag,
    rating = flag ? null : state.items[current()?.name]?.rating;
  $('ratings')
    .querySelectorAll('button[data-rating]')
    .forEach((b) =>
      b.classList.toggle(
        'selected',
        b.classList.contains('flag')
          ? b.dataset.rating === flag
          : b.dataset.rating === rating,
      ),
    );
}

async function save(
  rating,
  comment,
  flag = state.items[current().name]?.flag || null,
  marks = null,
) {
  const item = state.items[current().name] || {};
  const { pins = item.pins || [], strokes = item.strokes || [] } = marks || {};
  const result = await api('/api/review', {
    dir: state.dir,
    name: current().name,
    rating,
    comment,
    flag,
    pins,
    strokes,
    labels: Object.fromEntries(
      customs
        .filter((v) => state.customNames[v])
        .map((v) => [v, state.customNames[v]]),
    ),
  });
  const name = current().name;
  state.items = result.items;
  if (!multiOn()) $('comment').value = state.items[name]?.comment || '';
  paintCommentTool();
  // Pop the rating/flag when it changes, and again with the comment badge when a comment is added or edited (e.g. Redo + comment).
  const now = state.items[name] || {},
    tag = now.flag || now.rating,
    newComment = !!now.comment && now.comment !== (item.comment || '');
  if (tag && (tag !== (item.flag || item.rating) || newComment))
    popRating(tag, now);
  else if (newComment) popRating(null);
  paintLists();
  paintRating();
  paintMarks();
  paintPinList();
  if (!$('viewer').hidden) paintPeek();
}

const saveMarks = (marks) =>
  transact(async () => {
    const item = state.items[current().name] || {};
    await save(
      item.rating || null,
      $('comment').value,
      item.flag || null,
      marks,
    );
  });

async function saveComment() {
  if (
    current() &&
    !multiOn() &&
    $('comment').value.trim() !== (state.items[current().name]?.comment || '')
  )
    await save(state.items[current().name]?.rating || null, $('comment').value);
}

function jump(i) {
  if (!state.files.length) return;
  return transact(async () => {
    await saveComment();
    state.index = (i + state.files.length) % state.files.length;
    paintLists();
    paintCard();
  });
}

// Each button has a 💬 checkbox. Off: ratings save and advance, flags toggle (on → advance).
// On ("comment mode", default for Redo): the first press sets the value and stays until a
// comment exists (the comment bar opens for it); pressing again with a new comment moves on, without one it unsets the value.
// Only one value at a time: a rating replaces any flag and a flag replaces any rating; the comment stays.
let commentMode = { redo: true };

// Multi-select (Ctrl+click in the file list while it is visible, or on grid tiles): a rating or flag key and
// the comment field (Enter) apply to every picked file at once; a typed comment rides along with the rating.
const multiOn = () =>
  state.picked.size > 1 &&
  (state.grid || !document.body.classList.contains('list-off'));

function pick(name) {
  if (!state.picked.size && current()) state.picked.add(current().name);
  if (state.picked.has(name)) state.picked.delete(name);
  else state.picked.add(name);
  if (state.picked.size < 2) state.picked.clear();
  paintPicks();
}

function clearPicks() {
  state.pickWait = null;
  if (state.picked.size) {
    state.picked.clear();
    paintPicks();
  }
}

function placeMultiTip() {
  if ($('multi-tip').hidden) return;
  const m = $('media').getBoundingClientRect();
  $('multi-tip').style.left = m.left + m.width / 2 + 'px';
  $('multi-tip').style.top = state.grid ? '' : Math.max(m.top, 0) + 12 + 'px';
  $('multi-tip').style.bottom = state.grid
    ? Math.max(innerHeight - m.bottom, 0) + 12 + 'px'
    : '';
}

function paintPicks() {
  const on = multiOn(),
    was = document.body.classList.contains('multi');
  document.body.classList.toggle('multi', on);
  $('multi-tip').hidden = !on;
  $('multi-count').textContent = state.picked.size;
  placeMultiTip();
  document
    .querySelectorAll('#sidebar .row,#media .tile')
    .forEach((r) =>
      r.classList.toggle('picked', state.picked.has(r.dataset.name)),
    );
  if (!on) state.pickWait = null;
  $('comment').placeholder = on
    ? `${state.pickWait ? nameOf(state.pickWait) + ': c' : 'C'}omment for all ${state.picked.size} files (Enter saves)`
    : 'What works? What needs changing?';
  if (on !== was) {
    $('comment').value = on ? '' : state.items[current()?.name]?.comment || '';
    paintCommentTool();
  }
}

async function applyPicks(value) {
  const flag = flags.includes(value),
    names = [...state.picked],
    note = $('comment').value.trim();
  const labels = Object.fromEntries(
    customs
      .filter((v) => state.customNames[v])
      .map((v) => [v, state.customNames[v]]),
  );
  for (const name of names) {
    const it = state.items[name] || {};
    state.items = (
      await api('/api/review', {
        dir: state.dir,
        name,
        rating: value ? (flag ? null : value) : it.rating || null,
        flag: value ? (flag ? value : null) : it.flag || null,
        comment: note || it.comment || '',
        pins: it.pins || [],
        strokes: it.strokes || [],
        labels,
      })
    ).items;
  }
  if (value) {
    popRating(value, { comment: note });
    toast(
      `${nameOf(value)}${note ? ' + comment' : ''} → ${names.length} files`,
    );
    state.picked.clear();
    paintPicks();
  } else if (note) {
    popRating(null);
    toast(`Comment → ${names.length} files`);
  }
  paintLists();
  paintRating();
  paintMarks();
  paintPinList();
}

function act(value) {
  if (!current()) return;
  if (multiOn()) {
    if (commentMode[value] && !$('comment').value.trim()) {
      state.pickWait = value;
      paintPicks();
      setCommentOpen(true);
      return;
    }
    return transact(() => applyPicks(value)).then(() => setCommentOpen(false));
  }
  const flag = flags.includes(value);
  let next = false,
    ask = false;
  return transact(async () => {
    const item = state.items[current().name] || {},
      typed = $('comment').value.trim();
    const was = flag ? item.flag === value : item.rating === value,
      edited = typed !== (item.comment || '');
    let on = !was;
    if (commentMode[value]) {
      on = !was || edited;
      next = on && typed !== '';
      ask = on && !next;
    } else next = on || !flag;
    if (flag) await save(null, $('comment').value, on ? value : null);
    else
      await save(
        on || !commentMode[value] ? value : null,
        $('comment').value,
        null,
      );
    if (next) {
      state.index = (state.index + 1) % state.files.length;
      paintLists();
      paintCard();
    }
  }).then(() => {
    if (next) setCommentOpen(false);
    else if (ask) setCommentOpen(true);
  });
}

function setCommentMode(value, on) {
  commentMode[value] = on;
  store('commentMode', JSON.stringify(commentMode));
  const box = document.querySelector(
    `#ratings button[data-rating="${value}"] .comment-mode`,
  );
  box.classList.toggle('on', on);
  box.setAttribute('aria-checked', on);
  box.title = on
    ? 'Comment mode on: stays until there is a comment'
    : 'Comment mode off: saves and moves on';
}

// One row laid out like a numpad: 0 Reject and . Neutral on the bottom row,
// 1–3 better and better, 4–6 Redo/Broken/Trash. Flags toggle; ratings save and advance.
// Filled icons in the button color (no plain-text thumbs-up glyph renders cleanly).
const thumbsUp =
  '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/><path d="M7 10v12" stroke="#151a22" stroke-width="1.6"/></svg>';

const buttons = [
  ['0', 'reject', '✕'],
  ['.', 'neutral', '−'],
  null,
  ['1', 'pass', thumbsUp],
  ['2', 'love', '♥'],
  ['3', 'mvp', '★'],
  null,
  ['4', 'redo', '↻'],
  ['5', 'broken', '⚠'],
  ['6', 'trash', '🗑'],
  null,
  ['7', 'custom7', '◆'],
  ['8', 'custom8', '▲'],
  ['9', 'custom9', '●'],
];

// Button face: word, icon, then a footer with the comment toggle (ratings only) and the keycap.
// The word hides on narrow button rows; icon and key stay.
function buttonFace(b, word, symbol, key, box) {
  const icon = Object.assign(document.createElement('span'), {
    className: 'rating-icon',
  });
  if (symbol.startsWith('<svg')) icon.innerHTML = symbol;
  else icon.textContent = symbol;
  icon.setAttribute('aria-hidden', 'true');
  const foot = Object.assign(document.createElement('span'), {
    className: 'rating-foot',
  });
  if (box) foot.append(box);
  foot.append(
    Object.assign(document.createElement('kbd'), {
      className: 'keycap',
      textContent: key,
    }),
  );
  b.append(
    Object.assign(document.createElement('span'), {
      className: 'rating-word',
      textContent: word,
    }),
    icon,
    foot,
  );
}

// Bottom layout: the comment field is a popover; it closes on 💬, Esc, Enter or when a comment moves on to the next file.
// Fullscreen only renders the viewer, so the comment field moves into it while it is open.
function placeComments() {
  const inViewer = !$('viewer').hidden,
    there = $('comments').parentElement === $('viewer');
  if (inViewer && !there) $('viewer').append($('comments'));
  else if (!inViewer && there) $('bar').after($('comments'));
}

function setCommentOpen(open) {
  placeComments();
  document.body.classList.toggle('comment-open', open);
  $('comment-tool').classList.toggle('on', open);
  $('zoom-level').querySelector('[data-k="C"]').classList.toggle('on', open);
  if (open) $('comment').focus();
  else if (document.activeElement === $('comment')) $('comment').blur();
}

function paintCommentTool() {
  const text = $('comment').value.trim();
  $('comment-tool').classList.toggle('has', !!text);
  $('comment-view').hidden = !text || !current() || multiOn();
  $('comment-view').querySelector('.cv-text').textContent = text;
}

function initReview() {
  commentMode = storedJSON('commentMode') || commentMode;

  new ResizeObserver(placeMultiTip).observe($('media'));
  addEventListener('resize', placeMultiTip);

  for (const entry of buttons) {
    if (!entry) {
      $('ratings').append(
        Object.assign(document.createElement('span'), {
          className: 'flag-sep',
        }),
      );
      continue;
    }
    const [key, value, symbol] = entry,
      flag = flags.includes(value);
    const b = document.createElement('button');
    b.dataset.rating = value;
    b.dataset.key = key;
    if (flag) b.className = 'flag';
    const label = nameOf(value);
    b.title = `${label} (${key})`;
    const box = document.createElement('span');
    box.className = 'comment-mode';
    box.textContent = '💬';
    box.setAttribute('role', 'checkbox');
    box.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      setCommentMode(value, !commentMode[value]);
    };
    buttonFace(b, label, symbol, key, box);
    keyAction[key] = b.onclick = () => act(value);
    $('ratings').append(b);
    setCommentMode(value, !!commentMode[value]);
  }

  // Right-sidebar layout: Enter (fullscreen) as the third big key beside 0 and . like a numpad; the header button hides there.
  {
    const b = document.createElement('button');
    b.id = 'fs-key';
    b.title = 'Fullscreen (Enter)';
    buttonFace(
      b,
      'Fullscreen',
      $('fs-btn').querySelector('svg').outerHTML,
      '↵',
    );
    b.onclick = () => $('fs-btn').click();
    $('ratings').append(b);
  }

  $('comment-view').onclick = () => setCommentOpen(true);

  $('comment-tool').onclick = () =>
    setCommentOpen(!document.body.classList.contains('comment-open'));

  $('comment').addEventListener('input', paintCommentTool);

  $('comment').onblur = (e) => {
    // These controls save the draft themselves; do not swallow their click with a blur POST.
    if (e.relatedTarget?.closest('button') || e.relatedTarget === $('folders'))
      return;
    transact(saveComment);
  };

  $('next').onclick = () => {
    jump(state.index + 1);
    setCommentOpen(false);
  };

  $('clear').onclick = () =>
    transact(async () => {
      if (current()) await save(null, '', null, { pins: [], strokes: [] });
    });
}

// ── media ──

// Kept as a reference: #media is often emptied, which detaches the box.
let zoomOpts, zoomBox, fsBtn;

const preloaded = new Map();
// media URL → <img> of the previous/next picture, see preloadNeighbours
// Single view: + / - zoom around the centre (10%–800%), Ctrl+wheel zooms at the cursor, the wheel or Shift+arrows pan while zoomed in. Kept across files, like fullscreen.
const single = { scale: 1, x: 0, y: 0, drag: null, dragged: false, token: 0 };

// Wheel delta in pixels: Firefox mouse wheels report lines (deltaMode 1), some devices pages (2).
const wheelPx = (e, d) =>
  d * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);

const dims = {};

const fileType = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toUpperCase();

function fileSize(bytes) {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes < 10 && i ? bytes.toFixed(1) : Math.round(bytes)} ${units[i]}`;
}

// Bottom-left details: type · resolution · size, then generation info read from the file (ComfyUI graph or A1111 parameters).
const metaCache = {};

async function paintDetails(f) {
  const line = () =>
    [fileType(f.name), dims[mediaUrl(f)], fileSize(f.size)]
      .filter(Boolean)
      .join(' · ');
  $('filemeta').textContent = line();
  $('genmeta').replaceChildren();
  if (f.kind === 'image' && !dims[mediaUrl(f)]) {
    const probe = new Image();
    probe.onload = () => {
      dims[mediaUrl(f)] = `${probe.naturalWidth}×${probe.naturalHeight}`;
      if (current() === f) $('filemeta').textContent = line();
    };
    probe.src = mediaUrl(f);
  }
  const key = mediaUrl(f);
  try {
    metaCache[key] ??= (
      await api(
        '/api/meta?' + new URLSearchParams({ dir: state.dir, name: f.name }),
      )
    ).rows;
  } catch {
    metaCache[key] = [];
  }
  if (current() !== f) return;
  $('genmeta').replaceChildren(
    ...metaCache[key].flatMap(([label, value]) => {
      const dt = document.createElement('dt'),
        dd = document.createElement('dd');
      dt.textContent = label;
      dd.textContent = value;
      dd.title = value;
      if (label === 'Prompt' || label === 'Parameters') dd.className = 'prompt';
      return [dt, dd];
    }),
  );
}

const label = (r) => (r ? nameOf(r) : '');

// Rebuilds the tiles when the folder, file order or media versions change; otherwise just moves the outline and badges.
function paintGrid() {
  const start = 0,
    key =
      state.dir +
      '|' +
      JSON.stringify(
        state.files.map(({ name, mtime, size }) => [name, mtime, size]),
      );
  let g = $('media').querySelector('.grid');
  if (!g || g.dataset.key !== key) {
    // Keep the scroll position when files change in the same folder.
    const same = g?.dataset.key.startsWith(state.dir + '|'),
      keep = same
        ? [g, $('media'), document.querySelector('main')].map((e) => [
            e,
            e.scrollTop,
          ])
        : [],
      last = g?.dataset.index;
    g = document.createElement('div');
    if (same) g.dataset.index = last;
    g.className = 'grid';
    g.dataset.key = key;
    state.files.forEach((f, k) => {
      const tile = document.createElement('button');
      tile.className = 'tile' + (state.picked.has(f.name) ? ' picked' : '');
      tile.dataset.name = f.name;
      tile.title = f.name + ' · Ctrl+click to select several';
      if (f.kind === 'image') {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = mediaUrl(f);
        img.alt = f.name;
        tile.append(img);
      } else tile.textContent = '♪';
      const name = document.createElement('span');
      name.className = 'tile-name';
      name.textContent = f.name
        .replace(/\.[^.]+$/, '')
        .replace(/^\d{8}-r\d+-/, '');
      const badge = document.createElement('span');
      badge.className = 'tile-badge';
      tile.append(name, badge);
      tile.onclick = (e) => {
        if (e.ctrlKey || e.metaKey) {
          pick(f.name);
          return;
        }
        clearPicks();
        jump(start + k);
      };
      tile.ondblclick = () => {
        if (state.index === start + k) openViewer();
      };
      g.append(tile);
    });
    $('media').replaceChildren(g);
    paintZoomBox();
    keep.forEach(([e, top], k) => ((k ? e : g).scrollTop = top));
  }
  [...g.children].forEach((tile, k) => {
    const item = state.items[state.files[start + k]?.name] || {},
      r = item.flag || item.rating,
      badge = tile.querySelector('.tile-badge');
    tile.classList.toggle('current', start + k === state.index);
    if (r) badge.dataset.rating = r;
    else delete badge.dataset.rating;
    badge.textContent = label(r);
    badge.hidden = !r;
  });
  // Scroll only when the selection moved, not on a background refresh.
  if (g.dataset.index !== String(state.index))
    g.children[state.index - start]?.scrollIntoView({ block: 'nearest' });
  g.dataset.index = state.index;
}

function paintCard() {
  const old = $('media').querySelector('audio');
  if (old) {
    old.pause();
    old.removeAttribute('src');
    old.load();
  }
  const f = current();
  // A single-view picture replaces the old content itself, once decoded (see below).
  if ((!state.grid && f?.kind !== 'image') || !f) $('media').replaceChildren();
  for (const id of [
    'details',
    'ratings',
    'comments',
    'grid-toggle',
    'marks-bar',
  ])
    $(id).hidden = !f;
  if (!f || f.kind !== 'image') closeViewer();
  if (!f) {
    $('media').textContent = 'No media files in this folder';
    return;
  }
  if (state.grid) {
    paintGrid();
    if (f.kind === 'image' && !$('viewer').hidden) showInViewer(f);
  } else if (f.kind === 'image') {
    // A preloaded neighbour, or the picture already shown (repaint after a rating), is used as is.
    const u = mediaUrl(f),
      shown = $('media').querySelector(':scope>img');
    const image =
      preloaded.get(u) ||
      (shown?.getAttribute('src') === u
        ? shown
        : document.createElement('img'));
    preloaded.delete(u);
    if (image.getAttribute('src') !== u) image.src = u;
    image.alt = f.name;
    image.title = 'Click for fullscreen';
    image.draggable = false;
    image.onclick = () => {
      if (!single.dragged) openViewer();
    };
    // The old picture stays until the new one is fully loaded and decoded: no half-loaded or blurry frames.
    // Shown already zoomed (paintSingle), so there is no 100% flash either.
    const token = ++single.token;
    const show = () => {
      if (token !== single.token || state.grid || current() !== f) return;
      const old = $('media').querySelector(':scope>img'),
        a = fitSize(old),
        b = fitSize(image);
      if (single.scale !== 1 && a && b && old !== image) {
        single.x *= b.w / a.w;
        single.y *= b.h / a.h;
      }
      $('media').replaceChildren(image, marksLayer(f.name));
      paintSingle();
    };
    if (image.complete && image.naturalWidth) show();
    else image.decode().then(show, show);
    if (!$('viewer').hidden) showInViewer(f);
  } else {
    const card = document.createElement('div');
    card.className = 'audio-card';
    const symbol = document.createElement('div');
    symbol.className = 'symbol';
    symbol.textContent = '♪';
    const name = document.createElement('div');
    name.className = 'audio-name';
    name.textContent = f.name;
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.autoplay = true;
    audio.src = mediaUrl(f);
    card.append(symbol, name, audio);
    $('media').append(card);
  }
  $('filename').textContent = f.name;
  $('date').textContent = new Date(f.mtime * 1000).toLocaleString();
  paintDetails(f);
  if (!multiOn()) $('comment').value = state.items[f.name]?.comment || '';
  paintCommentTool();
  paintRating();
  paintPinList();
  paintZoomBox();
  if (!state.grid || !$('viewer').hidden) preloadNeighbours();
}

// The next 2 pictures and the previous one (audio skipped), fetched and decoded in the background, nearest first,
// so ← → show them at once.
const PRELOAD = { 1: 2, '-1': 1 };

function preloadNeighbours() {
  const keep = new Map(),
    seen = new Set([state.index]),
    ahead = { '-1': [], 1: [] };
  for (const d of [1, -1])
    for (
      let k = 1;
      k < state.files.length && ahead[d].length < PRELOAD[d];
      k++
    ) {
      const i =
        (((state.index + d * k) % state.files.length) + state.files.length) %
        state.files.length;
      if (state.files[i].kind === 'image' && !seen.has(i)) {
        seen.add(i);
        ahead[d].push(i);
      }
    }
  for (const i of [ahead[1][0], ahead[-1][0], ahead[1][1]]) {
    if (i === undefined) continue;
    const u = mediaUrl(state.files[i]);
    const shown = $('media').querySelector(':scope>img');
    let img =
      preloaded.get(u) || (shown?.getAttribute('src') === u ? shown : null);
    if (!img) {
      img = document.createElement('img');
      img.src = u;
      img.decode().catch(() => {});
    }
    keep.set(u, img);
  }
  preloaded.clear();
  keep.forEach((img, u) => preloaded.set(u, img));
}

function setGrid(on) {
  state.grid = on;
  $('grid-toggle').classList.toggle('on', on);
  if (!on && document.body.classList.contains('list-off')) clearPicks();
  store('grid', on ? '1' : '0');
  $('media').replaceChildren();
  if (state.files.length) paintCard();
  else paintPinList();
}

// Grid size (columns × rows), kept per browser. ↑↓ move one row, PgUp/PgDn one page.
const gridSize = { cols: 3, rows: 3 };

function setGridSize(cols, rows) {
  const fit = (v, old) =>
    String(v).trim() === '' || !isFinite(+v)
      ? old
      : Math.min(10, Math.max(1, Math.round(+v)));
  gridSize.cols = fit(cols, gridSize.cols);
  gridSize.rows = fit(rows, gridSize.rows);
  // 1×1 is just the single view; the smallest grid is 2×1.
  if (gridSize.cols === 1 && gridSize.rows === 1) gridSize.cols = 2;
  document.body.style.setProperty('--gcols', gridSize.cols);
  document.body.style.setProperty('--grows', gridSize.rows);
  $('grid-cols').value = gridSize.cols;
  $('grid-rows').value = gridSize.rows;
  for (const b of document.querySelectorAll('.grid-presets button'))
    b.classList.toggle(
      'on',
      b.dataset.grid === gridSize.cols + 'x' + gridSize.rows,
    );
  store('gridSize', gridSize.cols + 'x' + gridSize.rows);
  paintZoomBox();
}

// Fullscreen viewer: click opens, Ctrl+wheel zooms at the cursor, drag pans, a click without drag closes.
const view = { fit: 1, scale: 1, x: 0, y: 0, w: 0, h: 0, token: 0, drag: null };

const viewerImg = () => $('viewer').querySelector('img');

function paintView() {
  const img = viewerImg(),
    s = view.fit * view.scale;
  if (view.scale > 1) {
    const clampAxis = (v, size, screen) =>
      size <= screen
        ? (screen - size) / 2
        : Math.min(0, Math.max(screen - size, v));
    view.x = clampAxis(view.x, view.w * s, innerWidth);
    view.y = clampAxis(view.y, view.h * s, innerHeight);
  }
  img.style.transform = `translate(${view.x}px,${view.y}px) scale(${s})`;
  const layer = $('viewer').querySelector('.marks');
  if (layer)
    Object.assign(layer.style, {
      left: view.x + 'px',
      top: view.y + 'px',
      width: view.w * s + 'px',
      height: view.h * s + 'px',
    });
  $('viewer').classList.toggle('zoomed', view.scale > 1);
  // The bar always lists the keys; the zoom level and Reset only show while zoomed.
  $('zoom-level').querySelector('.zl').textContent =
    view.scale === 1 ? '' : `${Math.round(view.scale * 100)}%`;
  $('zoom-level').querySelector('.zoom-reset').hidden = view.scale === 1;
  paintZoomOpts();
}

// view.w/h are the shown picture's size; the next picture is preloaded and swapped in only once decoded,
// so a half-loaded picture of another size is never drawn with the old transform.
function centerView() {
  const s = view.fit * view.scale;
  view.x = (innerWidth - view.w * s) / 2;
  view.y = (innerHeight - view.h * s) / 2;
  paintView();
}

function resetView() {
  const w = innerWidth,
    h = innerHeight;
  if (!view.w) return;
  view.fit = Math.min(w / view.w, h / view.h);
  view.scale = 1;
  view.x = (w - view.w * view.fit) / 2;
  view.y = (h - view.h * view.fit) / 2;
  paintView();
}

// Small previous/next thumbnails at the screen edges; audio files are skipped, the ends wrap.
function peekIndex(d) {
  for (let k = 1; k < state.files.length; k++) {
    const i =
      (((state.index + d * k) % state.files.length) + state.files.length) %
      state.files.length;
    if (state.files[i].kind === 'image') return i;
  }
  return -1;
}

// After rating: the rating's icon pops up big over the picture (or the fullscreen viewer) and fades out,
// with small comment / pin / pen badges on its upper-right edge for what the file carries.
// r=null (comment saved on an unrated file): just the comment bubble, smaller.
function popRating(r, item = {}) {
  const fs = !$('viewer').hidden,
    m = (fs ? $('viewer') : $('media')).getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'rate-pop' + (r ? '' : ' comment-pop');
  if (r) {
    paintIcon(el, r);
    el.hidden = false;
  } else el.textContent = '💬';
  // Badges at fixed spots on the circle edge: comment top centre, pin bottom left, pen bottom right.
  const extras = r
    ? [
        item.comment && ['💬', 0],
        item.pins?.length && ['📍', 225],
        item.strokes?.length && ['✏️', 135],
      ].filter(Boolean)
    : [];
  extras.forEach(([sym, deg]) => {
    const a = (deg * Math.PI) / 180;
    el.append(
      Object.assign(document.createElement('i'), {
        className: 'pop-badge',
        textContent: sym,
        style: `left:${60 + 60 * Math.sin(a)}px;top:${60 - 60 * Math.cos(a)}px`,
      }),
    );
  });
  Object.assign(el.style, {
    left: m.left + m.width / 2 + 'px',
    top: m.top + m.height / 2 + 'px',
  });
  (fs ? $('viewer') : document.body).append(el);
  el.addEventListener('animationend', (e) => {
    if (e.target === el) el.remove();
  });
}

// Rating icon (same as on the rating button) in the rating's colour; hidden when unrated.
function paintIcon(badge, r) {
  if (r) badge.dataset.rating = r;
  else delete badge.dataset.rating;
  const sym = r ? symOf(r) || label(r) : '';
  if (sym.startsWith('<svg')) badge.innerHTML = sym;
  else badge.textContent = sym;
  badge.hidden = !r;
  badge.title = r ? label(r) : '';
}

function paintPeek() {
  const item = state.items[current()?.name] || {};
  paintIcon($('viewer-badge'), item.flag || item.rating);
  for (const b of $('viewer').querySelectorAll('.peek')) {
    const i = peekIndex(b.classList.contains('prev') ? -1 : 1);
    b.hidden = i < 0 || i === state.index;
    if (b.hidden) continue;
    const im = b.querySelector('img'),
      u = mediaUrl(state.files[i]);
    if (im.getAttribute('src') !== u) im.src = u;
    const item = state.items[state.files[i].name] || {},
      r = item.flag || item.rating;
    paintIcon(b.querySelector('.tile-badge'), r);
    b.dataset.i = i;
    b.title = state.files[i].name + (r ? ' · ' + label(r) : '');
  }
}

// fresh: the viewer was just opened, so an older picture still in it is cleared rather than shown meanwhile.
function showInViewer(f, fresh = false) {
  const img = viewerImg(),
    u = mediaUrl(f);
  paintPeek();
  if (img.dataset.url === u || view.pending === u) return;
  const clear = () => {
    img.removeAttribute('src');
    img.dataset.url = '';
    $('viewer').querySelector('.marks')?.remove();
  };
  if (fresh) clear();
  view.pending = u;
  const next = new Image(),
    token = ++view.token;
  next.onerror = () => {
    if (token !== view.token) return;
    view.pending = null;
    clear();
    toast('Could not load ' + f.name);
  };
  next.onload = async () => {
    try {
      await next.decode();
    } catch {}
    if (token !== view.token) return;
    view.pending = null;
    img.dataset.url = u;
    // Zoomed in: keep the zoom and show the same spot (relative to the image) at the screen centre.
    const scale = view.scale,
      keep = scale > 1 && view.w;
    const s = view.fit * scale,
      ru = keep && (innerWidth / 2 - view.x) / (view.w * s),
      rv = keep && (innerHeight / 2 - view.y) / (view.h * s);
    img.src = next.src;
    view.w = next.naturalWidth;
    view.h = next.naturalHeight;
    $('viewer').querySelector('.marks')?.remove();
    $('viewer').append(marksLayer(f.name));
    resetView();
    if (keep) {
      view.scale = scale;
      const t = view.fit * scale;
      view.x = innerWidth / 2 - ru * view.w * t;
      view.y = innerHeight / 2 - rv * view.h * t;
      paintView();
    } else if (scale < 1) {
      view.scale = scale;
      centerView();
    }
  };
  next.src = u;
}

function openViewer() {
  const f = current();
  if (!f || f.kind !== 'image') return;
  $('viewer').hidden = false;
  placeComments();
  placeMarkOpts();
  showInViewer(f, true);
  resetView();
  $('viewer')
    .requestFullscreen?.()
    .catch(() => {});
}

let escTypedAt = 0; // see the fullscreenchange handler

function closeViewer() {
  if ($('viewer').hidden) return;
  $('viewer').hidden = true;
  placeComments();
  placeMarkOpts();
  if (markMode) setMarkMode(null);
  view.drag = null;
  view.scale = 1;
  view.pending = null;
  view.token++;
  paintSingle();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// Zooms the fullscreen picture to scale s, keeping the screen point (cx,cy) in place.
// Below 100% of the fitted size the picture stays centred.
function zoomView(s, cx, cy) {
  const next = Math.min(Math.max(s, 0.1), Math.max(8, (1 / view.fit) * 4));
  if (Math.abs(next - 1) < 1e-6) {
    resetView();
    return;
  }
  if (next < 1) {
    resetView();
    view.scale = next;
    centerView();
    return;
  }
  const k = next / view.scale;
  view.x = cx - (cx - view.x) * k;
  view.y = cy - (cy - view.y) * k;
  view.scale = next;
  paintView();
}

function paintSingle() {
  const img = $('media').querySelector(':scope>img');
  if (!img) return;
  const m = $('media').getBoundingClientRect(),
    s = single.scale;
  const mx = Math.max(0, (m.width * (s - 1)) / 2),
    my = Math.max(0, (m.height * (s - 1)) / 2);
  single.x = Math.min(Math.max(single.x, -mx), mx);
  single.y = Math.min(Math.max(single.y, -my), my);
  img.style.transform =
    s !== 1 ? `translate(${single.x}px,${single.y}px) scale(${s})` : '';
  $('media').classList.toggle('zoomed', s > 1);
  placeMarks();
  paintZoomBox();
  paintZoomOpts();
}

// Zoom hint bar while zoomed: above the key legend in fullscreen, at the bottom of the picture in single view.
function paintZoomOpts() {
  const o = zoomOpts,
    fs = !$('viewer').hidden,
    s = fs ? view.scale : single.scale;
  o.hidden =
    (fs ? false : state.grid || !$('media').querySelector(':scope>img')) ||
    s === 1;
  if (fs) {
    if (o.parentNode !== $('zoom-level')) $('mark-opts').after(o);
  } else if (o.parentNode !== $('media') && !o.hidden) $('media').append(o);
  o.querySelector('.zpct').textContent = Math.round(s * 100) + '%';
}

// Zoom level + Reset in the picture's bottom-right corner: single view shows the zoom, the grid its size.
// #media is often emptied, so the box is moved back into it on every paint.
function paintZoomBox() {
  const box = zoomBox,
    f = current(),
    img = !state.grid && $('media').querySelector(':scope>img');
  fsBtn.disabled = f?.kind !== 'image'; // fullscreen (header, beside settings) works for images only
  // Shown only when zoomed, or when the grid size differs from the default 3×3.
  box.hidden =
    !f ||
    !(state.grid || img) ||
    (state.grid
      ? gridSize.cols === 3 && gridSize.rows === 3
      : single.scale === 1 || !document.body.classList.contains('no-hints'));
  if (box.hidden) return;
  $('media').append(box);
  box.querySelector('span').textContent = state.grid
    ? `Grid ${gridSize.cols}×${gridSize.rows} · + −`
    : `${Math.round(single.scale * 100)}% · + −`;
  const b = box.querySelector('button');
  b.title = state.grid
    ? 'Back to the default grid (3×3)'
    : 'Back to fit (100%)';
}

// (px,py): the point to keep in place, relative to the picture area's centre (default: the centre).
function zoomSingle(f, px = 0, py = 0) {
  if (!$('media').querySelector(':scope>img')) return;
  let s = Math.min(Math.max(single.scale * f, 0.1), 8);
  if (Math.abs(s - 1) < 1e-6) s = 1;
  const k = s / single.scale;
  single.x = px - (px - single.x) * k;
  single.y = py - (py - single.y) * k;
  single.scale = s;
  paintSingle();
}

// Grid: +1 steps to more, smaller tiles, -1 to fewer, bigger ones: 2×1, 2×2, 3×3 … 10×10 (same as the ⚙ grid size).
// From any size (also a custom one) it goes to the next step with more or fewer tiles; none left: unchanged.
function stepGrid(dir) {
  const steps = [
      [2, 1],
      ...Array.from({ length: 9 }, (_, k) => [k + 2, k + 2]),
    ],
    n = gridSize.cols * gridSize.rows;
  const to =
    dir > 0
      ? steps.find(([c, r]) => c * r > n)
      : steps.findLast(([c, r]) => c * r < n);
  if (!to) return;
  setGridSize(...to);
  $('media')
    .querySelector('.tile.current')
    ?.scrollIntoView({ block: 'nearest' });
}

// Ctrl+wheel anywhere on the page zooms the picture or steps the grid, like + and -, instead of zooming the browser.
// Fullscreen has its own handler. Elsewhere (sidebar, settings, comment) Ctrl+wheel does nothing.
let wheelSum = 0,
  wheelAt = 0;

// Shift+arrows pan a zoomed picture (single view or fullscreen) by a tenth of the screen; plain arrows still change pictures.
function panBy(dx, dy) {
  if (!$('viewer').hidden) {
    if (view.scale > 1) {
      view.x += (dx * innerWidth) / 10;
      view.y += (dy * innerHeight) / 10;
      paintView();
    }
    return;
  }
  if (state.grid || single.scale <= 1) return;
  const m = $('media').getBoundingClientRect();
  single.x += (dx * m.width) / 10;
  single.y += (dy * m.height) / 10;
  paintSingle();
}

// Unzoomed size of a picture fitted into the single-view area (object-fit:contain).
function fitSize(img) {
  if (!img?.naturalWidth) return null;
  const m = $('media').getBoundingClientRect(),
    k = Math.min(m.width / img.naturalWidth, m.height / img.naturalHeight);
  return { w: img.naturalWidth * k, h: img.naturalHeight * k };
}

function initMedia() {
  zoomOpts = document.getElementById('zoom-opts');
  zoomBox = document.getElementById('zoom-box');
  fsBtn = document.getElementById('fs-btn');

  {
    // Two-part switch: single view | grid; the active half is lit. A click on a half picks it, elsewhere (or G) toggles.
    const b = document.createElement('button');
    b.id = 'grid-toggle';
    b.title = 'Single view or grid of all files (G)';
    const one = document.createElement('span');
    one.className = 'gt-seg';
    one.dataset.mode = 'single';
    one.title = 'Single view (G)';
    one.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/></svg>';
    const many = document.createElement('span');
    many.className = 'gt-seg';
    many.dataset.mode = 'grid';
    many.title = 'Grid view (G)';
    many.innerHTML =
      '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><rect x="1" y="1" width="4" height="4" rx=".8"/><rect x="6" y="1" width="4" height="4" rx=".8"/><rect x="11" y="1" width="4" height="4" rx=".8"/><rect x="1" y="6" width="4" height="4" rx=".8"/><rect x="6" y="6" width="4" height="4" rx=".8"/><rect x="11" y="6" width="4" height="4" rx=".8"/><rect x="1" y="11" width="4" height="4" rx=".8"/><rect x="6" y="11" width="4" height="4" rx=".8"/><rect x="11" y="11" width="4" height="4" rx=".8"/></svg>';
    b.append(
      one,
      many,
      Object.assign(document.createElement('kbd'), {
        className: 'keycap',
        textContent: 'G',
      }),
    );
    b.onclick = (e) => {
      const m = e.target.closest('[data-mode]')?.dataset.mode;
      setGrid(m ? m === 'grid' : !state.grid);
    };
    $('fs-btn').before(b);
  }

  state.grid = stored('grid') === '1';
  $('grid-toggle').classList.toggle('on', state.grid);

  for (const b of document.querySelectorAll('.grid-presets button'))
    b.onclick = () => setGridSize(...b.dataset.grid.split('x'));

  $('grid-cols').onchange = $('grid-rows').onchange = () =>
    setGridSize($('grid-cols').value, $('grid-rows').value);

  const [c, r] = (stored('gridSize') || '3x3').split('x');
  setGridSize(c, r);

  {
    const b = $('zoom-level').querySelector('button');
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.onclick = (e) => {
      e.stopPropagation();
      resetView();
    };
  }

  for (const b of document.querySelectorAll('#viewer .peek')) {
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.onclick = (e) => {
      e.stopPropagation();
      jump(+b.dataset.i);
    };
  }

  // The browser leaves fullscreen on Esc and pages cannot stop it (Firefox has no Keyboard Lock).
  // Esc while typing only closes the comment; the viewer stays as a window-sized overlay.
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) return resetView();
    const a = document.activeElement;
    if (
      !$('viewer').hidden &&
      (['TEXTAREA', 'INPUT'].includes(a?.tagName) ||
        performance.now() - escTypedAt < 500)
    ) {
      a?.blur();
      setCommentOpen(false);
      return;
    }
    closeViewer();
  });
  // The next key (not Esc) brings that overlay back to true fullscreen; so does a click,
  // see pointerup. Deferred so keys that close the viewer (Enter, F1) win.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') return;
    setTimeout(() => {
      if (!$('viewer').hidden && !document.fullscreenElement)
        $('viewer')
          .requestFullscreen?.()
          .catch(() => {});
    });
  });

  addEventListener('resize', () => {
    if (!$('viewer').hidden) resetView();
    placeMarksPanel();
  });

  $('viewer').addEventListener(
    'wheel',
    (e) => {
      if (e.target.closest('#comments')) return; // the comment box scrolls itself
      e.preventDefault();
      // Ctrl+wheel zooms at the cursor; the plain wheel pans while zoomed.
      if (!e.ctrlKey) {
        if (view.scale > 1) {
          view.x -= wheelPx(e, e.deltaX);
          view.y -= wheelPx(e, e.deltaY);
          paintView();
        }
        return;
      }
      zoomView(
        view.scale * Math.exp(-wheelPx(e, e.deltaY) * 0.002),
        e.clientX,
        e.clientY,
      );
    },
    { passive: false },
  );

  fsBtn.onclick = (e) => {
    e.stopPropagation();
    e.currentTarget.blur();
    openViewer();
  };

  zoomOpts.querySelector('button').onclick = (e) => {
    e.stopPropagation();
    e.currentTarget.blur();
    if (!$('viewer').hidden) resetView();
    else {
      single.scale = 1;
      single.x = single.y = 0;
      paintSingle();
    }
  };

  for (const t of ['pointerdown', 'pointerup'])
    zoomOpts.addEventListener(t, (e) => e.stopPropagation());

  zoomBox.querySelector('button').onclick = (e) => {
    e.currentTarget.blur();
    if (state.grid) setGridSize(3, 3);
    else {
      single.scale = 1;
      single.x = single.y = 0;
      paintSingle();
    }
  };

  document.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey || !$('viewer').hidden) return;
      e.preventDefault();
      if (!current() || !e.target.closest?.('#media')) return;
      const dy = wheelPx(e, e.deltaY);
      if (state.grid) {
        // Touchpads send many small deltas: one grid step per 100px of scrolling; a pause or a turn starts over.
        if (
          e.timeStamp - wheelAt > 400 ||
          Math.sign(dy) !== Math.sign(wheelSum)
        )
          wheelSum = 0;
        wheelAt = e.timeStamp;
        wheelSum += dy;
        if (Math.abs(wheelSum) < 100) return;
        stepGrid(wheelSum < 0 ? 1 : -1);
        wheelSum = 0;
        return;
      }
      if (!$('media').querySelector(':scope>img')) return;
      const m = $('media').getBoundingClientRect();
      zoomSingle(
        Math.exp(-dy * 0.002),
        e.clientX - m.left - m.width / 2,
        e.clientY - m.top - m.height / 2,
      );
    },
    { passive: false },
  );

  $('media').addEventListener(
    'wheel',
    (e) => {
      if (
        e.ctrlKey ||
        single.scale <= 1 ||
        !$('media').querySelector(':scope>img')
      )
        return;
      e.preventDefault();
      single.x -= wheelPx(e, e.deltaX);
      single.y -= wheelPx(e, e.deltaY);
      paintSingle();
    },
    { passive: false },
  );

  // Zoomed in, drag the picture to pan; a drag does not open fullscreen. Pin/draw tools keep the mouse.
  $('media').addEventListener('pointerdown', (e) => {
    single.dragged = false;
    if (
      e.button !== 0 ||
      markMode ||
      single.scale <= 1 ||
      !(
        e.target === $('media').querySelector(':scope>img') ||
        e.target.closest('#media>.marks')
      )
    )
      return;
    if (single.drag) return;
    e.preventDefault();
    single.drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      ox: single.x,
      oy: single.y,
    };
    $('media').setPointerCapture(e.pointerId);
  });

  $('media').addEventListener('pointermove', (e) => {
    const d = single.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!(e.buttons & 1)) {
      single.drag = null;
      $('media').classList.remove('dragging');
      return;
    }
    if (!single.dragged && Math.hypot(e.clientX - d.x, e.clientY - d.y) <= 5)
      return;
    single.dragged = true;
    $('media').classList.add('dragging');
    single.x = d.ox + e.clientX - d.x;
    single.y = d.oy + e.clientY - d.y;
    paintSingle();
  });

  for (const t of ['pointerup', 'pointercancel'])
    $('media').addEventListener(t, (e) => {
      if (single.drag?.id !== e.pointerId) return;
      const open = t === 'pointerup' && !single.dragged;
      single.drag = null;
      $('media').classList.remove('dragging');
      if (open) openViewer();
    });

  // No native image drag (Firefox ignores -webkit-user-drag): it cancels the pointer, the release is lost
  // and the picture would keep following the mouse.
  for (const el of [$('viewer'), $('media')])
    el.addEventListener('dragstart', (e) => e.preventDefault());

  $('viewer').addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#comments')) return;
    e.preventDefault();
    // preventDefault keeps focus where it is, so an open pin note is closed (and saved) by hand.
    if (document.activeElement?.classList.contains('pin-edit')) {
      document.activeElement.blur();
      return;
    }
    if (markMode) {
      const layer = $('viewer').querySelector(':scope>.marks'),
        b = layer?.getBoundingClientRect();
      if (
        b &&
        e.clientX >= b.left &&
        e.clientX <= b.right &&
        e.clientY >= b.top &&
        e.clientY <= b.bottom
      )
        startMark(e, layer);
      return;
    }
    // A second finger cancels the click-to-close and is otherwise ignored.
    if (view.drag) {
      view.drag.moved = true;
      return;
    }
    view.drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      ox: view.x,
      oy: view.y,
      moved: false,
    };
    $('viewer').setPointerCapture(e.pointerId);
  });

  $('viewer').addEventListener('pointermove', (e) => {
    const d = view.drag;
    if (!d || e.pointerId !== d.id) return;
    if (!(e.buttons & 1)) {
      view.drag = null;
      $('viewer').classList.remove('dragging');
      return;
    }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) d.moved = true;
    if (d.moved && view.scale > 1) {
      $('viewer').classList.add('dragging');
      view.x = d.ox + e.clientX - d.x;
      view.y = d.oy + e.clientY - d.y;
      paintView();
    }
  });

  $('viewer').addEventListener('pointerup', (e) => {
    const d = view.drag;
    if (d && e.pointerId !== d.id) return;
    view.drag = null;
    $('viewer').classList.remove('dragging');
    if (!d || d.moved) return;
    if (document.fullscreenElement || !$('viewer').requestFullscreen)
      return closeViewer();
    $('viewer').requestFullscreen().catch(closeViewer);
  });

  $('viewer').addEventListener('pointercancel', (e) => {
    if (view.drag && e.pointerId !== view.drag.id) return;
    view.drag = null;
    $('viewer').classList.remove('dragging');
  });

  new ResizeObserver(paintSingle).observe($('media'));
}

// ── sidebar ──

let pathBoxEl = null,
  foldersEl = null;

let sideResize;

function paintLists() {
  pathBoxEl ||= $('path-box');
  foldersEl ||= $('folders');
  const pathTyping = document.activeElement === $('path') && [
    $('path').selectionStart,
    $('path').selectionEnd,
  ];
  $('ticks').replaceChildren();
  $('sidebar').replaceChildren();
  const views = document.createElement('div');
  views.className = 'side-views';
  for (const [mode, text, title] of [
    ['list', '☰ List', 'File list with names'],
    ['grid', '▦ Grid', 'Thumbnails only, 3 per row'],
  ]) {
    const b = Object.assign(document.createElement('button'), {
      textContent: text,
      title,
    });
    b.classList.toggle('on', sideView === mode);
    b.onclick = () => setSideView(mode);
    views.append(b);
  }
  // Sort row: Time (default, oldest first), Name, Size; pressing the active one flips the direction. Dragging rows makes a custom order instead.
  const sorter = document.createElement('div');
  sorter.className = 'side-sort';
  sorter.append(
    Object.assign(document.createElement('span'), {
      textContent: '⇅',
      title: 'Sort the file list',
    }),
  );
  const custom = loadOrder().length > 0;
  for (const [key, text, title] of [
    ['time', 'Time', 'By modification time'],
    ['name', 'Name', 'Alphabetical (numbers in order)'],
    ['size', 'Size', 'By file size'],
  ]) {
    const on = !custom && sortBy.key === key,
      b = Object.assign(document.createElement('button'), {
        textContent: text + (on ? (sortBy.dir > 0 ? ' ↑' : ' ↓') : ''),
        title: title + (on ? ' · click to reverse' : ''),
      });
    b.classList.toggle('on', on);
    b.onclick = () => setSort(key);
    sorter.append(b);
  }
  views.append(sorter, scrollHint('to-start', '▲', 'Back to the first file'));
  // Discovered-folder list (F) and fuzzy folder search sit above the open folder; keep typing focus across repaints.
  const sec = document.createElement('div');
  sec.className = 'dir-section';
  $('sidebar').append(sec, views);
  sec.append(foldersEl, pathBoxEl);
  if (pathTyping) {
    $('path').focus();
    $('path').setSelectionRange(...pathTyping);
  }
  // Folder navigation: up one level, then the subfolders of the open folder.
  if (state.dir) {
    // Open folder (long paths cut from the left, full path on hover) with a Browse… button beside it.
    const bar = document.createElement('div');
    bar.className = 'dir-bar';
    const path = Object.assign(document.createElement('span'), {
      className: 'dir-path',
      title: state.dir,
    });
    path.append(
      Object.assign(document.createElement('bdi'), {
        textContent: tilde(state.dir),
      }),
    );
    const browse = Object.assign(document.createElement('button'), {
      textContent: '📁 Browse…',
      title: 'Pick a folder (B or O)',
    });
    browse.onclick = () => $('browse').click();
    const wipe = Object.assign(document.createElement('button'), {
      textContent: '🧹',
      title: 'Remove all ratings, flags, comments and marks in this folder',
      disabled: !Object.values(state.items).some(hasReview),
    });
    wipe.setAttribute('aria-label', wipe.title);
    wipe.onclick = clearFolder;
    bar.append(path, browse, wipe);
    sec.append(bar);
    const nav = document.createElement('div');
    nav.className = 'folder-nav';
    const parent = state.dir.replace(/\/[^/]+\/?$/, '') || '/';
    if (state.dir !== '/') {
      const up = Object.assign(document.createElement('button'), {
        textContent: '↑ Up',
        title: 'Up one folder: ' + parent,
      });
      up.onclick = () => openFolder(parent);
      nav.append(up);
    }
    for (const name of state.subfolders) {
      const n = state.subCounts[name],
        b = Object.assign(document.createElement('button'), {
          textContent: '📁 ' + name,
          title: 'Open ' + name + (n != null ? ` (${n} files)` : ''),
        });
      if (n != null)
        b.append(
          Object.assign(document.createElement('span'), {
            className: 'sub-count',
            textContent: n,
          }),
        );
      b.onclick = () =>
        openFolder((state.dir === '/' ? '' : state.dir) + '/' + name);
      nav.append(b);
    }
    if (nav.childElementCount) sec.append(nav);
  }
  if (loadOrder().length) {
    const bar = document.createElement('div');
    bar.className = 'order-bar';
    const reset = Object.assign(document.createElement('button'), {
      textContent: 'Reset',
      title: 'Back to the chosen sort order',
    });
    reset.onclick = () => setSort(sortBy.key, true);
    bar.append('Custom order (drag to sort)', reset);
    $('sidebar').append(bar);
  }
  let rated = 0;
  const list = document.createElement('div');
  list.className = 'files';
  $('sidebar').append(list, scrollHint('to-end', '▼', 'To the last file'));
  state.files.forEach((f, i) => {
    const item = state.items[f.name] || {},
      rating = item.flag || item.rating;
    if (rating) rated++;
    const tick = document.createElement('button');
    if (rating) {
      paintIcon(tick, rating);
      tick.hidden = false;
    }
    tick.title = f.name + ': ' + (rating ? nameOf(rating) : 'unrated');
    tick.setAttribute('aria-label', tick.title);
    tick.classList.toggle('current', i === state.index);
    tick.onclick = () => jump(i);
    $('ticks').append(tick);
    const row = document.createElement('button');
    row.className =
      'row' +
      (i === state.index ? ' current' : '') +
      (state.picked.has(f.name) ? ' picked' : '');
    row.dataset.name = f.name;
    row.title =
      f.name +
      (rating ? ' · ' + nameOf(rating) : '') +
      ' · drag to reorder · Ctrl+click to select several';
    if (rating) row.dataset.rating = rating;
    row.onclick = (e) => {
      if (dragged) return;
      if (e.ctrlKey || e.metaKey) {
        pick(f.name);
        return;
      }
      clearPicks();
      jump(i);
    };
    row.addEventListener('pointerdown', (e) => {
      if (e.button === 0)
        drag = {
          from: i,
          x: e.clientX,
          y: e.clientY,
          row,
          active: false,
          to: null,
        };
    });
    const thumb = document.createElement(f.kind === 'image' ? 'img' : 'span');
    thumb.className = 'thumb' + (f.kind === 'audio' ? ' note' : '');
    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = f.name;
    // Grey line under the name: type · resolution (from the loaded thumbnail, cached) · file size.
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    const paintMeta = () => {
      meta.textContent = [fileType(f.name), dims[mediaUrl(f)], fileSize(f.size)]
        .filter(Boolean)
        .join(' · ');
    };
    if (f.kind === 'image') {
      thumb.loading = 'lazy';
      thumb.alt = '';
      thumb.onload = () => {
        dims[mediaUrl(f)] = `${thumb.naturalWidth}×${thumb.naturalHeight}`;
        paintMeta();
      };
      thumb.src = mediaUrl(f);
    } else thumb.textContent = '♪';
    paintMeta();
    const text = document.createElement('span');
    text.className = 'row-text';
    const when = Object.assign(document.createElement('span'), {
      className: 'row-meta row-date',
      textContent: shortDate(f.mtime),
      title: new Date(f.mtime * 1000).toLocaleString(),
    });
    text.append(name, meta, when);
    const badge = document.createElement('span');
    badge.className = 'badge';
    // Rated rows show the rating's icon (same as its button), unrated a dash.
    if (rating) paintIcon(badge, rating);
    else badge.textContent = '—';
    row.append(thumb, text, badge);
    if (item.comment) {
      const marker = document.createElement('span');
      marker.className = 'comment-marker';
      marker.textContent = '💬';
      marker.title = item.comment;
      row.append(marker);
    }
    if (item.pins?.length || item.strokes?.length) {
      const marker = document.createElement('span');
      marker.className = 'comment-marker';
      marker.textContent = '📍';
      marker.title = `${item.pins?.length || 0} pins · ${item.strokes?.length || 0} strokes`;
      row.append(marker);
    }
    list.append(row);
  });
  $('progress').textContent = `${rated}/${state.files.length} rated`;
  $('banner').hidden = !state.files.length || rated !== state.files.length;
  $('sidebar').querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  if (state.grid && current()) paintGrid();
  sideResize.disconnect();
  sideResize.observe($('sidebar'));
  sideResize.observe(list);
  paintScrollHints();
}

// Shadow under the sticky List/Grid bar (top) and a fade + arrow at the bottom of the sidebar, only while there is more to scroll that way.
function paintScrollHints() {
  const s = $('sidebar');
  s.classList.toggle('more-up', s.scrollTop > 2);
  s.classList.toggle(
    'more-down',
    s.scrollTop + s.clientHeight < s.scrollHeight - 2,
  );
}

// ▲ under the List/Grid bar and ▼ at the bottom: shown while there is more to scroll, click to jump to that end.
function scrollHint(cls, arrow, title) {
  const box = document.createElement('div');
  box.className = 'scroll-hint ' + cls;
  const b = Object.assign(document.createElement('button'), {
    type: 'button',
    textContent: arrow,
    title,
  });
  b.setAttribute('aria-label', title);
  b.onclick = () =>
    $('sidebar').scrollTo({
      top: cls === 'to-start' ? 0 : $('sidebar').scrollHeight,
      behavior: 'smooth',
    });
  box.append(b);
  return box;
}

const hasReview = (item) =>
  !!(
    item.rating ||
    item.flag ||
    item.comment ||
    item.pins?.length ||
    item.strokes?.length
  );

// 🧹 beside Browse…: clears every review in the open folder (also the copies embedded in PNGs), after a confirmation.
function clearFolder() {
  const names = Object.keys(state.items).filter((n) =>
    hasReview(state.items[n]),
  );
  if (
    !names.length ||
    !confirm(
      `Remove all ratings, flags, comments, pins and strokes from ${names.length} file${names.length > 1 ? 's' : ''} in ${tilde(state.dir)}?\n\nThis cannot be undone.`,
    )
  )
    return;
  transact(async () => {
    try {
      for (const name of names) {
        const result = await api('/api/review', {
          dir: state.dir,
          name,
          rating: null,
          flag: null,
          comment: '',
          pins: [],
          strokes: [],
        });
        state.items = result.items;
      }
    } finally {
      // Repaint what was cleared even when a later file fails.
      if (!multiOn())
        $('comment').value = state.items[current()?.name]?.comment || '';
      paintCommentTool();
      paintLists();
      paintRating();
      paintMarks();
      paintPinList();
      if (!$('viewer').hidden) paintPeek();
    }
  });
}

// Sidebar look: 'list' (thumbnail, name, details) or 'grid' (thumbnails only, 3 per row). Kept per browser.
let sideView = 'list';

function setSideView(mode) {
  sideView = mode === 'grid' ? 'grid' : 'list';
  document.body.classList.toggle('side-grid', sideView === 'grid');
  store('sideView', sideView);
  paintLists();
}

function setList(on) {
  document.body.classList.toggle('list-off', !on);
  if (!on && !state.grid) clearPicks();
  $('set-list').checked = on;
  $('list-btn').setAttribute('aria-pressed', on);
  store('list', on ? '1' : '0');
  if (!$('viewer').hidden) resetView();
}

// Sidebar drag to reorder (pointer events: Firefox can't drag <button> natively). The order is per folder,
// in this browser only; files not in it (new ones) go to the bottom, oldest first.
let drag = null,
  dragged = false;

const orderKey = () => 'order:' + state.dir;

function loadOrder() {
  return storedJSON(orderKey()) || [];
}

let sortBy = { key: 'time', dir: 1 };

function sortFiles(list) {
  const { key, dir: d } = sortBy,
    byName = (a, b) =>
      a.name.localeCompare(b.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
  return list
    .slice()
    .sort(
      (a, b) =>
        d *
          (key === 'name'
            ? byName(a, b)
            : key === 'size'
              ? a.size - b.size
              : a.mtime - b.mtime) || byName(a, b),
    );
}

// Picking a sort drops any dragged custom order; the active sort again reverses it (keep=true only re-applies it).
function setSort(key, keep = false) {
  if (!keep)
    sortBy =
      sortBy.key === key && !loadOrder().length
        ? { key, dir: -sortBy.dir }
        : { key, dir: key === 'size' ? -1 : 1 };
  store('sortBy', JSON.stringify(sortBy));
  const name = current()?.name;
  saveOrder(null);
  state.files = sortFiles(state.files);
  state.index = Math.max(
    state.files.findIndex((f) => f.name === name),
    0,
  );
  paintLists();
  if (state.grid) paintCard();
}

function saveOrder(names) {
  store(orderKey(), names ? JSON.stringify(names) : null);
}

function arrange(list) {
  const pos = new Map(loadOrder().map((n, i) => [n, i]));
  if (!pos.size) return list;
  return [
    ...list
      .filter((f) => pos.has(f.name))
      .sort((a, b) => pos.get(a.name) - pos.get(b.name)),
    ...list.filter((f) => !pos.has(f.name)),
  ];
}

function clearDropMarks() {
  $('sidebar')
    .querySelectorAll('.drop-before,.drop-after')
    .forEach((r) => r.classList.remove('drop-before', 'drop-after'));
}

function initSidebar() {
  sideResize = new ResizeObserver(() => paintScrollHints());

  $('sidebar').addEventListener('scroll', paintScrollHints, { passive: true });

  $('set-list').onchange = (e) => setList(e.target.checked);

  $('list-btn').onclick = () =>
    setList(document.body.classList.contains('list-off'));

  setList(stored('list') !== '0');

  sideView = stored('sideView') === 'grid' ? 'grid' : 'list';

  document.body.classList.toggle('side-grid', sideView === 'grid');

  sortBy = { ...sortBy, ...storedJSON('sortBy') };

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.active = true;
      drag.row.classList.add('dragging');
      document.body.classList.add('sorting');
    }
    const rows = [...$('sidebar').querySelectorAll('.row')];
    // List: before the first row whose middle is below the pointer. Grid: also left of a tile's middle in its line.
    const tiles = sideView === 'grid';
    let to = rows.findIndex((r) => {
      const b = r.getBoundingClientRect();
      return tiles
        ? e.clientY < b.top ||
            (e.clientY < b.bottom && e.clientX < b.left + b.width / 2)
        : e.clientY < b.top + b.height / 2;
    });
    if (to < 0) to = rows.length;
    drag.to = to;
    clearDropMarks();
    if (to < rows.length) rows[to].classList.add('drop-before');
    else rows[rows.length - 1]?.classList.add('drop-after');
    const box = $('sidebar').getBoundingClientRect();
    if (e.clientY < box.top + 40) $('sidebar').scrollBy(0, -14);
    else if (e.clientY > box.bottom - 40) $('sidebar').scrollBy(0, 14);
  });

  document.addEventListener('pointerup', () => {
    const d = drag;
    drag = null;
    if (!d?.active) return;
    d.row.classList.remove('dragging');
    document.body.classList.remove('sorting');
    clearDropMarks();
    // The click that ends a drag must not open the row; reset after this event loop turn either way.
    dragged = true;
    setTimeout(() => {
      dragged = false;
    }, 0);
    if (d.to == null || d.to === d.from || d.to === d.from + 1) return;
    const name = current()?.name,
      [f] = state.files.splice(d.from, 1);
    state.files.splice(d.to > d.from ? d.to - 1 : d.to, 0, f);
    state.index = state.files.findIndex((x) => x.name === name);
    saveOrder(state.files.map((x) => x.name));
    paintLists();
  });
}

// ── marks ──

// Marks: numbered pins with notes and pen strokes, stored with the review in 0..1 image coordinates.
// They are drawn in an overlay sized to the shown picture (single view and fullscreen), never into the file.
let markMode = null,
  pen = null;

const marksOf = (name) => state.items[name] || {};

function marksLayer(name) {
  const layer = document.createElement('div');
  layer.className = 'marks';
  layer.dataset.name = name;
  layer.innerHTML = '<svg viewBox="0 0 1 1" preserveAspectRatio="none"></svg>';
  fillMarks(layer);
  return layer;
}

const pathD = (pts) =>
  pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join('') +
  (pts.length === 1 ? 'l0 0' : '');

// Pin note editor floating beside the pin: Enter or clicking away saves, Esc closes without saving.
const shownLayer = () =>
  $('viewer').hidden
    ? $('media').querySelector(':scope>.marks')
    : $('viewer').querySelector(':scope>.marks');

function editPin(i) {
  const layer = shownLayer(),
    f = current();
  if (!layer || !f) return;
  layer.querySelector('.pin-edit')?.remove();
  const pins = marksOf(f.name).pins || [],
    pin = pins[i];
  if (!pin) return;
  const ed = Object.assign(document.createElement('input'), {
    className: 'pin-edit',
    value: pin.note || '',
    placeholder: `Note for pin ${i + 1}`,
  });
  Object.assign(ed.style, { left: pin.x * 100 + '%', top: pin.y * 100 + '%' });
  ed.classList.toggle('flip', pin.x > 0.7);
  let done = false;
  const close = (keep) => {
    if (done) return;
    done = true;
    ed.remove();
    if (
      keep &&
      ed.value.trim() !== (pin.note || '') &&
      current()?.name === f.name
    )
      saveMarks({
        pins: pins.map((p, j) => (j === i ? { ...p, note: ed.value } : p)),
      });
  };
  ed.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(false);
    }
  };
  ed.onblur = () => close(true);
  ed.onpointerdown = (e) => e.stopPropagation();
  layer.append(ed);
  ed.focus();
}

function fillMarks(layer) {
  const { pins = [], strokes = [] } = marksOf(layer.dataset.name),
    svg = layer.querySelector('svg');
  svg.innerHTML = strokes
    .map((st) => {
      const d = pathD(st.pts);
      return `<path class="halo" d="${d}"/><path class="ink" d="${d}" stroke="${st.color}"/>`;
    })
    .join('');
  layer.querySelectorAll('.pin').forEach((p) => p.remove());
  pins.forEach((pin, i) => {
    const el = document.createElement('div');
    el.className = 'pin';
    el.textContent = i + 1;
    el.title = pin.note || '(no note)';
    Object.assign(el.style, {
      left: pin.x * 100 + '%',
      top: pin.y * 100 + '%',
    });
    el.onpointerdown = (e) => {
      if (markMode || !$('viewer').hidden) e.stopPropagation();
    };
    el.onclick = (e) => {
      e.stopPropagation();
      if (!$('viewer').hidden || !single.dragged) editPin(i);
    };
    layer.append(el);
  });
}

function paintMarks() {
  document.querySelectorAll('.marks').forEach(fillMarks);
}

// Sizes the single-view overlay to the picture inside its object-fit:contain box.
function placeMarks() {
  const img = $('media').querySelector(':scope>img'),
    layer = $('media').querySelector(':scope>.marks');
  if (!img || !layer || !img.naturalWidth) return;
  const r = img.getBoundingClientRect(),
    m = $('media').getBoundingClientRect();
  const k = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight),
    w = img.naturalWidth * k,
    h = img.naturalHeight * k;
  Object.assign(layer.style, {
    left: r.left - m.left + (r.width - w) / 2 + 'px',
    top: r.top - m.top + (r.height - h) / 2 + 'px',
    width: w + 'px',
    height: h + 'px',
  });
}

// Right-sidebar layout: the marks panel docks under the mark tools when the sidebar still fits the window,
// otherwise it floats over the picture as in the bottom layout.
function placeMarksPanel() {
  const b = document.body;
  b.classList.toggle(
    'marks-dock',
    b.classList.contains('side') && !$('marks-panel').hidden,
  );
  if (
    b.classList.contains('marks-dock') &&
    !$('details').hidden &&
    $('details').getBoundingClientRect().height < 70
  )
    b.classList.remove('marks-dock');
}

// Right-hand panel over the picture, listing pins (with notes) and strokes; shown only when there is something to list.
function paintPinList() {
  const f = current(),
    { pins = [], strokes = [] } = f ? marksOf(f.name) : {};
  $('marks-panel').hidden =
    state.grid ||
    !f ||
    f.kind !== 'image' ||
    !(pins.length || strokes.length || markMode);
  requestAnimationFrame(placeMarksPanel);
  const strokeRows = strokes.map((st, i) => {
    const li = document.createElement('li');
    const sw = Object.assign(document.createElement('span'), {
      className: 'swatch',
    });
    sw.style.background = st.color;
    const name = Object.assign(document.createElement('input'), {
      value: st.note || '',
      placeholder: 'Stroke ' + (i + 1),
      title: 'Name this stroke',
    });
    name.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        name.blur();
      }
    };
    name.onblur = () => {
      if (name.value.trim() !== (st.note || ''))
        saveMarks({
          strokes: strokes.map((q, j) =>
            j === i ? { ...q, note: name.value } : q,
          ),
        });
    };
    const del = Object.assign(document.createElement('button'), {
      textContent: '✕',
      title: 'Remove stroke ' + (i + 1),
    });
    del.onclick = () =>
      saveMarks({ strokes: strokes.filter((_, j) => j !== i) });
    li.append(sw, name, del);
    return li;
  });
  const empty =
    !pins.length && !strokes.length
      ? [
          Object.assign(document.createElement('li'), {
            className: 'stroke-name',
            textContent:
              markMode === 'pin'
                ? 'Click the image to drop a pin'
                : 'Drag on the image to draw',
          }),
        ]
      : [];
  $('pin-list').replaceChildren(
    ...empty,
    ...pins.map((pin, i) => {
      const li = document.createElement('li');
      const no = Object.assign(document.createElement('span'), {
        className: 'pin-no',
        textContent: i + 1,
      });
      const note = Object.assign(document.createElement('input'), {
        value: pin.note || '',
        placeholder: 'Note for pin ' + (i + 1),
      });
      const commit = () => {
        if (note.value.trim() === (pin.note || '')) return;
        saveMarks({
          pins: pins.map((p, j) => (j === i ? { ...p, note: note.value } : p)),
        });
      };
      note.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          note.blur();
        }
      };
      note.onblur = commit;
      const del = Object.assign(document.createElement('button'), {
        textContent: '✕',
        title: 'Remove pin ' + (i + 1),
      });
      del.onclick = () => saveMarks({ pins: pins.filter((_, j) => j !== i) });
      li.append(no, note, del);
      return li;
    }),
    ...strokeRows,
  );
}

function setMarkMode(mode) {
  if (mode && state.grid) setGrid(false);
  markMode = mode;
  $('mark-opts').dataset.mode = mode || '';
  for (const el of [$('media'), $('viewer')]) {
    el.classList.toggle('mode-pin', mode === 'pin');
    el.classList.toggle('mode-draw', mode === 'draw');
  }
  $('pin-tool').classList.toggle('on', mode === 'pin');
  $('draw-tool').classList.toggle('on', mode === 'draw');
  $('zoom-level')
    .querySelector('[data-k="A"]')
    .classList.toggle('on', mode === 'pin');
  $('zoom-level')
    .querySelector('[data-k="D"]')
    .classList.toggle('on', mode === 'draw');
  if (mode) setMarksHidden(false);
  paintPinList();
}

function setMarksHidden(off) {
  document.body.classList.toggle('marks-off', off);
  $('hide-tool').classList.toggle('on', off);
  if (off && markMode) setMarkMode(null); // hidden marks can't be edited, so drop the active tool
  store('marksOff', off ? '1' : '0');
}

// Undo takes back the newest pin or stroke: the ones added in this tab, newest first, then strokes, then pins.
const added = [];

function undoStroke() {
  const f = current();
  if (!f) return;
  const { pins = [], strokes = [] } = marksOf(f.name),
    k = added.findLastIndex((a) => a.name === f.name);
  let kind =
    k >= 0 ? added.splice(k, 1)[0].kind : strokes.length ? 'stroke' : 'pin';
  if (kind === 'stroke' && !strokes.length) kind = 'pin';
  else if (kind === 'pin' && !pins.length) kind = 'stroke';
  if (kind === 'stroke' && strokes.length)
    saveMarks({ strokes: strokes.slice(0, -1) });
  else if (kind === 'pin' && pins.length)
    saveMarks({ pins: pins.slice(0, -1) });
}

const unitPoint = (e, layer) => {
  const b = layer.getBoundingClientRect();
  const c = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 1e4) / 1e4;
  return [c((e.clientX - b.left) / b.width), c((e.clientY - b.top) / b.height)];
};

function startMark(e, layer) {
  if (!layer || !markMode || e.button !== 0 || state.busy) return false;
  // The previous picture stays visible while the next one decodes: no marks on it for the wrong file.
  if (layer.dataset.name !== current()?.name) {
    e.preventDefault();
    return true;
  }
  e.preventDefault();
  const q = unitPoint(e, layer);
  if (markMode === 'pin') {
    const pins = [
      ...(marksOf(current().name).pins || []),
      { x: q[0], y: q[1], note: '' },
    ];
    added.push({ name: current().name, kind: 'pin' });
    saveMarks({ pins }).then(() => editPin(pins.length - 1));
    return true;
  }
  layer.setPointerCapture(e.pointerId);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'ink');
  path.setAttribute('stroke', $('mark-color').value);
  layer.querySelector('svg').append(path);
  pen = { layer, path, pts: [q], free: [q], at: q, id: e.pointerId };
  path.setAttribute('d', pathD(pen.pts));
  return true;
}

// Shift draws a straight line from the start point, Ctrl+Shift a circle around it (radius = drag distance);
// without modifiers the stroke follows the shape picked in the fullscreen pen row (freehand by default).
// The modifiers held when the button is released decide.
let penShape = 'free';

function setPenShape(shape) {
  penShape = shape;
  document
    .querySelectorAll('.pen-shapes [data-shape]')
    .forEach((b) => b.classList.toggle('on', b.dataset.shape === shape));
}

// The options row sits in the marks panel in single view and moves into the fullscreen legend.
function placeMarkOpts() {
  if ($('viewer').hidden)
    $('marks-panel').querySelector('.panel-head').after($('mark-opts'));
  else $('zoom-level').prepend($('mark-opts'));
}

function shapePen(shift, ctrl) {
  const [sx, sy] = pen.free[0],
    [x, y] = pen.at;
  if (!shift && !ctrl && penShape !== 'free') {
    shift = true;
    ctrl = penShape === 'circle';
  }
  if (shift && ctrl) {
    const b = pen.layer.getBoundingClientRect(),
      r = Math.hypot((x - sx) * b.width, (y - sy) * b.height),
      c = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 1e4) / 1e4;
    pen.pts = Array.from({ length: 65 }, (_, i) => {
      const a = (i / 64) * 2 * Math.PI;
      return [
        c(sx + (r * Math.cos(a)) / b.width),
        c(sy + (r * Math.sin(a)) / b.height),
      ];
    });
  } else pen.pts = shift ? [pen.free[0], pen.at] : pen.free;
  pen.path.setAttribute('d', pathD(pen.pts));
}

function initMarks() {
  setMarksHidden(stored('marksOff') === '1');

  $('pin-tool').onclick = () => setMarkMode(markMode === 'pin' ? null : 'pin');

  $('draw-tool').onclick = () =>
    setMarkMode(markMode === 'draw' ? null : 'draw');

  $('hide-tool').onclick = () =>
    setMarksHidden(!document.body.classList.contains('marks-off'));

  $('undo-tool').onclick = undoStroke;

  // P and D work the same in fullscreen: there the whole screen takes the clicks and points outside
  // the picture are ignored.
  $('media').addEventListener('pointerdown', (e) =>
    startMark(e, e.target.closest('#media>.marks')),
  );

  document.querySelectorAll('.pen-shapes [data-shape]').forEach((b) => {
    b.onclick = (e) => {
      e.stopPropagation();
      setPenShape(b.dataset.shape);
    };
    if (b.dataset.shape !== 'free')
      b.title = `${b.lastChild.textContent}: every stroke (or hold ${b.querySelector('kbd').textContent} for one)`;
  });

  {
    const k = document.querySelector('.pen-colour'),
      paint = () =>
        (k.querySelector('.swatch').style.background = $('mark-color').value);
    k.onclick = (e) => {
      e.stopPropagation();
      $('mark-color').click();
    };
    $('mark-color').addEventListener('input', paint);
    paint();
  }

  document.querySelectorAll('#mark-opts .mark-off').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        setMarkMode(null);
      }),
  );

  for (const t of ['pointerdown', 'pointerup'])
    $('mark-opts').addEventListener(t, (e) => e.stopPropagation());

  placeMarkOpts();

  // Right-click on the picture drops the active pen or pin tool (text fields and the rest of the page keep their own menu).
  document.addEventListener('contextmenu', (e) => {
    if (
      markMode &&
      e.target.closest?.('#viewer,#media,#marks-panel') &&
      !['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)
    ) {
      e.preventDefault();
      setMarkMode(null);
    }
  });

  document.addEventListener('pointermove', (e) => {
    if (!pen || e.pointerId !== pen.id) return;
    const q = unitPoint(e, pen.layer),
      last = pen.free[pen.free.length - 1];
    pen.at = q;
    if (Math.hypot(q[0] - last[0], q[1] - last[1]) >= 0.002) pen.free.push(q);
    shapePen(e.shiftKey, e.ctrlKey || e.metaKey);
  });

  for (const type of ['keydown', 'keyup'])
    document.addEventListener(type, (e) => {
      if (pen && (e.key === 'Shift' || e.key === 'Control' || e.key === 'Meta'))
        shapePen(e.shiftKey, e.ctrlKey || e.metaKey);
    });

  document.addEventListener('pointercancel', (e) => {
    if (pen && e.pointerId === pen.id) {
      pen.path.remove();
      pen = null;
    }
  });

  document.addEventListener('pointerup', (e) => {
    if (pen && e.pointerId !== pen.id) return;
    const p = pen;
    pen = null;
    if (p && p.layer.dataset.name === current()?.name)
      added.push({ name: p.layer.dataset.name, kind: 'stroke' });
    if (p && p.layer.dataset.name === current()?.name)
      saveMarks({
        strokes: [
          ...(marksOf(current().name).strokes || []),
          { pts: p.pts, color: $('mark-color').value },
        ],
      });
  });
}

// ── settings ──

function setLayout(side) {
  document.body.classList.toggle('side', side);
  $('set-side').checked = side;
  $('layout-btn').setAttribute('aria-pressed', side);
  store('layout', side ? 'side' : 'bottom');
  if (!$('viewer').hidden) resetView();
  if (typeof placeMarksPanel === 'function') placeMarksPanel();
}

function setPeek(on) {
  document.body.classList.toggle('peek-off', !on);
  $('set-peek').checked = on;
  store('peek', on ? '1' : '0');
}

// Settings switch that hides the file details box entirely (its expanded state is separate).
function setShowDetails(on) {
  document.body.classList.toggle('no-details', !on);
  $('set-details').checked = on;
  store('showDetails', on ? '1' : '0');
}

// Settings switch for the pen / pin / zoom hint bars (off: keys still work, the zoom box shows the level instead).
function setHints(on) {
  document.body.classList.toggle('no-hints', !on);
  $('set-hints').checked = on;
  store('hints', on ? '1' : '0');
  if (typeof paintZoomOpts === 'function') {
    paintZoomOpts();
    paintZoomBox();
  }
}

// Sidebar pictures: scales each file row/tile in the sidebar (60–100%); folder controls stay full size.
function setSideScale(pct) {
  pct = Math.min(100, Math.max(60, +pct || 100));
  $('set-side-scale').value = pct;
  $('side-scale-out').value = pct + '%';
  document.body.style.setProperty('--side-scale', pct / 100);
  store('sideScale', pct);
}

// Left sidebar size (50–100%): narrows the file list column and scales everything in it, folder controls too.
function setLsScale(pct) {
  pct = Math.min(100, Math.max(50, +pct || 100));
  $('set-ls-width').value = pct;
  $('ls-width-out').value = pct + '%';
  document.body.style.setProperty('--ls-scale', pct / 100);
  store('lsScale', pct);
}

// Right sidebar size (50–100%): narrows the column and scales its buttons and text with it.
function setRsScale(pct) {
  pct = Math.min(100, Math.max(50, +pct || 100));
  $('set-rs-width').value = pct;
  $('rs-width-out').value = pct + '%';
  document.body.style.setProperty('--rs-scale', pct / 100);
  store('rsScale', pct);
  if (typeof placeMarksPanel === 'function') placeMarksPanel();
}

function setMenu(open) {
  $('settings-menu').hidden = !open;
  $('settings').setAttribute('aria-expanded', open);
}

// A click outside open settings only closes them: it does not also zoom, rate or open the picture.
let eatClick = false;

// Unnamed custom buttons are hidden and their keys do nothing (unless the file already carries that flag).
function paintCustoms() {
  const shown = customs.filter(
    (v) => state.customNames[v] || state.folderLabels[v],
  );
  for (const v of customs) {
    const b = document.querySelector(`#ratings button[data-rating="${v}"]`),
      name = nameOf(v);
    b.hidden = !shown.includes(v);
    b.title = `${name} (${b.dataset.key})`;
    b.querySelector('.rating-word').textContent = name;
  }
  $('ratings').querySelectorAll('.flag-sep')[2].hidden = !shown.length;
  document.body.classList.toggle('customs', shown.length > 0);
  if (state.files.length) paintLists();
}

// Button colour, icon and title overrides (Settings → Buttons), kept per browser.
const defaultTone = {},
  symOf = (v) =>
    state.btnStyle[v]?.icon ||
    (buttons.find((x) => x && x[1] === v) || [])[2] ||
    '';

function saveBtnStyle() {
  for (const v in state.btnStyle)
    if (!Object.values(state.btnStyle[v]).some(Boolean))
      delete state.btnStyle[v];
  store('btnStyle', JSON.stringify(state.btnStyle));
}

function paintBtnStyle() {
  const root = document.documentElement;
  for (const b of $('ratings').querySelectorAll('button[data-rating]')) {
    const v = b.dataset.rating,
      st = state.btnStyle[v] || {};
    if (st.color) root.style.setProperty('--' + v, st.color);
    else root.style.removeProperty('--' + v);
    const icon = b.querySelector('.rating-icon'),
      sym = symOf(v);
    if (sym.startsWith('<svg')) icon.innerHTML = sym;
    else icon.textContent = sym;
    b.querySelector('.rating-word').textContent = nameOf(v);
    b.title = `${nameOf(v)} (${b.dataset.key})`;
  }
  for (const row of document.querySelectorAll('.btn-row')) {
    const v = row.dataset.v;
    row.querySelector('[type=color]').value =
      state.btnStyle[v]?.color || defaultTone[v];
    row.querySelector('.btn-icon').value = state.btnStyle[v]?.icon || '';
    if (!customs.includes(v))
      row.querySelector('input:not([type])').value =
        state.btnStyle[v]?.name || '';
  }
  paintCustoms();
}

// Bottom layout: the details box is at most as tall as the rating buttons; a click shows the rest, the next one shrinks it back.
function fitDetails() {
  const h = $('ratings').offsetHeight,
    d = $('details');
  document.body.style.setProperty('--bar-h', h ? h + 'px' : 'none');
  document.body.style.setProperty('--det-h', d.scrollHeight + 'px'); // side layout: keeps the details row from being squeezed by the spacer rows
  d.classList.toggle(
    'more',
    !document.body.classList.contains('details-full') &&
      d.scrollHeight > d.clientHeight + 1,
  );
}

let detailsObserver;

function setDetails(mode) {
  document.body.classList.toggle('details-full', mode === 'full');
  store('details', mode);
  fitDetails();
}

function initSettings() {
  detailsObserver = new ResizeObserver(fitDetails);

  $('set-side').onchange = (e) => setLayout(e.target.checked);

  $('layout-btn').onclick = () =>
    setLayout(!document.body.classList.contains('side'));

  $('set-peek').onchange = (e) => setPeek(e.target.checked);

  setPeek(stored('peek') !== '0');

  $('set-details').onchange = (e) => setShowDetails(e.target.checked);

  $('set-hints').onchange = (e) => setHints(e.target.checked);

  setHints(stored('hints') !== '0');

  $('set-ls-width').oninput = (e) => setLsScale(e.target.value);

  setLsScale(stored('lsScale') || 100);

  $('set-side-scale').oninput = (e) => setSideScale(e.target.value);

  setSideScale(stored('sideScale') || 100);

  $('set-rs-width').oninput = (e) => setRsScale(e.target.value);

  setRsScale(stored('rsScale') || 100);

  setShowDetails(stored('showDetails') !== '0');

  // Key hint bar: small by default, click toggles a bigger size (kept per browser).
  {
    const h = document.querySelector('main>.hint');
    h.title = 'Click to resize';
    const setBig = (on) => {
      h.classList.toggle('big', on);
      store('hintBig', on ? '1' : '0');
    };
    const setVisible = (on) => {
      h.hidden = !on;
      $('set-keybind-note').checked = on;
      store('keybindNote', on ? '1' : '0');
    };
    $('set-keybind-note').onchange = (e) => setVisible(e.target.checked);
    $('close-keybind-note').onclick = (e) => {
      e.stopPropagation();
      setVisible(false);
    };
    setVisible(stored('keybindNote') !== '0');
    h.onclick = () => setBig(!h.classList.contains('big'));
    setBig(stored('hintBig') === '1');
  }

  $('settings').onclick = () => setMenu($('settings-menu').hidden);

  document.addEventListener(
    'pointerdown',
    (e) => {
      eatClick = false;
      if ($('settings-menu').hidden || $('settings-box').contains(e.target))
        return;
      setMenu(false);
      eatClick = true;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  for (const t of ['click', 'pointerup'])
    document.addEventListener(
      t,
      (e) => {
        if (!eatClick) return;
        e.preventDefault();
        e.stopPropagation();
        if (t === 'click') eatClick = false;
      },
      true,
    );

  // A gesture that ends without a click (touch scroll, release outside) must not swallow a later one.
  for (const t of ['pointerup', 'pointercancel'])
    document.addEventListener(
      t,
      () =>
        setTimeout(() => {
          eatClick = false;
        }),
      true,
    );

  document.addEventListener(
    'keydown',
    () => {
      eatClick = false;
    },
    true,
  );

  for (const v of customs) {
    const input = $('name-' + v);
    input.value = state.customNames[v] || '';
    input.oninput = () => {
      state.customNames[v] = input.value.trim();
      if (!state.customNames[v]) delete state.customNames[v];
      store('customNames', JSON.stringify(state.customNames));
      paintCustoms();
    };
    // × clears the name here and the one saved in the open folder, which otherwise keeps the button shown.
    $('x-' + v).onclick = async (e) => {
      e.preventDefault();
      input.value = '';
      delete state.customNames[v];
      store('customNames', JSON.stringify(state.customNames));
      try {
        if (state.dir && state.folderLabels[v])
          state.folderLabels =
            (await api('/api/forget-label', { dir: state.dir, label: v }))
              .labels || {};
      } catch (err) {
        toast(err.message);
      }
      paintCustoms();
    };
  }

  for (const entry of buttons) {
    if (!entry) continue;
    const [key, v, sym] = entry,
      cs = getComputedStyle(document.documentElement);
    defaultTone[v] = cs.getPropertyValue('--' + v).trim();
    let row = document.querySelector(`.btn-row[data-v="${v}"]`);
    if (!row) {
      row = Object.assign(document.createElement('label'), {
        className: 'set-row btn-row',
      });
      row.dataset.v = v;
      const name = Object.assign(document.createElement('input'), {
        maxLength: 40,
        placeholder: nameOf(v),
      });
      name.oninput = () => {
        (state.btnStyle[v] ??= {}).name = name.value.trim();
        saveBtnStyle();
        paintBtnStyle();
      };
      row.append(
        Object.assign(document.createElement('kbd'), {
          className: 'keycap',
          textContent: key,
        }),
        name,
      );
      $('btn-rows').append(row);
    }
    const color = Object.assign(document.createElement('input'), {
      type: 'color',
      title: 'Colour',
    });
    color.oninput = () => {
      (state.btnStyle[v] ??= {}).color = color.value;
      saveBtnStyle();
      paintBtnStyle();
    };
    const icon = Object.assign(document.createElement('input'), {
      type: 'text',
      className: 'btn-icon',
      maxLength: 4,
      title: 'Icon: any emoji or character, empty = default',
      placeholder: sym.startsWith('<svg') ? '👍' : sym,
    });
    icon.oninput = () => {
      (state.btnStyle[v] ??= {}).icon = icon.value.trim();
      saveBtnStyle();
      paintBtnStyle();
    };
    row.querySelector('kbd').after(color, icon);
  }

  $('btn-reset').onclick = () => {
    state.btnStyle = {};
    saveBtnStyle();
    paintBtnStyle();
  };

  paintBtnStyle();

  setLayout(stored('layout') === 'side');

  for (const id of ['ratings', 'details', 'fileinfo', 'genmeta'])
    detailsObserver.observe($(id));

  setDetails(stored('details') || 'on');

  $('details').title = 'Click to show all file details, click again to shrink';

  $('details').onclick = () => {
    if (String(getSelection()).trim()) return; // selecting text (e.g. a prompt) is not a click
    const b = document.body.classList;
    if (b.contains('details-full')) setDetails('on');
    else if ($('details').classList.contains('more')) setDetails('full');
  };
}

// ── folders ──

const whenIdle = async () => {
  for (let t = 0; state.busy && t < 200; t++)
    await new Promise((r) => setTimeout(r, 50));
};

async function openFolder(raw) {
  await whenIdle();
  return transact(async () => {
    await saveComment();
    const result = await api('/api/list?' + new URLSearchParams({ dir: raw }));
    if (result.dir !== state.dir) {
      state.picked.clear();
      paintPicks();
    }
    state.dir = result.dir;
    state.files = arrange(sortFiles(result.files));
    state.items = result.items;
    state.folderLabels = result.labels || {};
    paintCustoms();
    const subs = await api(
      '/api/subdirs?counts=1&path=' + encodeURIComponent(state.dir),
    ).catch(() => ({ names: [] }));
    state.subfolders = subs.names.filter((n) => !n.startsWith('.'));
    state.subCounts = subs.counts || {};
    state.index = state.files.findIndex(
      (f) => !state.items[f.name]?.rating && !state.items[f.name]?.flag,
    );
    if (state.index < 0) state.index = 0;
    $('path').value = '';
    $('folders').value = state.dir;
    history.replaceState(
      null,
      '',
      '?' + new URLSearchParams({ dir: state.dir }),
    );
    paintLists();
    paintCard();
  });
}

// Path field scope: the folders the server was started with (default), or all of home (opt in).
let homeSearch = false,
  pathBase = '~',
  serverHome = '',
  serverRoot = '';

const tilde = (p) =>
  serverHome && (p === serverHome || p.startsWith(serverHome + '/'))
    ? '~' + p.slice(serverHome.length)
    : p;

function setHomeSearch(on) {
  const nextBase = on || !serverRoot ? '~' : tilde(serverRoot);
  if (homeSearch !== on || pathBase !== nextBase) clearPathHints();
  homeSearch = on;
  $('set-home').checked = on;
  pathBase = nextBase;
  store('homeSearch', on ? '1' : '0');
  if (on) api('/api/find-dirs?scope=home').catch(() => {}); // starts the home scan before the first search
}

// First start in this browser: a small popup asks which scope to use. Esc keeps the start folder.
function askSearchOnce() {
  try {
    if (localStorage.getItem('searchAsked')) return;
    localStorage.setItem('searchAsked', '1');
  } catch {
    return;
  }
  const box = $('first-run');
  $('first-run-root').textContent =
    `Just the start folder (${tilde(serverRoot) || 'current folder'})`;
  const choose = (on) => {
    setHomeSearch(on);
    box.hidden = true;
  };
  $('first-run-root').onclick = () => choose(false);
  $('first-run-home').onclick = () => choose(true);
  box.onkeydown = (e) => {
    e.stopPropagation();
    if (!['Tab', 'Enter', ' '].includes(e.key)) e.preventDefault();
    if (e.key === 'Escape') choose(false);
  };
  box.hidden = false;
  $('first-run-root').focus();
}

// Path suggestions while typing, fuzzy matched against the subfolders of the folder typed so far.
// The field starts in the start folder (home when "Search all of home" is on): a path with a "/" but
// no leading / or ~ is read as relative to it, and a bare name searches every folder below it. Tab or → takes the highlighted one,
// ↑↓ move, Enter opens the highlighted one (or the typed path when none is highlighted), Esc closes.
let pathHints = [],
  pathPick = -1,
  pathTimer = 0,
  pathGeneration = 0;

function clearPathHints() {
  clearTimeout(pathTimer);
  pathGeneration++;
  showPathHints([], -1);
}

async function suggestPaths() {
  clearPathHints();
  const input = $('path'),
    typed = input.value,
    generation = pathGeneration,
    scope = homeSearch,
    base = pathBase;
  if (!typed || document.activeElement !== input) return;
  let items = [];
  if (!typed.includes('/')) {
    // A bare name searches every folder under the start folder, or under home when opted in (ranked on the server).
    const { dirs } = await api(
      '/api/find-dirs?q=' +
        encodeURIComponent(typed) +
        (scope ? '&scope=home' : ''),
    ).catch(() => ({ dirs: [] }));
    // Long paths lose their start, not the folder name that matched.
    items = dirs.map((d, k) => {
      const cut = Math.max(0, d.path.length - 58),
        label = cut ? '…' + d.path.slice(cut + 1) : d.path;
      return {
        path: d.path,
        label,
        hits: d.hits.map((h) => h - cut),
        score: k,
      };
    });
  } else {
    const full = basePath(typed),
      slash = full.lastIndexOf('/');
    const head = full.slice(0, slash),
      query = full.slice(slash + 1);
    const { matches } = await api(
      '/api/subdirs?' +
        new URLSearchParams({ path: head || '/', q: query, match: '1' }),
    ).catch(() => ({ matches: [] }));
    items = matches.map(({ name, score, hits }) => ({
      path: head + '/' + name + '/',
      label: name + '/',
      score,
      hits,
    }));
  }
  if (
    generation !== pathGeneration ||
    document.activeElement !== input ||
    input.value !== typed ||
    homeSearch !== scope ||
    pathBase !== base
  )
    return;
  // Skip folders the sidebar already shows: the open one, its parent and its subfolders.
  const strip = (p) => tilde(p.replace(/\/+$/, '') || '/'),
    shown = new Set(
      state.dir
        ? [
            state.dir,
            state.dir.replace(/\/[^/]+\/?$/, '') || '/',
            ...state.subfolders.map((n) => state.dir + '/' + n),
          ].map(strip)
        : [],
    );
  items = items.filter((it) => !shown.has(strip(it.path)));
  items.sort((a, b) => a.score - b.score);
  showPathHints(items.slice(0, 50), typed.endsWith('/') ? -1 : 0);
}

const basePath = (p) => (p && !/^[/~]/.test(p) ? pathBase + '/' + p : p);

function showPathHints(list, pick) {
  pathHints = list;
  pathPick = list.length ? pick : -1;
  const ul = $('path-hints');
  ul.replaceChildren(
    ...list.map((item, i) => {
      const li = document.createElement('li');
      li.title = item.path;
      li.classList.toggle('on', i === pathPick);
      const hits = new Set(item.hits);
      [...item.label].forEach((c, k) =>
        li.append(
          hits.has(k)
            ? Object.assign(document.createElement('b'), { textContent: c })
            : c,
        ),
      );
      li.onmousedown = (e) => {
        e.preventDefault();
        takePathHint(i);
      };
      return li;
    }),
  );
  ul.hidden = !list.length;
  ul.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  paintPathGhost();
}

// Grey inline rest of the highlighted suggestion, when it continues what was typed.
function paintPathGhost() {
  const input = $('path'),
    ghost = $('path-ghost'),
    item = pathHints[pathPick],
    v = input.value;
  const rest =
    item &&
    item.path.startsWith(v) &&
    input.selectionStart === v.length &&
    input.scrollWidth <= input.clientWidth
      ? item.path.slice(v.length)
      : '';
  ghost.replaceChildren(
    Object.assign(document.createElement('span'), {
      textContent: rest ? v : '',
    }),
    rest,
  );
}

function takePathHint(i) {
  const item = pathHints[i];
  if (!item) return;
  $('path').value = item.path;
  $('path').focus();
  suggestPaths();
}

// Live refresh every 10 s while the tab is visible: new folders appear in the
// dropdown, new files in the open folder, without touching the current card.
async function refreshDirs() {
  const { dirs, roots, home } = await api('/api/dirs'),
    selected = $('folders').value;
  serverHome = home || '';
  serverRoot = roots?.[0] || '';
  setHomeSearch(homeSearch);
  askSearchOnce();
  $('folders').replaceChildren(
    Object.assign(document.createElement('option'), {
      value: '',
      textContent: 'Choose a folder (F)',
    }),
  );
  for (const d of dirs) {
    const option = document.createElement('option');
    option.value = d.path;
    option.textContent = `${d.label} (${d.count})`;
    $('folders').append(option);
  }
  $('folders').value = selected;
  return dirs;
}

async function refreshFiles() {
  if (!state.dir || state.busy) return;
  const result = await api(
    '/api/list?' + new URLSearchParams({ dir: state.dir }),
  );
  if (state.busy || result.dir !== state.dir) return;
  const next = arrange(result.files),
    names = (f) => f.map((x) => x.name + x.mtime).join('/');
  if (names(next) === names(state.files)) return;
  const name = current()?.name;
  state.files = next;
  state.items = result.items;
  const i = state.files.findIndex((f) => f.name === name);
  state.index =
    i < 0 ? Math.min(state.index, Math.max(state.files.length - 1, 0)) : i;
  paintLists();
  if (current()?.name !== name) paintCard();
}

async function startFolders() {
  let dirs = [];
  try {
    dirs = await refreshDirs();
  } catch (e) {
    toast(e.message);
  }
  const initial =
    new URLSearchParams(location.search).get('dir') || dirs[0]?.path;
  if (initial) await openFolder(initial);
}

function initFolders() {
  $('set-home').onchange = (e) => setHomeSearch(e.target.checked);

  homeSearch = stored('homeSearch') === '1';

  setHomeSearch(homeSearch);

  $('open').onclick = () => {
    $('path').value = basePath($('path').value);
    openFolder($('path').value);
  };

  // A picked folder opens straight away. The comment is saved first; the dialog itself does not block the app.
  $('browse').onclick = async () => {
    await whenIdle();
    await transact(saveComment);
    try {
      const result = await api('/api/pick-folder', {
        initial: $('path').value || state.dir,
      });
      if (result.path) {
        $('path').value = result.path;
        openFolder(result.path);
      }
    } catch (e) {
      toast(e.message);
    }
  };

  $('path').onkeydown = (e) => {
    const open = pathHints.length > 0;
    if (e.key === 'Enter') {
      const item = pathHints[pathPick];
      if (item) $('path').value = item.path;
      clearPathHints();
      $('path').value = basePath($('path').value);
      openFolder($('path').value);
    } else if (e.key === 'Escape') {
      if (open) e.stopPropagation();
      clearPathHints();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open) {
      e.preventDefault();
      e.stopPropagation();
      const n = pathHints.length;
      showPathHints(
        pathHints,
        (pathPick +
          (e.key === 'ArrowDown' ? 1 : n - 1 + (pathPick < 0 ? 1 : 0))) %
          n,
      );
    } else if (e.key === 'Tab' && !e.shiftKey && open) {
      e.preventDefault();
      takePathHint(Math.max(pathPick, 0));
    } else if (e.key === 'ArrowRight' && $('path-ghost').textContent) {
      e.preventDefault();
      takePathHint(pathPick);
    }
  };

  $('path').oninput = () => {
    clearPathHints();
    pathTimer = setTimeout(suggestPaths, 80);
  };

  $('path').onfocus = () => {
    if (!$('path').value) {
      $('path').value = pathBase + '/';
      suggestPaths();
    }
  };

  $('path').onblur = () => {
    clearPathHints();
    if ($('path').value === pathBase + '/') $('path').value = '';
  };

  // Leave the dropdown after picking, so the arrow keys move through the files instead of the folders.
  $('folders').onchange = () => {
    $('folders').blur();
    if ($('folders').value) openFolder($('folders').value);
  };

  setInterval(() => {
    if (document.hidden || document.activeElement === $('folders')) return;
    refreshDirs().catch(() => {});
    refreshFiles().catch(() => {});
  }, 10000);
}

// ── keyboard ──

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (
      !$('viewer').hidden &&
      (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) &&
      !['TEXTAREA', 'INPUT'].includes(e.target.tagName)
    ) {
      e.preventDefault();
      closeViewer();
      return;
    }
    if (e.key === 'Escape' && !$('settings-menu').hidden) {
      setMenu(false);
      $('settings').focus();
      return;
    }
    // F1 opens or closes settings (the browser's own help is suppressed), also while typing.
    // In fullscreen it leaves the viewer first, since the menu sits below it.
    if (e.key === 'F1') {
      e.preventDefault();
      if (!$('viewer').hidden) {
        closeViewer();
        setMenu(true);
      } else setMenu($('settings-menu').hidden);
      return;
    }
    const typing =
      ['TEXTAREA', 'INPUT', 'SELECT'].includes(e.target.tagName) ||
      e.target.isContentEditable;
    if (e.key === 'Escape' && typing) {
      escTypedAt = performance.now();
      e.target.blur();
      if (e.target.id === 'comment') setCommentOpen(false);
      return;
    }
    // Comment field: Enter saves and closes it, Shift+Enter (or Ctrl+Enter) also moves to the next file.
    // When the file already has a rating or flag, plain Enter also moves on.
    if (
      e.key === 'Enter' &&
      e.target === $('comment') &&
      !e.isComposing &&
      !e.altKey
    ) {
      e.preventDefault();
      if (multiOn()) {
        const v = state.pickWait;
        state.pickWait = null;
        transact(() => applyPicks(v));
        e.target.blur();
        setCommentOpen(false);
        return;
      }
      const item = (current() && state.items[current().name]) || {};
      if (e.shiftKey || e.ctrlKey || item.rating || item.flag)
        jump(state.index + 1);
      e.target.blur();
      setCommentOpen(false);
      return;
    }
    if (e.key === 'Escape' && markMode) {
      setMarkMode(null);
      return;
    }
    if (
      e.key === 'Escape' &&
      document.body.classList.contains('comment-open')
    ) {
      setCommentOpen(false);
      return;
    }
    if (e.key === 'Escape' && state.picked.size) {
      clearPicks();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'z' && !typing && !state.busy) {
      e.preventDefault();
      undoStroke();
      return;
    }
    // Ctrl+Space: zoom back to fit (single view or fullscreen).
    if (e.ctrlKey && e.code === 'Space' && !typing) {
      e.preventDefault();
      if (!$('viewer').hidden) resetView();
      else if (!state.grid) {
        single.scale = 1;
        single.x = single.y = 0;
        paintSingle();
      }
      return;
    }
    // Shift+arrows pan a zoomed picture; plain arrows change pictures.
    if (
      !typing &&
      e.shiftKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
    ) {
      e.preventDefault();
      panBy(
        ...{
          ArrowLeft: [1, 0],
          ArrowRight: [-1, 0],
          ArrowUp: [0, 1],
          ArrowDown: [0, -1],
        }[e.key],
      );
      return;
    }
    // Rating keys pressed while a save is still running are queued and applied in order, not dropped.
    if (
      state.busy &&
      !typing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      keyAction[e.key === ',' ? '.' : e.key]
    ) {
      e.preventDefault();
      keyQueue.push(e.key === ',' ? '.' : e.key);
      return;
    }
    if (typing || state.busy || e.ctrlKey || e.metaKey || e.altKey) return;
    // Enter: fullscreen. A focused list row or grid tile selects that file first; other buttons keep their own Enter.
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      (e.target.tagName !== 'BUTTON' || e.target.closest('.row,.tile'))
    ) {
      e.preventDefault();
      if (e.target.closest?.('.row,.tile')) e.target.click();
      openViewer();
      return;
    }
    // ',' is the numpad decimal key on some layouts.
    const key = e.key === ',' ? '.' : e.key;
    if (
      keyAction[key] &&
      !document.querySelector(`#ratings button[data-key="${key}"]`).hidden
    ) {
      e.preventDefault();
      keyAction[key]();
    } else if (['+', '=', '-'].includes(e.key)) {
      e.preventDefault();
      const f = e.key === '-' ? 1 / 1.25 : 1.25;
      if (!$('viewer').hidden)
        zoomView(view.scale * f, innerWidth / 2, innerHeight / 2);
      else if (!state.grid) zoomSingle(f);
      else stepGrid(e.key === '-' ? -1 : 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      jump(state.index - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      jump(state.index + 1);
    } else if (
      ['w', 's'].includes(e.key.toLowerCase()) &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey
    ) {
      e.preventDefault();
      jump(state.index + (e.key.toLowerCase() === 'w' ? -1 : 1));
    } // W previous, S next
    else if (e.key.toLowerCase() === 'g') {
      e.preventDefault();
      setGrid(!state.grid);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      $('clear').click();
    } else if (['b', 'o'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      $('browse').click();
    }
    // Grid: ↑ ↓ move a row, PgUp/PgDn a page (3 rows). Single view: ↑ ↓ one file, PgUp/PgDn ten.
    // Moves stop at the first/last file; pressing again there jumps to the other end.
    else if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      const n =
          (e.key.startsWith('Page')
            ? state.grid
              ? gridSize.cols * gridSize.rows
              : 10
            : state.grid
              ? gridSize.cols
              : 1) * (e.key === 'ArrowUp' || e.key === 'PageUp' ? -1 : 1),
        last = state.files.length - 1;
      jump(
        n < 0 && state.index === 0
          ? last
          : n > 0 && state.index === last
            ? 0
            : Math.min(Math.max(state.index + n, 0), last),
      );
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      jump(e.key === 'Home' ? 0 : state.files.length - 1);
    } else if (e.key.toLowerCase() === 'f') {
      e.preventDefault();
      const f = $('folders');
      f.focus();
      try {
        f.showPicker();
      } catch {}
    } else if (e.key.toLowerCase() === 'l') {
      e.preventDefault();
      setList(document.body.classList.contains('list-off'));
    } else if (e.key.toLowerCase() === 'c') {
      e.preventDefault();
      setCommentOpen(true);
    } else if (e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setMarkMode(markMode === 'pin' ? null : 'pin');
    } else if (e.key.toLowerCase() === 'd') {
      e.preventDefault();
      setMarkMode(markMode === 'draw' ? null : 'draw');
    } else if (e.key.toLowerCase() === 'r') {
      e.preventDefault();
      $('mark-color').click();
    } else if (e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undoStroke();
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      jump(state.index + 1);
    } else if (e.key.toLowerCase() === 'h') {
      e.preventDefault();
      setMarksHidden(!document.body.classList.contains('marks-off'));
    } else if (e.code === 'Space') {
      // Audio card: play/pause. Otherwise (and always inside the grid): open/close the grid.
      e.preventDefault();
      const audio = !state.grid && $('media').querySelector('audio');
      if (audio) {
        if (audio.paused) audio.play().catch((e) => toast(e.message));
        else audio.pause();
      } else setGrid(!state.grid);
    }
  });
}

initState();
initReview();
initMedia();
initSidebar();
initMarks();
initSettings();
initFolders();
initKeyboard();
startFolders();
