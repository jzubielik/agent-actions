#!/usr/bin/env bash
# Replaces agent config from the PR with the versions from the base branch, at any depth.
# Usage: restore-config.sh <checkout of the base branch>, in the checkout of the PR.
set -euo pipefail
trusted=$1
# The reusable workflows check this action out into the working directory. That checkout is not
# the pull request's, so nothing in it is replaced.
own=$(realpath -m --relative-to=. "$(dirname "$0")/../../..")
skip=( -path ./.git -o -path "./$trusted" )
case $own in . | ..*) ;; *) skip+=( -o -path "./$own" ) ;; esac
names=( -name .claude -o -name .mcp.json -o -name CLAUDE.md -o -name CLAUDE.local.md -o -name AGENTS.md -o -path ./REVIEW.md )

find . \( "${skip[@]}" \) -prune -o \( "${names[@]}" \) -prune -exec rm -rf {} +

(cd "$trusted" && find . -path ./.git -prune -o \( "${names[@]}" \) -prune -print0) |
  while IFS= read -r -d '' item; do
    mkdir -p "$(dirname "$item")"
    cp -r "$trusted/$item" "$item"
  done

# What the restored files import with "@path" becomes instructions too.
node "$(dirname "$0")/restore-imports.mjs" "$trusted"
