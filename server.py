#!/usr/bin/env python3
"""Simple Media Rater. Run: python3 server.py [--root PATH] [--port 8765].

Discovery roots: --root (repeatable), else $MEDIA_RATER_ROOTS (os.pathsep
separated), else the current directory.

Ratings live in .review.json; each change rebuilds REVIEW.md in that folder.
No dependencies. Only loopback hosts are accepted; arbitrary local folders
may be opened. Modification time orders files, not filesystem birth time.
Open the printed URL; pick a discovered folder or type its path. Rating clicks
and keys 1–6 save and advance to the next file, wrapping at the end. Comments
save on blur or Ctrl+Enter. Clear removes the rating, flag and comment.
Flags sit beside the rating: Redo (R) asks for changes described in the comment,
Broken (X) marks a file as trash; both get their own REVIEW.md section.
Arrow keys navigate, C focuses comments, and Space toggles audio playback.
Browse opens the system folder dialog (XDG desktop portal, falling back to Tk)
and fills the path; click Open to review it. Cancel leaves the path unchanged.
Large icon rating buttons sit beneath the media, above the comment box.
The page polls every 10 s for new folders and new files in the open folder.
"""
import argparse
from datetime import datetime
import http.server
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import time
from urllib.parse import parse_qs, urlsplit

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
AUDIO_EXT = {".mp3", ".flac", ".wav", ".ogg", ".m4a", ".opus"}
RATINGS = ["reject", "neutral", "good", "great", "love", "mvp"]
FLAGS = ["redo", "broken"]
STATE_FILE = ".review.json"
REPORT_FILE = "REVIEW.md"
LOCK = threading.Lock()


def configuration():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", action="append", metavar="PATH")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    if not ipaddress.ip_address(args.host).is_loopback or ":" in args.host:
        parser.error("--host must be an IPv4 loopback address")
    args.root = [Path(p).expanduser().resolve() for p in
                 (args.root or os.environ.get("MEDIA_RATER_ROOTS", ".").split(os.pathsep))
                 if p]
    return args


def resolve_dir(raw: str) -> Path:
    if not isinstance(raw, str) or not raw:
        raise ValueError("dir must be a nonempty path")
    d = Path(raw).expanduser().resolve()
    if not d.is_dir():
        raise ValueError(f"not a directory: {d}")
    return d


def media_kind(p: Path) -> str | None:
    suffix = p.suffix.lower()
    return "image" if suffix in IMAGE_EXT else "audio" if suffix in AUDIO_EXT else None


def list_media(d: Path) -> list[dict]:
    files = []
    for p in d.iterdir():
        kind = media_kind(p)
        if not p.name.startswith(".") and kind and p.is_file():
            stat = p.stat()
            files.append(dict(name=p.name, kind=kind, mtime=stat.st_mtime, size=stat.st_size))
    return sorted(files, key=lambda f: (-f["mtime"], f["name"]))


def safe_media_path(d: Path, name: str) -> Path:
    if (not isinstance(name, str) or not name or name != Path(name).name
            or name.startswith(".") or "\x00" in name):
        raise ValueError("invalid media name")
    p = d / name
    if not p.is_file() or media_kind(p) is None:
        raise ValueError(f"not a media file: {name}")
    return p


def load_state(d: Path) -> dict:
    # Caller holds LOCK: malformed-state preservation is also a write.
    p = d / STATE_FILE
    try:
        state = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or not isinstance(state.get("items"), dict):
            raise ValueError("invalid state")
        for item in state["items"].values():
            if (not isinstance(item, dict) or item.get("rating") not in [None, *RATINGS]
                    or item.get("flag") not in [None, *FLAGS]
                    or not isinstance(item.get("comment"), str)):
                raise ValueError("invalid review item")
        return state
    except FileNotFoundError:
        return {"version": 1, "items": {}}
    except (ValueError, UnicodeError):
        backup = d / f"{STATE_FILE}.bad-{int(time.time())}"
        while backup.exists():
            backup = d / f"{STATE_FILE}.bad-{time.time_ns()}"
        p.rename(backup)
        return {"version": 1, "items": {}}


def atomic_write(p: Path, text: str):
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, p)


