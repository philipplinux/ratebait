#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 philipplinux
"""RateBait. Run: python3 ratebait.py [--root PATH] [--port 8765].

Discovery roots: --root (repeatable), else $MEDIA_RATER_ROOTS (os.pathsep
separated), else the current directory.

Ratings live in .review.json; each change rebuilds REVIEW.md in that folder.
PNG files also carry their review in an iTXt chunk ("simple-media-rater"),
so a copy in another folder brings its rating along: opening that folder
imports embedded reviews for files it has no entry for.
No dependencies. Only loopback hosts are accepted; arbitrary local folders
may be opened. Modification time orders files, not filesystem birth time.
Open the printed URL; pick a discovered folder or type its path. Rating clicks
and numpad-style keys (0 Reject, . Neutral, 1–3 Pass…MVP) save and advance to the next file, wrapping at the end. Comments
save on blur or Ctrl+Enter. Clear removes the rating, flag and comment.
Flags sit beside the rating: Redo (4) asks for changes described in the comment,
Broken (5) marks a defective file, Trash (6) marks it for deletion; each
gets its own REVIEW.md section.
Arrow keys navigate, C focuses comments, and Space toggles audio playback.
Browse opens the system folder dialog (XDG desktop portal, falling back to Tk)
and fills the path; click Open to review it. Cancel leaves the path unchanged.
Large icon rating buttons sit beneath the media, above the comment box.
The page polls every 10 s for new folders and new files in the open folder.
"""
import argparse
import heapq
from contextlib import contextmanager
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
import tempfile
import threading
import time
import zlib
from urllib.parse import parse_qs, urlsplit

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
AUDIO_EXT = {".mp3", ".flac", ".wav", ".ogg", ".m4a", ".opus"}
RATINGS = ["reject", "neutral", "pass", "love", "mvp"]
LEGACY = {"good": "pass", "great": "pass", "bad": "reject"}  # retired ratings, mapped when a folder is loaded
FLAGS = ["redo", "broken", "trash", "custom7", "custom8", "custom9"]
CUSTOM = FLAGS[3:]  # numpad 7-9 flags; their names come from the browser and live in state["labels"]
STATE_FILE = ".review.json"
REPORT_FILE = "REVIEW.md"
LOCK = threading.Lock()
EMBED_KEY = b"simple-media-rater"
NO_EMBED = set()  # (path, mtime_ns, size) of PNGs already found without an embedded review
FRONTEND_ASSETS = {"/": "text/html", "/style.css": "text/css", "/app.js": "text/javascript"}


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


def list_subdirs(raw: str) -> list[str]:
    """Names of the subfolders of a folder, for the path field's suggestions."""
    if not isinstance(raw, str) or not raw:
        return []
    parent = Path(raw).expanduser()
    if not parent.is_dir():
        return []
    names = []
    for p in parent.iterdir():
        try:
            if p.is_dir():
                names.append(p.name)
        except OSError:
            pass
    return sorted(names, key=str.lower)[:2000]


# Folder search for the path field: every folder under the roots (or, once a client opts in, under
# home as well), kept in memory and refreshed in the background. Hidden folders, build/dependency
# folders and other mounts (network drives) are skipped so a scan takes about a second.
DIR_SKIP = {"node_modules", "__pycache__", "venv", "site-packages", "target", "dist", "build"}
DIR_INDEX: dict[str, list[str]] = {"roots": [], "home": []}
DIR_INDEX_EVERY = 300
HOME_WANTED = threading.Event()  # set by the first home-scope search
DIR_REINDEX = threading.Event()


