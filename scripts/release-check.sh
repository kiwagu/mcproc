#!/bin/sh
# A release tag must name the version package.json holds at the tagged commit, and that commit must be on main.
#   sh scripts/release-check.sh <tag> [main-ref]      (main-ref: origin/main unless given)
set -eu
tag=${1:?usage: release-check.sh <tag> [main-ref]}
main=${2:-origin/main}
case $tag in
  v[0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "not a release tag: $tag (expected vX.Y.Z)" >&2; exit 1 ;;
esac
commit=$(git rev-parse --verify --quiet "$tag^{commit}") || { echo "no such tag: $tag" >&2; exit 1; }
version=$(git show "$commit:package.json" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0, 'utf8')).version)")
if [ "v$version" != "$tag" ]; then
  echo "tag $tag does not match the version in package.json at that commit ($version)" >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$commit" "$main"; then
  echo "tag $tag points at $(git rev-parse --short "$commit"), which is not on $main" >&2
  exit 1
fi
echo "release $tag: $(git rev-parse --short "$commit") on $main"
