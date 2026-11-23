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
if [[ "$variant" = clean || "$variant" = other ]]; then tag=offline-v2-$variant; fi
release=$(gh release view "$tag" --json isDraft,assets 2>/dev/null || true)
missing=()
for blocks in 7864320 23330816 23592960; do
  if ! jq -e --arg blocks "$blocks" '([.assets[]?.name] | contains([$blocks + "-userdata.json", $blocks + "-userdata.bin"]))' <<< "${release:-null}" >/dev/null; then
    missing+=("$blocks")
  fi
done
if [[ "${#missing[@]}" == 0 ]] && jq -e '.isDraft == false' <<< "$release" >/dev/null; then
  exit 0
fi
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
set --
if [[ "${#missing[@]}" != 0 && ( "$variant" == stable || "$variant" == testing ) ]]; then
  git clone --depth 1 --no-checkout --single-branch --branch "$variant" "$origin" "$work/source"
  [[ "$(git -C "$work/source" rev-parse HEAD)" == "$revision" ]]
  set -- --repo "$work/source" --branch "$variant"
elif [[ "$variant" = other ]]; then
  set -- --fork-template
fi

for blocks in "${missing[@]}"; do
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
if [[ "${#missing[@]}" != 0 ]]; then
  gh release upload "$tag" "$work"/*-userdata.{json,bin} --clobber
fi
if ! jq -e '.isDraft == false' <<< "${release:-null}" >/dev/null; then
  gh release edit "$tag" --draft=false --latest=false
fi
