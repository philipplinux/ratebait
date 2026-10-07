// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import { $, api, customs, nameOf, state, toast } from './state.js';
import { paintZoomBox, paintZoomOpts, resetView } from './media.js';
import { placeMarksPanel } from './marks.js';
import { paintLists } from './sidebar.js';
import { buttons } from './review.js';

function setLayout(side) {
  document.body.classList.toggle('side', side);
  $('set-side').checked = side;
  $('layout-btn').setAttribute('aria-pressed', side);
  try {
    localStorage.setItem('layout', side ? 'side' : 'bottom');
  } catch {}
  if (!$('viewer').hidden) resetView();
  if (typeof placeMarksPanel === 'function') placeMarksPanel();
}

function setPeek(on) {
  document.body.classList.toggle('peek-off', !on);
  $('set-peek').checked = on;
  try {
    localStorage.setItem('peek', on ? '1' : '0');
  } catch {}
}

// Settings switch that hides the file details box entirely (its expanded state is separate).
function setShowDetails(on) {
  document.body.classList.toggle('no-details', !on);
  $('set-details').checked = on;
  try {
    localStorage.setItem('showDetails', on ? '1' : '0');
  } catch {}
}

// Settings switch for the pen / pin / zoom hint bars (off: keys still work, the zoom box shows the level instead).
function setHints(on) {
  document.body.classList.toggle('no-hints', !on);
  $('set-hints').checked = on;
  try {
    localStorage.setItem('hints', on ? '1' : '0');
  } catch {}
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
  try {
    localStorage.setItem('sideScale', pct);
  } catch {}
}

// Right sidebar size (50–100%): narrows the column and scales its buttons and text with it.
function setRsScale(pct) {
  pct = Math.min(100, Math.max(50, +pct || 100));
  $('set-rs-width').value = pct;
  $('rs-width-out').value = pct + '%';
  document.body.style.setProperty('--rs-scale', pct / 100);
  try {
    localStorage.setItem('rsScale', pct);
  } catch {}
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
  try {
    localStorage.setItem('btnStyle', JSON.stringify(state.btnStyle));
  } catch {}
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

function setDetails(state) {
  document.body.classList.toggle('details-full', state === 'full');
  try {
    localStorage.setItem('details', state);
  } catch {}
  fitDetails();
}

export function initSettings() {
  detailsObserver = new ResizeObserver(fitDetails);

  $('set-side').onchange = (e) => setLayout(e.target.checked);

  $('layout-btn').onclick = () =>
    setLayout(!document.body.classList.contains('side'));

  $('set-peek').onchange = (e) => setPeek(e.target.checked);

  try {
    setPeek(localStorage.getItem('peek') !== '0');
  } catch {
    setPeek(true);
  }

  $('set-details').onchange = (e) => setShowDetails(e.target.checked);

  $('set-hints').onchange = (e) => setHints(e.target.checked);

  try {
    setHints(localStorage.getItem('hints') !== '0');
  } catch {
    setHints(true);
  }

  $('set-side-scale').oninput = (e) => setSideScale(e.target.value);

  try {
    setSideScale(localStorage.getItem('sideScale') || 100);
  } catch {
    setSideScale(100);
  }

  $('set-rs-width').oninput = (e) => setRsScale(e.target.value);

  try {
    setRsScale(localStorage.getItem('rsScale') || 100);
  } catch {
    setRsScale(100);
  }

  try {
    setShowDetails(localStorage.getItem('showDetails') !== '0');
  } catch {
    setShowDetails(true);
  }

  // Key hint bar: small by default, click toggles a bigger size (kept per browser).
  {
    const h = document.querySelector('main>.hint');
    h.title = 'Click to resize';
    const setBig = (on) => {
      h.classList.toggle('big', on);
      try {
        localStorage.setItem('hintBig', on ? '1' : '0');
      } catch {}
    };
    h.onclick = () => setBig(!h.classList.contains('big'));
    try {
      setBig(localStorage.getItem('hintBig') === '1');
    } catch {}
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
      try {
        localStorage.setItem('customNames', JSON.stringify(state.customNames));
      } catch {}
      paintCustoms();
    };
    // × clears the name here and the one saved in the open folder, which otherwise keeps the button shown.
    $('x-' + v).onclick = async (e) => {
      e.preventDefault();
      input.value = '';
      delete state.customNames[v];
      try {
        localStorage.setItem('customNames', JSON.stringify(state.customNames));
      } catch {}
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

  try {
    setLayout(localStorage.getItem('layout') === 'side');
  } catch {
    setLayout(false);
  }

  for (const id of ['ratings', 'details', 'fileinfo', 'genmeta'])
    detailsObserver.observe($(id));

  try {
    setDetails(localStorage.getItem('details') || 'on');
  } catch {}

  $('details').title = 'Click to show all file details, click again to shrink';

  $('details').onclick = () => {
    if (String(getSelection()).trim()) return; // selecting text (e.g. a prompt) is not a click
    const b = document.body.classList;
    if (b.contains('details-full')) setDetails('on');
    else if ($('details').classList.contains('more')) setDetails('full');
  };
}

export { paintCustoms, setMenu, symOf };
