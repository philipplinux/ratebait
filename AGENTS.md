# AGENTS.md

RateBait is a local web app in which a person rates AI-generated images and music. You (the agent) set it up, then read what the person decided and act on it. The person rates in the browser; you read the files the app writes. Two files, `server.py` (Python standard library only) and `index.html`; no install, no build.

## Set it up

1. Check Python: `python3 --version` must be 3.10 or newer.
2. Clone and start it, with one `--root` per folder the person wants to rate:

   ```bash
   git clone https://github.com/philipplinux/ratebait
   cd ratebait
   python3 server.py --root ~/Pictures --root ~/Music --port 8765
   ```

   Without `--root` it uses `MEDIA_RATER_ROOTS` (colon-separated), else the current directory. It listens on `127.0.0.1` only; `--host` accepts IPv4 loopback addresses only.
3. Tell the person to open `http://127.0.0.1:8765/`, pick a folder and rate. The ⚙ menu (**F1**) lists every key.
4. Optional, to keep it running: a systemd user service.

   ```ini
   # ~/.config/systemd/user/ratebait.service
   [Unit]
   Description=RateBait media rater

   [Service]
   WorkingDirectory=%h/ratebait
   ExecStart=/usr/bin/python3 server.py --root %h/Pictures --port 8765
   Restart=on-failure

   [Install]
   WantedBy=default.target
   ```

   Then `systemctl --user daemon-reload && systemctl --user enable --now ratebait`. After a `git pull`, run `systemctl --user restart ratebait`.
5. Optional: the **Browse…** folder dialog needs PyGObject (`python3-gobject` on Fedora, `python3-gi` on Debian/Ubuntu) and `xdg-desktop-portal`. Without them it falls back to Tk (`python3-tkinter` / `python3-tk`); typing a path in the path field always works.

Check that it runs: `curl -s http://127.0.0.1:8765/api/dirs` returns JSON with `roots` and `dirs`.

## What the person's review gives you

Every rated folder gets two files, rewritten on each change:

| File | Use it for |
|---|---|
| `REVIEW.md` | **Read this first.** A Markdown summary grouped by verdict, with comments, pin notes and stroke notes |
| `.review.json` | Exact data, when you need to process it in code |

Verdicts, best to worst: `mvp`, `love`, `pass`, `neutral`, `reject`. A file can also carry a flag that wins over its rating in `REVIEW.md`:

- **`redo`:** the person wants a new version. The comment and pins say what to change.
- **`broken`:** the output is defective (artefacts, cut off, wrong format).
- **`trash`:** marked for deletion. Nothing is ever deleted automatically; ask the person before you delete.
- **`custom7`–`custom9`:** the person's own flags. Their names are in `labels` in `.review.json` and are used as section titles in `REVIEW.md`.

`.review.json` looks like this:

```json
{
  "version": 1,
  "dir": "/home/user/Pictures/run 10",
  "updated": "2026-10-06T15:42:43+01:00",
  "labels": {"custom7": "Print"},
  "items": {
    "phoenix.png": {
      "rating": "mvp", "flag": null,
      "comment": "Huge energy, warm palette. Strong candidate for the hero image.",
      "updated": "2026-10-06T15:42:43+01:00",
      "pins": [{"x": 0.43, "y": 0.37, "note": "Head is small but readable"}],
      "strokes": [{"pts": [[0.30, 0.66], [0.42, 0.20]], "color": "#ffd166", "note": "Strong diagonal"}]
    }
  }
}
```

Pin and stroke coordinates are fractions of the image (0 to 1, from the top left), so `x 0.43, y 0.37` is 43% across and 37% down. Unrated files have no entry in `items`.

PNG files also carry their own review in an iTXt chunk keyed `simple-media-rater`. A rated PNG copied into another folder keeps its rating there.

## Typical jobs

- **Learn the person's taste:** read `REVIEW.md` across folders and compare what `mvp`/`love` files have in common with `reject`/`broken` ones. If the PNGs hold generation metadata (ComfyUI `prompt` or A1111 `parameters`), compare prompts, models and settings too. `GET /api/meta?dir=<folder>&name=<file>` returns them as rows.
- **Redo flagged files:** for every `redo` entry, apply the comment and pin notes to the next generation. Put the new files in the same folder; the app shows them within 10 seconds.
- **Clean up:** list `trash` and `broken` files and ask the person before you move or delete anything.
- **Promote favourites:** copy `mvp` PNGs into a collection folder. Their ratings travel with them.

## Write a review yourself (rarely needed)

The person normally rates in the browser. If you must set a review, POST the **whole** item: the server replaces the entry, so any field you leave out is removed.

```bash
curl -s http://127.0.0.1:8765/api/review -H 'Content-Type: application/json' -d '{
  "dir": "/home/user/Pictures/run 10", "name": "phoenix.png",
  "rating": "mvp", "flag": null, "comment": "Hero image",
  "pins": [{"x": 0.43, "y": 0.37, "note": "Head"}], "strokes": []
}'
```

- `comment` is required and must be a string (it can be `""`).
- `rating`/`flag` must be one of the values above or `null`. With everything empty, the entry is removed.
- Requests carrying a foreign `Origin` header are rejected.
- Writing `.review.json` by hand also works, but only while the app is not saving the same folder. `REVIEW.md` is regenerated on the next save in the app.

## Working on the code

- Keep it dependency-free: standard-library Python and plain HTML/CSS/JS in one `index.html`, no build step.
- Keep the AGPL-3.0-or-later header in both files.
- Restart `server.py` after changing it; `index.html` only needs a browser reload.
- Update `README.md` when keys or behaviour change. The ⚙ Keybinds list in `index.html` is the in-app reference.
