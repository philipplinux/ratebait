// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import { $, api, current, mediaUrl, nameOf, state, toast } from './state.js';
import {
  clearPicks,
  jump,
  multiOn,
  paintCommentTool,
  paintRating,
  pick,
  placeComments,
} from './review.js';
import {
  markMode,
  marksLayer,
  paintPinList,
  placeMarkOpts,
  placeMarks,
  placeMarksPanel,
  setMarkMode,
  startMark,
} from './marks.js';
import { symOf } from './settings.js';

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
      JSON.stringify(state.files.map(({ name, mtime, size }) => [name, mtime, size]));
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
  try {
    localStorage.setItem('grid', on ? '1' : '0');
  } catch {}
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
  try {
    localStorage.setItem('gridSize', gridSize.cols + 'x' + gridSize.rows);
  } catch {}
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

export function initMedia() {
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

  try {
    state.grid = localStorage.getItem('grid') === '1';
    $('grid-toggle').classList.toggle('on', state.grid);
  } catch {}

  for (const b of document.querySelectorAll('.grid-presets button'))
    b.onclick = () => setGridSize(...b.dataset.grid.split('x'));

  $('grid-cols').onchange = $('grid-rows').onchange = () =>
    setGridSize($('grid-cols').value, $('grid-rows').value);

  try {
    const [c, r] = (localStorage.getItem('gridSize') || '3x3').split('x');
    setGridSize(c, r);
  } catch {
    setGridSize(3, 3);
  }

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

  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) closeViewer();
    else resetView();
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
    if (d && !d.moved) closeViewer();
  });

  $('viewer').addEventListener('pointercancel', (e) => {
    if (view.drag && e.pointerId !== view.drag.id) return;
    view.drag = null;
    $('viewer').classList.remove('dragging');
  });

  new ResizeObserver(paintSingle).observe($('media'));
}

export {
  closeViewer,
  dims,
  fileSize,
  fileType,
  gridSize,
  openViewer,
  paintCard,
  paintGrid,
  paintIcon,
  paintPeek,
  paintSingle,
  paintZoomBox,
  paintZoomOpts,
  panBy,
  popRating,
  resetView,
  setGrid,
  single,
  stepGrid,
  view,
  zoomSingle,
  zoomView,
};
