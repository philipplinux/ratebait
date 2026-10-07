# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 philipplinux
"""Run from the repo root: python3 -m tests.test_review. Exercises a real HTTP server with scratch PNGs."""

import json
from pathlib import Path
import struct
import tempfile
import threading
from urllib.request import Request, urlopen
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
        finally:
            server.shutdown()
            server.server_close()
            worker.join()
            (d / "a.png").chmod(0o644)
    print("Cleared PNG and loaded-mark HTTP regressions passed")


if __name__ == "__main__":
    check()
