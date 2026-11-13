#!/usr/bin/env bash
# Commits the state before the agent, so the patch holds only the agent's changes. The trusted
# checkout stays out of it.
# Usage: record-baseline.sh <trusted dir>, in the checkout.
set -euo pipefail
echo "$1/" >>.git/info/exclude
# So does the checkout of this action, when the reusable workflows put it in the working directory.
own=$(realpath -m --relative-to=. "$(dirname "$0")/../../..")
case $own in . | ..*) ;; *) echo "$own/" >>.git/info/exclude ;; esac
git add -A
git -c user.name=baseline -c user.email=baseline@example.invalid \
  commit --quiet --no-verify --allow-empty -m baseline
