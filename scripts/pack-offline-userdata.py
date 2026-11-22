#!/usr/bin/env python3
"""Pack a checked userdata image without transferring its unwritten sectors."""

import argparse
import errno
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path

BLOCK = 4096
CHUNK = 4 * 1024 * 1024


def sparse_extents(image, target, size, reserved):
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
        ranges = []
        cursor = start
        for low, high in reserved:
            if high <= cursor or low >= end:
                continue
            if low > cursor:
                ranges.append((cursor, low))
            cursor = max(cursor, high)
        if cursor < end:
            ranges.append((cursor, end))
        for first, last in ranges:
            image.seek(first)
            for position in range(first, last, CHUNK):
                length = min(CHUNK, last - position)
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
    parser.add_argument("--fork-template", action="store_true")
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
    reserve = []
    if args.fork_template:
        extents = subprocess.check_output(
            ["debugfs", "-R", "dump_extents -l /.starpilot-offline/fork.pack", args.image],
            text=True,
        )
        logical = 0
        for start, end, physical, _, length in re.findall(r"(\d+)\s+-\s*(\d+)\s+(\d+)\s+-\s*(\d+)\s+(\d+)", extents):
            if int(start) != logical or int(end) + 1 != logical + int(length):
                raise ValueError("Fork payload must be fully allocated in order")
            reserve.append([int(physical), int(length)])
            logical += int(length)
        if logical != 1024**3 // BLOCK:
            raise ValueError("Incomplete fork payload reservation")
    skipped = sorted((block * BLOCK, (block + count) * BLOCK) for block, count in reserve)
    digest = hashlib.sha256()
    extents = []
    with args.image.open("rb", buffering=0) as image, (args.directory / "userdata.bin").open("xb") as target:
        for start, content in sparse_extents(image, target, size, skipped):
            digest.update(content)
            extents.append([start, len(content) // BLOCK])
    (args.directory / "userdata.json").write_text(json.dumps({
        "size": sum(count * BLOCK for _, count in extents),
        "hash": digest.hexdigest(),
        "blocks": size // BLOCK,
        "access": int(access),
        "extents": extents,
        **({"fork": reserve} if reserve else {}),
    }) + "\n")