def walk_dirs(roots) -> list[str]:
    found, seen = [], set()
    for root in roots:
        root = str(root)
        if any(root == s or root.startswith(s + "/") for s in seen):
            continue
        seen.add(root)
        try:
            dev = os.stat(root).st_dev
        except OSError:
            continue
        stack = [root]
        while stack:
            d = stack.pop()
            try:
                with os.scandir(d) as it:
                    for e in it:
                        if e.name.startswith(".") or e.name in DIR_SKIP:
                            continue
                        try:
                            if e.is_dir(follow_symlinks=False) and e.stat(follow_symlinks=False).st_dev == dev:
                                found.append(e.path)
                                stack.append(e.path)
                        except OSError:
                            pass
            except OSError:
                pass
    return found


def index_dirs_forever(roots):
    roots = [str(r) for r in sorted(roots, key=lambda r: len(str(r)))]
    while True:
        DIR_INDEX["roots"] = walk_dirs(roots)
        if HOME_WANTED.is_set():
            DIR_INDEX["home"] = walk_dirs([str(Path.home())] + roots)
        DIR_REINDEX.wait(DIR_INDEX_EVERY)
        DIR_REINDEX.clear()


def fuzzy(query: str, text: str):
    """Shared folder-search score (lower is better) and matched positions, or None."""
    q, t = query.lower(), text.lower()
    at = t.find(q)
    if at >= 0:
        return (1000 + at if at else 0) + len(t) / 1000, list(range(at, at + len(q)))
    hits, start, gaps = [], 0, 0
    for c in q:
        k = t.find(c, start)
        if k < 0:
            return None
        gaps += k - start
        hits.append(k)
        start = k + 1
    if gaps > 2 * len(q):
        return None
    return 2000 + gaps + len(t) / 1000, hits


def find_dirs(query: str, scope: str = "roots", limit: int = 50) -> list[dict]:
    if scope == "home" and not HOME_WANTED.is_set():
        HOME_WANTED.set()
        DIR_REINDEX.set()
    if not query:
        return []
    home = str(Path.home())
    ranked = []
    for path in DIR_INDEX["home" if scope == "home" else "roots"]:
        base = path[path.rfind("/") + 1:]
        m = fuzzy(query, base)
        if m:
            ranked.append((m[0] + len(path) / 100, path, m[1]))
    out = []
    for _, path, hits in heapq.nsmallest(limit, ranked):
        label = "~" + path[len(home):] if path.startswith(home + "/") else path
        start = len(label) - (len(path) - path.rfind("/") - 1)
        out.append({"path": label + "/", "hits": [h + start for h in hits]})
    return out


def media_kind(p: Path) -> str | None:
    suffix = p.suffix.lower()
    return "image" if suffix in IMAGE_EXT else "audio" if suffix in AUDIO_EXT else None


def count_media(d: Path) -> int:
    """Number of media files directly in a folder (for the sidebar's subfolder buttons)."""
    try:
        with os.scandir(d) as it:
            return sum(1 for e in it if not e.name.startswith(".") and media_kind(Path(e.name)) and e.is_file())
    except OSError:
        return 0


def list_media(d: Path) -> list[dict]:
    files = []
    for p in d.iterdir():
        kind = media_kind(p)
        if not p.name.startswith(".") and kind and p.is_file():
            stat = p.stat()
            files.append(dict(name=p.name, kind=kind, mtime=stat.st_mtime, size=stat.st_size))
    return sorted(files, key=lambda f: (f["mtime"], f["name"]))


def safe_media_path(d: Path, name: str) -> Path:
    if (not isinstance(name, str) or not name or name != Path(name).name
            or name.startswith(".") or "\x00" in name):
        raise ValueError("invalid media name")
    p = d / name
    if not p.is_file() or media_kind(p) is None:
        raise ValueError(f"not a media file: {name}")
    return p


