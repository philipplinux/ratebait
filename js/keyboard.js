// SPDX-License-Identifier: AGPL-3.0-or-later · Copyright (C) 2026 philipplinux
import {
  $,
  current,
  keyAction,
  keyQueue,
  state,
  toast,
  transact,
} from './state.js';
import {
  closeViewer,
  gridSize,
  openViewer,
  paintSingle,
  panBy,
  resetView,
  setGrid,
  single,
  stepGrid,
  view,
  zoomSingle,
  zoomView,
} from './media.js';
import { setMenu } from './settings.js';
import {
  applyPicks,
  clearPicks,
  jump,
  multiOn,
  setCommentOpen,
} from './review.js';
import { markMode, setMarkMode, setMarksHidden, undoStroke } from './marks.js';
import { setList } from './sidebar.js';

export function initKeyboard() {
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
