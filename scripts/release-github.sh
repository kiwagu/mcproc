#!/bin/sh
# Creates the GitHub Release of a tag with its notes, unless it exists already (a re-run after a lost answer).
#   sh scripts/release-github.sh <tag>         (GH: the gh to run, default gh)
set -eu
tag=${1:?usage: release-github.sh <tag>}
gh=${GH:-gh}
if $gh release view "$tag" >/dev/null 2>&1; then
  echo "the GitHub Release $tag exists already"
  exit 0
fi
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
sh "$(dirname "$0")/release-notes.sh" "$tag" > "$notes"
$gh release create "$tag" --verify-tag --title "$tag" --notes-file "$notes"
