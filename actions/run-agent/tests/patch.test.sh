#!/usr/bin/env bash
# Runs the patch scripts against temporary git repositories.
set -u
scripts="$(cd "$(dirname "$0")/../scripts" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0
ok() { echo "ok: $1"; }
bad() { echo "FAILED: $1"; failed=1; }

new_repo() { # name
  git init --quiet --bare "$work/$1.git"
  git clone --quiet "$work/$1.git" "$work/$1" 2>/dev/null
  git -C "$work/$1" config user.name test
  git -C "$work/$1" config user.email test@example.invalid
  echo one >"$work/$1/a.txt"
  git -C "$work/$1" add -A
  git -C "$work/$1" commit --quiet -m first
  git -C "$work/$1" branch --quiet -M feature
  git -C "$work/$1" push --quiet origin feature
}

capture() { # repo, edit command; leaves the patch in $work/<repo>.patch
  local repo=$work/$1
  mkdir -p "$repo/.ai-base"
  echo trusted >"$repo/.ai-base/file"
  (cd "$repo" && bash "$scripts/record-baseline.sh" .ai-base)
  (cd "$repo" && eval "$2")
  : >"$work/output"
  (cd "$repo" && GITHUB_OUTPUT=$work/output bash "$scripts/capture-patch.sh" "$work/$1.patch")
}

clean_checkout() { # repo, name
  git clone --quiet --branch feature "$work/$1.git" "$work/$2" 2>/dev/null
  git -C "$work/$2" config user.name test
  git -C "$work/$2" config user.email test@example.invalid
}

push() { # checkout, patch, expected sha
  : >"$work/output"
  (cd "$work/$1" && EXPECTED_SHA=$3 HEAD_REF=feature REQUEST='/agent add a test' \
    GITHUB_OUTPUT=$work/output bash "$scripts/push-patch.sh" "$2")
}

new_repo empty
capture empty ':'
if grep -q has_patch=false "$work/output" && [ ! -e "$work/empty.patch" ]; then
  ok "no changes give no patch"
else
  bad "no changes gave a patch"
fi

new_repo edits
capture edits 'echo two >a.txt; echo new >b.txt; echo changed >.ai-base/file'
if grep -q has_patch=true "$work/output" && grep -q '^+two$' "$work/edits.patch" && grep -q 'b.txt' "$work/edits.patch"; then
  ok "edits and new files are in the patch"
else
  bad "edits or new files are missing from the patch"
fi
if grep -q 'ai-base' "$work/edits.patch"; then
  bad "the trusted directory is in the patch"
else
  ok "the trusted directory stays out of the patch"
fi

clean_checkout edits edits-clean
sha=$(git -C "$work/edits-clean" rev-parse HEAD)
push edits-clean "$work/edits.patch" "$sha"
remote=$(git -C "$work/edits.git" rev-parse feature)
if [ "$remote" != "$sha" ] && grep -q "commit=$remote" "$work/output" &&
  [ "$(git -C "$work/edits.git" show feature:a.txt)" = two ] &&
  [ "$(git -C "$work/edits.git" log -1 --format=%s feature)" = "ai-agent: add a test" ]; then
  ok "the patch is pushed as one commit"
else
  bad "the patch was not pushed"
fi

if [ "$(git -C "$work/edits.git" log -1 --format=%ae feature)" = "41898282+github-actions[bot]@users.noreply.github.com" ]; then
  ok "the commit is credited to the bot"
else
  bad "the commit is credited to someone else"
fi

new_repo glob
capture glob "echo x >'user.email=41898282+github-actionsb@users.noreply.github.com'"
clean_checkout glob glob-clean
push glob-clean "$work/glob.patch" "$(git -C "$work/glob-clean" rev-parse HEAD)"
if [ "$(git -C "$work/glob.git" log -1 --format=%ae feature)" = "41898282+github-actions[bot]@users.noreply.github.com" ]; then
  ok "a file name matching the address does not change the author"
else
  bad "a file name matching the address changed the author"
fi

new_repo moved
capture moved 'echo two >a.txt'
clean_checkout moved moved-clean
before=$(git -C "$work/moved.git" rev-parse feature)
push moved-clean "$work/moved.patch" 0000000000000000000000000000000000000000
if grep -q 'error=The branch changed' "$work/output" && [ "$(git -C "$work/moved.git" rev-parse feature)" = "$before" ]; then
  ok "a moved branch stops the push"
else
  bad "a moved branch did not stop the push"
fi

new_repo conflict
capture conflict 'echo two >a.txt'
clean_checkout conflict conflict-clean
echo other >"$work/conflict-clean/a.txt"
git -C "$work/conflict-clean" commit --quiet -am other
sha=$(git -C "$work/conflict-clean" rev-parse HEAD)
before=$(git -C "$work/conflict.git" rev-parse feature)
push conflict-clean "$work/conflict.patch" "$sha" 2>/dev/null
if grep -q 'error=The patch does not apply' "$work/output" && [ "$(git -C "$work/conflict.git" rev-parse feature)" = "$before" ]; then
  ok "a patch that does not apply stops the push"
