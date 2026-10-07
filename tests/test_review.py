# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 philipplinux
"""Run from the repo root: python3 -m tests.test_review. Exercises a real HTTP server with scratch PNGs."""

import json
from pathlib import Path
import struct
import tempfile
import threading
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import ProxyHandler, Request, build_opener, urlopen
import zlib

import ratebait as rb


def check():
    with tempfile.TemporaryDirectory() as raw:
        d = Path(raw)
        png = (
            b"\x89PNG\r\n\x1a\n"
            + rb.png_chunk(b"IHDR", struct.pack("!IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + rb.png_chunk(b"IDAT", zlib.compress(b"\0\xff\0\0"))
            + rb.png_chunk(b"IEND", b"")
        )
        for name in ["a.png", "b.png"]:
            (d / name).write_bytes(png)
        server = rb.http.server.ThreadingHTTPServer(("127.0.0.1", 0), rb.Handler)
        server.roots = [d]
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.1:{server.server_port}"

        def save(name, rating):
            body = json.dumps(dict(dir=str(d), name=name, rating=rating, flag=None, comment="")).encode()
            with urlopen(
                Request(base + "/api/review", data=body, headers={"Content-Type": "application/json"})
            ) as response:
                return json.load(response)

        def request(path, data=None, headers=None, status=200):
            body = json.dumps(data).encode() if data is not None else None
            try:
                response = build_opener(ProxyHandler({})).open(Request(base + path, data=body, headers=headers or {}))
            except HTTPError as e:
                response = e
            with response:
                assert response.status == status, (response.status, status)
                result = json.load(response)
                if status >= 400:
                    assert isinstance(result["error"], str)
                return result

        listing = "/api/list?" + urlencode({"dir": str(d)})
        review = dict(dir=str(d), name="b.png", rating="pass", flag=None, comment="")
        try:
            save("a.png", "love")
            (d / "a.png").chmod(0o444)
            # A genuine unwritable media file, while its state/report remain writable.
            # Root bypasses mode bits; use an explicit embedding failure in that environment.
            from unittest.mock import patch
            import os
            from contextlib import nullcontext

            failure = (
                patch.object(rb, "embed_review", side_effect=PermissionError("read-only PNG"))
                if os.geteuid() == 0
                else nullcontext()
            )
            with failure:
                assert save("a.png", None)["items"]["a.png"]["rating"] is None
            assert rb.read_embedded(d / "a.png")["rating"] == "love"
            with urlopen(base + "/api/list?dir=" + str(d)) as response:
                assert json.load(response)["items"]["a.png"]["rating"] is None
            # Reload from disk, not a transient in-memory marker.
            assert rb.load_state(d)["items"]["a.png"]["rating"] is None
            (d / "a.png").chmod(0o644)
            state = rb.load_state(d)
            state["items"]["a.png"] = dict(rating="love", flag=None, comment="", pins=[dict(x=0.5, y=0.5)])
            (d / rb.STATE_FILE).write_text(json.dumps(state))
            result = save("b.png", "pass")
            assert result["items"]["a.png"]["pins"] == [dict(x=0.5, y=0.5, note="")]
            assert result["items"]["b.png"]["rating"] == "pass"
            assert "Pin 1 (50%, 50%)" in (d / rb.REPORT_FILE).read_text()
            assert rb.load_state(d)["items"]["a.png"]["pins"][0]["note"] == ""
            # Null/falsey optional marks are canonicalized, never fed back to report loops.
            for value in [None, False, {}, ""]:
                state = rb.load_state(d)
                state["items"]["a.png"].update(pins=value, strokes=value)
                (d / rb.STATE_FILE).write_text(json.dumps(state))
                result = save("b.png", "pass")
                assert "pins" not in result["items"]["a.png"]
                assert "strokes" not in result["items"]["a.png"]

            # Malformed disk ratings/labels are preserved in quarantine and list recovers.
            for bad in [[], {}, {"labels": None}, {"labels": {"custom7": 4}}]:
                state = {"items": {"a.png": dict(rating=bad, comment="")}}
                if isinstance(bad, dict) and "labels" in bad:
                    state = {"items": {}, **bad}
                raw_state = json.dumps(state)
                (d / rb.STATE_FILE).write_text(raw_state)
                request(listing)
                assert any(p.read_text() == raw_state for p in d.glob(".review.json.bad-*"))

            # Untrusted embedded ratings are ignored; valid legacy imports still report.
            for rating in [[], {}]:
                (d / rb.STATE_FILE).unlink(missing_ok=True)
                rb.embed_review(d / "a.png", dict(rating=rating, comment=""))
                assert "a.png" not in request(listing)["items"]
            (d / rb.STATE_FILE).unlink(missing_ok=True)
            rb.embed_review(d / "a.png", dict(rating="great", comment="imported", pins=[dict(x=.2, y=.3)]))
            assert request(listing)["items"]["a.png"]["rating"] == "pass"
            assert "imported" in (d / rb.REPORT_FILE).read_text()

            # Every report-writing consumer rolls JSON back, including non-I/O failures.
            for error in [OSError("report disk"), KeyError("report field"), TypeError("report type"), ValueError("report value")]:
                before = (d / rb.STATE_FILE).read_bytes()
                with patch.object(rb, "write_report", side_effect=error):
                    request("/api/review", review, status=500)
                assert (d / rb.STATE_FILE).read_bytes() == before
            request("/api/review", {**review, "labels": {"custom7": "Print"}})
            before = (d / rb.STATE_FILE).read_bytes()
            with patch.object(rb, "write_report", side_effect=KeyError("forget report")):
                request("/api/forget-label", dict(dir=str(d), label="custom7"), status=500)
            assert (d / rb.STATE_FILE).read_bytes() == before
            request("/api/forget-label", dict(dir=str(d), label="custom7"))
            assert "custom7" not in rb.load_state(d)["labels"]
            (d / rb.STATE_FILE).unlink()
            with patch.object(rb, "write_report", side_effect=TypeError("import report")):
                request(listing, status=500)
            assert not (d / rb.STATE_FILE).exists()

            graph = {
                "1": {"class_type": "ImageScale", "inputs": {"width": 512}},
                "2": {"inputs": None}, "3": {"inputs": []},
                "4": {"class_type": "LoadImage", "inputs": {"image": "source.png"}},
            }
            (d / "b.png").write_bytes(png[:-12] + rb.png_chunk(b"tEXt", b"prompt\0" + json.dumps(graph).encode()) + png[-12:])
            meta = request("/api/meta?" + urlencode({"dir": str(d), "name": "b.png"}))
            assert meta["rows"] == [["Source", "source.png"]]

            # Host is validated independently even when Origin agrees with an attacker.
            trusted = f"localhost:{server.server_port}"
            request(listing, headers={"Host": trusted, "Origin": "http://" + trusted})
            for host in ["evil.example", f"evil.example:{server.server_port}", "127.0.0.1:1", "127.0.0.2:" + str(server.server_port)]:
                headers = {"Host": host, "Origin": "http://" + host}
                request(listing, headers=headers, status=400)
                request("/api/review", review, headers=headers, status=400)
            for origin in ["https://" + trusted, "http://evil.example", "null"]:
                request(listing, headers={"Origin": origin}, status=400)
                request("/api/review", review, headers={"Origin": origin}, status=400)
            request("/api/review", review)  # Non-browser clients need no Origin.
            # HTTP default-port authorities omit :80 after browser URL normalization.
            with patch.object(server, "server_port", 80):
                for host in ["127.0.0.1", "127.0.0.1:80", "localhost", "localhost:80"]:
                    request(listing, headers={"Host": host, "Origin": "http://" + host})
                    request("/api/review", review, headers={"Host": host, "Origin": "http://" + host})
                request(listing, headers={"Host": "evil.example", "Origin": "http://evil.example"}, status=400)
            for field, value in [("rating", []), ("rating", {}), ("flag", []), ("labels", []), ("labels", {"custom7": 7})]:
                request("/api/review", {**review, field: value}, status=400)

        finally:
            server.shutdown()
            server.server_close()
            worker.join()
            (d / "a.png").chmod(0o644)
        # A configured non-default IPv4 loopback authority is accepted without DNS.
        server = rb.http.server.ThreadingHTTPServer(("127.0.0.2", 0), rb.Handler)
        server.roots = [d]
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        base = f"http://127.0.0.2:{server.server_port}"
        try:
            request(listing)
            trusted = f"localhost:{server.server_port}"
            request("/api/review", review, headers={"Host": trusted, "Origin": "http://" + trusted})
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
    print("Review recovery, rollback, metadata and local-authority HTTP regressions passed")


if __name__ == "__main__":
    check()
