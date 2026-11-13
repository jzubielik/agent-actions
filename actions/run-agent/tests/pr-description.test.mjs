import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalMarker, confidenceFor, gateState, parseMarker, reviewHeading, withGateMarker, withSummary } from "../pr-description.mjs";

const summary = (blocking = 0, important = 0, notes = 0, confidence = 5) =>
  `Checked.\n\n## 🧭 Review summary\n\nText.\n\n<!-- pr-review sha=abc blocking=${blocking} important=${important} notes=${notes} confidence=${confidence} -->`;

test("the block goes below the author's text, after a separator", () => {
  const out = withSummary("Author text", summary(), "important");
  assert.ok(out.startsWith("Author text\n\n---\n\n"));
  assert.ok(out.indexOf("Author text") < out.indexOf("Review summary"));
});

test("without author text there is no separator", () => {
  for (const description of [null, "", "  \n"]) {
    assert.ok(withSummary(description, summary(), "important").startsWith("<!-- ai-review:start -->"));
  }
});

test("the heading shows the confidence and the state the gate uses", () => {
  assert.equal(
    reviewHeading({ blocking: 1, important: 0, notes: 0, confidence: 2 }, "important", "abcdef1234", "https://x/commits/"),
    "### ⚖️ Confidence: 2/5\n\n**❌ Merge blocked** · 🚧 Blocking: 1 · 💡 Important: 0 · 📝 Notes: 0 · Commit [`abcdef1`](https://x/commits/abcdef1234)",
  );
  assert.match(reviewHeading({ blocking: 0, important: 2, notes: 0, confidence: 3 }, "important", "abc"), /\*\*❌ Merge blocked\*\*/);
  assert.match(reviewHeading({ blocking: 0, important: 2, notes: 0, confidence: 3 }, "blocking", "abc"), /\*\*⚠️ Changes requested\*\*/);
  assert.match(reviewHeading({ blocking: 0, important: 0, notes: 1, confidence: 4 }, "important", "abc"), /4\/5\n\n\*\*✅ Ready to merge\*\* · 🚧 Blocking: 0 · 💡 Important: 0 · 📝 Notes: 1/);
  assert.match(reviewHeading({ blocking: 0, important: 0, notes: 0, confidence: 5 }, "important", "abc"), /5\/5\n\n\*\*✅ Ready to merge\*\* · No findings\./);
  assert.match(reviewHeading({ blocking: 0, important: 0, notes: 0, confidence: null }, "important", "abc"), /^### ⚖️ AI review\n/);
});

test("notes never block, and important findings block unless only blocking ones do", () => {
  assert.equal(gateState({ blocking: 0, important: 0, notes: 9 }, "important"), "ready");
  assert.equal(gateState({ blocking: 0, important: 1, notes: 0 }, "important"), "blocked");
  assert.equal(gateState({ blocking: 0, important: 1, notes: 0 }, "blocking"), "changes");
  assert.equal(gateState({ blocking: 1, important: 0, notes: 0 }, "blocking"), "blocked");
});

test("the confidence stays within what the findings allow", () => {
  const c = (blocking, important, notes, given) => confidenceFor({ blocking, important, notes }, given);
  assert.equal(c(1, 0, 0, 5), 2);
  assert.equal(c(1, 0, 0, 1), 1);
  assert.equal(c(0, 2, 0, 5), 3);
  assert.equal(c(0, 0, 1, 5), 4);
  assert.equal(c(0, 0, 0, 1), 4);
  assert.equal(c(0, 0, 0, 5), 5);
  for (const bad of [null, 0, 6, 2.5]) assert.equal(c(0, 0, 0, bad), null);
});

test("a marker without notes and confidence reads as no notes and no confidence", () => {
  const match = "<!-- pr-review sha=abc blocking=1 important=2 -->".match(/<!-- pr-review sha=(\S+) blocking=(\d+) important=(\d+)(?: notes=(\d+))?(?: confidence=(\d+))? -->/);
  assert.deepEqual(parseMarker(match), { sha: "abc", blocking: 1, important: 2, notes: 0, confidence: null });
});

test("the gate marker stays out of the description", () => {
  assert.doesNotMatch(withSummary("Author", summary(), "important"), /pr-review sha=/);
});

test("a second review replaces the block and keeps the author's text once", () => {
  const first = withSummary("Author text", summary(1, 0), "important");
  const second = withSummary(first, summary(0, 0), "important");
  assert.match(second, /Confidence: 5\/5/);
  assert.doesNotMatch(second, /Confidence: [12]\/5/);
  assert.equal(second.match(/ai-review:start/g).length, 1);
  assert.equal(second.match(/Author text/g).length, 1);
  assert.equal(second.match(/^---$/gm).length, 1);
});

test("an author's own separator is kept", () => {
  const first = withSummary("Intro\n\n---\n\nDetails", summary(), "important");
  const second = withSummary(first, summary(), "important");
  assert.match(second, /Intro\n\n---\n\nDetails\n\n---\n\n/);
});

test("a summary without the marker is refused", () => {
  assert.throws(() => withSummary("Author", "no marker"));
});

test("text below an existing block is kept and moved above it", () => {
  const description = "<!-- ai-review:start -->\nOld\n<!-- ai-review:end -->\n\nAuthor text";
  const out = withSummary(description, summary(), "important");
  assert.ok(out.startsWith("Author text\n\n---\n\n"));
  assert.doesNotMatch(out, /Old/);
});

test("text on both sides of the block is kept", () => {
  const first = withSummary("Above", summary(), "important");
  const out = withSummary(`${first}\nBelow`, summary(), "important");
  assert.ok(out.startsWith("Above\n\nBelow\n\n---\n\n"));
});

test("the gate marker in the budget comment is replaced, not repeated", () => {
  const comment = "Budget\n\n<!-- ai-review-budget auto=1 manual=0 -->\n<!-- pr-review sha=old blocking=1 important=0 -->";
  const out = withGateMarker(comment, "<!-- pr-review sha=new blocking=0 important=0 -->");
  assert.match(out, /ai-review-budget auto=1/);
  assert.match(out, /sha=new/);
  assert.doesNotMatch(out, /sha=old/);
});

test("a threshold the gate would reject is refused", () => {
  for (const bad of ["Blocking", "blocked", "blocking ", undefined]) {
    assert.throws(() => gateState({ blocking: 0, important: 0, notes: 0 }, bad), /must be important or blocking/);
  }
});

test("the stored marker has every count and a confidence the counts allow", () => {
  assert.equal(canonicalMarker("<!-- pr-review sha=abc blocking=1 important=0 confidence=5 -->"),
    "<!-- pr-review sha=abc blocking=1 important=0 notes=0 confidence=2 -->");
  assert.equal(canonicalMarker("<!-- pr-review sha=abc blocking=0 important=0 notes=2 confidence=9 -->"),
    "<!-- pr-review sha=abc blocking=0 important=0 notes=2 -->");
});
