#!/usr/bin/env bash
# Deterministic parts of the AI review: size limit, review budget, merge gate, risk labels, run log.
# Runs from a checkout of the base branch, never from the PR head.
# Env: GH_TOKEN, REPO (owner/name), PR (number). Usage: ai-review.sh ci-state|precheck|record|resolve|agent-budget|labels|gate ...
set -euo pipefail

MAX_LINES="${AI_REVIEW_MAX_LINES:-1000}"
MAX_AUTO="${AI_REVIEW_MAX_AUTO:-3}"
MAX_MANUAL="${AI_REVIEW_MAX_MANUAL:-2}"
MAX_AGENT="${AI_AGENT_MAX_RUNS:-5}"
# Which findings block the merge: important (blocking and important) or blocking only.
# Notes never block.
BLOCK_ON="${AI_REVIEW_BLOCK_ON:-important}"
# Where the result goes: a block in the PR description, or the top of the budget comment.
SUMMARY="${AI_REVIEW_SUMMARY:-description}"
READ_DESCRIPTION="${AI_REVIEW_READ_DESCRIPTION:-true}"
# Slug of the GitHub App that resolves fixed threads, from a repository variable: variables,
# unlike secrets, reach runs started from forks, so the gate counts the same on every event.
APP_SLUG="${AGENT_ACTIONS_APP_SLUG:-}"
# Generated or vendored files do not count toward the size limit.
EXCLUDE='(^|/)(package-lock\.json|yarn\.lock|poetry\.lock|uv\.lock)$|\.snap$'
OVERRIDE_LABEL=ai-review-override
BOT=github-actions[bot]
STATUS_CONTEXT="${AI_REVIEW_STATUS_CONTEXT:-AI review / Merge gate}"

out() { [ -n "${GITHUB_OUTPUT:-}" ] && echo "$1=$2" >>"$GITHUB_OUTPUT"; echo "$1=$2"; }

# Limits come from repository variables. Each command checks only the ones it uses, so a typo
# in the /agent limit does not stop the review, and the reverse.
require_number() { # variable-name value
  case "$2" in
    '' | *[!0-9]*) echo "$1 must be a number, got: $2" >&2; exit 1 ;;
  esac
}

changed_lines() {
  gh api --paginate "repos/$REPO/pulls/$PR/files" --jq '.[] | "\(.filename)\t\(.additions + .deletions)"' |
    EXCLUDE="$EXCLUDE" awk -F'\t' '$1 !~ ENVIRON["EXCLUDE"] { s += $2 } END { print s + 0 }'
}

has_override() {
  gh api "repos/$REPO/issues/$PR/labels" --jq '.[].name' | grep -qx "$OVERRIDE_LABEL"
}

# Budget and run log live in one comment of the workflow token (github-actions[bot]).
# It is recognised by how it starts: other bot comments can quote text from the PR, markers too.
# PR authors cannot edit it, so the counters are trustworthy. In comment mode it starts with the
# review block, which holds the model's text, so markers are read only from what follows it.
budget_comment() {
  gh api --paginate "repos/$REPO/issues/$PR/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]") | select(.body | startswith("### AI review budget") or startswith("<!-- ai-review:start -->")) | "\(.id)\t\(.body | @base64)"' |
    tail -1
}

comment_block() { # budget comment on stdin -> its leading review block, or nothing
  awk 'NR == 1 && !/^<!-- ai-review:start -->/ { exit } { print } /<!-- ai-review:end -->/ { exit }'
}

without_block() { # budget comment on stdin -> the comment after its leading review block
  awk 'NR == 1 && !/^<!-- ai-review:start -->/ { rest = 1 }
    rest == 1 { print; next }
    /<!-- ai-review:end -->/ { rest = 2; next }
    rest == 2 && (/^---$/ || /^$/) { next }
    rest == 2 { rest = 1; print }'
}

budget_body() { # the budget comment without its review block
  local row
  row=$(budget_comment)
  [ -n "$row" ] && cut -f2 <<<"$row" | base64 -d | without_block
  return 0
}

# The bot's 👀 reaction on the pull request is a lock around each read and write of the budget
# comment, which GitHub cannot write conditionally. GitHub answers 201 to the request that adds
# the reaction and 200 when the same user already has it. publish-summary takes the same lock.
LOCK_ATTEMPTS="${AI_REVIEW_LOCK_ATTEMPTS:-75}"
LOCK_DELAY="${AI_REVIEW_LOCK_DELAY:-2}"
# A run that died holding the lock leaves the reaction; after this long it is taken over.
LOCK_STALE=120
LOCK_ID=