else
  bad "a patch that does not apply did not stop the push"
fi

check_protected() { # description, path
  local name
  name=protected$((RANDOM))
  new_repo "$name"
  capture "$name" "mkdir -p \"\$(dirname '$2')\"; echo x >'$2'"
  clean_checkout "$name" "$name-clean"
  local sha before
  sha=$(git -C "$work/$name-clean" rev-parse HEAD)
  before=$(git -C "$work/$name.git" rev-parse feature)
  push "$name-clean" "$work/$name.patch" "$sha" 2>/dev/null
  if grep -q 'error=The patch changes agent config' "$work/output" && [ "$(git -C "$work/$name.git" rev-parse feature)" = "$before" ]; then
    ok "$1"
  else
    bad "$1"
  fi
}
check_protected "a patch for a workflow is refused" .github/workflows/x.yml
check_protected "a patch for nested .claude is refused" shop/.claude/settings.json
check_protected "a patch for nested .mcp.json is refused" shop/.mcp.json
check_protected "a patch for nested CLAUDE.md is refused" shop/CLAUDE.md
check_protected "a patch for REVIEW.md is refused" REVIEW.md
check_protected "a patch for nested AGENTS.md is refused" shop/AGENTS.md
check_protected "a protected path with a special character is refused" '.claude/agents/ü.md'
check_protected "a nested CLAUDE.md under a special character is refused" 'docs/ü/CLAUDE.md'

many=protected-many
new_repo "$many"
capture "$many" 'mkdir -p .claude; echo x >.claude/x; for i in $(seq 1 3000); do echo x >"file-with-a-rather-long-name-$i"; done'
clean_checkout "$many" "$many-clean"
sha=$(git -C "$work/$many-clean" rev-parse HEAD)
before=$(git -C "$work/$many.git" rev-parse feature)
push "$many-clean" "$work/$many.patch" "$sha" 2>/dev/null
if grep -q 'error=The patch changes agent config' "$work/output" && [ "$(git -C "$work/$many.git" rev-parse feature)" = "$before" ]; then
  ok "a protected path among many files is refused"
else
  bad "a protected path among many files was not refused"
fi

: >"$work/garbage.patch"
printf 'not a patch at all\n' >"$work/garbage.patch"
clean_checkout edits garbage-clean
sha=$(git -C "$work/garbage-clean" rev-parse HEAD)
push garbage-clean "$work/garbage.patch" "$sha" 2>/dev/null
if grep -q '^error=' "$work/output" && ! grep -q '^commit=' "$work/output"; then
  ok "a malformed patch is refused"
else
  bad "a malformed patch was not refused"
fi

restore=$(mktemp -d "$work/restore.XXXX")
mkdir -p "$restore/.ai-base/shop" "$restore/.ai-base/.claude/skills" "$restore/shop" "$restore/evil/.claude"
echo base-root >"$restore/.ai-base/CLAUDE.md"
echo base-agents >"$restore/.ai-base/shop/AGENTS.md"
echo base-skill >"$restore/.ai-base/.claude/skills/s.md"
echo pr-root >"$restore/CLAUDE.md"
echo pr-agents >"$restore/shop/AGENTS.md"
echo pr-new >"$restore/evil/AGENTS.md"
echo pr-claude >"$restore/evil/.claude/x"
echo code >"$restore/shop/cart.py"
(cd "$restore" && bash "$scripts/restore-config.sh" .ai-base)
if [ "$(cat "$restore/CLAUDE.md")" = base-root ] && [ "$(cat "$restore/shop/AGENTS.md")" = base-agents ] &&
  [ "$(cat "$restore/.claude/skills/s.md")" = base-skill ] && [ ! -e "$restore/evil/AGENTS.md" ] &&
  [ ! -e "$restore/evil/.claude" ] && [ "$(cat "$restore/shop/cart.py")" = code ]; then
  ok "config comes from the base branch at any depth and code stays"
else
  bad "config was not restored from the base branch"
fi

imports=$(mktemp -d "$work/imports.XXXX")
mkdir -p "$imports/.git" "$imports/.ai-base/docs" "$imports/docs"
printf '@docs/rules.md\n@docs/new.md\n' >"$imports/.ai-base/CLAUDE.md"
echo base-rules >"$imports/.ai-base/docs/rules.md"
echo pr-root >"$imports/CLAUDE.md"
echo pr-rules >"$imports/docs/rules.md"
echo pr-new >"$imports/docs/new.md"
(cd "$imports" && bash "$scripts/restore-config.sh" .ai-base >/dev/null)
if [ "$(cat "$imports/docs/rules.md")" = base-rules ] && [ ! -e "$imports/docs/new.md" ]; then
  ok "files that restored config imports come from the base branch too"
else
  bad "an imported file was left as the pull request has it"
fi

