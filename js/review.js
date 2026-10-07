// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import {
  $,
  api,
  current,
  customs,
  flags,
  keyAction,
  nameOf,
  state,
  toast,
  transact,
} from './state.js';
import { paintCard, paintPeek, popRating } from './media.js';
import { paintLists } from './sidebar.js';
import { paintMarks, paintPinList } from './marks.js';

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
  try {
    localStorage.setItem('commentMode', JSON.stringify(commentMode));
  } catch {}
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

export function initReview() {
  try {
    commentMode =
      JSON.parse(localStorage.getItem('commentMode')) || commentMode;
  } catch {}

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

export {
  applyPicks,
  buttons,
  clearPicks,
  jump,
  multiOn,
  paintCommentTool,
  paintPicks,
  paintRating,
  pick,
  placeComments,
  saveComment,
  saveMarks,
  setCommentOpen,
};