release_lock() {
  [ -z "$LOCK_ID" ] || gh api -X DELETE "repos/$REPO/issues/$PR/reactions/$LOCK_ID" >/dev/null 2>&1 || true
  LOCK_ID=
}

take_lock() { # [count]: record waits for the lock as long as it takes
  local attempt response status body id now created age
  for ((attempt = 1; ; attempt++)); do
    # A failed request (a 5xx, a rate limit, the network) is one more attempt, so it does not
    # stop record before the count. Only a 201 takes the lock.
    status="" body="" id="" age=0
    if response=$(gh api -i "repos/$REPO/issues/$PR/reactions" -f content=eyes 2>/dev/null | tr -d '\r'); then
      status=$(head -1 <<<"$response" | cut -d' ' -f2)
      # The body is everything after the headers, however gh formats the JSON.
      body=$(sed '1,/^$/d' <<<"$response")
      id=$(jq -r '.id // empty' <<<"$body" 2>/dev/null) || id=""
    fi
    if [ "$status" = 201 ]; then
      LOCK_ID=$id
      trap release_lock EXIT
      return
    fi
    # GitHub's clock on both sides, so a runner clock that is off does not matter.
    if [ "$status" = 200 ] && [ -n "$id" ] &&
      now=$(date -d "$(grep -i '^date:' <<<"$response" | cut -d' ' -f2-)" +%s 2>/dev/null) &&
      created=$(date -d "$(jq -r '.created_at // empty' <<<"$body")" +%s 2>/dev/null); then
      age=$((now - created))
    fi
    # A dead holder's reaction is removed and the next attempt can take the lock; a takeover
    # that fails still waits and counts, so it cannot loop without pause.
    if [ "$age" -gt "$LOCK_STALE" ]; then
      gh api -X DELETE "repos/$REPO/issues/$PR/reactions/$id" >/dev/null 2>&1 || true
    fi
    # record keeps waiting: a holder needs seconds and a dead one is taken over above, so the
    # wait ends, and a run that used the model is never left uncounted or written unlocked.
    if [ "$attempt" -ge "$LOCK_ATTEMPTS" ] && [ "${1:-}" != count ]; then
      echo "Another run kept the review comment locked; nothing was written" >&2; exit 1
    fi
    sleep "$LOCK_DELAY"
  done
}

# Each /agent run has a comment that starts with this marker. Counting them means
# /agent never rewrites the budget comment, which also holds the data of the gate.
agent_runs() {
  gh api --paginate "repos/$REPO/issues/$PR/comments" \
    --jq '.[] | select(.user.login == "github-actions[bot]") | select(.body | startswith("<!-- ai-agent-run -->")) | .id' |
    wc -l | tr -d ' '
}

read_budget() {
  local row body
  row=$(budget_comment)
  BUDGET_ID=${row%%$'\t'*}
  body=$( [ -n "$row" ] && cut -f2 <<<"$row" | base64 -d || true )
  SECTION=$(comment_block <<<"$body")
  body=$(without_block <<<"$body")
  AUTO=$(grep -oP 'ai-review-budget auto=\K[0-9]+' <<<"$body" || echo 0)
  MANUAL=$(grep -oP 'ai-review-budget auto=[0-9]+ manual=\K[0-9]+' <<<"$body" || echo 0)
  LOG=$(sed -n '/^| [0-9a-f]\{7\} |/p' <<<"$body")
  GATE_MARKER=$(grep -oP '<!-- pr-review sha=\S+ blocking=[0-9]+ important=[0-9]+ notes=[0-9]+( confidence=[0-9]+)? -->' <<<"$body" | tail -1 || true)
  # The commit and run of the last review started after failed CI, set before the model runs.
  CI_SHA=$(grep -oP '<!-- ai-review-ci sha=\K[0-9a-f]+(?= run=[0-9]+ -->)' <<<"$body" | tail -1 || true)
  CI_RUN=$(grep -oP '<!-- ai-review-ci sha=[0-9a-f]+ run=\K[0-9]+(?= -->)' <<<"$body" | tail -1 || true)
  # What the status line above the result shows: the commit the pull request is at, and the
  # run that reviews a commit now. The result's commit is the one of the gate marker.
  STATE_HEAD=$(grep -oP '<!-- ai-review-state head=\K[0-9a-f]+' <<<"$body" | tail -1 || true)
  STATE_RUN=$(grep -oP '<!-- ai-review-state head=[0-9a-f]+ run=\K[0-9]+(?=:[0-9a-f]+ -->)' <<<"$body" | tail -1 || true)
  STATE_RUN_SHA=$(grep -oP '<!-- ai-review-state head=[0-9a-f]+ run=[0-9]+:\K[0-9a-f]+(?= -->)' <<<"$body" | tail -1 || true)
  NOTE=""
}

