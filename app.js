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
  pickDraft: null, // shared draft retained if live refresh removes the selection
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
  '/media?' +
  new URLSearchParams({
    dir: state.dir,
    name: f.name,
    v: `${f.mtime}:${f.size}`,
  });

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
  if (state.busy) return false;
  state.busy = true;
  document.body.classList.add('busy');
  $('comment').readOnly = true;
  let success = false;
  try {
    success = (await action()) !== false;
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
  return success;
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
    popRating(tag, now, item.flag || item.rating);
  else if (newComment) popRating(null);
  paintLists();
  paintRating();
  paintMarks();
  paintPinList(!marks);
  if (!$('viewer').hidden) paintPeek();
}

function saveMarks(marks) {
  const dir = state.dir,
    name = current()?.name;
  return transact(async () => {
    if (state.dir !== dir || current()?.name !== name)
      throw new Error('The selected file changed; marks were not saved.');
    const item = state.items[name] || {};
    // In multi-select the comment box holds the shared draft, not this file's comment.
    await save(
      item.rating || null,
      multiOn() ? item.comment || '' : $('comment').value,
      item.flag || null,
      marks,
    );
  });
}

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
  folderPick = -1;
  const dir = state.dir,
    name = state.files[(i + state.files.length) % state.files.length].name;
  return transact(async () => {
    if (state.dir !== dir)
      throw new Error('The folder changed; selection was not applied.');
    const pop = lastPop;
    await saveComment();
    clearPicks();
    // Comment saved on the way out (e.g. Redo + comment, Enter): its pop swipes off like a rating that moves on.
    const rated = lastPop !== pop;
    if (rated) lastPop.classList.add('swipe');
    state.index = state.files.findIndex((f) => f.name === name);
    if (state.index < 0) state.index = 0;
    slideTo = rated ? slideKey() : null;
    paintLists();
    paintCard();
  });
}

// Each button has a 💬 checkbox. Off: ratings save and advance, flags toggle (on → advance).
// On ("comment mode", default for Redo): the first press sets the value and stays until a
// comment exists (the comment bar opens for it); pressing again with a new comment moves on, without one it unsets the value.
// Only one value at a time: a rating replaces any flag and a flag replaces any rating; the comment stays.
let commentMode = { redo: true };

// Multi-select (Ctrl+click toggles one file, Shift+click picks the range from the last clicked file, Ctrl+Shift+click
// adds that range; in the file list while it is visible, or on grid tiles): a rating or flag key and
// the comment field (Enter) apply to every picked file at once; a typed comment rides along with the rating.
const multiOn = () =>
  state.picked.size > 1 &&
  (state.grid || !document.body.classList.contains('list-off'));

function pick(name) {
  const dir = state.dir;
  return transact(async () => {
    if (state.dir !== dir || !state.files.some((f) => f.name === name))
      throw new Error('The folder changed; selection was not applied.');
    await saveComment();
    if (!state.picked.size && current()) state.picked.add(current().name);
    if (state.picked.has(name)) state.picked.delete(name);
    else state.picked.add(name);
    if (state.picked.size < 2) state.picked.clear();
    state.pickFrom = state.files.findIndex((f) => f.name === name);
    paintPicks();
  });
}

function pickRange(i, add) {
  const dir = state.dir,
    name = state.files[i]?.name;
  return transact(async () => {
    if (state.dir !== dir || !state.files.some((f) => f.name === name))
      throw new Error('The folder changed; selection was not applied.');
    i = state.files.findIndex((f) => f.name === name);
    await saveComment();
    const from = state.pickFrom ?? state.index,
      names = state.files
        .slice(Math.min(from, i), Math.max(from, i) + 1)
        .map((f) => f.name);
    if (!add) state.picked.clear();
    names.forEach((n) => state.picked.add(n));
    if (state.picked.size < 2) state.picked.clear();
    paintPicks();
  });
}

function clearPicks() {
  state.pickWait = null;
  state.pickFrom = null;
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

// Mode chip: one pill per active mode (pin, draw, comment, multi-select) at the top left of the picture, or of the
// fullscreen view, and the picture area outlined in the first mode's colour, so it is always clear what clicks and keys do.
function paintModes() {
  const modes = [
    markMode === 'pin' && ['pin', '📍 Pin', 'A'],
    markMode === 'draw' && ['draw', '✏️ Draw', 'D'],
    document.body.classList.contains('comment-open') && [
      'comment',
      '💬 Comment',
      'Esc',
    ],
    multiOn() && ['multi', `☑ ${state.picked.size} selected`, 'Esc'],
  ].filter(Boolean);
  const chip = $('mode-chip'),
    opts = $('mark-opts'), // pen / pin hints sit beside the mode pill, at the top of the picture
    fs = !$('viewer').hidden;
  chip.replaceChildren(
    ...modes.map(([mode, text, key]) => {
      const pill = Object.assign(document.createElement('span'), {
        className: 'mode-pill',
        textContent: text + ' ',
        title: `${text.slice(3)} is on · ${key} turns it off`,
      });
      pill.dataset.mode = mode;
      pill.append(
        Object.assign(document.createElement('kbd'), {
          className: 'keycap',
          textContent: key,
        }),
      );
      return pill;
    }),
  );
  // The hints float centred over the top of the picture area (fixed, so they stay put while zooming or panning).
  const optsHome = fs ? $('viewer') : document.body;
  if (opts.parentElement !== optsHome) optsHome.append(opts);
  chip.hidden = !modes.length;
  for (const el of [$('media'), $('viewer')])
    el.dataset.active = modes[0]?.[0] || '';
  // Fullscreen shows only the viewer, so the chip moves in there.
  const home = fs ? $('viewer') : document.body;
  if (chip.parentElement !== home) home.append(chip);
  placeModes();
}

// The mode pill sits at the top left of the picture (its visible part when zoomed); the pen / pin hints centred in
// the picture area, so they do not follow the picture sideways.
function placeModes() {
  const fs = !$('viewer').hidden,
    box = $(fs ? 'viewer' : 'media').getBoundingClientRect(),
    r = (
      (fs && $('viewer').querySelector(':scope>.marks')) ||
      $(fs ? 'viewer' : 'media')
    ).getBoundingClientRect(),
    top = Math.max(r.top, 0) + 12;
  Object.assign($('mode-chip').style, {
    left: Math.max(r.left, 0) + 12 + 'px',
    top: top + 'px',
  });
  // Above the picture when the letterbox leaves room, otherwise over its top.
  const opts = $('mark-opts'),
    img = $(fs ? 'viewer' : 'media')
      .querySelector(':scope>.marks')
      ?.getBoundingClientRect(),
    boxTop = Math.max(box.top, 0),
    above = img && img.top - opts.offsetHeight - 6;
  Object.assign(opts.style, {
    left: (Math.max(box.left, 0) + Math.min(box.right, innerWidth)) / 2 + 'px',
    top: (above >= boxTop + 6 ? above : boxTop + 12) + 'px',
  });
}

function paintPicks() {
  paintModes();
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
    $('comment').value = on
      ? state.pickDraft?.dir === state.dir
        ? state.pickDraft.value
        : ''
      : state.items[current()?.name]?.comment || '';
    if (on && state.pickDraft?.dir === state.dir) state.pickDraft = null;
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
  // A failed save stops the loop; the files saved so far still show (finally), the selection stays for a retry.
  try {
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
  } finally {
    paintLists();
    paintRating();
    paintMarks();
    paintPinList();
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
    return transact(() => applyPicks(value)).then((success) => {
      if (success) setCommentOpen(false);
    });
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
      lastPop?.classList.add('swipe');
      state.index = (state.index + 1) % state.files.length;
      slideTo = slideKey();
      paintLists();
      paintCard();
    }
  }).then((success) => {
    if (!success) return;
    if (next) setCommentOpen(false);
    else if (ask) setCommentOpen(true);
  });
}

