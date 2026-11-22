#!/usr/bin/env python3
"""Pack a checked userdata image without transferring its unwritten sectors."""

import argparse
import errno
import hashlib
import json
import os
import subprocess
from pathlib import Path

BLOCK = 4096
CHUNK = 4 * 1024 * 1024


def sparse_extents(image, target, size):
    offset = 0
    while offset < size:
        try:
            start = os.lseek(image.fileno(), offset, os.SEEK_DATA)
        except OSError as error:
            if error.errno == errno.ENXIO:
                break
            raise
        end = min(os.lseek(image.fileno(), start, os.SEEK_HOLE), size)
        if start % BLOCK or end % BLOCK or end <= start:
            raise ValueError("Unaligned sparse image extents")
        image.seek(start)
        for position in range(start, end, CHUNK):
            length = min(CHUNK, end - position)
            content = image.read(length)
            if len(content) != length:
                raise ValueError("Short read from userdata image")
            if content.count(0) != length:
                target.write(content)
                yield position // BLOCK, content
        offset = end


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    size = args.image.stat().st_size
    if size % BLOCK:
        parser.error("userdata image size must be a multiple of 4096 bytes")
    args.directory.mkdir(parents=True)
    access = subprocess.check_output(
        ["debugfs", "-R", "blocks /.starpilot-offline/access", args.image],
        text=True,
    ).strip()
    if not access.isdigit():
        parser.error("offline image must contain a one-sector SSH configuration file")
    digest = hashlib.sha256()
    extents = []
    with args.image.open("rb", buffering=0) as image, (args.directory / "userdata.bin").open("xb") as target:
        for start, content in sparse_extents(image, target, size):
            digest.update(content)
            extents.append([start, len(content) // BLOCK])
    (args.directory / "userdata.json").write_text(json.dumps({
        "size": sum(count * BLOCK for _, count in extents),
        "hash": digest.hexdigest(),
        "blocks": size // BLOCK,
        "access": int(access),
        "extents": extents,
    }) + "\n")