write_budget() {
  local body agent=""
  # /agent runs are counted in their own comments; this one shows only their limit. A bad
  # value is left out here, and the /agent command reports it.
  case "$MAX_AGENT" in
    '' | *[!0-9]*) ;;
    *) agent=" · \`/agent\`: up to $MAX_AGENT runs" ;;
  esac
  body=$(cat <<EOF
${SECTION:+$SECTION

---

}### AI review budget

Automatic reviews: **$AUTO/$MAX_AUTO** · on demand (\`/review\`): **$MANUAL/$MAX_MANUAL**$agent · size limit: $MAX_LINES changed lines
${NOTE:+
> $NOTE
}
| Commit | Trigger | Lines | Result | Cost | Time |
|---|---|---|---|---|---|
$LOG

<!-- ai-review-budget auto=$AUTO manual=$MANUAL -->
$GATE_MARKER
${CI_SHA:+<!-- ai-review-ci sha=$CI_SHA run=$CI_RUN -->}
${STATE_HEAD:+<!-- ai-review-state head=$STATE_HEAD${STATE_RUN:+ run=$STATE_RUN:$STATE_RUN_SHA} -->}
EOF
)
  if [ -n "$BUDGET_ID" ]; then
    gh api -X PATCH "repos/$REPO/issues/comments/$BUDGET_ID" -f body="$body" >/dev/null
  else
    gh api "repos/$REPO/issues/$PR/comments" -f body="$body" >/dev/null
  fi
}

RUN_URL="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-$REPO}/actions/runs/${GITHUB_RUN_ID:-}"

# GitHub refuses 4-byte characters in a status description, which rules out most emoji.
set_status() { # state description sha; "Details" in the PR opens this run
  gh api "repos/$REPO/statuses/$3" -f state="$1" -f context="$STATUS_CONTEXT" -f description="$2" \
    -f target_url="$RUN_URL" >/dev/null
  echo "status $STATUS_CONTEXT=$1: $2"
}

# A result describes one commit. Until a new commit gets its own review,
# the block says so, whatever happens next: over the limit, no budget, or a failed agent.
commit_link() { # sha
  echo "[\`${1:0:7}\`](${GITHUB_SERVER_URL:-https://github.com}/$REPO/pull/$PR/commits/$1)"
}

# The status line comes only from the state that read_budget read, never from the text of the
# block, so every writer gives the same line for the same state.
status_line() {
  local result base="${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY:-$REPO}" line=""
  [ -n "$STATE_HEAD" ] || return 0
  result=$(grep -oP 'pr-review sha=\K[0-9a-f]+' <<<"$GATE_MARKER" || true)
  if [ -n "$STATE_RUN" ] && [ "$STATE_RUN_SHA" = "$STATE_HEAD" ]; then
    line="**⏳ Review in progress: $(commit_link "$STATE_HEAD")** · [Run log]($base/actions/runs/$STATE_RUN)"
    if [ "$result" = "$STATE_HEAD" ]; then line="$line · Result below is for this commit."
    elif [ -n "$result" ]; then line="$line · Result below is for $(commit_link "$result")"
    fi
  elif [ "$result" != "$STATE_HEAD" ]; then
    line="**⏳ Not reviewed: $(commit_link "$STATE_HEAD")**"
    [ -n "$result" ] && line="$line · Result below is for $(commit_link "$result")"
  fi
  printf '%s' "$line"
}

# Text with a review block on stdin -> the same text with the status line in place of any
# earlier one, right below the block's heading. With create, text without a block gets one.
with_status() { # line [create]
  STATUS=$1 CREATE=${2:-} awk '
    function status() { if (ENVIRON["STATUS"] != "") { print ""; print ENVIRON["STATUS"]; gap = 1 } }
    /<!-- ai-review:start -->/ { inside = 1; seen = 1; print; next }
    inside && /^\*\*⏳/ { drop = 1; next }
    drop && /^$/ { drop = 0; next }
    { drop = 0 }
    inside && !done && /^### ⚖️/ { print; status(); done = 1; next }
    gap { gap = 0; if ($0 == "") { print; next } if ($0 !~ /<!-- ai-review:end -->/) print "" }
    /<!-- ai-review:end -->/ { inside = 0 }
    { print }
    END {
      if (!seen && ENVIRON["CREATE"] != "" && ENVIRON["STATUS"] != "") {
        print "<!-- ai-review:start -->"; print "### ⚖️ AI review"; print ""; print ENVIRON["STATUS"]; print "<!-- ai-review:end -->"
      }
    }'
}

# Puts the status line where the result is: the description, or the block of the budget comment,
# which the caller writes.
show_status() {
  local line body updated
  line=$(status_line)
  if [ "$SUMMARY" = comment ]; then
    # No block yet: awk then reads no line at all, and only adds one when there is a status.
    SECTION=$(printf '%s' "$SECTION" | with_status "$line" create)
    return
  fi
  # Explicit returns: under || in record, set -e does not stop a failed call here.
  body=$(gh api "repos/$REPO/pulls/$PR" --jq .body) || return 1
  grep -q '<!-- ai-review:start -->' <<<"$body" || return 0
  updated=$(with_status "$line" <<<"$body")
  [ "$updated" = "$body" ] || gh api -X PATCH "repos/$REPO/pulls/$PR" -f body="$updated" >/dev/null || return 1
}

save_budget() { show_status; write_budget; }

# record must count a run that used the model, so a failed status line does not stop it.
save_count() {
  show_status || echo "::warning::The status line was not updated; the run is counted"
  write_budget
}

# Under the lock: the head is read again, so a precheck that started for an older commit does
# not store it, and a stored run whose workflow run has ended (one that stopped before record,
# for example cancelled while queued) is not shown. A status that cannot be read keeps it.
refresh_state() {
  local status
  STATE_HEAD=$(gh api "repos/$REPO/pulls/$PR" --jq .head.sha)
  if [ -n "$STATE_RUN" ] && [ "$STATE_RUN" != "${GITHUB_RUN_ID:-0}" ] &&
    status=$(gh api "repos/$REPO/actions/runs/$STATE_RUN" --jq .status 2>/dev/null) && [ "$status" = completed ]; then
    STATE_RUN="" STATE_RUN_SHA=""
  fi
}

require_block_on() {
  case "$BLOCK_ON" in
    important | blocking) ;;
    *) echo "AI_REVIEW_BLOCK_ON must be important or blocking, got: $BLOCK_ON" >&2; exit 1 ;;
  esac
}

require_summary() {
  case "$SUMMARY" in
    description | comment) ;;
    *) echo "AI_REVIEW_SUMMARY must be description or comment, got: $SUMMARY" >&2; exit 1 ;;
  esac
  case "$READ_DESCRIPTION" in
    true | false) ;;
    *) echo "AI_REVIEW_READ_DESCRIPTION must be true or false, got: $READ_DESCRIPTION" >&2; exit 1 ;;
  esac
}

check_budget_limits() {
  # Checked before the model runs, so a bad threshold never produces a review whose shown
  # state the gate would then reject.
  require_block_on
  require_summary
  require_number AI_REVIEW_MAX_LINES "$MAX_LINES"
  require_number AI_REVIEW_MAX_AUTO "$MAX_AUTO"
  require_number AI_REVIEW_MAX_MANUAL "$MAX_MANUAL"
}

# ci-state <sha>: whether the CI workflows named in WAIT_FOR_CI still run on the commit. waiting:
# one of them is queued or running, and its workflow_run starts the review. done: they ran.
# none: none of them ran on it, for example a paths filter left them out; the review runs now.
cmd_ci_state() {
  local sha=$1 state
  require_summary
  # workflow_run names one pull request of the branch; another one from the same branch would
  # wait for nothing, so with more than one open the push is reviewed at once.
  if [ -n "${HEAD_LABEL:-}" ] &&
    [ "$(gh api "repos/$REPO/pulls?state=open&head=$HEAD_LABEL&per_page=2" --jq length)" -gt 1 ]; then
    out ci none; return
  fi
  state=$(gh api --paginate "repos/$REPO/actions/runs?head_sha=$sha&event=pull_request&per_page=100" \
    --jq '.workflow_runs[] | [.name, .run_number, .status] | @tsv' |
    WANT=$WAIT_FOR_CI awk -F'\t' '
      BEGIN { n = split(ENVIRON["WANT"], names, ","); for (i = 1; i <= n; i++) { gsub(/^ +| +$/, "", names[i]); want[names[i]] = 1 } }
      # A re-run gets a new run number; the latest one of each workflow decides.
      want[$1] && $2 + 0 >= last[$1] + 0 { last[$1] = $2; status[$1] = $3 }
      END { state = "none"; for (w in status) { if (status[w] != "completed") { print "waiting"; exit } state = "done" } print state }')
  out ci "$state"
  if [ "$state" = waiting ]; then
    set_status pending "Waiting for CI: $WAIT_FOR_CI" "$sha"
    take_lock
    read_budget
    refresh_state
    save_budget
  fi
}

ci_review_running() { # sha; a status that cannot be read counts as finished, so the review runs
  local status
  [ "$CI_SHA" = "$1" ] && [ -n "$CI_RUN" ] && [ "$CI_RUN" != "${GITHUB_RUN_ID:-}" ] || return 1
  status=$(gh api "repos/$REPO/actions/runs/$CI_RUN" --jq .status 2>/dev/null) || return 1
  [ -n "$status" ] && [ "$status" != completed ]
}

# precheck <auto|manual|ci> <sha>: decide whether the model runs at all. ci is an automatic run
# after failed CI: it reviews a reviewed commit again, now with the logs, from the automatic budget.
cmd_precheck() {
  local mode=$1 sha=$2 lines
  check_budget_limits
  # A comment-triggered run is not attached to the PR commit; the pending status makes it visible there.
  set_status pending "AI review in progress" "$sha"
  take_lock
  lines=$(changed_lines)
  out lines "$lines"
  read_budget
  # The status line follows the head commit, whatever this precheck decides below.
  refresh_state
  # A /review on a reviewed commit runs again: someone asks for a new look, for example after
  # answering a finding in the description, and pays for it from the on-demand budget.
  if [ "$mode" = auto ] && [ -n "$(summary_marker "$sha")" ]; then
    NOTE="Commit \`${sha:0:7}\`: already reviewed. The model was not run and no budget was used."
    save_budget; out run false; return
  fi
  # Each failed CI workflow, and each re-run of one, ends in its own workflow_run; the logs of
  # the first are enough to judge the commit, and /review asks for more. A review that started
  # and is not recorded yet counts while its run is in progress; one that failed or was
  # cancelled before the model ran leaves no row, so the next failed CI tries again. With
  # wait_for_ci a push review counts too: CI that finished before its precheck sends a
  # workflow_run as well, and the commit needs one review.
  local once=ci
  [ -n "${WAIT_FOR_CI:-}" ] && once='auto\|ci'
  if { [ "$mode" = ci ] || { [ "$mode" = auto ] && [ -n "${WAIT_FOR_CI:-}" ]; }; } &&
    # A cancelled run gave no result, so it does not stand for the commit's review.
    { grep "^| ${sha:0:7} | \($once\) |" <<<"$LOG" | grep -qv '| cancelled |' || { ci_review_running "$sha" && out busy true; }; }; then
    NOTE="Commit \`${sha:0:7}\`: already reviewed, or a review of it is running. The model was not run and no budget was used."
    save_budget; out run false; return
  fi
  if [ "$lines" -gt "$MAX_LINES" ]; then
    NOTE="Commit \`${sha:0:7}\`: $lines changed lines exceed the limit of $MAX_LINES. Split the PR; the model was not run."
    save_budget; out run false; return
  fi
  if [ "$mode" != manual ] && [ "$AUTO" -ge "$MAX_AUTO" ]; then
    NOTE="Commit \`${sha:0:7}\`: automatic review budget used up. A maintainer can comment \`/review\`."
    save_budget; out run false; return
  fi
  if [ "$mode" = manual ] && [ "$MANUAL" -ge "$MAX_MANUAL" ]; then
    NOTE="Commit \`${sha:0:7}\`: on-demand review budget used up. Use the \`$OVERRIDE_LABEL\` label to merge without review."
    save_budget; out run false; return
  fi
  if [ "$mode" = ci ] || { [ "$mode" = auto ] && [ -n "${WAIT_FOR_CI:-}" ]; }; then
    CI_SHA=$sha CI_RUN=${GITHUB_RUN_ID:-}
  fi
  STATE_RUN=${GITHUB_RUN_ID:-0} STATE_RUN_SHA=$sha
  save_budget
  out run true
}

confidence_of() { # sha -> the confidence publishSummary kept within the counts, or empty
  budget_body |
    { grep -oP "pr-review sha=$1 [^>]*confidence=\K[1-5]\b" || true; } | tail -1
}

summary_marker() { # sha -> "blocking important notes" or empty
  budget_body |
    { grep -oP "pr-review sha=$1 \Kblocking=[0-9]+ important=[0-9]+ notes=[0-9]+" || true; } | tail -1 |
    sed -E 's/blocking=([0-9]+) important=([0-9]+) notes=([0-9]+)/\1 \2 \3/'
}

# The gate follows the finding counts, never the model's confidence.
# Same rule as gateState in pr-description.mjs.
gate_state() { # blocking important -> blocked, changes or ready
  if [ "$1" -gt 0 ] || { [ "$2" -gt 0 ] && [ "$BLOCK_ON" != blocking ]; }; then echo blocked
  elif [ "$2" -gt 0 ]; then echo changes
  else echo ready
  fi
}

published_summary() { # execution file -> success when upsert_summary was called and did not fail
  jq -e '([.. | objects | select(.type? == "tool_use" and .name == "mcp__pr__upsert_summary") | .id]) as $ids
    | any(.. | objects; .type? == "tool_result" and (.tool_use_id as $id | $ids | index($id)) and (.is_error | not))' \
    "$1" >/dev/null
}

# The run ends: the status line stops showing it, unless a newer run has taken its place.
end_run() {
  if [ "$STATE_RUN" = "${GITHUB_RUN_ID:-0}" ]; then STATE_RUN="" STATE_RUN_SHA=""; fi
}

# record <auto|manual|ci> <sha> <lines> <execution_file>: count the run and log cost and time.
cmd_record() {
  local mode=$1 sha=$2 lines=$3 exec_file=${4:-${RUNNER_TEMP:+$RUNNER_TEMP/agent-execution.json}} cost="-" secs="-" counts score="-" confidence tokens
  # No limit check here: precheck did it, and a run that already used the model must be counted.
  take_lock count
  # The agent can fail before the model answers; such a run uses no budget.
  if [ -z "$exec_file" ] || [ ! -f "$exec_file" ]; then
    read_budget; end_run
    NOTE="Commit \`${sha:0:7}\`: the agent did not run the model (see the run log). Budget unchanged."
    save_count
    return
  fi
  # A cancelled run, superseded by a newer review of the PR or stopped by a person, gave no
  # result: it is logged with the tokens it used. It counts, or each push cancelling the review
  # before it would spend the model without limit.
  tokens=$(jq -r '[.[] | select(.type? == "cancelled")][-1].tokens // empty' "$exec_file")
  if [ -n "$tokens" ]; then
    # In jq: expr exits 1 when the result is 0, which would stop the script before the count.
    secs=$(jq -r '[.[] | select(.type? == "cancelled")][-1].duration_ms / 1000 | floor' "$exec_file")
    read_budget; end_run
    if [ "$mode" = manual ]; then MANUAL=$((MANUAL + 1)); else AUTO=$((AUTO + 1)); fi
    LOG="${LOG:+$LOG
}| ${sha:0:7} | $mode | $lines | cancelled | $([ "$tokens" -gt 0 ] && echo "$((tokens / 1000))k tokens" || echo -) | ${secs} s |"
    save_count
    return
  fi
  cost=$(jq -r '[.. | objects | select(.type? == "result")][-1].total_cost_usd // empty' "$exec_file" | xargs -r printf '$%.2f')
  secs=$(jq -r '[.. | objects | select(.type? == "result")][-1].duration_ms // empty | . / 1000 | floor' "$exec_file")
  secs=${secs:+${secs} s}
  # A /review can run again on a commit that has a result. The marker for this commit then
  # belongs to this run only if this run published a summary.
  if published_summary "$exec_file"; then
    counts=$(summary_marker "$sha")
    # record never stops on a setting: a run that used the model must be counted.
    case "$BLOCK_ON" in important | blocking) [ -n "$counts" ] && score=$(gate_state $counts) ;; esac
    confidence=$(confidence_of "$sha")
    if [ -n "$confidence" ] && [ "$score" = - ]; then score="$confidence/5"
    elif [ -n "$confidence" ]; then score="$score · $confidence/5"
    fi
  fi
  read_budget; end_run
  if [ "$mode" = manual ]; then MANUAL=$((MANUAL + 1)); else AUTO=$((AUTO + 1)); fi
  LOG="${LOG:+$LOG
}| ${sha:0:7} | $mode | $lines | $score | ${cost:--} | ${secs:--} |"
  save_count
}

# The bot's review threads, one per line: "<id> <resolved> <outdated> <resolver> <level>".
# resolver is the login of whoever resolved the thread (apps appear as "<slug>[bot]"), or "-";
# level is blocking (🚧), important (💡) or note. Text in the pull request cannot change any of
# these fields.
bot_threads() {
  # shellcheck disable=SC2016
  gh api graphql --paginate -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F pr="$PR" -f query='
    query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
      repository(owner: $owner, name: $name) { pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id isResolved isOutdated resolvedBy { login }
            comments(first: 1) { nodes { author { login } body } } }
      } } }
    }' --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.comments.nodes[0].author.login == "github-actions") |
      "\(.id) \(.isResolved) \(.isOutdated) \(.resolvedBy.login // "-") \(.comments.nodes[0].body |
        if startswith("### 🚧") then "blocking" elif startswith("### 💡") then "important" else "note" end)"'
}

declare -A WRITERS=()
is_writer() { # login
  local permission
  if [ -z "${WRITERS[$1]+x}" ]; then
    permission=$(gh api "repos/$REPO/collaborators/$1/permission" --jq .permission 2>/dev/null || true)
    case $permission in
      admin | maintain | write) WRITERS[$1]=1 ;;
      "") WRITERS[$1]=0
        # The thread keeps counting; say why, so a maintainer knows the override label is the way out.
        echo "::warning::Could not read the access of $1, who resolved a review thread; it still counts" >&2 ;;
      *) WRITERS[$1]=0 ;;
    esac
  fi
  [ "${WRITERS[$1]}" = 1 ]
}

# A thread stops counting only when someone trusted resolved it: this action's app or a person
# with write access. The author of a pull request may resolve its threads too, including the
# author of a fork, and other apps may resolve them on a command; neither counts.
trusted_resolver() { # login
  if [ -n "$APP_SLUG" ] && [ "$1" = "$APP_SLUG[bot]" ]; then return 0; fi
  case $1 in
    - | *"[bot]") return 1 ;;
    *) is_writer "$1" ;;
  esac
}

open_defects() { # level -> how many threads of that level still count for the gate
  local id resolved outdated resolver level n=0
  while read -r id resolved outdated resolver level; do
    [ "$level" = "$1" ] || continue
    # Without the slug the gate cannot tell this action's app from another resolver, so resolved
    # threads and threads under changed code are left to the model's counts.
    if [ -z "$APP_SLUG" ] && { [ "$resolved" = true ] || [ "$outdated" = true ]; }; then continue; fi
    if [ "$resolved" = true ] && trusted_resolver "$resolver"; then continue; fi
    n=$((n + 1))
  done <<<"$THREADS"
  echo "$n"
}

# resolve <thread>...: resolve fixed threads with APP_TOKEN. The ids come from a job with a model,
# so each one is checked again: it must be a thread of the bot on this pull request.
cmd_resolve() {
  local threads row id author head_repo trusted_author=false failed=0
  threads=$(bot_threads)
  # When the code comes from a branch of this repository and its author can write anyway, the
  # model decides whether a defect is fixed, also when the fix is elsewhere. Code from a fork or
  # from a bot must change under the thread. pr-tools.mjs applies the same rule.
  read -r author head_repo < <(gh api "repos/$REPO/pulls/$PR" --jq '"\(.user.login) \(.head.repo.full_name)"')
  if [ "$head_repo" = "$REPO" ] && [[ $author != *"[bot]" ]] && is_writer "$author"; then trusted_author=true; fi
  for id in "$@"; do
    row=$(grep -m1 "^$id " <<<"$threads" || true)
    if [ -z "$row" ]; then
      echo "::warning::Not a thread of this bot on this pull request: $id"
      failed=1
      continue
    fi
    if [ "$trusted_author" != true ] && [ "${row##* }" != note ] && [ "$(cut -d' ' -f3 <<<"$row")" != true ]; then
      echo "::warning::$id is a defect, its code has not changed and the pull request is not from a writer's branch here; it stays open"
      continue
    fi
    # shellcheck disable=SC2016
    if GH_TOKEN=$APP_TOKEN gh api graphql -f thread="$id" -f query='
      mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }' >/dev/null; then
      echo "resolved $id"
    else
      echo "::warning::Could not resolve $id"
      failed=1
    fi
  done
  return "$failed"
}

# agent-budget: reserve a /agent run by posting its comment, so runs in progress count too.
# A failed count stops the script: no budget data means no run.
cmd_agent_budget() {
  local before runs id
  require_number AI_AGENT_MAX_RUNS "$MAX_AGENT"
  out max "$MAX_AGENT"
  # runs includes this request's reservation exactly while comment_id is set; the report
  # job relies on that to leave out a reservation that did not start the model.
  before=$(agent_runs)
  out runs "$before"
  if [ "$before" -ge "$MAX_AGENT" ]; then
    out run false
    return
  fi
  id=$(gh api "repos/$REPO/issues/$PR/comments" --jq .id \
    -f body=$'<!-- ai-agent-run -->\n⏳ **Working on it.** This comment shows the result when the run ends.')
  # From here the report job can always finish this comment, whatever fails below.
  out comment_id "$id"
  out runs "$((before + 1))"
  if ! runs=$(agent_runs); then
    if gh api -X DELETE "repos/$REPO/issues/comments/$id" >/dev/null; then
      out comment_id ""
      out runs "$before"
    fi
    return 1
  fi
  out runs "$runs"
  # Two requests at the same moment can both pass the first count. Whoever sees too many
  # comments now backs off, so the limit holds; at worst both have to ask again.
  if [ "$runs" -gt "$MAX_AGENT" ]; then
    if gh api -X DELETE "repos/$REPO/issues/comments/$id" >/dev/null; then
      out comment_id ""
      out runs "$((runs - 1))"
    fi
    out backed_off true
    out run false
    return
  fi
  out run true
}

# labels: risk labels from the categories of the bot's inline comments.
cmd_labels() {
  local cats c
  cats=$(gh api --paginate "repos/$REPO/pulls/$PR/comments" --jq ".[] | select(.user.login == \"$BOT\") | .body" |
    grep -oP '^`\K(security|api-contract)(?=`$)' | sort -u || true)
  for c in $cats; do
    gh api "repos/$REPO/issues/$PR/labels" -f "labels[]=risk:$c" >/dev/null && echo "label risk:$c"
  done
}

# gate <sha>: commit status that the ruleset requires. Fails closed.
cmd_gate() {
  local sha=$1 lines counts
  if has_override; then
    set_status success "Override: merged without a clean AI review" "$sha"; return
  fi
  # After the override: a bad limit must not take away the way to merge without a review.
  require_number AI_REVIEW_MAX_LINES "$MAX_LINES"
  lines=$(changed_lines)
  if [ "$lines" -gt "$MAX_LINES" ]; then
    set_status failure "Too large to review: $lines of $MAX_LINES changed lines" "$sha"; return
  fi
  counts=$(summary_marker "$sha")
  # Not green: an unreviewed update waits for /review or the override label from a person.
  if [ -z "$counts" ] && [ "$(gh api "repos/$REPO/pulls/$PR" --jq .user.login)" = "dependabot[bot]" ]; then
    set_status pending "Dependabot: comment /review or add the override label" "$sha"; return
  fi
  if [ -z "$counts" ]; then
    set_status failure "Not reviewed: ${sha:0:7}. Comment /review to run it" "$sha"; return
  fi
  require_block_on
  set -- $counts
  # The counts come from the model. A 🚧 or 💡 thread that nobody trusted resolved counts
  # anyway, so text in the pull request cannot talk the model below what is still there.
  local open_blocking open_important
  THREADS=$(bot_threads)
  open_blocking=$(open_defects blocking)
  open_important=$(open_defects important)
  [ "$open_blocking" -gt "$1" ] && set -- "$open_blocking" "$2" "$3"
  [ "$open_important" -gt "$2" ] && set -- "$1" "$open_important" "$3"
  case $(gate_state "$1" "$2") in
    blocked) set_status failure "Merge blocked · $1 blocking, $2 important, $3 notes" "$sha" ;;
    changes) set_status success "Changes requested · $2 important, $3 notes" "$sha" ;;
    *) if [ "$3" -gt 0 ]; then set_status success "Ready to merge · $3 notes" "$sha"
       else set_status success "Ready to merge" "$sha"; fi ;;
  esac
}

cmd=$1; shift
"cmd_${cmd//-/_}" "$@"