function setCommentMode(value, on) {
  commentMode[value] = on;
  store('commentMode', JSON.stringify(commentMode));
  const box = document.querySelector(
    `#ratings .comment-mode[data-value="${value}"]`,
  );
  box.classList.toggle('on', on);
  box.setAttribute('aria-checked', on);
  box.checked = on;
  box.setAttribute('aria-label', `Comment mode for ${nameOf(value)}`);
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

// Button face: word, icon, then a footer with the keycap; the comment checkbox is a sibling control.
// The word hides on narrow button rows; icon and key stay.
function buttonFace(b, word, symbol, key) {
  const icon = Object.assign(document.createElement('span'), {
    className: 'rating-icon',
  });
  if (symbol.startsWith('<svg')) icon.innerHTML = symbol;
  else icon.textContent = symbol;
  icon.setAttribute('aria-hidden', 'true');
  const foot = Object.assign(document.createElement('span'), {
    className: 'rating-foot',
  });
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
  fitComment();
  $('comment-tool').classList.toggle('on', open);
  $('zoom-level').querySelector('[data-k="C"]').classList.toggle('on', open);
  paintModes();
  if (open) $('comment').focus();
  else if (document.activeElement === $('comment')) $('comment').blur();
}

function paintCommentTool() {
  const text = $('comment').value.trim(),
    float = document.body.classList.contains('comment-float');
  $('comment-tool').classList.toggle('has', !!text);
  document.body.classList.toggle('has-comment', !!text && !multiOn());
  // With the floating comment on, the box over the picture shows it; no second copy in the bar.
  $('comment-view').hidden = !text || !current() || multiOn() || float;
  $('comment-view').querySelector('.cv-text').textContent = text;
  $('mp-comment').textContent = multiOn() ? '' : text;
  placeMarksPanel();
  fitComment();
}

// Outside the right sidebar the comment field is one line tall and grows with its text (capped in CSS).
function fitComment() {
  const t = $('comment');
  t.style.height = '';
  if (
    (document.body.classList.contains('side') && $('viewer').hidden) ||
    !t.offsetHeight
  )
    return;
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + t.offsetHeight - t.clientHeight + 'px';
}

function initReview() {
  commentMode = storedJSON('commentMode') || commentMode;

  new ResizeObserver(() => {
    placeMultiTip();
    paintModes();
  }).observe($('media'));
  addEventListener('resize', placeMultiTip);
  addEventListener('resize', paintModes);
  new ResizeObserver(fitComment).observe($('comments'));

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
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'comment-mode';
    box.dataset.value = value;
    box.onchange = () => setCommentMode(value, box.checked);
    buttonFace(b, label, symbol, key);
    keyAction[key] = () => act(value);
    b.onclick = (e) => {
      if (e.detail) b.blur();
      return keyAction[key]();
    };
    const wrap = document.createElement('span');
    wrap.className = 'rating-control';
    wrap.dataset.key = key;
    wrap.dataset.rating = value;
    const foot = b.querySelector('.rating-foot');
    const spacer = foot.cloneNode(true);
    spacer.style.visibility = 'hidden';
    foot.replaceWith(spacer);
    foot.append(box);
    wrap.append(b, foot);
    $('ratings').append(wrap);
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

  $('comment-view').onclick = $('mp-comment').onclick = () =>
    setCommentOpen(true);

  $('comment-tool').onclick = () =>
    setCommentOpen(!document.body.classList.contains('comment-open'));

  $('comment').addEventListener('input', paintCommentTool);

  $('comment').onblur = (e) => {
    // These controls save the draft themselves; do not swallow their click with a blur POST.
    if (e.relatedTarget?.closest('button') || e.relatedTarget === $('folders'))
      return;
    transact(saveComment);
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
  let rows = metaCache[key];
  try {
    rows ??= metaCache[key] = (
      await api(
        '/api/meta?' + new URLSearchParams({ dir: state.dir, name: f.name }),
      )
    ).rows;
  } catch {
    rows = []; // not cached: the next visit asks again
  }
  if (current() !== f) return;
  $('genmeta').replaceChildren(
    ...rows.flatMap(([label, value]) => {
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
  const key =
    state.dir +
    '|' +
    JSON.stringify(
      state.files.map(({ name, mtime, size }) => [name, mtime, size]),
    ) +
    state.subfolders;
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
    if (!same) folderPick = -1;
    // Folder tiles first (⚙ Viewport gridview navigation): up one folder, like ↑ Up in the sidebar.
    const folderTiles = $('set-folder-tiles').checked;
    if (folderTiles && state.dir !== '/') {
      const parent = state.dir.replace(/\/[^/]+\/?$/, '') || '/',
        up = Object.assign(document.createElement('button'), {
          className: 'tile folder-tile',
          textContent: '↑',
          title: 'Up one folder: ' + parent,
        });
      up.append(
        Object.assign(document.createElement('span'), {
          className: 'tile-name',
          textContent: 'Up: ' + (parent.split('/').pop() || '/'),
        }),
      );
      up.onclick = () => openFolder(parent);
      g.append(up);
    }
    // Then the subfolders, like the 📁 buttons in the sidebar.
    for (const sub of folderTiles ? state.subfolders : []) {
      const n = state.subCounts[sub],
        tile = Object.assign(document.createElement('button'), {
          className: 'tile folder-tile',
          textContent: '📁',
          title: 'Open ' + sub + (n != null ? ` (${n} files)` : ''),
        });
      tile.append(
        Object.assign(document.createElement('span'), {
          className: 'tile-name',
          textContent: sub + (n != null ? ` · ${n}` : ''),
        }),
      );
      tile.onclick = () =>
        openFolder((state.dir === '/' ? '' : state.dir) + '/' + sub);
      g.append(tile);
    }
    state.files.forEach((f, k) => {
      const tile = document.createElement('button');
      tile.className = 'tile' + (state.picked.has(f.name) ? ' picked' : '');
      tile.dataset.name = f.name;
      tile.title = f.name + ' · Ctrl/Shift+click to select several';
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
      const marks = document.createElement('span');
      marks.className = 'tile-marks';
      tile.append(name, badge, marks);
      tile.onclick = (e) => {
        if (e.shiftKey) {
          pickRange(k, e.ctrlKey || e.metaKey);
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          pick(f.name);
          return;
        }
        jump(k);
      };
      tile.ondblclick = () => {
        if (state.index === k) openViewer();
      };
      g.append(tile);
    });
    $('media').replaceChildren(g);
    paintZoomBox();
    keep.forEach(([e, top], k) => ((k ? e : g).scrollTop = top));
  }
  const tiles = g.querySelectorAll('.tile[data-name]');
  tiles.forEach((tile, k) => {
    const item = state.items[state.files[k]?.name] || {},
      r = item.flag || item.rating,
      badge = tile.querySelector('.tile-badge');
    tile.classList.toggle('current', k === state.index);
    paintIcon(badge, r);
    // Same markers as the list: 💬 comment, 📍 pins or strokes.
    const marks = tile.querySelector('.tile-marks');
    marks.textContent =
      (item.comment ? '💬' : '') +
      (item.pins?.length || item.strokes?.length ? '📍' : '');
    marks.title = [
      item.comment,
      item.pins?.length || item.strokes?.length
        ? `${item.pins?.length || 0} pins · ${item.strokes?.length || 0} strokes`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  // Scroll only when the selection moved, not on a background refresh.
  if (g.dataset.index !== String(state.index))
    tiles[state.index]?.scrollIntoView({ block: 'nearest' });
  g.dataset.index = state.index;
  paintFolderPick();
}

function paintCard(preserveDrafts = false) {
  const old = $('media').querySelector('audio');
  if (old) {
    old.pause();
    old.removeAttribute('src');
    old.load();
  }
  const f = current();
  // A single-view picture replaces the old content itself, once decoded (see below).
  if (f && !state.grid && f.kind !== 'image') $('media').replaceChildren();
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
    // No media: the folder tiles (↑ Up, subfolders), keyboard-selectable from the first one.
    if (
      $('set-folder-tiles').checked &&
      state.dir &&
      (state.dir !== '/' || state.subfolders.length)
    ) {
      paintGrid();
      if (folderPick < 0) folderPick = 0;
      paintFolderPick();
    } else $('media').textContent = 'No media files in this folder';
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
    image.title = 'Double-click for fullscreen';
    image.draggable = false;
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
      const existing = $('media').querySelector(':scope>.marks');
      const layer =
        preserveDrafts && existing?.dataset.name === f.name
          ? existing
          : marksLayer(f.name);
      if (layer === existing) fillMarks(layer);
      if (layer === existing && old) {
        if (old !== image) old.replaceWith(image); // Leave the focused pin editor attached.
      } else $('media').replaceChildren(image, layer);
      slideIn(image, 'single');
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
  if (!multiOn() && !preserveDrafts)
    $('comment').value = state.items[f.name]?.comment || '';
  paintCommentTool();
  paintRating();
  paintPinList(preserveDrafts);
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
  folderPick = -1;
  paintCard();
  if (!state.files.length) paintPinList();
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

// After a rating moves on to the next file, its picture slides in briefly from the right; manual navigation doesn't.
// Tracked per place (single view, fullscreen), since both repaint on their own once their picture has loaded.
const slid = {};
let slideTo = null;
const slideKey = () => state.dir + '\n' + state.index;
function slideIn(img, where) {
  const key = slideKey();
  if (slid[where] === key) return;
  slid[where] = key;
  if (slideTo !== key) return;
  // The marks layer (with the mode outline) slides along with the picture.
  for (const el of [img, img.parentElement.querySelector(':scope>.marks')]) {
    if (!el) continue;
    el.classList.remove('slide-next');
    void el.offsetWidth; // restart the animation
    el.classList.add('slide-next');
  }
}

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
  placeModes();
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
// When the rating moves on to the next file, the caller adds .swipe and the icon slides off to the left instead.
// Replacing another rating or flag (prev): the old icon shows first, well left of centre; a moment later the new
// one pops up in the centre, slides left over it (the old one fades under it) and fades out.
let lastPop = null;
function popRating(r, item = {}, prev = null) {
  const fs = !$('viewer').hidden,
    m = (fs ? $('viewer') : $('media')).getBoundingClientRect();
  const el = document.createElement('div');
  el.className = 'rate-pop' + (r ? '' : ' comment-pop');
  let ghost = null;
  if (r && prev && prev !== r) {
    ghost = document.createElement('div');
    ghost.className = 'rate-pop ghost';
    paintIcon(ghost, prev);
    el.classList.add('over');
  }
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
  for (const p of ghost ? [ghost, el] : [el]) {
    if (p === ghost) p.style.cssText = el.style.cssText;
    (fs ? $('viewer') : document.body).append(p);
    p.addEventListener('animationend', (e) => {
      if (e.target === p) p.remove();
    });
  }
  lastPop = el;
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
    const layer = $('viewer').querySelector('.marks');
    if (layer?.dataset.name === f.name) fillMarks(layer);
    else {
      layer?.remove();
      $('viewer').append(marksLayer(f.name));
    }
    slideIn(img, 'view');
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
  showInViewer(f, true);
  resetView();
  paintModes();
  $('viewer')
    .requestFullscreen?.()
    .catch(() => {});
}

let escTypedAt = 0; // see the fullscreenchange handler

function closeViewer() {
  if ($('viewer').hidden) return;
  $('viewer').hidden = true;
  placeComments();
  if (markMode) setMarkMode(null);
  view.drag = null;
  view.scale = 1;
  view.pending = null;
  view.token++;
  paintSingle();
  paintModes();
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
    if (o.parentNode !== $('zoom-level')) $('zoom-level').prepend(o);
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

// Grid: the folder tiles (↑ Up, subfolders) come before the files and the arrows walk through both.
// folderPick is the selected folder tile, -1 while a file is selected.
let folderPick = -1;
function gridStep(n) {
  const nf = $('media').querySelectorAll('.folder-tile').length,
    last = nf + state.files.length - 1,
    pos = folderPick >= 0 ? folderPick : nf + state.index,
    to =
      n < 0 && pos === 0
        ? last
        : n > 0 && pos === last
          ? 0
          : Math.min(Math.max(pos + n, 0), last);
  if (to >= nf) return jump(to - nf);
  folderPick = to;
  paintFolderPick();
}
function paintFolderPick() {
  const g = $('media').querySelector('.grid'),
    tiles = g?.querySelectorAll('.folder-tile') || [];
  tiles.forEach((t, k) => t.classList.toggle('current', k === folderPick));
  g?.classList.toggle('folder-on', folderPick >= 0);
  tiles[folderPick]?.scrollIntoView({ block: 'nearest' });
}

// Grid: +1 steps to fewer, bigger tiles (zoom in), -1 to more, smaller ones: 2×1, 2×2, 3×3 … 10×10 (same as the ⚙ grid size).
// From any size (also a custom one) it goes to the next step with more or fewer tiles; none left: unchanged.
function stepGrid(dir) {
  const steps = [
      [2, 1],
      ...Array.from({ length: 9 }, (_, k) => [k + 2, k + 2]),
    ],
    n = gridSize.cols * gridSize.rows;
  const to =
    dir > 0
      ? steps.findLast(([c, r]) => c * r < n)
      : steps.find(([c, r]) => c * r > n);
  if (!to) return;
  setGridSize(...to);
  $('media')
    .querySelector('.tile.current')
    ?.scrollIntoView({ block: 'nearest' });
}

// Ctrl+wheel anywhere on the page zooms the picture or steps the grid, like + and -, instead of zooming the browser.
// Fullscreen has its own handler. Elsewhere (sidebar, settings, comment) Ctrl+wheel does nothing.
let wheelSum = 0,
  wheelAt = 0,
  wheelStepAt = 0;
// Pan distance of a wheel event; Shift turns the vertical wheel sideways (where the browser does not already).
function wheelPan(e) {
  return e.shiftKey && !e.deltaX
    ? [wheelPx(e, e.deltaY), 0]
    : [wheelPx(e, e.deltaX), wheelPx(e, e.deltaY)];
}
// Touchpads send many small deltas: one step per 100px of scrolling; a pause or a turn starts over.
// After a step the wheel rests for 350ms, so a fast spin or touchpad momentum does not run through the folder.
function wheelStep(e, step) {
  if (e.timeStamp - wheelStepAt < 350) return;
  const dy = wheelPx(e, e.deltaY);
  if (e.timeStamp - wheelAt > 400 || Math.sign(dy) !== Math.sign(wheelSum))
    wheelSum = 0;
  wheelAt = e.timeStamp;
  wheelSum += dy;
  if (Math.abs(wheelSum) < 100) return;
  step(wheelSum > 0 ? 1 : -1);
  wheelSum = 0;
  wheelStepAt = e.timeStamp;
}

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
      // Ctrl+wheel zooms at the cursor; the plain wheel pans while zoomed, else goes to the previous or next file.
      if (!e.ctrlKey) {
        if (view.scale > 1) {
          const [dx, dy] = wheelPan(e);
          view.x -= dx;
          view.y -= dy;
          paintView();
        } else if (!e.shiftKey) wheelStep(e, (n) => jump(state.index + n));
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
      if (state.grid) return wheelStep(e, (n) => stepGrid(-n));
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
      if (e.ctrlKey || state.grid || !current()) return;
      e.preventDefault();
      // Not zoomed in: the wheel goes to the previous or next file.
      if (single.scale <= 1 || !$('media').querySelector(':scope>img'))
        return e.shiftKey || wheelStep(e, (n) => jump(state.index + n));
      const [dx, dy] = wheelPan(e);
      single.x -= dx;
      single.y -= dy;
      paintSingle();
    },
    { passive: false },
  );

  // Zoomed in, drag the picture to pan. Pin/draw tools keep the mouse.
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
      single.drag = null;
      $('media').classList.remove('dragging');
    });
  // Double-click the picture for fullscreen (not after a drag, not with a mark tool on).
  $('media').addEventListener('dblclick', (e) => {
    if (
      state.grid ||
      markMode ||
      single.dragged ||
      current()?.kind !== 'image' ||
      e.target.closest('.grid')
    )
      return;
    openViewer();
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
  // List scale and sort rows: their icon (⤢, ⇅) folds the row into a button beside List/Grid; clicking that opens it again.
  const rows = [];
  const foldable = (key, icon, name, row) => {
    const open = stored(key) !== '0',
      fold = Object.assign(document.createElement('button'), {
        className: 'fold',
        textContent: icon,
        title: open ? `Fold ${name} into a button` : name,
        onclick: () => {
          store(key, open ? '0' : '1');
          paintLists();
        },
      });
    fold.setAttribute('aria-expanded', open);
    if (open) rows.push(row(fold));
    else views.append(fold);
  };
  // List scale: grid view, picture size (so how many per row); list view, row density. Same value as ⚙ File list pictures.
  foldable('sideScaleOpen', '⤢', 'List scale', (fold) => {
    const scale = document.createElement('div');
    scale.className = 'side-scale-row';
    scale.append(
      fold,
      Object.assign(document.createElement('input'), {
        type: 'range',
        id: 'side-scale-bar',
        title:
          'List scale: pictures per row in grid view, row density in list view',
        min: 50,
        max: 200,
        step: 10,
        value: stored('sideScale') || 100,
        oninput: (e) => setSideScale(e.target.value),
      }),
    );
    return scale;
  });
  // Sort row: Time (default, oldest first), Name, Size; pressing the active one flips the direction. Dragging rows makes a custom order instead.
  foldable('sideSortOpen', '⇅', 'Sort', (fold) => {
    const sorter = document.createElement('div');
    sorter.className = 'side-sort';
    sorter.append(fold);
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
    return sorter;
  });
  views.append(...rows, scrollHint('to-start', '▲', 'Back to the first file'));
  // Discovered-folder list (F) and fuzzy folder search sit above the open folder; keep typing focus across repaints.
  const sec = document.createElement('div');
  sec.className = 'dir-section';
  $('sidebar').append(sec, views);
  // Head row: Explore folds the browse controls away (V shows the folder's REVIEW.md in the picture area).
  // A copy rides in the sticky List/Grid block once the section has scrolled away; it scrolls back up, unfolded.
  const [head, mini] = [false, true].map((away) => {
    const row = document.createElement('div');
    row.className = 'dir-head' + (away ? ' away' : '');
    const fold = Object.assign(document.createElement('button'), {
      className: 'dir-fold',
      textContent: '🧭 Explore',
      title: away
        ? 'Back to the folder browser'
        : 'Show / hide the folder browser',
    });
    fold.onclick = () => {
      const on = !away && !document.body.classList.contains('dir-folded');
      document.body.classList.toggle('dir-folded', on);
      store('dirFolded', on ? '1' : null);
      if (away) $('sidebar').scrollTo({ top: 0, behavior: 'smooth' });
    };
    const report = Object.assign(document.createElement('button'), {
      className: 'report-btn' + (reportOn ? ' on' : ''),
      innerHTML: '📄 Report <kbd class="keycap">V</kbd>',
      title: "This folder's REVIEW.md (V)",
      disabled: !state.dir,
    });
    report.onclick = () => setReport(!reportOn);
    const wipe = Object.assign(document.createElement('button'), {
      className: 'wipe-btn',
      textContent: '🧹',
      title: 'Remove all ratings, flags, comments and marks in this folder',
      disabled: !Object.values(state.items).some(hasReview),
    });
    wipe.setAttribute('aria-label', wipe.title);
    wipe.onclick = clearFolder;
    row.append(fold, report, wipe);
    return row;
  });
  views.prepend(mini);
  sec.append(head, foldersEl, pathBoxEl);
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
    bar.append(path, browse);
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
  const counts = {};
  const list = document.createElement('div');
  list.className = 'files';
  $('sidebar').append(list, scrollHint('to-end', '▼', 'To the last file'));
  state.files.forEach((f, i) => {
    const item = state.items[f.name] || {},
      rating = item.flag || item.rating;
    if (rating) rated++;
    counts[rating || ''] = (counts[rating || ''] || 0) + 1;
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
      ' · drag to reorder · Ctrl/Shift+click to select several';
    if (rating) row.dataset.rating = rating;
    row.onclick = (e) => {
      if (dragged) return;
      if (e.shiftKey) {
        pickRange(i, e.ctrlKey || e.metaKey);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        pick(f.name);
        return;
      }
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
      thumb.draggable = false;
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
  if (reportOn) paintReport();
  $('ticks').append(tally(counts));
  fitTicks();
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
  // The head copy shows once the sticky block has stuck, and its height is taken back
  // with a negative margin so the list below doesn't jump.
  const sec = s.querySelector('.dir-section'),
    views = s.querySelector('.side-views'),
    stuckAt = s.getBoundingClientRect().top + s.clientTop;
  // Shadow and ▲ only once files actually slide under the stuck block, not while it still scrolls along.
  s.classList.toggle(
    'more-up',
    s.scrollTop > 2 &&
      !!views &&
      views.getBoundingClientRect().top <= stuckAt + 0.5,
  );
  const away = !!sec && sec.getBoundingClientRect().bottom <= stuckAt;
  s.classList.toggle('dir-away', away);
  const mini = away && views?.querySelector('.dir-head.away');
  if (views)
    views.style.marginTop = mini
      ? `${mini.offsetTop - mini.nextElementSibling.offsetTop}px`
      : '';
  s.classList.toggle(
    'more-down',
    s.scrollTop + s.clientHeight < s.scrollHeight - 2,
  );
}

// Too many files for one tick each: the bar rolls up into a count per rating; a click jumps to the next file with it.
function tally(counts) {
  const box = document.createElement('div');
  box.className = 'tally';
  for (const r of ['mvp', 'love', 'pass', 'neutral', 'reject', ...flags, '']) {
    if (!counts[r]) continue;
    const chip = document.createElement('button'),
      icon = document.createElement('span');
    paintIcon(icon, r);
    if (!r) ((icon.textContent = '—'), (icon.hidden = false));
    const name = r ? nameOf(r) : 'Unrated';
    chip.append(
      icon,
      `${counts[r]}`,
      Object.assign(document.createElement('b'), { textContent: name }),
    );
    chip.title = `${counts[r]} ${name}: next ${name.toLowerCase()} file`;
    chip.onclick = () => {
      const n = state.files.length;
      for (let k = 1; k <= n; k++) {
        const i = (state.index + k) % n,
          it = state.items[state.files[i].name] || {};
        if ((it.flag || it.rating || '') === r) return jump(i);
      }
    };
    box.append(chip);
  }
  return box;
}

// Rolls up when a tick would be narrower than 8 CSS px, so the rule follows window size and zoom alike,
// or always with the "always rolled up" setting.
function fitTicks() {
  const t = $('ticks'),
    n = state.files.length;
  t.classList.toggle(
    'rollup',
    n > 0 && ($('set-rollup').checked || (t.clientWidth - 4 * (n - 1)) / n < 8),
  );
  // Still too wide as a rollup: drop the names, icon and count only.
  const box = t.querySelector('.tally');
  t.classList.remove('short');
  t.classList.toggle(
    'short',
    t.classList.contains('rollup') && box.scrollWidth > box.clientWidth,
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
  new ResizeObserver(fitTicks).observe($('ticks'));

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
      if (drag.row.classList.contains('picked'))
        $('sidebar')
          .querySelectorAll('.row.picked')
          .forEach((r) => r.classList.add('dragging'));
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
    // Grid: at the end of a line the mark goes after the tile under the pointer, not before the next line.
    const prev = rows[to - 1]?.getBoundingClientRect();
    if (to < rows.length && !(tiles && prev && e.clientY < prev.bottom))
      rows[to].classList.add('drop-before');
    else rows[to - 1]?.classList.add('drop-after');
    const box = $('sidebar').getBoundingClientRect();
    if (e.clientY < box.top + 40) $('sidebar').scrollBy(0, -14);
    else if (e.clientY > box.bottom - 40) $('sidebar').scrollBy(0, 14);
  });

  // A cancelled pointer (or Escape) ends the drag without moving anything.
  const endDrag = (drop) => {
    const d = drag;
    drag = null;
    if (!d?.active) return;
    $('sidebar')
      .querySelectorAll('.dragging')
      .forEach((r) => r.classList.remove('dragging'));
    document.body.classList.remove('sorting');
    clearDropMarks();
    // The click that ends a drag must not open the row; reset after this event loop turn either way.
    dragged = true;
    setTimeout(() => {
      dragged = false;
    }, 0);
    if (!drop || d.to == null) return;
    // Dragging a picked file moves all picked files, in their current order.
    const grabbed = state.files[d.from].name,
      moving = (n) =>
        state.picked.size > 1 && state.picked.has(grabbed)
          ? state.picked.has(n)
          : n === grabbed,
      block = state.files.filter((f) => moving(f.name)),
      rest = state.files.filter((f) => !moving(f.name)),
      anchor = state.files.slice(d.to).find((f) => !moving(f.name)),
      at = anchor ? rest.indexOf(anchor) : rest.length,
      files = [...rest.slice(0, at), ...block, ...rest.slice(at)];
    if (files.every((f, i) => f === state.files[i])) return;
    const name = current()?.name;
    state.files = files;
    state.index = files.findIndex((x) => x.name === name);
    saveOrder(files.map((x) => x.name));
    paintLists();
  };
  document.addEventListener('pointerup', () => endDrag(true));
  document.addEventListener('pointercancel', () => endDrag(false));
  // Esc only cancels the drag; it does not also clear the selection.
  addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !drag?.active) return;
      e.stopPropagation();
      endDrag(false);
    },
    true,
  );
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

// Pin number on the pin's colour: black on bright colours, white on dark ones.
function paintPin(el, color) {
  if (!color) return;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  el.style.background = color;
  el.style.color = r * 0.299 + g * 0.587 + b * 0.114 > 160 ? '#000' : '#fff';
}

const pathD = (pts) =>
  pts.map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join('') +
  (pts.length === 1 ? 'l0 0' : '');

// Pin note editor floating beside the pin: Enter or clicking away saves, Esc closes without saving.
const shownLayer = () =>
  $('viewer').hidden
    ? $('media').querySelector(':scope>.marks')
    : $('viewer').querySelector(':scope>.marks');

const markKey = (kind, mark) =>
  kind + ':' + JSON.stringify(kind === 'pin' ? [mark.x, mark.y] : mark.pts);

function editPin(i) {
  const layer = shownLayer(),
    f = current(),
    dir = state.dir;
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
  ed.dataset.markKey = markKey('pin', pin);
  ed.defaultValue = pin.note || '';
  Object.assign(ed.style, { left: pin.x * 100 + '%', top: pin.y * 100 + '%' });
  ed.classList.toggle('flip', pin.x > 0.7);
  let done = false;
  const close = async (keep) => {
    if (done) return;
    if (keep && ed.value.trim() !== (pin.note || '')) {
      if (state.dir !== dir || current()?.name !== f.name) return;
      const currentPins = marksOf(f.name).pins || [],
        matches = currentPins
          .map((p, j) => (markKey('pin', p) === ed.dataset.markKey ? j : -1))
          .filter((j) => j >= 0);
      if (matches.length !== 1) {
        toast(
          'This pin changed externally; its unsaved note is still in the editor.',
        );
        return;
      }
      done = true;
      if (
        !(await saveMarks({
          pins: currentPins.map((p, j) =>
            j === matches[0] ? { ...p, note: ed.value } : p,
          ),
        }))
      ) {
        done = false;
        ed.focus();
        return;
      }
    }
    done = true;
    ed.remove();
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
    const el = document.createElement('button');
    el.className = 'pin';
    el.textContent = i + 1;
    paintPin(el, pin.color);
    el.title = pin.note || '(no note)';
    el.setAttribute(
      'aria-label',
      `Edit pin ${i + 1}: ${pin.note || 'no note'}`,
    );
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
    m = $('media').getBoundingClientRect(),
    tx = parseFloat(getComputedStyle(img).translate) || 0; // mid slide-in: measure where the picture lands
  r.x -= tx;
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

// The marks panel docks when there is room, otherwise it floats over the picture (only when there are marks).
// Right-sidebar layout: under the mark tools, its list scrolling when space runs short. Bottom layout: right of the
// rating buttons, where it also shows the saved comment.
function placeMarksPanel() {
  const b = document.body,
    side = b.classList.contains('side'),
    mp = $('marks-panel'),
    f = current(),
    { pins = [], strokes = [] } = f ? marksOf(f.name) : {},
    below = !side && innerHeight >= 700 && innerWidth > 1000;
  mp.hidden =
    state.grid ||
    !f ||
    f.kind !== 'image' ||
    !(
      pins.length ||
      strokes.length ||
      markMode ||
      (below && $('mp-comment').textContent)
    );
  b.classList.toggle('marks-dock', !mp.hidden && (side || below));
  // Too short for even two rows of the list: float it over the picture instead.
  if (
    side &&
    b.classList.contains('marks-dock') &&
    $('pin-list').clientHeight < 50
  )
    b.classList.remove('marks-dock');
}

// Panel listing pins (with notes) and strokes; shown only when there is something to list.
function paintPinList(preserveDrafts = false) {
  const inputs = [...$('pin-list').querySelectorAll('input')];
  const drafts = preserveDrafts
    ? inputs
        .filter(
          (input) =>
            input.value !== input.defaultValue ||
            input === document.activeElement,
        )
        .map((input) => ({
          key: input.dataset.markKey,
          value: input.value,
          dirty: input.value !== input.defaultValue,
          focused: input === document.activeElement,
          start: input.selectionStart,
          end: input.selectionEnd,
        }))
    : [];
  // Replacing a focused editor must not enqueue its old blur save (or resurrect a deleted mark).
  $('pin-list')
    .querySelectorAll('input,button')
    .forEach((el) => {
      el.onblur = null;
    });
  const f = current(),
    { pins = [], strokes = [] } = f ? marksOf(f.name) : {};
  placeMarksPanel();
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
    name.dataset.mark = `stroke:${i}`;
    name.dataset.markKey = markKey('stroke', st);
    name.defaultValue = st.note || '';
    name.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        name.blur();
      }
    };
    name.onblur = (e) => {
      if (e.relatedTarget === del) return;
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
    del.onpointerdown = (e) => e.preventDefault();
    del.onblur = () => {
      if (li.isConnected) name.onblur({ relatedTarget: null });
    };
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
      paintPin(no, pin.color);
      const note = Object.assign(document.createElement('input'), {
        value: pin.note || '',
        placeholder: 'Note for pin ' + (i + 1),
      });
      note.dataset.mark = `pin:${i}`;
      note.dataset.markKey = markKey('pin', pin);
      note.defaultValue = pin.note || '';
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
      note.onblur = (e) => {
        if (e.relatedTarget !== del) commit();
      };
      const del = Object.assign(document.createElement('button'), {
        textContent: '✕',
        title: 'Remove pin ' + (i + 1),
      });
      del.onpointerdown = (e) => e.preventDefault();
      del.onblur = () => {
        if (li.isConnected) commit();
      };
      del.onclick = () => saveMarks({ pins: pins.filter((_, j) => j !== i) });
      li.append(no, note, del);
      return li;
    }),
    ...strokeRows,
  );
  for (const draft of drafts) {
    const matches = [...$('pin-list').querySelectorAll('input')].filter(
      (el) => el.dataset.markKey === draft.key,
    );
    if (matches.length !== 1) continue;
    const input = matches[0];
    if (draft.dirty) input.value = draft.value;
    if (draft.focused) {
      input.focus();
      input.setSelectionRange(draft.start, draft.end);
    }
  }
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
  paintModes();
}

function setMarksHidden(off) {
  document.body.classList.toggle('marks-off', off);
  $('hide-tool').classList.toggle('on', off);
  if (off && markMode) setMarkMode(null); // hidden marks can't be edited, so drop the active tool
  store('marksOff', off ? '1' : '0');
}

// Undo takes back the newest pin or stroke: the ones added in this tab, newest first, then strokes, then pins.
const added = [];

async function undoStroke() {
  const f = current(),
    dir = state.dir;
  if (!f || state.busy) return;
  const { pins = [], strokes = [] } = marksOf(f.name),
    k = added.findLastIndex((a) => a.dir === dir && a.name === f.name);
  let kind = k >= 0 ? added[k].kind : strokes.length ? 'stroke' : 'pin';
  if (kind === 'stroke' && !strokes.length) kind = 'pin';
  else if (kind === 'pin' && !pins.length) kind = 'stroke';
  const marks =
    kind === 'stroke' && strokes.length
      ? { strokes: strokes.slice(0, -1) }
      : kind === 'pin' && pins.length
        ? { pins: pins.slice(0, -1) }
        : null;
  if (marks && (await saveMarks(marks)) && k >= 0) added.splice(k, 1);
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
      { x: q[0], y: q[1], note: '', color: $('mark-color').value },
    ];
    const entry = { dir: state.dir, name: current().name, kind: 'pin' };
    saveMarks({ pins }).then((success) => {
      if (!success) return;
      added.push(entry);
      editPin(pins.length - 1);
    });
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

// Modifier keys pick the shape of one stroke: Shift line, Ctrl rectangle, Ctrl+Shift circle around the
// start point (radius = drag distance), Alt arrow, Alt+Shift cross. Without modifiers the stroke follows
// the shape picked in the pen row (freehand by default). The keys held when the button is released decide.
// Every shape is one polyline, so the review format stays the same.
let penShape = 'free';

// R: a ring of quick colours at the pointer; the middle button (or clicking the colour swatch) opens
// the full picker. A click elsewhere, Esc or R again closes it.
const wheelColours = [
  '#ff4d6d',
  '#ff9f1c',
  '#ffd166',
  '#06d6a0',
  '#4cc9f0',
  '#4361ee',
  '#b56cff',
  '#ffffff',
];
let lastPointer = [innerWidth / 2, innerHeight / 2];

// A ring of buttons around the pointer; any other click or key closes it, and its own key (or Esc) is swallowed.
// While its key is still held, moving the pointer a short way toward a button picks that slice, like a pie menu.
function popRing(id, toggle, buttons, radius, centre) {
  const [ox, oy] = lastPointer,
    w = document.createElement('div'),
    aim = (e) => {
      const dx = e.clientX - ox,
        dy = e.clientY - oy,
        n = buttons.length,
        i =
          (Math.round(
            (Math.atan2(dy, dx) + Math.PI / 2) / ((2 * Math.PI) / n),
          ) +
            n) %
          n;
      buttons.forEach(([b], j) =>
        b.classList.toggle('aim', j === i && Math.hypot(dx, dy) > 6),
      );
      if (Math.hypot(dx, dy) > radius * 0.4) buttons[i][0].click();
    },
    up = (e) => {
      if (e.key.toLowerCase() !== toggle) return;
      removeEventListener('pointermove', aim, true);
      buttons.forEach(([b]) => b.classList.remove('aim'));
    },
    away = (e) => {
      if (w.contains(e.target)) return;
      e.stopPropagation(); // the click only closes the ring, it does not draw, pin or press a button
      eatClick = true;
      close();
    },
    key = (e) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      if (e.repeat || e.key === 'Escape' || e.key.toLowerCase() === toggle) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      if (!e.repeat) close();
    },
    close = () => {
      w.remove();
      removeEventListener('pointerdown', away, true);
      removeEventListener('keydown', key, true);
      removeEventListener('keyup', up, true);
      removeEventListener('pointermove', aim, true);
    },
    edge = radius + 24;
  w.id = id;
  w.className = 'ring';
  // Clicks on the ring stay on it: no mark, no pan, no closing the viewer.
  w.onpointerdown = w.onclick = (e) => e.stopPropagation();
  w.style.left =
    Math.min(Math.max(lastPointer[0], edge), innerWidth - edge) + 'px';
  w.style.top =
    Math.min(Math.max(lastPointer[1], edge), innerHeight - edge) + 'px';
  buttons.forEach(([b, run], i) => {
    const a = (i / buttons.length) * 2 * Math.PI - Math.PI / 2;
    b.style.translate = `${Math.cos(a) * radius}px ${Math.sin(a) * radius}px`;
    b.onclick = () => {
      close();
      run();
    };
    w.append(b);
  });
  if (centre) {
    centre[0].onclick = () => {
      close();
      centre[1]();
    };
    w.append(centre[0]);
  }
  // Fullscreen covers the page, so the ring goes inside the viewer there.
  ($('viewer').hidden ? document.body : $('viewer')).append(w);
  addEventListener('pointerdown', away, true);
  addEventListener('keydown', key, true);
  addEventListener('keyup', up, true);
  addEventListener('pointermove', aim, true);
}

function colourWheel() {
  const input = $('mark-color'),
    pick = (c) => {
      input.value = c;
      input.dispatchEvent(new Event('input'));
    };
  popRing(
    'colour-wheel',
    'r',
    wheelColours.map((c) => {
      const b = document.createElement('button');
      b.style.background = c;
      b.title = c;
      b.classList.toggle('on', c === input.value.toLowerCase());
      return [b, () => pick(c)];
    }),
    46,
    [
      Object.assign(document.createElement('button'), {
        className: 'more',
        textContent: '🎨',
        title: 'All colours',
      }),
      () => input.click(),
    ],
  );
}

// `: every visible rating and flag button in a ring, for rating with the mouse.
function ratingWheel() {
  if (!current()) return;
  popRing(
    'rating-wheel',
    '`',
    [...document.querySelectorAll('#ratings button[data-rating]')]
      .filter((o) => !o.hidden)
      .map((o) => {
        const b = document.createElement('button');
        paintIcon(b, o.dataset.rating);
        b.title += ` (${o.dataset.key})`;
        b.classList.toggle('on', o.classList.contains('selected'));
        return [b, keyAction[o.dataset.key]];
      }),
    74,
  );
}

function setPenShape(shape) {
  penShape = shape;
  document
    .querySelectorAll('.pen-shapes [data-shape]')
    .forEach((b) => b.classList.toggle('on', b.dataset.shape === shape));
}

function shapePen(shift, ctrl, alt) {
  const shape =
    !shift && !ctrl && !alt
      ? penShape
      : alt
        ? shift
          ? 'cross'
          : 'arrow'
        : ctrl
          ? shift
            ? 'circle'
            : 'rect'
          : 'line';
  // Work in pixels so circles stay round and arrow heads keep their angle on any aspect ratio.
  const { width: w, height: h } = pen.layer.getBoundingClientRect(),
    c = (v) => Math.round(Math.min(Math.max(v, 0), 1) * 1e4) / 1e4,
    [sx, sy] = [pen.free[0][0] * w, pen.free[0][1] * h],
    [x, y] = [pen.at[0] * w, pen.at[1] * h],
    len = Math.hypot(x - sx, y - sy),
    head = (t) => {
      const a = Math.atan2(y - sy, x - sx) + t,
        r = Math.min(len * 0.35, 40);
      return [x - r * Math.cos(a), y - r * Math.sin(a)];
    },
    pts = {
      line: [
        [sx, sy],
        [x, y],
      ],
      rect: [
        [sx, sy],
        [x, sy],
        [x, y],
        [sx, y],
        [sx, sy],
      ],
      circle: Array.from({ length: 65 }, (_, i) => {
        const a = (i / 64) * 2 * Math.PI;
        return [sx + len * Math.cos(a), sy + len * Math.sin(a)];
      }),
      arrow: [[sx, sy], [x, y], head(0.45), [x, y], head(-0.45)],
      // Both diagonals in one line: corner to corner, back to the middle, then the other diagonal.
      cross: [
        [sx, sy],
        [x, y],
        [(sx + x) / 2, (sy + y) / 2],
        [sx, y],
        [x, sy],
      ],
    }[shape];
  pen.pts = pts ? pts.map(([px, py]) => [c(px / w), c(py / h)]) : pen.free;
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
      paint = () => {
        const c = $('mark-color').value,
          svg = (body) =>
            `url("data:image/svg+xml,${encodeURIComponent(body.replaceAll('C', c))}")`;
        k.querySelector('.swatch').style.background = c;
        // The pin and pen cursors take the current colour (C in the SVG).
        document.body.style.setProperty(
          '--pin-cursor',
          svg(
            `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='30' viewBox='0 0 24 30'><path d='M12 29s9-9.5 9-16a9 9 0 0 0-18 0c0 6.5 9 16 9 16z' fill='C' stroke='#fff' stroke-width='2'/><circle cx='12' cy='13' r='3.5' fill='#fff'/></svg>`,
          ) + ' 12 29, crosshair',
        );
        document.body.style.setProperty(
          '--pen-cursor',
          svg(
            `<svg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'><path d='M3 25l2-7L19 4l5 5L10 23z' fill='C' stroke='#000' stroke-width='1.5' stroke-linejoin='round'/><path d='M3 25l2-7 5 5z' fill='#f4c9a0' stroke='#000' stroke-width='1.5' stroke-linejoin='round'/><path d='M3 25l1-3.5 2.5 2.5z'/><path d='M16.5 6.5l5 5' stroke='#000' stroke-width='1.5'/></svg>`,
          ) + ' 3 25, crosshair',
        );
      };
    k.onclick = (e) => {
      e.stopPropagation();
      $('mark-color').click();
    };
    addEventListener(
      'pointermove',
      (e) => (lastPointer = [e.clientX, e.clientY]),
      { passive: true },
    );
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
    shapePen(e.shiftKey, e.ctrlKey || e.metaKey, e.altKey);
  });

  for (const type of ['keydown', 'keyup'])
    document.addEventListener(type, (e) => {
      if (pen && ['Shift', 'Control', 'Meta', 'Alt'].includes(e.key)) {
        e.preventDefault(); // Alt alone would open the browser menu bar
        shapePen(e.shiftKey, e.ctrlKey || e.metaKey, e.altKey);
      }
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
    const dir = state.dir;
    if (p && p.layer.dataset.name === current()?.name)
      saveMarks({
        strokes: [
          ...(marksOf(current().name).strokes || []),
          { pts: p.pts, color: $('mark-color').value },
        ],
      }).then((success) => {
        if (success)
          added.push({ dir, name: p.layer.dataset.name, kind: 'stroke' });
        else p.path.remove();
      });
  });
}

// ── settings ──

function setLayout(side) {
  document.body.classList.toggle('side', side);
  $('set-side').checked = side;
  $('layout-btn').setAttribute('aria-pressed', side);
  $('layout-btn').setAttribute(
    'aria-label',
    side ? 'Right sidebar layout' : 'Bottom layout',
  );
  store('layout', side ? 'side' : 'bottom');
  if (!$('viewer').hidden) resetView();
  if (typeof placeMarksPanel === 'function') placeMarksPanel();
  if (detailsObserver) fitDetails();
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

// Settings switch: the progress bar always shows one chip per rating instead of a tile per file.
function setRollup(on) {
  $('set-rollup').checked = on;
  store('rollup', on ? '1' : '0');
  fitTicks();
}

// Settings switch: the grid (and a folder without media) starts with ↑ Up and subfolder tiles.
function setFolderTiles(on) {
  $('set-folder-tiles').checked = on;
  store('folderTiles', on ? '1' : '0');
  folderPick = -1;
  $('media').replaceChildren();
  paintCard();
}

// Settings switch: fullscreen shows the comment box whenever the file has a comment (off: only on C).
function setCommentFloat(on) {
  document.body.classList.toggle('comment-float', on);
  $('set-comment-float').checked = on;
  store('commentFloat', on ? '1' : '0');
  paintCommentTool();
}

// File list pictures / list scale: thumbnail size in the left sidebar (50–200%); in its grid, bigger pictures mean
// fewer columns. In the list, small sizes also tighten the rows: below 100% the name keeps to one line and the date
// goes, at 60% and less the type/size line goes too.
function setSideScale(pct) {
  pct = Math.min(200, Math.max(50, +pct || 100));
  $('set-side-scale').value = pct;
  if ($('side-scale-bar')) $('side-scale-bar').value = pct;
  document.body.classList.toggle('list-dense', pct < 100);
  document.body.classList.toggle('list-denser', pct <= 60);
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

// ⚙ Keyboard: a UK keyboard (main block, navigation keys, numpad) with every bound key coloured by what it does.
// Rows of "label:width:height" in key units; _ is a gap, a leading ~ marks a numpad key (bound like its main-row twin).
const kbRows = [
  'Esc _ F1 F2 F3 F4 _:0.5 F5 F6 F7 F8 _:0.5 F9 F10 F11 F12 _:0.5 PrtSc ScrLk Pause _:0.5 _:4',
  '` 1 2 3 4 5 6 7 8 9 0 - = Back:2 _:0.5 Ins Home PgUp _:0.5 Num ~/ ~* ~-',
  'Tab:1.75 Q W E R T Y U I O P [ ] Enter:1.25:2 _:0.5 Del End PgDn _:0.5 ~7 ~8 ~9 ~+:1:2',
  "Caps:1.75 A S D F G H J K L ; ' # _:5.25 ~4 ~5 ~6",
  'Shift:1.25 \\ Z X C V B N M , . / Shift:2.75 _:1.5 ↑ _:1.5 ~1 ~2 ~3 ~Enter:1:2',
  'Ctrl:1.25 Win:1.25 Alt:1.25 Space:6.25 AltGr:1.25 Win:1.25 Menu:1.25 Ctrl:1.25 _:0.5 ← ↓ → _:0.5 ~0:2 ~.',
];
const kbMove = ['Previous', 'Next'];
// Report view: the folder's REVIEW.md over the picture area; file names jump to the file.
let reportOn = false;
function setReport(on) {
  reportOn = on && !!state.dir;
  $('report').hidden = !reportOn;
  document
    .querySelectorAll('.report-btn')
    .forEach((b) => b.classList.toggle('on', reportOn));
  if (reportOn) paintReport();
}
let reportToken = 0;
async function paintReport() {
  // Only the newest request paints: quick ratings or a folder switch can finish out of order.
  const token = ++reportToken;
  let md;
  try {
    const r = await fetch('/api/report?dir=' + encodeURIComponent(state.dir));
    md = r.ok ? await r.text() : 'No REVIEW.md yet: rate a file first.';
  } catch {
    md = 'Could not load REVIEW.md.';
  }
  if (token !== reportToken) return;
  $('report-body').innerHTML = mdToHtml(md);
  placeReport();
}
function placeReport() {
  if (!reportOn) return;
  const m = $('media').getBoundingClientRect();
  Object.assign($('report').style, {
    top: m.top + 'px',
    left: m.left + 'px',
    width: m.width + 'px',
    height: m.height + 'px',
  });
}
// Just what REVIEW.md uses: # headings, nested - lists, `code`.
function mdToHtml(md) {
  const esc = (s) =>
      s.replace(
        /[&<>"]/g,
        (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`,
      ),
    names = new Set(state.files.map((f) => esc(f.name))),
    inline = (s) =>
      esc(s).replace(/`([^`]+)`/g, (_, c) =>
        names.has(c)
          ? `<a href="#" data-name="${c}">${c}</a>`
          : `<code>${c}</code>`,
      );
  let html = '',
    depth = 0;
  for (const line of md.split('\n')) {
    const li = line.match(/^( *)- (.*)/),
      d = li ? (li[1].length >> 1) + 1 : 0,
      h = line.match(/^(#{1,3}) (.*)/);
    for (; depth > d; depth--) html += '</ul>';
    for (; depth < d; depth++) html += '<ul>';
    if (li) html += '<li>' + inline(li[2]);
    else if (h) html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`;
    else if (line.trim()) html += '<p>' + inline(line) + '</p>';
  }
  return html + '</ul>'.repeat(depth);
}

function keyBinds() {
  const rate = (v) => ['rate', nameOf(v), v];
  return {
    Esc: ['mark', 'Leave (the comment or tool; closes fullscreen)'],
    F1: ['view', 'Settings'],
    0: rate('reject'),
    '.': rate('neutral'),
    ',': rate('neutral'),
    1: rate('pass'),
    2: rate('love'),
    3: rate('mvp'),
    4: rate('redo'),
    5: rate('broken'),
    6: rate('trash'),
    7: rate('custom7'),
    8: rate('custom8'),
    9: rate('custom9'),
    '-': ['view', 'Zoom − (grid: more tiles)'],
    '=': ['view', 'Zoom + (grid: fewer tiles)'],
    '+': ['view', 'Zoom + (grid: fewer tiles)'],
    W: ['move', kbMove[0]],
    S: ['move', kbMove[1]],
    '←': ['move', kbMove[0]],
    '→': ['move', kbMove[1]],
    '↑': ['move', 'Previous (grid: row up)'],
    '↓': ['move', 'Next (grid: row down)'],
    PgUp: ['move', '−10 (grid: a page)'],
    PgDn: ['move', '+10 (grid: a page)'],
    Home: ['move', 'First'],
    End: ['move', 'Last'],
    A: ['mark', 'Pin'],
    D: ['mark', 'Draw'],
    C: ['mark', 'Comment'],
    R: ['mark', 'Colour ring (pen and pins; hold and move to pick)'],
    '`': ['rate', 'Rating ring (click, or hold and move toward a button)'],
    Z: ['mark', 'Undo (the newest pin or stroke)'],
    H: ['mark', 'Hide marks'],
    Del: ['mark', 'Clear (marks and rating)'],
    Enter: ['view', 'Fullscreen (Shift: next file)'],
    G: ['view', 'Grid'],
    Space: ['view', 'Grid (plays or pauses audio)'],
    L: ['view', 'File list'],
    X: ['view', 'Bar side (rating buttons right / below)'],
    V: ['view', "Report (this folder's REVIEW.md)"],
    F: ['folder', 'Folders (pick a discovered one)'],
    B: ['folder', 'Browse (folder dialog)'],
    O: ['folder', 'Browse (folder dialog)'],
    Tab: ['folder', 'Accept (path field suggestion)'],
    // Held while drawing: the pen shape of that stroke.
    Shift: [
      'mark',
      'Line (hold while drawing; with Ctrl: circle, with Alt: cross)',
    ],
    Ctrl: [
      'mark',
      'Box · Zoom* (hold while drawing: box, with Shift: circle; *with the mouse wheel: zoom at the cursor)',
    ],
    Alt: ['mark', 'Arrow (hold while drawing; with Shift: cross)'],
  };
}
const kbCombos = [
  [
    'Pen and pins',
    [
      ['drag', 'Pen: freehand (or the shape picked in the pen row)'],
      ['Shift+drag', 'Pen: straight line'],
      ['Ctrl+drag', 'Pen: box'],
      ['Ctrl+Shift+drag', 'Pen: circle around the start point'],
      ['Alt+drag', 'Pen: arrow'],
      ['Alt+Shift+drag', 'Pen: cross'],
      ['Ctrl+Z', 'Undo the newest pin or stroke'],
      ['Right-click', 'Turn the pin or draw tool off'],
    ],
  ],
  [
    'Comment',
    [
      ['Enter', 'Save (moves on if the file is rated)'],
      ['Shift+Enter', 'Save and go to the next file'],
      ['Alt+Enter', 'New line'],
      ['Esc', 'Close without moving on'],
    ],
  ],
  [
    'Zoom and more',
    [
      ['Ctrl+wheel', 'Zoom at the cursor'],
      ['Shift+arrows', 'Move the picture while zoomed (also drag or wheel)'],
      ['Ctrl+Space', 'Reset zoom'],
      ['Tab / ↑ ↓', 'Path field: take or pick a suggestion'],
    ],
  ],
];

function paintKeyboard() {
  const binds = keyBinds(),
    board = $('kb-board');
  board.replaceChildren();
  kbRows.forEach((row, r) => {
    let x = 1;
    for (const tok of row.split(' ')) {
      const [label, w = 1, h = 1] = tok.split(':'),
        span = Math.round(w * 4);
      if (label !== '_') {
        const name = label.replace(/^~(.)/, '$1'),
          b = binds[name],
          k = document.createElement('div');
        k.className = 'kb-key' + (b ? ' kb-' + b[0] : '');
        k.style.gridColumn = `${x} / span ${span}`;
        k.style.gridRow = `${r + 1} / span ${h}`;
        k.append(
          Object.assign(document.createElement('b'), { textContent: name }),
        );
        if (b) {
          if (b[2]) {
            const i = document.createElement('i');
            paintIcon(i, b[2]);
            k.append(i);
          }
          k.append(
            Object.assign(document.createElement('small'), {
              textContent: b[1].split(' (')[0], // short caption; the title has it all
            }),
          );
          k.title = `${name}: ${b[1]}`;
        }
        board.append(k);
      }
      x += span;
    }
  });
  $('kb-combos').replaceChildren(
    ...kbCombos.map(([head, rows]) => {
      const col = document.createElement('div'),
        ul = document.createElement('ul');
      for (const [k, text] of rows) {
        const li = document.createElement('li');
        li.append(
          Object.assign(document.createElement('kbd'), {
            className: 'keycap',
            textContent: k,
          }),
          Object.assign(document.createElement('span'), { textContent: text }),
        );
        ul.append(li);
      }
      col.append(
        Object.assign(document.createElement('h4'), { textContent: head }),
        ul,
      );
      return col;
    }),
  );
}

function setMenu(open) {
  if (open) paintKeyboard();
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
    b.parentElement.hidden = b.hidden;
    b.parentElement
      .querySelector('.comment-mode')
      .setAttribute('aria-label', `Comment mode for ${name}`);
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
  // Bottom layout, expanded beside the buttons: the box grows upward over the picture (negative top margin = the extra
  // height), so the bar row keeps its height and the buttons beside it stay put.
  d.style.marginTop = '';
  const b = document.body.classList;
  if (b.contains('details-full') && !b.contains('side')) {
    b.remove('details-full');
    const closed = d.offsetHeight,
      // only when the box sits beside the buttons; in its own row below them the page just grows
      beside =
        d.getBoundingClientRect().top <
        $('ratings').getBoundingClientRect().bottom;
    b.add('details-full');
    if (beside && d.offsetHeight > closed)
      d.style.marginTop = closed - d.offsetHeight + 'px';
  }
  placeMarksPanel(); // docking depends on the details height
  // Cut off: the box itself, or the prompt clamped to a few lines inside it.
  const p = d.querySelector('dd.prompt');
  d.classList.toggle(
    'more',
    !document.body.classList.contains('details-full') &&
      (d.scrollHeight > d.clientHeight + 1 ||
        (p && p.scrollHeight > p.clientHeight + 1)),
  );
}

let detailsObserver;

function setDetails(mode) {
  document.body.classList.toggle('details-full', mode === 'full');
  $('details-toggle').setAttribute('aria-expanded', mode === 'full');
  $('details-toggle').setAttribute(
    'aria-label',
    mode === 'full' ? 'Collapse file details' : 'Expand file details',
  );
  store('details', mode);
  fitDetails();
}

function initSettings() {
  detailsObserver = new ResizeObserver(fitDetails);

  $('set-side').onchange = (e) => setLayout(e.target.checked);
  $('set-close').onclick = () => setMenu(false);

  $('layout-btn').onclick = () =>
    setLayout(!document.body.classList.contains('side'));

  $('set-peek').onchange = (e) => setPeek(e.target.checked);

  setPeek(stored('peek') !== '0');

  $('set-details').onchange = (e) => setShowDetails(e.target.checked);

  $('set-hints').onchange = (e) => setHints(e.target.checked);

  setHints(stored('hints') !== '0');
  document.body.classList.toggle('dir-folded', stored('dirFolded') === '1');
  new ResizeObserver(placeReport).observe($('media'));
  addEventListener('resize', placeReport);
  $('report-close').onclick = () => setReport(false);
  $('report-body').onclick = (e) => {
    const a = e.target.closest('a[data-name]');
    if (!a) return;
    e.preventDefault();
    const i = state.files.findIndex((f) => f.name === a.dataset.name);
    setReport(false);
    if (i >= 0) jump(i);
  };
  $('set-rollup').onchange = (e) => setRollup(e.target.checked);
  setRollup(stored('rollup') === '1');
  $('set-folder-tiles').onchange = (e) => setFolderTiles(e.target.checked);
  $('set-folder-tiles').checked = stored('folderTiles') !== '0';
  $('set-comment-float').onchange = (e) => setCommentFloat(e.target.checked);
  setCommentFloat(stored('commentFloat') !== '0');

  $('set-ls-width').oninput = (e) => setLsScale(e.target.value);

  setLsScale(stored('lsScale') || 100);

  $('set-side-scale').oninput = (e) => setSideScale(e.target.value);

  setSideScale(stored('sideScale') || 100);

  $('set-rs-width').oninput = (e) => setRsScale(e.target.value);

  setRsScale(stored('rsScale') || 100);

  setShowDetails(stored('showDetails') !== '0');

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
  $('details-toggle').onclick = (e) => {
    e.stopPropagation();
    setDetails(
      document.body.classList.contains('details-full') ? 'on' : 'full',
    );
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
    if (result.dir !== state.dir) clearPicks();
    state.dir = result.dir;
    folderPick = -1;
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
  const beforeItems = state.items,
    beforeDir = state.dir;
  const result = await api(
    '/api/list?' + new URLSearchParams({ dir: beforeDir }),
  );
  if (state.busy || result.dir !== state.dir || state.items !== beforeItems)
    return;
  const next = arrange(sortFiles(result.files)),
    identity = (files) =>
      JSON.stringify(
        files.map(({ name, mtime, size, kind }) => [name, mtime, size, kind]),
      ),
    previous = current(),
    name = previous?.name,
    reviewChanged =
      JSON.stringify(state.items) !== JSON.stringify(result.items),
    labelsChanged =
      JSON.stringify(state.folderLabels) !==
      JSON.stringify(result.labels || {});
  if (
    identity(next) === identity(state.files) &&
    !reviewChanged &&
    !labelsChanged
  )
    return;
  const incomingMarks = result.items[current()?.name] || {},
    keys = [
      ...(incomingMarks.pins || []).map((p) => markKey('pin', p)),
      ...(incomingMarks.strokes || []).map((s) => markKey('stroke', s)),
    ],
    noteDrafts = [
      ...document.querySelectorAll('#pin-list input,.pin-edit'),
    ].filter((el) => el.value !== el.defaultValue && el.dataset.markKey);
  if (
    noteDrafts.some(
      (el) => keys.filter((key) => key === el.dataset.markKey).length !== 1,
    )
  ) {
    toast('A mark changed externally. Finish its note before refreshing.');
    return;
  }
  const draft = $('comment').value,
    wasMulti = multiOn(),
    dirtyComment =
      wasMulti || draft.trim() !== (state.items[name]?.comment || '');
  state.files = next;
  state.items = result.items;
  state.folderLabels = result.labels || {};
  const i = state.files.findIndex((f) => f.name === name);
  state.index =
    i < 0 ? Math.min(state.index, Math.max(state.files.length - 1, 0)) : i;
  state.picked = new Set(
    [...state.picked].filter((n) => next.some((f) => f.name === n)),
  );
  if (state.picked.size < 2) state.picked.clear();
  const endedMulti = wasMulti && !multiOn();
  if (endedMulti && draft) {
    state.pickDraft = { dir: state.dir, value: draft };
    toast('Selection changed. Shared draft kept for the next multi-selection.');
  }
  paintPicks();
  if (labelsChanged) paintCustoms();
  paintLists();
  const same = current()?.name === name;
  if (
    !same ||
    identity([current()].filter(Boolean)) !==
      identity([previous].filter(Boolean))
  )
    paintCard(same);
  else {
    if (state.grid) paintGrid();
    paintRating();
    paintMarks();
    paintPinList(true);
    if (!$('viewer').hidden) paintPeek();
  }
  if (same) {
    if (!dirtyComment || endedMulti)
      $('comment').value = state.items[name]?.comment || '';
    else $('comment').value = draft;
    paintCommentTool();
  }
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

  // A picked folder opens straight away. The comment is saved first; the dialog itself does not block the app.
  $('browse').onclick = async () => {
    await whenIdle();
    if (!(await transact(saveComment))) return;
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
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      ['Enter', ' '].includes(e.key) &&
      e.target.closest('button:not(.row):not(.tile)')
    )
      return; // Native controls own activation, including inside fullscreen.
    if (
      !$('viewer').hidden &&
      (e.key === 'Escape' || (e.key === 'Enter' && !e.shiftKey)) &&
      !['TEXTAREA', 'INPUT'].includes(e.target.tagName)
    ) {
      e.preventDefault();
      closeViewer();
      return;
    }
    if (e.key === 'Escape' && reportOn) {
      setReport(false);
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
    // Open settings keep the keys: nothing rates or moves behind them (Esc and F1 close them above).
    if (!$('settings-menu').hidden && !typing) return;
    if (e.key === 'Escape' && typing) {
      escTypedAt = performance.now();
      e.target.blur();
      if (e.target.id === 'comment') setCommentOpen(false);
      return;
    }
    // Comment field: Alt+Enter starts a new line.
    if (e.key === 'Enter' && e.altKey && e.target === $('comment')) {
      e.preventDefault();
      e.target.setRangeText(
        '\n',
        e.target.selectionStart,
        e.target.selectionEnd,
        'end',
      );
      e.target.dispatchEvent(new Event('input'));
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
        transact(() => applyPicks(v)).then((success) => {
          if (success) {
            state.pickWait = null;
            setCommentOpen(false);
          }
        });
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
    if (
      e.ctrlKey &&
      e.key.toLowerCase() === 'z' &&
      !typing &&
      !state.busy &&
      folderPick < 0
    ) {
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
    if (e.key === 'Enter' && folderPick >= 0) {
      e.preventDefault();
      $('media').querySelectorAll('.folder-tile')[folderPick]?.click();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && e.target.closest?.('.folder-tile'))
      return; // a focused folder tile opens with its own Enter
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
    // A folder tile is selected and the file is not shown as selected: keys that change the file do nothing.
    if (
      folderPick >= 0 &&
      (keyAction[key] ||
        ['Delete', 'c', 'z', 'h', 'a', 'd', 'r', '`'].includes(
          e.key.length === 1 ? e.key.toLowerCase() : e.key,
        ))
    )
      return;
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
    } else if (
      (state.grid || !state.files.length) &&
      [
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'PageUp',
        'PageDown',
      ].includes(e.key)
    ) {
      e.preventDefault();
      const page = e.key.startsWith('Page') ? gridSize.cols * gridSize.rows : 0;
      gridStep(
        {
          ArrowLeft: -1,
          ArrowRight: 1,
          ArrowUp: -gridSize.cols,
          ArrowDown: gridSize.cols,
          PageUp: -page,
          PageDown: page,
        }[e.key],
      );
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
    } else if (e.key.toLowerCase() === 'v') {
      e.preventDefault();
      setReport(!reportOn);
    } else if (e.key.toLowerCase() === 'x') {
      e.preventDefault();
      setLayout(!document.body.classList.contains('side'));
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
      colourWheel();
    } else if (e.key === '`') {
      e.preventDefault();
      ratingWheel();
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
