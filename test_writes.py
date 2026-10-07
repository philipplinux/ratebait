# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 philipplinux
"""Run: python3 test_writes.py. Uses disposable files only."""

from pathlib import Path
import struct
import tempfile
from unittest.mock import patch
import zlib

import ratebait as rb


def check():
    with tempfile.TemporaryDirectory() as raw:
        d = Path(raw)
        target, victim = d / "review.txt", d / "unrelated.txt"
        victim.write_text("keep")
        (d / "review.txt.tmp").symlink_to(victim)
        rb.atomic_write(target, "new")
        assert target.read_text() == "new" and victim.read_text() == "keep"
        assert (d / "review.txt.tmp").is_symlink()
        with patch.object(rb.os, "replace", side_effect=OSError("disk failure")):
            try:
                rb.atomic_write(target, "discard")
            except OSError:
                pass
            else:
                raise AssertionError("failed publication accepted")
        assert target.read_text() == "new"
        assert not list(d.glob(".review.txt.*.tmp"))

        p = d / "image.png"
        header = b"\x89PNG\r\n\x1a\n"
        pixels = rb.png_chunk(b"IDAT", zlib.compress(b"\0\xff\0\0"))
        ihdr = rb.png_chunk(b"IHDR", struct.pack("!IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
        note = rb.png_chunk(b"tEXt", b"Comment\0keep this metadata")
        end = rb.png_chunk(b"IEND", b"")
        p.write_bytes(header + ihdr + pixels + end)
        p.chmod(0o640)
        before = p.stat()
        item = dict(rating="love", flag=None, comment="hello")
        rb.embed_review(p, item)
        assert rb.read_embedded(p) == item
        assert p.stat().st_mtime_ns == before.st_mtime_ns
        assert p.stat().st_mode & 0o7777 == 0o640
        # Metadata tools may insert another chunk after an embedded review.
        p.write_bytes(p.read_bytes()[: -len(end)] + note + end)
        rb.embed_review(p, None)
        assert rb.read_embedded(p) is None
        assert p.read_bytes() == header + ihdr + pixels + note + end
        original = p.read_bytes()
        with patch.object(rb.os, "replace", side_effect=OSError("disk failure")):
            try:
                rb.embed_review(p, item)
            except OSError:
                pass
            else:
                raise AssertionError("failed publication accepted")
        assert p.read_bytes() == original
        make_temp = rb.tempfile.NamedTemporaryFile

        def failing_temp(**kwargs):
            file = make_temp(**kwargs)
            write = file.write

            def partial_write(data):
                write(data[:4])
                raise OSError("disk full after partial write")

            file.write = partial_write
            return file

        with patch.object(rb.tempfile, "NamedTemporaryFile", side_effect=failing_temp):
            try:
                rb.embed_review(p, item)
            except OSError:
                pass
            else:
                raise AssertionError("partial write accepted")
        assert p.read_bytes() == original
        # Failure after copying valid chunks must not touch the source either.
        p.write_bytes(original[: -len(end)] + b"\0\0\0\x20IDATshort")
        broken = p.read_bytes()
        try:
            rb.embed_review(p, item)
        except ValueError:
            pass
        else:
            raise AssertionError("truncated PNG accepted")
        assert p.read_bytes() == broken
        assert not list(d.glob(".image.png.*.tmp"))
    print("File safety checks passed")


if __name__ == "__main__":
    check()
