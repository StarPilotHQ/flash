#!/usr/bin/env python3
"""Build mountable userdata for an offline StarPilot USB recovery."""

import argparse
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ORIGIN = "https://github.com/StarPilotHQ/StarPilot"
BLOCK_SIZE = 4096


def git(repo, *args):
    return subprocess.check_output(["git", "-C", repo, *args], text=True).strip()


def make_image(output, blocks, repo=None, branch=None):
    if output.exists():
        raise ValueError(f"Output already exists: {output}")
    with tempfile.TemporaryDirectory(dir=output.parent) as work:
        work = Path(work)
        tree = work / "tree"
        tree.mkdir()
        image = work / "userdata.img"
        seed = tree / ".starpilot-offline"
        seed.mkdir(mode=0o700)
        access = seed / "access"
        access.write_bytes(b"." * BLOCK_SIZE)
        access.chmod(0o600)
        shutil.copyfile(Path(__file__).with_name("offline-settings.py"), seed / "settings.py")
        launcher = tree / "continue.sh"
        shutil.copyfile(Path(__file__).with_name("offline-continue.sh"), launcher)
        launcher.chmod(0o755)
        if repo:
            origin = git(repo, "remote", "get-url", "origin").removesuffix(".git")
            if origin.casefold() != ORIGIN.casefold() or git(repo, "branch", "--show-current") != branch:
                raise ValueError("Provide a fresh checkout of the selected official StarPilot branch")
            if any(line.startswith("160000 ") for line in git(repo, "ls-tree", "-r", "HEAD").splitlines()):
                raise ValueError("This revision has submodules that need their own offline bundles")
            git_dir = Path(git(repo, "rev-parse", "--absolute-git-dir"))
            if git_dir != repo.resolve() / ".git" or (git_dir / "objects/info/alternates").exists():
                raise ValueError("Provide a standalone shallow clone")
            shutil.copytree(git_dir, seed / "git", copy_function=os.link)
            (seed / "revision").write_text(git(repo, "rev-parse", "HEAD") + "\n")
        with image.open("xb") as target:
            target.truncate(blocks * BLOCK_SIZE)
        subprocess.run(["mke2fs", "-q", "-F", "-t", "ext4", "-b", str(BLOCK_SIZE), "-m", "0",
                        "-O", "^orphan_file,^metadata_csum_seed", "-E", "root_owner=1000:1000",
                        "-d", tree, image], check=True)
        subprocess.run(["e2fsck", "-fn", image], check=True)
        image.rename(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--blocks", type=int, required=True, help="userdata partition size in 4096-byte sectors")
    parser.add_argument("--repo", type=Path, help="fresh shallow clone of the official branch")
    parser.add_argument("--branch", choices=["stable", "testing"])
    args = parser.parse_args()
    if args.blocks < 32768 or bool(args.repo) != bool(args.branch):
        parser.error("provide at least 32768 blocks and either both --repo/--branch or neither")
    make_image(args.output.absolute(), args.blocks, args.repo, args.branch)
