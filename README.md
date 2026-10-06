# RateBait

Tiny local web app for rating AI-generated images and music fast: numpad keys to rate (Reject → MVP) and flag (Redo, Broken, Trash), a comment per file, a scrollable grid view, and a `REVIEW.md` summary per folder that an LLM can read to learn your taste. Python standard library only: no install, no build.

![RateBait: grid view with ratings, numpad buttons and comment box](docs/screenshot.png)

## Setup

- **Required:** Python 3.10+ and a modern browser. Nothing to install: clone and run.
- **Optional, for Browse…:** on Linux, PyGObject (`python3-gobject` on Fedora, `python3-gi` on Debian/Ubuntu) plus a running `xdg-desktop-portal`, which most desktops ship. Without it, Browse… falls back to Tk (`python3-tkinter` / `python3-tk`). Without either, type the folder path instead.
- **Folders:** pass `--root` per media folder, or set `MEDIA_RATER_ROOTS` once (e.g. in `~/.config/environment.d/`).

```bash
git clone https://github.com/philipplinux/ratebait
cd ratebait
python3 server.py                          # scans the current directory → http://127.0.0.1:8765/
python3 server.py --root ~/Pictures --root ~/Music --port 8765
```

## Use

- Pick a discovered folder (scans the roots up to 4 levels deep) or type/browse to any local folder. Roots: `--root` (repeatable), else `MEDIA_RATER_ROOTS` (colon-separated), else the current directory.
- Numpad layout: **0** Neutral, **.** Reject, **1–3** Great · Love · MVP: rate and advance (old Good/Bad ratings load as Great/Reject); **← →** and **↑ ↓** navigate (in the grid ↑ ↓ move a row); **C** comment (**Ctrl+Enter** or **Next →** beside Clear saves it and moves on); **Space** play/pause audio.
- **4** Redo: request changes. Without a comment it stays (press again to remove it); with one it moves on (Redo → **C**, write → **Ctrl+Enter** or Redo again → next). A rating replaces any flag; **Clear** removes rating, flag and comment. **5** Broken: defective output, advance. **6** Trash: mark for deletion, advance. Press again to remove the flag. Each gets its own section in `REVIEW.md`; nothing is deleted automatically.
- **💬 checkbox** (top right of every button): comment mode. On, the button works like Redo: it sets the value but stays until there is a comment, then pressing it again moves on (or press again without a comment to undo). Off, ratings and flags move on straight away. On for Redo by default; remembered per browser.
- **⇥ (top right):** flips the buttons and comment into a right sidebar, buttons arranged like a numpad; remembered per browser.
- **▦ G Grid (right of the comment, or under it in the sidebar; Space/G):** all files as a scrollable 3-column grid, 3 rows visible; click a tile to select it, double-click for fullscreen, ↑↓ move by row; tiles show the filename (date-run prefix dropped); ratings apply to the outlined tile. On an audio file, Space still plays/pauses; G opens the grid there.
- **Sidebar:** each file shows type · resolution · size in grey. Drag rows to put files in your own order for A/B comparing; arrows, grid and progress bar follow it. The order is saved per folder in this browser; new files appear on top, and **Reset** returns to newest-first.
- **‹ flag (edge of the file list) / L:** hides the file list; the › flag on the left edge brings it back; remembered per browser.
- **Live:** new folders and new files show up within 10 s, no reload needed.
- **Click an image** for fullscreen: **Ctrl+wheel** zooms at the cursor, drag pans, click or Esc closes.
- Ratings are stored per folder in `.review.json`, and `REVIEW.md` is rebuilt on every change: a Markdown summary an LLM can read to learn your taste.
- PNG files also carry their review in an embedded iTXt chunk (pixels and other metadata untouched, mtime kept). Copy a rated PNG into another folder and the rater picks up its rating there, so favourites can be promoted and demoted in a collection folder.

Images: PNG, JPG, WebP, GIF. Audio: MP3, FLAC, WAV, OGG, M4A, Opus. Listens on IPv4 loopback only; cross-origin POSTs are rejected. **Browse…** opens the system folder dialog via the XDG desktop portal (needs PyGObject), falling back to Tk.

## License

MIT, see [LICENSE](LICENSE).
