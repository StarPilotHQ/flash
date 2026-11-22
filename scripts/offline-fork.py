#!/usr/bin/env python3
"""Turn USB-staged Git packfiles into a checked-out fork and its submodules."""

import json
import os
import re
import subprocess
from pathlib import Path

HASH = re.compile(r"[0-9a-f]{40}")
REPO = re.compile(r"[a-zA-Z0-9-]+/[a-zA-Z0-9_.-]+")
directory = Path(".starpilot-install")
seed = Path(".starpilot-offline")

def git(repo, *args, **kwargs):
    return subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", *args], check=True, **kwargs)

with (seed / "fork.pack").open("rb") as stream:
    if stream.read(8) != b"SPFORK01":
        raise SystemExit("Fork recovery payload is missing")
    length = int.from_bytes(stream.read(4), "little")
    if not 1 <= length <= 65536:
        raise SystemExit("Invalid fork recovery manifest")
    manifest = json.loads(stream.read(length))
    branch = manifest["branch"]
    git(directory, "check-ref-format", "--branch", branch, stdout=subprocess.DEVNULL)
    repos = manifest["repos"]
    if not 1 <= len(repos) <= 24 or repos[0]["path"]:
        raise SystemExit("Invalid fork recovery repositories")
    environment = {**os.environ, "GIT_ALLOW_PROTOCOL": "", "GIT_LFS_SKIP_SMUDGE": "1"}
    checkouts = []
    for i, repo in enumerate(repos):
        path, url, revision, size = (repo[key] for key in ("path", "repo", "revision", "size"))
        if not HASH.fullmatch(revision) or not REPO.fullmatch(url) or not 32 <= size <= 1024**3:
            raise SystemExit("Invalid fork recovery repository")
        if i and (not path or any(part in ("", ".", "..", ".git") for part in path.split("/"))):
            raise SystemExit("Invalid fork recovery checkout path")
        checkout = directory / path
        if not checkout.resolve().is_relative_to(directory.resolve()):
            raise SystemExit("Fork recovery source escapes its checkout")
        if i:
            checkout.mkdir(parents=True, exist_ok=True)
        checkouts.append(checkout)
        git(checkout, "init", "--template=", "-q")
        (checkout / ".git/shallow").write_text(revision + "\n")
        with subprocess.Popen(["git", "-C", str(checkout), "index-pack", "--strict", "--stdin"],
                              stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, env=environment) as index:
            remaining = size
            while remaining:
                data = stream.read(min(1024 * 1024, remaining))
                if not data:
                    raise SystemExit("Truncated fork recovery pack")
                index.stdin.write(data)
                remaining -= len(data)
            index.stdin.close()
            if index.wait():
                raise SystemExit("Fork recovery pack verification failed")
        git(checkout, "remote", "add", "origin", "https://github.com/" + url + ".git")
        if i:
            git(checkout, "checkout", "--detach", "--no-recurse-submodules", revision, env=environment)
        else:
            git(checkout, "update-ref", "refs/remotes/origin/" + branch, revision)
            git(checkout, "checkout", "--no-recurse-submodules", "-b", branch, "--track", "origin/" + branch,
                env=environment)
    for checkout in checkouts:
        if (checkout / ".gitmodules").is_file():
            git(checkout, "submodule", "init", env=environment)
    if (directory / ".gitmodules").is_file():
        git(directory, "submodule", "absorbgitdirs", env=environment)
    (seed / "revision").write_text(repos[0]["revision"] + "\n")
