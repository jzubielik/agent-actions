#!/usr/bin/env bash
# Applies the agent's patch and pushes one commit. Usage: push-patch.sh <patch file>, in the checkout.
# Env: EXPECTED_SHA, HEAD_REF, REQUEST, GITHUB_OUTPUT.
# A problem the requester should read goes to the error output; the step itself stays green.
set -uo pipefail
fail() { echo "error=$1" >>"$GITHUB_OUTPUT"; exit 0; }

[ "$(git rev-parse HEAD)" = "$EXPECTED_SHA" ] ||
  fail "The branch changed while the agent worked. Send the request again."
# Second layer behind the agent's edit rules: nothing that configures an agent or a workflow.
protected='(^|/)(\.claude/|\.mcp\.json$|CLAUDE\.md$|CLAUDE\.local\.md$|AGENTS\.md$)|^REVIEW\.md$|^\.github/workflows/'
# A rename or a copy names its source where the check below does not read it, and its header
# has more than one spelling, so git says whether the patch holds one. A patch from
# capture-patch.sh never does.
summary=$(git apply --summary "$1") || fail "The patch is malformed."
if grep -qE '^ (rename|copy) ' <<<"$summary"; then
  fail "The patch renames or copies a file, which a patch from the agent never does."
fi
# -z keeps raw paths: otherwise special characters quote them and the anchors stop matching.
paths=$(git apply --numstat -z "$1" | tr '\0' '\n' | cut -f3-) || fail "The patch is malformed."
if grep -E "$protected" <<<"$paths" >/dev/null; then
  fail "The patch changes agent config or a workflow, which the agent may not do."
fi
git apply --check --index "$1" || fail "The patch does not apply to the branch."
git apply --index "$1"
message=$(printf 'ai-agent: %s' "${REQUEST#/agent }" | head -1 | cut -c1-72)
# The bot's own address: any other users.noreply.github.com address credits a real account.
git -c user.name='github-actions[bot]' -c 'user.email=41898282+github-actions[bot]@users.noreply.github.com' \
  commit --quiet --no-verify -m "$message" || fail "The commit failed."
git push --quiet origin "HEAD:refs/heads/$HEAD_REF" || fail "GitHub refused the push."
echo "commit=$(git rev-parse HEAD)" >>"$GITHUB_OUTPUT"
