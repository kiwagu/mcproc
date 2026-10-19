#!/bin/sh
# The notes of a release: the subjects of the commits on main since the previous release (an annotated vX.Y.Z tag),
# newest first. Other tags, lightweight ones included, do not end the list.
#   sh scripts/release-notes.sh <tag>
set -eu
tag=${1:?usage: release-notes.sh <tag>}
released=$(mktemp)
trap 'rm -f "$released"' EXIT
git for-each-ref --format='%(refname:strip=2)|%(*objectname)' refs/tags |
  awk -F'|' '$2 != "" && $1 ~ /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ { print $2 }' > "$released"
prev=$(git rev-list --first-parent "$tag^" 2>/dev/null | grep -m 1 -Fxf "$released" || true)
if [ -n "$prev" ]; then
  git log --first-parent --format='- %s' "$prev..$tag"
else
  git log --first-parent --format='- %s' "$tag"
fi
