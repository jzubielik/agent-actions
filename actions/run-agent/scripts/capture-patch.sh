#!/usr/bin/env bash
# Saves the changes since the baseline. Usage: capture-patch.sh <patch file>, in the checkout.
# Env: GITHUB_OUTPUT, RUNNER_TEMP.
set -euo pipefail
git add -A
# A move is written as a deletion and an addition, so the patch names both paths and
# push-patch.sh checks both.
git diff --cached --binary --no-renames >"$1"
# Files that the instruction files import are instructions too. The agent's edit rules deny
# them, and this is the second layer, as push-patch.sh is for the other protected paths.
imports="${RUNNER_TEMP:-}/agent-imports.txt"
if [ -n "${RUNNER_TEMP:-}" ] && [ ! -e "$imports" ]; then
  # restore-imports.mjs writes the list on every run, empty when nothing is imported.
  echo "::error::The list of imported rule files is missing, so the patch cannot be checked"
  rm -f "$1"
  echo "has_patch=false" >>"$GITHUB_OUTPUT"
  exit 1
fi
if [ -n "${RUNNER_TEMP:-}" ] && [ -s "$imports" ]; then
  changed=$(git diff --cached --name-only --no-renames -z | tr '\0' '\n' | grep -Fxf "$imports" | head -1 || true)
  if [ -n "$changed" ]; then
    # The name comes from the PR and ends up in a bot comment.
    safe=$(printf '%s' "$changed" | tr -c 'A-Za-z0-9._/-' '_')
    echo "::error::The agent changed a file that the repository's rules import: $changed"
    echo "The change touches \`$safe\`, which the rules of this repository import. \`/agent\` may not change it." >>"$RUNNER_TEMP/agent-result.md"
    rm -f "$1"
    echo "has_patch=false" >>"$GITHUB_OUTPUT"
    exit 1
  fi
fi
if [ -s "$1" ]; then
  echo "has_patch=true" >>"$GITHUB_OUTPUT"
else
  rm "$1"
  echo "has_patch=false" >>"$GITHUB_OUTPUT"
fi
