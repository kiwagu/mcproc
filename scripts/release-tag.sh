#!/bin/sh
# Fetches the tag as origin holds it. actions/checkout replaces a pushed annotated tag with a lightweight one pointing
# at its commit, which the release check would refuse and the notes would not count as a release.
#   sh scripts/release-tag.sh <tag>
set -eu
tag=${1:?usage: release-tag.sh <tag>}
git fetch --force origin "+refs/tags/$tag:refs/tags/$tag"
