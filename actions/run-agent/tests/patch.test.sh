#!/usr/bin/env bash
# Runs the script that restores the trusted config against temporary directories.
set -u
scripts="$(cd "$(dirname "$0")/../scripts" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0
ok() { echo "ok: $1"; }
bad() { echo "FAILED: $1"; failed=1; }

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

exit "$failed"
