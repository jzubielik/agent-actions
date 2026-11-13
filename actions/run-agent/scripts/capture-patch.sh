#!/usr/bin/env bash
# Saves the changes since the baseline. Usage: capture-patch.sh <patch file>, in the checkout.
# Env: GITHUB_OUTPUT.
set -euo pipefail
git add -A
git diff --cached --binary >"$1"
if [ -s "$1" ]; then
  echo "has_patch=true" >>"$GITHUB_OUTPUT"
else
  rm "$1"
  echo "has_patch=false" >>"$GITHUB_OUTPUT"
fi
