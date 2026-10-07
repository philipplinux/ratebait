// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import { $, api, current, state, toast, transact } from './state.js';
import { paintPicks, saveComment } from './review.js';
import { arrange, paintLists, sortFiles } from './sidebar.js';
import { paintCustoms } from './settings.js';
import { paintCard } from './media.js';

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
  try {
    localStorage.setItem('homeSearch', on ? '1' : '0');
  } catch {}
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
        hits: d.hits.map((h) => h - (cut ? cut : 0)),
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
  ) return;
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

const basePath = (p) => (p && !/^[\/~]/.test(p) ? pathBase + '/' + p : p);

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

export async function startFolders() {
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

export function initFolders() {
  $('set-home').onchange = (e) => setHomeSearch(e.target.checked);

  try {
    homeSearch = localStorage.getItem('homeSearch') === '1';
  } catch {}

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

export { openFolder, tilde };