def clean_marks(item: dict) -> dict:
    # Pins {x, y, note} and pen strokes {pts: [[x, y], ...], color}; x and y are 0..1 of the image size.
    pins, strokes = item.get("pins") or [], item.get("strokes") or []
    if not isinstance(pins, list) or not isinstance(strokes, list) or len(pins) > 200 or len(strokes) > 1000:
        raise ValueError("invalid marks")
    unit = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v <= 1
    out = {}
    for pin in pins:
        if not (isinstance(pin, dict) and unit(pin.get("x")) and unit(pin.get("y"))
                and isinstance(pin.get("note", ""), str) and len(pin.get("note", "")) <= 2000):
            raise ValueError("invalid pin")
    for stroke in strokes:
        pts = stroke.get("pts") if isinstance(stroke, dict) else None
        if not (isinstance(pts, list) and 1 <= len(pts) <= 20000
                and all(isinstance(q, list) and len(q) == 2 and unit(q[0]) and unit(q[1]) for q in pts)
                and re.fullmatch(r"#[0-9a-fA-F]{6}", str(stroke.get("color", "")))
                and isinstance(stroke.get("note", ""), str) and len(stroke.get("note", "")) <= 2000):
            raise ValueError("invalid stroke")
    if pins:
        out["pins"] = [dict(x=round(q["x"], 4), y=round(q["y"], 4), note=q.get("note", "").strip()) for q in pins]
    if strokes:
        out["strokes"] = [dict(pts=[[round(x, 4), round(y, 4)] for x, y in q["pts"]], color=q["color"],
                               **({"note": q["note"].strip()} if q.get("note", "").strip() else {})) for q in strokes]
    return out


def load_state(d: Path) -> dict:
    # Caller holds LOCK: malformed-state preservation is also a write.
    p = d / STATE_FILE
    try:
        state = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(state, dict) or not isinstance(state.get("items"), dict):
            raise ValueError("invalid state")
        for item in state["items"].values():
            if isinstance(item, dict) and item.get("rating") in LEGACY:
                item["rating"] = LEGACY[item["rating"]]
            if (not isinstance(item, dict) or item.get("rating") not in [None, *RATINGS]
                    or item.get("flag") not in [None, *FLAGS]
                    or not isinstance(item.get("comment"), str)):
                raise ValueError("invalid review item")
            item.update(clean_marks(item))
        return state
    except FileNotFoundError:
        return {"version": 1, "items": {}}
    except (ValueError, UnicodeError):
        backup = d / f"{STATE_FILE}.bad-{int(time.time())}"
        while backup.exists():
            backup = d / f"{STATE_FILE}.bad-{time.time_ns()}"
        p.rename(backup)
        return {"version": 1, "items": {}}


def png_chunks(f):
    # Yields (offset, type, data reader) without loading IDAT: only headers are read.
    if f.read(8) != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    while True:
        offset, head = f.tell(), f.read(8)
        if len(head) < 8:
            return
        length, kind = int.from_bytes(head[:4], "big"), head[4:]
        yield offset, kind, length
        f.seek(offset + 12 + length)


def read_embedded(p: Path) -> dict | None:
    found = None
    with p.open("rb") as f:
        for offset, kind, length in png_chunks(f):
            if kind == b"iTXt" and length < 1048576:
                f.seek(offset + 8)
                data = f.read(length)
                if data.startswith(EMBED_KEY + b"\0\0\0\0\0"):
                    found = json.loads(data[len(EMBED_KEY) + 5:])
    return found


