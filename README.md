# Simple Media Rater

Tiny local web app for rating generated images and music one file at a time. Python standard library only: no install, no build.

![Simple Media Rater rating a folder of wallpapers](docs/screenshot.png)

```bash
python3 server.py                          # scans the current directory → http://127.0.0.1:8765/
python3 server.py --root ~/Pictures --root ~/Music --port 8765
```

- Pick a discovered folder (scans the roots up to 4 levels deep) or type/browse to any local folder. Roots: `--root` (repeatable), else `MEDIA_RATER_ROOTS` (colon-separated), else the current directory.
- **1–5** rate (Reject · Neutral · Good · Great · Love) and advance; **← →** navigate; **C** comment; **Space** play/pause audio.
- **Click an image** for fullscreen: **Ctrl+wheel** zooms at the cursor, drag pans, click or Esc closes.
- Ratings are stored per folder in `.review.json`, and `REVIEW.md` is rebuilt on every change: a Markdown summary an LLM can read to learn your taste.

Images: PNG, JPG, WebP, GIF. Audio: MP3, FLAC, WAV, OGG, M4A, Opus. Listens on IPv4 loopback only; cross-origin POSTs are rejected. **Browse…** opens the system folder dialog via the XDG desktop portal (needs PyGObject), falling back to Tk.