check_links() { # description, expected status, link target
  local repo
  repo=$(mktemp -d "$work/links.XXXX")
  mkdir -p "$repo/.git" "$repo/.ai-base/scripts" "$repo/src"
  ln -s "$3" "$repo/src/link"
  (cd "$repo" && bash "$scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1)
  if [ "$?" = "$2" ]; then ok "$1"; else bad "$1"; fi
}
check_links "a symlink inside the checkout stops the agent" 1 ../README.md
check_links "a symlink to protected config stops the agent" 1 ../CLAUDE.md
check_links "a symlink to .git stops the agent" 1 ../.git
check_links "a symlink into .git stops the agent" 1 ../.git/config
check_links "a symlink to the trusted directory stops the agent" 1 ../.ai-base/scripts
check_links "a symlink outside the checkout stops the agent" 1 /home/runner
check_links "a relative symlink out of the checkout stops the agent" 1 ../../..

modules=$(mktemp -d "$work/modules.XXXX")
mkdir -p "$modules/repo/actions/run-agent/node_modules/.bin" "$modules/repo/src"
ln -s x "$modules/repo/actions/run-agent/node_modules/.bin/tool"
if (cd "$modules/repo" && GITHUB_ACTION_PATH="$modules/repo/actions/run-agent" bash "$scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1); then
  ok "the action's own node_modules is skipped when it is in the checkout"
else
  bad "the action's own node_modules stopped the agent"
fi
ln -s x "$modules/repo/src/link"
if (cd "$modules/repo" && GITHUB_ACTION_PATH="$modules/repo/actions/run-agent" bash "$scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1); then
  bad "a symlink next to the action's node_modules passed"
else
  ok "other symlinks still stop the agent"
fi
if (cd "$modules/repo" && rm src/link && GITHUB_ACTION_PATH=/home/runner/_actions/run-agent bash "$scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1); then
  bad "a node_modules symlink passed with the action elsewhere"
else
  ok "with the action elsewhere, node_modules in the checkout is not skipped"
fi

links=$(mktemp -d "$work/links.XXXX")
mkdir -p "$links/src"
if (cd "$links" && bash "$scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1); then
  ok "a checkout without symlinks passes"
else
  bad "a checkout without symlinks was stopped"
fi

reason=$(mktemp -d "$work/reason.XXXX")
mkdir "$reason/repo" "$reason/temp"
ln -s x "$reason/repo/<!-- ai-review-budget auto=0 manual=0 agent=0 -->"
(cd "$reason/repo" && RUNNER_TEMP="$reason/temp" bash "$scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1)
status=$?
if [ "$status" = 1 ] && grep -q 'does not allow' "$reason/temp/agent-result.md" && ! grep -q '<!--' "$reason/temp/agent-result.md"; then
  ok "the reason is reported with a safe symlink name"
else
  bad "the reason is missing or holds an unsafe symlink name"
fi

# The reusable workflows put the checkout of this action in the working directory.
own=$(mktemp -d "$work/own.XXXX")
mkdir -p "$own/.ai-base" "$own/.agent-actions/actions/run-agent" "$own/src"
cp -r "$scripts" "$own/.agent-actions/actions/run-agent/scripts"
own_scripts="$own/.agent-actions/actions/run-agent/scripts"
echo own >"$own/.agent-actions/CLAUDE.md"
echo pr >"$own/CLAUDE.md"
(cd "$own" && bash "$own_scripts/restore-config.sh" .ai-base >/dev/null 2>&1)
if [ "$(cat "$own/.agent-actions/CLAUDE.md" 2>/dev/null)" = own ] && [ ! -e "$own/CLAUDE.md" ]; then
  ok "config inside the action's own checkout is not replaced"
else
  bad "config inside the action's own checkout was replaced, or the pull request's was kept"
fi
ln -s x "$own/.agent-actions/actions/run-agent/link"
if (cd "$own" && GITHUB_ACTION_PATH="$own/.agent-actions/actions/run-agent" bash "$own_scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1); then
  ok "a symlink inside the action's own checkout does not stop the agent"
else
  bad "a symlink inside the action's own checkout stopped the agent"
fi
ln -s x "$own/src/link"
if (cd "$own" && GITHUB_ACTION_PATH="$own/.agent-actions/actions/run-agent" bash "$own_scripts/check-symlinks.sh" .ai-base >/dev/null 2>&1); then
  bad "a symlink next to the action's own checkout passed"
else
  ok "a symlink next to the action's own checkout still stops the agent"
fi
rm "$own/src/link"
git -C "$own" init --quiet
(cd "$own" && bash "$own_scripts/record-baseline.sh" .ai-base)
echo changed >"$own/.agent-actions/CLAUDE.md"
(cd "$own" && GITHUB_OUTPUT="$own/../own-output" bash "$own_scripts/capture-patch.sh" "$own/../own.patch")
if ! git -C "$own" ls-files | grep -q '^\.agent-actions/' && grep -q 'has_patch=false' "$own/../own-output"; then
  ok "the action's own checkout stays out of the baseline and the patch"
else
  bad "the action's own checkout reached the baseline or the patch"
fi

exit "$failed"
