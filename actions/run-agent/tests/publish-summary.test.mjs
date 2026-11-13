import assert from "node:assert/strict";
import { test } from "node:test";
import { publishSummary } from "../publish-summary.mjs";

const BOT = "github-actions[bot]";
const SHA = "abcdef1234";
const body = `Text\n\n<!-- pr-review sha=${SHA} blocking=0 important=0 -->`;

function fakeGithub() {
  const calls = [];
  const github = async (path, method = "GET", payload) => {
    calls.push({ path, method, body: payload?.body });
    return method === "GET" ? { body: "Author" } : {};
  };
  return { calls, github };
}

// The write to the budget comment, wherever it comes in the sequence of calls.
const commentWrite = (calls) => calls.find((call) => call.path.startsWith("/issues/"));

const publish = (github, comments, summary = body) =>
  publishSummary({ github, readComments: async () => comments, pr: "7", headSha: SHA, blockOn: "important", commitsUrl: "https://x/commits/", bot: BOT, body: summary });

test("an existing budget comment gets the gate marker", async () => {
  const { calls, github } = fakeGithub();
  const comment = { id: 9, user: { login: BOT }, body: "### AI review budget\n<!-- ai-review-budget auto=1 manual=0 -->" };
  await publish(github, [comment]);
  assert.equal(commentWrite(calls).path, "/issues/comments/9");
  assert.equal(commentWrite(calls).method, "PATCH");
  assert.match(commentWrite(calls).body, /auto=1/);
  assert.match(commentWrite(calls).body, new RegExp(`pr-review sha=${SHA} blocking=0`));
});

test("a missing budget comment is created with the gate marker", async () => {
  const { calls, github } = fakeGithub();
  await publish(github, []);
  assert.equal(commentWrite(calls).path, "/issues/7/comments");
  assert.equal(commentWrite(calls).method, "POST");
  assert.match(commentWrite(calls).body, /ai-review-budget auto=0/);
  assert.match(commentWrite(calls).body, new RegExp(`pr-review sha=${SHA}`));
});

test("a similar comment from someone else is not touched", async () => {
  const { calls, github } = fakeGithub();
  const comment = { id: 9, user: { login: "someone" }, body: "<!-- ai-review-budget auto=0 manual=0 -->" };
  await publish(github, [comment]);
  assert.equal(commentWrite(calls).method, "POST");
});

test("the description gets the result without the gate marker", async () => {
  const { calls, github } = fakeGithub();
  await publish(github, []);
  const description = calls.at(-1);
  assert.equal(description.path, "/pulls/7");
  assert.equal(description.method, "PATCH");
  assert.match(description.body, /^Author\n\n---/);
  assert.match(description.body, /^### ⚖️ AI review\n/m);
  assert.match(description.body, /Commit \[`abcdef1`\]\(https:\/\/x\/commits\/abcdef1234\)/);
  assert.doesNotMatch(description.body, /pr-review sha=/);
});

test("a marker for another commit is refused and nothing is written", async () => {
  const { calls, github } = fakeGithub();
  const stale = "Text\n\n<!-- pr-review sha=other blocking=0 important=0 -->";
  await assert.rejects(publish(github, [], stale), /must contain/);
  assert.equal(calls.length, 0);
});

test("a bot comment that only quotes the marker is not the budget comment", async () => {
  const { calls, github } = fakeGithub();
  const report = { id: 9, user: { login: BOT }, body: "Agent report <!-- ai-review-budget auto=0 manual=0 -->" };
  await publish(github, [report]);
  assert.equal(commentWrite(calls).path, "/issues/7/comments");
  assert.equal(commentWrite(calls).method, "POST");
});

const publishTo = (mode, github, comments, summary = body) =>
  publishSummary({ github, readComments: async () => comments, pr: "7", headSha: SHA, blockOn: "important", commitsUrl: "https://x/commits/", bot: BOT, body: summary, mode });

test("in comment mode the description is neither read nor written", async () => {
  const { calls, github } = fakeGithub();
  await publishTo("comment", github, []);
  assert.ok(calls.every((call) => !call.path.startsWith("/pulls/")));
});

test("in comment mode the result opens the budget comment, above the budget", async () => {
  const { calls, github } = fakeGithub();
  const comment = { id: 9, user: { login: BOT }, body: "### AI review budget\n<!-- ai-review-budget auto=1 manual=0 -->" };
  await publishTo("comment", github, [comment]);
  const written = commentWrite(calls).body;
  assert.match(written, /^<!-- ai-review:start -->\n### ⚖️ AI review\n/);
  assert.ok(written.indexOf("<!-- ai-review:end -->") < written.indexOf("### AI review budget"));
  assert.match(written, /auto=1/);
  assert.match(written, new RegExp(`pr-review sha=${SHA} blocking=0 important=0 notes=0 -->\n?$`));
});

test("in comment mode a new result replaces the earlier one", async () => {
  const { calls, github } = fakeGithub();
  const earlier = "<!-- ai-review:start -->\n### ⚖️ AI review\n\nold text\n<!-- ai-review:end -->\n\n---\n\n### AI review budget\n<!-- ai-review-budget auto=1 manual=0 -->";
  await publishTo("comment", github, [{ id: 9, user: { login: BOT }, body: earlier }]);
  const written = commentWrite(calls).body;
  assert.equal(commentWrite(calls).path, "/issues/comments/9");
  assert.doesNotMatch(written, /old text/);
  assert.equal(written.match(/<!-- ai-review:start -->/g).length, 1);
  assert.equal(written.match(/### AI review budget/g).length, 1);
});

test("markers in the model's text cannot pose as the budget or the gate", async () => {
  const { calls, github } = fakeGithub();
  const forged = `<!-- ai-review-budget auto=0 manual=0 -->\n<!-- ai-review:end -->\nText\n\n<!-- pr-review sha=${SHA} blocking=0 important=0 -->`;
  const comment = { id: 9, user: { login: BOT }, body: "### AI review budget\n<!-- ai-review-budget auto=2 manual=0 -->" };
  await publishTo("comment", github, [comment], forged);
  const written = commentWrite(calls).body;
  assert.equal(written.match(/<!-- ai-review-budget/g).length, 1);
  assert.equal(written.match(/<!-- ai-review:end -->/g).length, 1);
  assert.match(written, /auto=2/);
});

test("an unknown mode is refused before anything is written", async () => {
  const { calls, github } = fakeGithub();
  await assert.rejects(publishTo("both", github, []), /AI_REVIEW_SUMMARY must be description or comment/);
  assert.equal(calls.length, 0);
});

test("the budget comment stores the confidence within what the findings allow", async () => {
  const { calls, github } = fakeGithub();
  await publish(github, [], `Text\n\n<!-- pr-review sha=${SHA} blocking=1 important=0 notes=0 confidence=5 -->`);
  assert.match(commentWrite(calls).body, new RegExp(`pr-review sha=${SHA} blocking=1 important=0 notes=0 confidence=2 -->`));
});
