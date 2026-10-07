# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 philipplinux
"""Run from the repo root: python3 -m tests.test_assets. Exercises browser asset delivery and route isolation."""

from http.server import ThreadingHTTPServer
from threading import Thread
from urllib.error import HTTPError
from urllib.request import urlopen

from ratebait import Handler


if __name__ == "__main__":
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            assets = [
                ("/", "text/html"),
                ("/style.css", "text/css"),
                ("/app.js", "text/javascript"),
            ]
            for path, mime in assets:
                for query in ("", "?reload=1"):
                    with urlopen(base + path + query) as response:
                        assert response.headers.get_content_type() == mime
                        assert response.headers.get_content_charset() == "utf-8"
            for path in (
                "/ratebait.py",
                "/../ratebait.py",
                "/.git/config",
                "/missing.css",
                "/js/unknown.js",
                "/js/",
                "/js/../ratebait.py",
                "/js/../app.js",
                "/js/%2e%2e/ratebait.py",
                "/js/state.js/../../ratebait.py",
                "/test_assets.py",
                "/AGENTS.md",
            ):
                try:
                    urlopen(base + path)
                except HTTPError as error:
                    assert error.code == 404
                else:
                    raise AssertionError(f"Private or unknown path served: {path}")
        finally:
            server.shutdown()
            thread.join()
    print("Asset MIME types and private-route isolation passed.")
