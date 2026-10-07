// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux

export const state = {
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

const ratings = ['reject', 'neutral', 'pass', 'love', 'mvp'];

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

export function initState() {
  try {
    state.customNames = JSON.parse(localStorage.getItem('customNames')) || {};
  } catch {}
  try {
    state.btnStyle = JSON.parse(localStorage.getItem('btnStyle')) || {};
  } catch {}
}

export {
  $,
  api,
  current,
  customs,
  flags,
  keyAction,
  keyQueue,
  mediaUrl,
  nameOf,
  shortDate,
  toast,
  transact,
};
