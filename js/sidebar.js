// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import { $, current, mediaUrl, nameOf, shortDate, state } from './state.js';
import { openFolder, tilde } from './folders.js';
import {
  dims,
  fileSize,
  fileType,
  paintCard,
  paintGrid,
  paintIcon,
  resetView,
} from './media.js';
import { clearPicks, jump, pick } from './review.js';

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
  views.append(sorter);
  $('sidebar').append(views);
  // Discovered-folder list (F) and fuzzy folder search sit above the open folder; keep typing focus across repaints.
  const sec = document.createElement('div');
  sec.className = 'dir-section';
  $('sidebar').append(sec);
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
  const list = document.createElement('div');
  list.className = 'files';
  $('sidebar').append(list);
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

// Sidebar look: 'list' (thumbnail, name, details) or 'grid' (thumbnails only, 3 per row). Kept per browser.
let sideView = 'list';

function setSideView(mode) {
  sideView = mode === 'grid' ? 'grid' : 'list';
  document.body.classList.toggle('side-grid', sideView === 'grid');
  try {
    localStorage.setItem('sideView', sideView);
  } catch {}
  paintLists();
}

function setList(on) {
  document.body.classList.toggle('list-off', !on);
  if (!on && !state.grid) clearPicks();
  $('set-list').checked = on;
  $('list-flag').querySelector('.arr').textContent = on ? '‹' : '›';
  $('list-flag').title = (on ? 'Hide' : 'Show') + ' file list (L)';
  $('list-flag').setAttribute(
    'aria-label',
    (on ? 'Hide' : 'Show') + ' file list',
  );
  try {
    localStorage.setItem('list', on ? '1' : '0');
  } catch {}
  if (!$('viewer').hidden) resetView();
}

// Sidebar drag to reorder (pointer events: Firefox can't drag <button> natively). The order is per folder,
// in this browser only; files not in it (new ones) go to the bottom, oldest first.
let drag = null,
  dragged = false;

const orderKey = () => 'order:' + state.dir;

function loadOrder() {
  try {
    return JSON.parse(localStorage.getItem(orderKey())) || [];
  } catch {
    return [];
  }
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
  try {
    localStorage.setItem('sortBy', JSON.stringify(sortBy));
  } catch {}
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
  try {
    names
      ? localStorage.setItem(orderKey(), JSON.stringify(names))
      : localStorage.removeItem(orderKey());
  } catch {}
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

export function initSidebar() {
  sideResize = new ResizeObserver(() => paintScrollHints());

  $('sidebar').addEventListener('scroll', paintScrollHints, { passive: true });

  $('set-list').onchange = (e) => setList(e.target.checked);

  $('list-flag').onclick = () =>
    setList(document.body.classList.contains('list-off'));

  try {
    setList(localStorage.getItem('list') !== '0');
  } catch {
    setList(true);
  }

  try {
    sideView = localStorage.getItem('sideView') === 'grid' ? 'grid' : 'list';
  } catch {}

  document.body.classList.toggle('side-grid', sideView === 'grid');

  try {
    sortBy = { ...sortBy, ...JSON.parse(localStorage.getItem('sortBy')) };
  } catch {}

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

export { arrange, paintLists, setList, sortFiles };
