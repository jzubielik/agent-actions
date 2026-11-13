import { canonicalMarker, reviewBlock, withCommentBlock, withGateMarker, withSummary } from "./pr-description.mjs";

const SUMMARY_MARKER = "<!-- pr-review sha=";
const BUDGET_MARKER = "<!-- ai-review-budget";
const BUDGET_HEADING = "### AI review budget";
const BLOCK_START = "<!-- ai-review:start -->";

export function isBudgetComment(comment, bot) {
  return comment.user.login === bot && (comment.body.startsWith(BUDGET_HEADING) || comment.body.startsWith(BLOCK_START));
}

// mode: description puts the result in a block of the PR description, comment puts it at the
// top of the bot's budget comment and leaves the description alone.
export async function publishSummary({ github, readComments, lock = (fn) => fn(), pr, headSha, base, blockOn, commitsUrl, bot, body, mode = "description" }) {
  if (mode !== "description" && mode !== "comment") {
    throw new Error(`AI_REVIEW_SUMMARY must be description or comment, got: ${mode}`);
  }
  if (!base) throw new Error("The base branch of the review is not set");
  // The merge gate reads this marker, so a summary without it must not be published.
  const marker = body.match(
    new RegExp(`${SUMMARY_MARKER}${headSha} blocking=\\d+ important=\\d+(?: notes=\\d+)?(?: confidence=\\d+)? -->`),
  )?.[0];
  if (!marker) {
    throw new Error(`The body must contain ${SUMMARY_MARKER}${headSha} blocking=N important=N notes=N confidence=N --> with the fields in this order`);
  }
  // Read and written under the lock, so a precheck or record at the same moment is not lost.
  await lock(async () => {
    // The author can edit the description, so the gate's copy stays in the bot's budget comment.
    // The model reads the diff as the pull request has it now. A result stored for the base
    // branch the review started with would then stand for a diff that nobody looked at.
    const pull = await github(`/pulls/${pr}`);
    if (pull.base.ref !== base) {
      throw new Error(`The base branch of the pull request changed from ${base} to ${pull.base.ref} during the review, so this result is not published. Stop here: the pull request needs a new review.`);
    }
    const budget = (await readComments()).findLast((c) => isBudgetComment(c, bot));
    let comment = withGateMarker(budget?.body ?? `${BUDGET_HEADING}\n\n${BUDGET_MARKER} auto=0 manual=0 -->`, canonicalMarker(marker, base));
    let description;
    if (mode === "comment") {
      comment = withCommentBlock(comment, reviewBlock(withSummary("", body, blockOn, commitsUrl, marker)));
    } else {
      description = withSummary(pull.body, body, blockOn, commitsUrl, marker);
    }
    if (budget) {
      await github(`/issues/comments/${budget.id}`, "PATCH", { body: comment });
    } else {
      await github(`/issues/${pr}/comments`, "POST", { body: comment });
    }
    if (description !== undefined) await github(`/pulls/${pr}`, "PATCH", { body: description });
  });
}
