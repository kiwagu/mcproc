#!/bin/sh
# A release is an annotated vX.Y.Z tag naming the version package.json holds at the tagged commit, on main.
#   sh scripts/release-check.sh <tag> [main-ref]      (main-ref: origin/main unless given)
set -eu
tag=${1:?usage: release-check.sh <tag> [main-ref]}
main=${2:-origin/main}
if ! printf '%s\n' "$tag" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  echo "not a release tag: $tag (expected vX.Y.Z)" >&2
  exit 1
fi
if [ "$(git cat-file -t "refs/tags/$tag" 2>/dev/null)" != tag ]; then
  echo "no annotated tag $tag (a release tag carries a message: git tag -a)" >&2
  exit 1
fi
commit=$(git rev-parse "$tag^{commit}")
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
