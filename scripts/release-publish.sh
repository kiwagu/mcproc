#!/bin/sh
# Stages the package at the tagged commit on npm, for the owner to approve on npmjs.com, unless npm already has this
# version from that same commit (approved earlier, or published by hand). The version published from another commit
# is an error, as is any npm failure.
#   sh scripts/release-publish.sh <tag>        (NPM: the npm to run, default npm)
set -eu
tag=${1:?usage: release-publish.sh <tag>}
npm=${NPM:-npm}
name=$(node -p "require('./package.json').name")
version=$(node -p "require('./package.json').version")
commit=$(git rev-parse "$tag^{commit}")
if [ -n "$($npm view "$name@$version" version 2>/dev/null || true)" ]; then
  head=$($npm view "$name@$version" gitHead 2>/dev/null || true)
  if [ "$head" = "$commit" ]; then
    echo "$name@$version is already on npm from $commit: nothing to publish"
    exit 0
  fi
  echo "$name@$version is already on npm from ${head:-an unknown commit}, not from $commit" >&2
  exit 1
fi
$npm stage publish --access public
echo "$name@$version is staged: it reaches npm once approved on npmjs.com"
