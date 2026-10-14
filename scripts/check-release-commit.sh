#!/usr/bin/env bash
# Refuses a release commit that is not on the main branch.
#
# Usage: scripts/check-release-commit.sh <commit> [<main-ref>]
#
# A pushed `v*` tag can point at any commit, including one that was never merged. The release
# workflow runs this before anything is built: only a commit that is an ancestor of (or is)
# `origin/main` may be published. The checkout must have the history (`fetch-depth: 0`).
set -euo pipefail

commit="${1:?usage: check-release-commit.sh <commit> [<main-ref>]}"
main_ref="${2:-origin/main}"

if ! git rev-parse --verify --quiet "${main_ref}^{commit}" > /dev/null; then
  echo "The release check could not find ${main_ref}: fetch the full history (fetch-depth: 0)." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "$commit" "$main_ref"; then
  echo "Refusing to release ${commit}: it is not on ${main_ref}. Tag a commit that has been merged to main." >&2
  exit 1
fi

echo "Release commit ${commit} is on ${main_ref}."