def embed_review(p: Path, item: dict | None):
    # Preserve pixels and unrelated chunks; publish only a complete replacement.
    stat = p.stat()
    with p.open("r+b") as source, replacement_file(p) as target:
        target.write(source.read(8))
        source.seek(0)
        for offset, kind, length in png_chunks(source):
            if kind == b"IEND":
                source.seek(offset)
                if source.read(12) != png_chunk(b"IEND", b""):
                    raise ValueError(f"invalid IEND chunk: {p.name}")
                if item:
                    text = json.dumps(item, ensure_ascii=False).encode()
                    target.write(png_chunk(b"iTXt", EMBED_KEY + b"\0\0\0\0\0" + text))
                target.write(png_chunk(b"IEND", b""))
                break
            source.seek(offset + 8)
            if (kind == b"iTXt" and length >= len(EMBED_KEY) + 1
                    and source.read(len(EMBED_KEY) + 1) == EMBED_KEY + b"\0"):
                continue
            source.seek(offset)
            remaining = length + 12
            while remaining:
                chunk = source.read(min(65536, remaining))
                if not chunk:
                    raise ValueError(f"truncated PNG chunk: {p.name}")
                target.write(chunk)
                remaining -= len(chunk)
        else:
            raise ValueError(f"no IEND chunk: {p.name}")
        target.flush()
        os.fchmod(target.fileno(), stat.st_mode & 0o7777)
        os.utime(target.name, ns=(stat.st_atime_ns, stat.st_mtime_ns))


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return len(data).to_bytes(4, "big") + kind + data + zlib.crc32(kind + data).to_bytes(4, "big")


def import_embedded(d: Path, state: dict, files: list[dict]) -> bool:
    # Caller holds LOCK. Adopts embedded reviews of PNGs this folder has no entry for.
    added = False
    for f in files:
        p = d / f["name"]
        if f["name"] in state["items"] or p.suffix.lower() != ".png":
            continue
        stat = p.stat()
        key = (str(p), stat.st_mtime_ns, stat.st_size)
        if key in NO_EMBED:
            continue
        try:
            item = read_embedded(p)
        except (OSError, ValueError):
            item = None
        if not isinstance(item, dict):
            NO_EMBED.add(key)
            continue
        item["rating"] = LEGACY.get(item.get("rating"), item.get("rating"))
        if (item.get("rating") in [None, *RATINGS] and item.get("flag") in [None, *FLAGS]
                and isinstance(item.get("comment", ""), str)):
            try:
                marks = clean_marks(item)
            except ValueError:
                marks = {}
            state["items"][f["name"]] = dict(rating=item.get("rating"), flag=item.get("flag"),
                                             comment=item.get("comment", ""), updated=item.get("updated"), **marks)
            added = True
    return added


def png_text(p: Path) -> dict:
    # tEXt/iTXt chunks (uncompressed), without our own review chunk.
    out = {}
    with p.open("rb") as f:
        for offset, kind, length in png_chunks(f):
            if kind not in (b"tEXt", b"iTXt") or length > 4194304:
                continue
            f.seek(offset + 8)
            key, _, rest = f.read(length).partition(b"\0")
            if key == EMBED_KEY:
                continue
            if kind == b"iTXt":
                if rest[:1] != b"\0":
                    continue  # compressed iTXt: skip
                rest = rest[2:].split(b"\0", 2)[-1]
            out[key.decode("latin-1")] = rest.decode("utf-8" if kind == b"iTXt" else "latin-1", "replace")
    return out


def media_meta(p: Path) -> list:
    # Generation details as [label, value] rows: ComfyUI API graphs ("prompt") or A1111 "parameters".
    if p.suffix.lower() != ".png":
        return []
    text = png_text(p)
    rows = []
    try:
        graph = json.loads(text.get("prompt", ""))
    except ValueError:
        graph = None
    if isinstance(graph, dict):
        models, prompts, sampling, scale = [], [], [], []
        for node in graph.values():
            inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
            kind = node.get("class_type", "") if isinstance(node, dict) else ""
            for key, value in inputs.items():
                if isinstance(value, str) and key.endswith("_name") and "." in value:
                    models.append(value.rsplit(".", 1)[0])
                if isinstance(value, str) and key in ("prompt", "text") and len(value) > 15:
                    prompts.append(value)
            if "seed" in inputs and not isinstance(inputs["seed"], list):
                sampling.append(f"seed {inputs['seed']}")
                sampling += [f"{inputs[k]} steps" for k in ["steps"] if k in inputs]
                sampling += [f"cfg {inputs['cfg']}" for k in ["cfg"] if k in inputs]
                if "sampler_name" in inputs:
                    sampling.append(f"{inputs['sampler_name']}/{inputs.get('scheduler', '')}".rstrip("/"))
                if inputs.get("denoise", 1) != 1:
                    sampling.append(f"denoise {inputs['denoise']}")
            if kind == "LoadImage" and isinstance(inputs.get("image"), str):
                rows.append(["Source", inputs["image"]])
            if kind == "ImageScale" and "width" in inputs:
                scale.append(f"{inputs.get('upscale_method', '')} → {inputs['width']}×{inputs['height']}")
        if models:
            rows.append(["Models", " · ".join(dict.fromkeys(models))])
        if sampling:
            rows.append(["Sampling", " · ".join(sampling)])
        if scale:
            rows.append(["Resize", " · ".join(scale)])
        if prompts:
            rows.append(["Prompt", prompts[0]])
    elif text.get("parameters"):
        rows.append(["Parameters", text["parameters"]])
    return rows