def save_state(d: Path, state: dict):
    # All callers hold LOCK across the complete read-modify-write operation.
    atomic_write(d / STATE_FILE, json.dumps(state, ensure_ascii=False, indent=2) + "\n")


def discover_dirs(roots) -> list[dict]:
    found = {}
    for root in roots:
        if not root.is_dir():
            continue
        for raw, children, _ in os.walk(root):
            d = Path(raw)
            depth = len(d.relative_to(root).parts)
            children[:] = [n for n in children if not n.startswith(".")
                           and n not in {"__pycache__", "node_modules"}] if depth < 4 else []
            files = list_media(d)
            if files:
                path = str(d)
                home = str(Path.home())
                label = "~" + path[len(home):] if path == home or path.startswith(home + "/") else path
                found[path] = dict(path=path, label=label, count=len(files),
                                   newest=max(f["mtime"] for f in files))
    return sorted(found.values(), key=lambda f: (-f["newest"], f["path"]))


def write_report(d: Path, state: dict, files: list[dict]):
    # Flagged files are listed under their flag (rating kept in the line), not their rating.
    sections = ["redo", *reversed(RATINGS), "broken", "unrated"]
    groups = {section: [] for section in sections}
    for f in files:
        item = state["items"].get(f["name"], {})
        groups[item.get("flag") or item.get("rating") or "unrated"].append((f, item))
    rated = len(files) - len(groups["unrated"])
    counts = " · ".join(f"{r} {len(groups[r])}" for r in sections)
    titles = {"redo": "Redo / changes requested", "broken": "Broken / trash", "mvp": "MVP / best"}
    lines = ["# Media review", "", f"- Folder: `{d}`",
             f"- Updated: {state['updated']}",
             f"- Progress: {rated}/{len(files)} rated · {counts}", ""]
    for rating in sections:
        lines.append(f"## {titles.get(rating, rating.title())}")
        if not groups[rating]:
            lines.append("- (none)")
        for f, item in groups[rating]:
            comment = " ".join(item.get("comment", "").splitlines())
            kind = f["kind"] + (f", {item['rating']}" if item.get("flag") and item.get("rating") else "")
            lines.append(f"- `{f['name']}` ({kind})" + (f": {comment}" if comment else ""))
        lines.append("")
    atomic_write(d / REPORT_FILE, "\n".join(lines))


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def json_response(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            self.get_route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as e:
            self.json_response(400, {"error": str(e)})
        except OSError as e:
            self.json_response(500, {"error": str(e)})

    def get_route(self):
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if url.path == "/":
            body = (Path(__file__).parent / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/api/dirs":
            self.json_response(200, {"roots": [str(p) for p in self.server.roots],
                                     "dirs": discover_dirs(self.server.roots)})
        elif url.path in {"/api/list", "/media"}:
            d = resolve_dir(query.get("dir", [""])[0])
            if url.path == "/api/list":
                with LOCK:
                    state = load_state(d)
                self.json_response(200, {"dir": str(d), "files": list_media(d),
                                         "items": state["items"]})
            else:
                self.stream_media(safe_media_path(d, query.get("name", [""])[0]))
        else:
            self.json_response(404, {"error": "unknown route"})

    def stream_media(self, p: Path):
        with p.open("rb") as source:
            size = os.fstat(source.fileno()).st_size
            start, end, status = 0, size - 1, 200
            requested = self.headers.get("Range")
            if requested:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested)
                if not match or not any(match.groups()):
                    valid = False
                else:
                    a, b = match.groups()
                    if a:
                        start, end = int(a), min(int(b), size - 1) if b else size - 1
                    else:
                        start = max(0, size - int(b))
                    valid = size > 0 and 0 <= start <= end < size and (bool(a) or int(b) > 0)
                if not valid:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                status = 206
            self.send_response(status)
            content_type = "audio/flac" if p.suffix.lower() == ".flac" else (
                mimetypes.guess_type(p.name)[0] or "application/octet-stream")
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if status == 206:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            source.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_POST(self):
        try:
            route = urlsplit(self.path).path
            if route not in {"/api/review", "/api/pick-folder"}:
                self.json_response(404, {"error": "unknown route"})
                return
            # Browsers on other origins must not be able to mutate local files.
            origin = self.headers.get("Origin")
            if origin and origin != f"http://{self.headers.get('Host')}":
                raise ValueError("cross-origin review is not allowed")
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 1048576:
                raise ValueError("invalid request size")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("request must be an object")
            if route == "/api/pick-folder":
                initial = data.get("initial") or str(Path.home())
                if not isinstance(initial, str):
                    raise ValueError("initial path must be a string")
                # Modal GUIs run in a child process, away from HTTP worker threads.
                result = subprocess.run(
                    [sys.executable, __file__, "--pick-folder", str(Path(initial).expanduser())],
                    capture_output=True, text=True)
                if result.returncode:
                    raise OSError("Folder picker could not open: " + result.stderr.strip())
                self.json_response(200, {"path": result.stdout.strip() or None})
                return
            d = resolve_dir(data.get("dir"))
            name = data.get("name")
            safe_media_path(d, name)
            rating = data.get("rating")
            if rating not in [None, *RATINGS]:
                raise ValueError("invalid rating")
            flag = data.get("flag")
            if flag not in [None, *FLAGS]:
                raise ValueError("invalid flag")
            comment = data.get("comment")
            if not isinstance(comment, str):
                raise ValueError("comment must be a string")
            comment = comment.strip()
            with LOCK:
                state = load_state(d)
                state_path = d / STATE_FILE
                previous = state_path.read_text(encoding="utf-8") if state_path.exists() else None
                now = datetime.now().astimezone().isoformat(timespec="seconds")
                if rating is None and flag is None and not comment:
                    state["items"].pop(name, None)
                else:
                    state["items"][name] = dict(rating=rating, flag=flag, comment=comment, updated=now)
                state.update(dir=str(d), updated=now)
                save_state(d, state)
                try:
                    write_report(d, state, list_media(d))
                except OSError:
                    # A failed POST must not appear committed on reopening the folder.
                    if previous is None:
                        state_path.unlink()
                    else:
                        atomic_write(state_path, previous)
                    raise
                self.json_response(200, {"ok": True, "items": state["items"]})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except (ValueError, UnicodeError) as e:
            self.json_response(400, {"error": str(e)})
        except OSError as e:
            self.json_response(500, {"error": str(e)})


PORTAL_PICKER = r"""
import os, sys
from urllib.parse import unquote, urlsplit
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION)
token = "smr%d" % os.getpid()
sender = bus.get_unique_name()[1:].replace(".", "_")
handle = "/org/freedesktop/portal/desktop/request/%s/%s" % (sender, token)
loop, out = GLib.MainLoop(), []
def done(_c, _s, _p, _i, _n, params, _d):
    code, results = params.unpack()
    if code == 0 and results.get("uris"):
        out.append(unquote(urlsplit(results["uris"][0]).path))
    loop.quit()
bus.signal_subscribe("org.freedesktop.portal.Desktop", "org.freedesktop.portal.Request",
                     "Response", handle, None, 0, done, None)
opts = {"handle_token": GLib.Variant("s", token), "directory": GLib.Variant("b", True),
        "modal": GLib.Variant("b", True),
        "current_folder": GLib.Variant("ay", os.fsencode(sys.argv[1]) + b"\0")}
bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
              "org.freedesktop.portal.FileChooser", "OpenFile",
              GLib.Variant("(ssa{sv})", ("", "Choose media folder", opts)),
              GLib.VariantType("(o)"), 0, -1, None)
loop.run()
print(out[0] if out else "")
"""


def pick_folder(initial: str) -> None:
    """Print a folder chosen in the system dialog (XDG portal), else Tk's."""
    portal = subprocess.run([sys.executable, "-c", PORTAL_PICKER, initial],
                            capture_output=True, text=True)
    if portal.returncode == 0:
        print(portal.stdout.strip())
        return
    import tkinter as tk
    from tkinter import filedialog
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    path = filedialog.askdirectory(parent=root, title="Choose media folder",
                                   initialdir=initial, mustexist=True)
    root.destroy()
    print(path if isinstance(path, str) else "")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--pick-folder"]:
        pick_folder(sys.argv[2])
        sys.exit()
    args = configuration()
    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    server.roots = args.root
    print(f"Simple Media Rater: http://{args.host}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
