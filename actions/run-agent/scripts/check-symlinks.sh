#!/usr/bin/env bash
# Stops an editing agent when the checkout has any symlink. Path rules cannot be trusted to see
# through symlinks, and the agent cannot create new ones.
# Usage: check-symlinks.sh <trusted dir>, in the checkout.
set -euo pipefail
found=0
# The action's own files are not the pull request's, and npm links inside its node_modules. The
# reusable workflows check the action out into the working directory, and that checkout is
# skipped as a whole. When this repository tests itself the action is the checkout, and only its
# node_modules is skipped. An action outside the working directory skips nothing.
own=$(realpath -m --relative-to=. "${GITHUB_ACTION_PATH:-/nonexistent}/../..")
if [ "$own" = . ]; then own=$(realpath -m --relative-to=. "$GITHUB_ACTION_PATH/node_modules"); fi
while IFS= read -r -d '' link; do
  # The name comes from the PR and ends up in the job log and in a bot comment.
  safe=$(printf '%s' "${link#./}" | tr -c 'A-Za-z0-9._/-' '_')
  echo "::error::/agent cannot run on a pull request with symlinks: $safe"
  if [ -n "${RUNNER_TEMP:-}" ]; then
    echo "This pull request contains a symlink, which \`/agent\` does not allow: \`$safe\`" >>"$RUNNER_TEMP/agent-result.md"
  fi
  found=1
done < <(find . \( -path ./.git -o -path "./$1" -o -path "./$own" \) -prune -o -type l -print0)
exit "$found"