@contextmanager
def replacement_file(p: Path):
    # Exclusive creation prevents collisions and following pre-existing symlinks.
    with tempfile.NamedTemporaryFile(mode="wb", dir=p.parent, prefix=f".{p.name}.",
                                     suffix=".tmp", delete=False) as target:
        tmp = Path(target.name)
        try:
            yield target
            target.close()
            os.replace(tmp, p)
        finally:
            tmp.unlink(missing_ok=True)


def atomic_write(p: Path, text: str):
    with replacement_file(p) as target:
        target.write(text.encode("utf-8"))


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
                           and n not in {"__pycache__", "node_modules"}] if depth < 6 else []
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
    sections = ["redo", *reversed(RATINGS), *CUSTOM, "broken", "trash", "unrated"]
    groups = {section: [] for section in sections}
    for f in files:
        item = state["items"].get(f["name"], {})
        groups[item.get("flag") or item.get("rating") or "unrated"].append((f, item))
    labels = state.get("labels", {})
    sections = [s for s in sections if s not in CUSTOM or s in labels or groups[s]]
    rated = len(files) - len(groups["unrated"])
    counts = " · ".join(f"{labels.get(r, r)} {len(groups[r])}" for r in sections)
    titles = {"redo": "Redo / changes requested", "broken": "Broken", "trash": "Trash / marked for deletion", "mvp": "MVP / best"}
    lines = ["# Media review", "", f"- Folder: `{d}`",
             f"- Updated: {state['updated']}",
             f"- Progress: {rated}/{len(files)} rated · {counts}", ""]
    for rating in sections:
        lines.append(f"## {labels.get(rating) or titles.get(rating, rating.title())}")
        if not groups[rating]:
            lines.append("- (none)")
        for f, item in groups[rating]:
            comment = " ".join(item.get("comment", "").splitlines())
            kind = f["kind"] + (f", {item['rating']}" if item.get("flag") and item.get("rating") else "")
            lines.append(f"- `{f['name']}` ({kind})" + (f": {comment}" if comment else ""))
            for n, pin in enumerate(item.get("pins", []), 1):
                note = " ".join(pin["note"].splitlines())
                lines.append(f"  - Pin {n} ({pin['x']:.0%}, {pin['y']:.0%})" + (f": {note}" if note else ""))
            for n, stroke in enumerate(item.get("strokes", []), 1):
                note = " ".join(stroke.get("note", "").splitlines())
                lines.append(f"  - Stroke {n} ({stroke['color']})" + (f": {note}" if note else ""))
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
        if url.path in FRONTEND_ASSETS:
            filename = "index.html" if url.path == "/" else url.path[1:]
            body = (Path(__file__).parent / filename).read_bytes()
            content_type = FRONTEND_ASSETS[url.path]
            self.send_response(200)
            self.send_header("Content-Type", content_type + "; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/api/dirs":
            self.json_response(200, {"roots": [str(p) for p in self.server.roots], "home": str(Path.home()),
                                     "dirs": discover_dirs(self.server.roots)})
        elif url.path == "/api/find-dirs":
            scope = query.get("scope", ["roots"])[0]
            self.json_response(200, {"dirs": find_dirs(query.get("q", [""])[0], scope),
                                     "indexed": len(DIR_INDEX["home" if scope == "home" else "roots"])})
        elif url.path == "/api/subdirs":
            raw = query.get("path", [""])[0]
            names = list_subdirs(raw)
            body = {"names": names}
            if query.get("match", [""])[0] == "1":
                needle = query.get("q", [""])[0]
                matches = []
                for name in names:
                    if name.startswith(".") and not needle.startswith("."):
                        continue
                    m = fuzzy(needle, name) if needle else (0, [])
                    if m is not None:
                        matches.append({"name": name, "score": m[0], "hits": m[1]})
                body = {"matches": matches}
            elif query.get("counts", [""])[0] == "1" and len(names) <= 200:
                body["counts"] = {n: count_media(Path(raw).expanduser() / n) for n in names}
            self.json_response(200, body)
        elif url.path == "/api/meta":
            d = resolve_dir(query.get("dir", [""])[0])
            p = safe_media_path(d, query.get("name", [""])[0])
            try:
                rows = media_meta(p)
            except (OSError, ValueError):
                rows = []
            self.json_response(200, {"rows": rows})
        elif url.path in {"/api/list", "/media"}:
            d = resolve_dir(query.get("dir", [""])[0])
            if url.path == "/api/list":
                files = list_media(d)
                with LOCK:
                    state = load_state(d)
                    if import_embedded(d, state, files):
                        state.update(dir=str(d), updated=datetime.now().astimezone().isoformat(timespec="seconds"))
                        save_state(d, state)
                        write_report(d, state, files)
                self.json_response(200, {"dir": str(d), "files": files, "items": state["items"],
                                         "labels": state.get("labels", {})})
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
            if route not in {"/api/review", "/api/pick-folder", "/api/forget-label"}:
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
            if route == "/api/forget-label":
                # Drops a custom button name saved in this folder, so the button can be hidden again.
                if data.get("label") not in CUSTOM:
                    raise ValueError("invalid label")
                with LOCK:
                    state = load_state(d)
                    if state.get("labels", {}).pop(data["label"], None) is not None:
                        save_state(d, state)
                        write_report(d, state, list_media(d))
                self.json_response(200, {"labels": state.get("labels", {})})
                return
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
            marks = clean_marks(data)
            labels = data.get("labels") or {}
            if (not isinstance(labels, dict) or not set(labels) <= set(CUSTOM)
                    or not all(isinstance(v, str) and len(v) <= 40 for v in labels.values())):
                raise ValueError("invalid labels")
            labels = {k: v.strip() for k, v in labels.items() if v.strip()}
            with LOCK:
                state = load_state(d)
                state_path = d / STATE_FILE
                previous = state_path.read_text(encoding="utf-8") if state_path.exists() else None
                now = datetime.now().astimezone().isoformat(timespec="seconds")
                cleared = rating is None and flag is None and not comment and not marks
                # An explicit empty PNG entry prevents stale embedded data from being reimported.
                if cleared and Path(name).suffix.lower() != ".png":
                    state["items"].pop(name, None)
                else:
                    state["items"][name] = dict(rating=rating, flag=flag, comment=comment, updated=now, **marks)
                state.update(dir=str(d), updated=now)
                if labels:
                    state["labels"] = {**state.get("labels", {}), **labels}
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
                if Path(name).suffix.lower() == ".png":
                    try:
                        embed_review(d / name, None if cleared else state["items"].get(name))
                    except (OSError, ValueError) as e:
                        print(f"embed skipped: {e}", file=sys.stderr, flush=True)
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
    threading.Thread(target=index_dirs_forever, args=(args.root,), daemon=True).start()
    print(f"RateBait: http://{args.host}:{args.port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
