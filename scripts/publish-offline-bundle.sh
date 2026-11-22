#!/usr/bin/env bash
set -euo pipefail

variant=${1:?Specify clean, other, stable, or testing}
case "$variant" in
  clean|other) revision=$variant ;;
  stable|testing)
    origin=https://github.com/StarPilotHQ/StarPilot
    revision=$(git ls-remote --exit-code "$origin" "refs/heads/$variant" | cut -f 1)
    [[ "$revision" =~ ^[0-9a-f]{40}$ ]]
    ;;
  *) exit 2 ;;
esac

tag=offline-v1-$revision
if [[ "$variant" = other ]]; then tag=offline-v2-other; fi
if release=$(gh release view "$tag" --json isDraft 2>/dev/null) && jq -e '.isDraft == false' <<< "$release" >/dev/null; then
  exit 0
fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
set --
if [[ "$variant" == stable || "$variant" == testing ]]; then
  git clone --depth 1 --no-checkout --single-branch --branch "$variant" "$origin" "$work/source"
  [[ "$(git -C "$work/source" rev-parse HEAD)" == "$revision" ]]
  set -- --repo "$work/source" --branch "$variant"
elif [[ "$variant" = other ]]; then
  set -- --fork-template
fi

for blocks in 23330816 23592960; do
  python3 scripts/build-offline-userdata.py "$work/userdata-$blocks.img" --blocks "$blocks" "$@"
  if [[ "$variant" = other ]]; then
    python3 scripts/pack-offline-userdata.py "$work/userdata-$blocks.img" "$work/$blocks" --fork-template
  else
    python3 scripts/pack-offline-userdata.py "$work/userdata-$blocks.img" "$work/$blocks"
  fi
  rm -- "$work/userdata-$blocks.img"
  mv -- "$work/$blocks/userdata.json" "$work/$blocks-userdata.json"
  mv -- "$work/$blocks/userdata.bin" "$work/$blocks-userdata.bin"
done

if [[ -z "${release:-}" ]]; then
  gh release create "$tag" --draft --prerelease --title "$tag" --notes ""
fi
gh release upload "$tag" "$work"/*-userdata.{json,bin} --clobber
gh release edit "$tag" --draft=false --latest=false
