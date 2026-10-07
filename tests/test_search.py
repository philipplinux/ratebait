# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 philipplinux
"""Run from the repo root: python3 -m tests.test_search. Check folder matching, visibility and fresh child listings."""

from http.server import ThreadingHTTPServer
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from urllib.parse import urlencode
from urllib.request import urlopen

import ratebait


if __name__ == "__main__":
    with TemporaryDirectory(prefix="ratebait-search-") as scratch:
        parent = Path(scratch)
        for name in ("peacock", "phoenix", ".private"):
            (parent / name).mkdir()
        # Build the actual recursive index without starting its perpetual refresh worker.
        old_index = ratebait.DIR_INDEX["roots"]
        ratebait.DIR_INDEX["roots"] = ratebait.walk_dirs([parent])
        with ThreadingHTTPServer(("127.0.0.1", 0), ratebait.Handler) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f"http://127.0.0.1:{server.server_port}"

            def get(route, **params):
                with urlopen(base + route + "?" + urlencode(params)) as response:
                    return json.load(response)

            def complete(query):
                return get("/api/subdirs", path=str(parent), match="1", q=query)["matches"]

            try:
                fuzzy = complete("PCK")
                assert [(m["name"], m["hits"]) for m in fuzzy] == [("peacock", [0, 3, 6])]
                recursive = get("/api/find-dirs", q="PCK")["dirs"]
                assert [d["path"] for d in recursive] == [str(parent / "peacock") + "/"]
                assert [d["hits"] for d in recursive] == [[len(str(parent)) + 1 + n for n in (0, 3, 6)]]
                assert complete("no-match") == []
                assert [m["name"] for m in complete("")] == ["peacock", "phoenix"]
                assert [m["name"] for m in complete(".pri")] == [".private"]
                assert {m["name"] for m in complete("pea")} == {"peacock"}
                (parent / "pearl").mkdir()
                assert {m["name"] for m in complete("pea")} == {"peacock", "pearl"}
                (parent / "pearl").rmdir()
                assert {m["name"] for m in complete("pea")} == {"peacock"}
                listing = get("/api/subdirs", path=str(parent), counts="1")
                assert listing["names"] == [".private", "peacock", "phoenix"]
                assert listing["counts"] == {".private": 0, "peacock": 0, "phoenix": 0}
            finally:
                server.shutdown()
                thread.join()
                ratebait.DIR_INDEX["roots"] = old_index
    print("Recursive/child fuzzy matching, hidden-folder rules and fresh listings passed.")
