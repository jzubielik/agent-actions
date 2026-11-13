// Keeps the review result in a marked block of the PR description, below the author's text.
const START = "<!-- ai-review:start -->";
const END = "<!-- ai-review:end -->";
const SEPARATOR = "---";
// The gate reads this marker from the comment; it must not appear in text the author can edit.
// A summary that leaves out notes counts none; one without a valid confidence shows none.
const GATE_MARKER = /\n*<!-- pr-review sha=(\S+) blocking=(\d+) important=(\d+)(?: notes=(\d+))?(?: confidence=(\d+))? -->\s*/;

export function parseMarker(match) {
  return {
    sha: match[1],
    blocking: Number(match[2]),
    important: Number(match[3]),
    notes: Number(match[4] ?? 0),
    confidence: match[5] === undefined ? null : Number(match[5]),
  };
}

// The marker as the gate and the run log read it: every count, and the confidence kept within
// what the counts allow, or left out when the model gave none that is valid.
export function canonicalMarker(marker) {
  const counts = parseMarker(marker.match(GATE_MARKER));
  const confidence = confidenceFor(counts, counts.confidence);
  const tail = confidence === null ? "" : ` confidence=${confidence}`;
  return `<!-- pr-review sha=${counts.sha} blocking=${counts.blocking} important=${counts.important} notes=${counts.notes}${tail} -->`;
}

// Same rule as gate_state in ai-review.sh. Notes never block. Precheck rejects any other
// threshold before the model runs; this check keeps a direct caller from showing a state
// the gate would not give.
export function gateState({ blocking, important }, blockOn) {
  if (blockOn !== "important" && blockOn !== "blocking") {
    throw new Error(`AI_REVIEW_BLOCK_ON must be important or blocking, got: ${blockOn}`);
  }
  if (blocking > 0 || (important > 0 && blockOn !== "blocking")) return "blocked";
  return important > 0 ? "changes" : "ready";
}

// The model picks the confidence, and code keeps it within what the findings allow, so the
// number never contradicts them: 1-2 with a blocking finding, 3 with important ones, at most
// 4 with notes, 4-5 without findings. A missing or invalid value is not shown.
export function confidenceFor({ blocking, important, notes }, given) {
  if (!Number.isInteger(given) || given < 1 || given > 5) return null;
  const [low, high] = blocking > 0 ? [1, 2] : important > 0 ? [3, 3] : notes > 0 ? [4, 4] : [4, 5];
  return Math.min(high, Math.max(low, given));
}

// In comment mode the budget comment starts with the review block. The block holds the model's
// text, so markers are read from the rest of the comment only.
export function splitComment(comment) {
  if (!comment.startsWith(START)) return { block: "", rest: comment };
  const end = comment.indexOf(END);
  if (end === -1) return { block: "", rest: comment };
  return {
    block: comment.slice(0, end + END.length),
    rest: comment.slice(end + END.length).replace(/^\s*---\s*/, ""),
  };
}

export function withCommentBlock(comment, block) {
  const { rest } = splitComment(comment);
  return block ? `${block}\n\n---\n\n${rest}` : rest;
}

// The budget comment keeps the gate marker, which the author cannot edit there.
export function withGateMarker(comment, marker) {
  const { block, rest } = splitComment(comment);
  const updated = `${rest.replace(GATE_MARKER, "\n").trimEnd()}\n${marker}`;
  return block ? withCommentBlock(updated, block) : updated;
}

export function reviewBlock(description) {
  const start = description.indexOf(START);
  const end = description.indexOf(END);
  return start === -1 || end < start ? "" : description.slice(start, end + END.length);
}

const STATES = { blocked: "❌ Merge blocked", changes: "⚠️ Changes requested", ready: "✅ Ready to merge" };

export function reviewHeading(counts, blockOn, sha, commitsUrl) {
  const { blocking, important, notes } = counts;
  const confidence = confidenceFor(counts, counts.confidence);
  const title = confidence === null ? "### ⚖️ AI review" : `### ⚖️ Confidence: ${confidence}/5`;
  const details =
    blocking + important + notes > 0
      ? `🚧 Blocking: ${blocking} · 💡 Important: ${important} · 📝 Notes: ${notes}`
      : "No findings.";
  return `${title}\n\n**${STATES[gateState(counts, blockOn)]}** · ${details} · Commit [\`${sha.slice(0, 7)}\`](${commitsUrl}${sha})`;
}

export function authorText(description) {
  const current = description ?? "";
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start === -1 || end < start) return current.trim();
  // Text can also sit below the block, if someone added it there, so keep both sides.
  const before = current.slice(0, start).replace(/\s*---\s*$/, "").trim();
  const after = current.slice(end + END.length).trim();
  return [before, after].filter(Boolean).join("\n\n");
}

export function withSummary(description, summary, blockOn, commitsUrl) {
  const marker = summary.match(GATE_MARKER);
  if (!marker) throw new Error("The summary has no pr-review marker");
  const counts = parseMarker(marker);
  const heading = reviewHeading(counts, blockOn, counts.sha, commitsUrl);
  // An HTML comment in the model's text could pose as a block end or a budget marker.
  const text = summary.replace(GATE_MARKER, "\n").replaceAll("<!--", "&lt;!--").trim();
  const block = `${START}\n${heading}\n\n${text}\n${END}\n`;
  const author = authorText(description);
  return author ? `${author}\n\n${SEPARATOR}\n\n${block}` : block;
}
