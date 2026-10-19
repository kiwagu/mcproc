#!/bin/sh
# The notes of a release: the subjects of the commits on main since the previous release tag, newest first.
#   sh scripts/release-notes.sh <tag>
set -eu
tag=${1:?usage: release-notes.sh <tag>}
prev=$(git describe --tags --abbrev=0 --first-parent --match 'v[0-9]*' "$tag^" 2>/dev/null || true)
if [ -n "$prev" ]; then
  git log --first-parent --format='- %s' "$prev..$tag"
else
  git log --first-parent --format='- %s' -1 "$tag"
fi
