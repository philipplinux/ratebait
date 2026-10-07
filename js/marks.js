// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import { $, current, state } from './state.js';
import { saveMarks } from './review.js';
import { setGrid, single } from './media.js';

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
  try {
    localStorage.setItem('marksOff', off ? '1' : '0');
  } catch {}
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

export function initMarks() {
  try {
    setMarksHidden(localStorage.getItem('marksOff') === '1');
  } catch {}

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

export {
  markMode,
  marksLayer,
  paintMarks,
  paintPinList,
  placeMarkOpts,
  placeMarks,
  placeMarksPanel,
  setMarkMode,
  setMarksHidden,
  startMark,
  undoStroke,
};
