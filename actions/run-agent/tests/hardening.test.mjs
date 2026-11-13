import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);
const workflows = readdirSync(new URL(".github/workflows/", root)).map((f) => `.github/workflows/${f}`);
const actions = readdirSync(new URL("actions/", root)).map((d) => `actions/${d}/action.yml`);
const files = [...workflows, ...actions].map((f) => [f, readFileSync(new URL(f, root), "utf8")]);

test("third-party actions are pinned to a full commit", () => {
  for (const [file, text] of files) {
    for (const [, ref] of text.matchAll(/^\s*(?:- )?uses:\s+(\S+)/gm)) {
      if (ref.startsWith("./.agent-actions/actions/") || ref.startsWith("./actions/")) continue;
      // This repository's own review runs the workflow as it is on main.
      if (file === ".github/workflows/ai-review.yml" && ref.endsWith("/.github/workflows/review.yml@main")) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${file}: ${ref}`);
    }
  }
});

test("the reusable workflows run the actions of their own version", () => {
  for (const [file, text] of files.filter(([f]) => /\/(review|agent)\.yml$/.test(f))) {
    assert.doesNotMatch(text, /uses:\s+\S+\/actions\/\S+@/, file);
    const jobs = text.slice(text.indexOf("\njobs:\n")).split(/\n  (?=[a-z-]+:\n)/).slice(1);
    const withActions = jobs.filter((job) => job.includes("uses: ./.agent-actions/actions/"));
    assert.ok(withActions.length >= 3, file);
    for (const job of withActions) {
      const name = job.slice(0, job.indexOf(":"));
      const checkout = job.indexOf("repository: ${{ job.workflow_repository }}\n          ref: ${{ job.workflow_sha }}\n          path: .agent-actions\n          persist-credentials: false\n");
      assert.ok(checkout !== -1 && checkout < job.indexOf("uses: ./.agent-actions/actions/"), `${file}: ${name}`);
    }
  }
});

test("workflows start with no permissions and a fixed runner image", () => {
  for (const [file, text] of files.filter(([f]) => f.startsWith(".github/workflows/"))) {
    assert.match(text, /^permissions: \{\}$/m, file);
    assert.doesNotMatch(text, /ubuntu-latest/, file);
  }
});

test("package install scripts do not run", () => {
  for (const [file, text] of files) {
    for (const [line] of text.matchAll(/npm ci.*/g)) assert.match(line, /--ignore-scripts/, file);
  }
});

test("status descriptions have no 4-byte characters, which GitHub refuses", () => {
  const script = readFileSync(new URL("actions/review-script/ai-review.sh", root), "utf8");
  const lines = script.split("\n").filter((line) => /\bset_status (success|failure|pending|error)\b/.test(line));
  assert.ok(lines.length >= 5);
  for (const line of lines) {
    assert.ok([...line].every((c) => c.codePointAt(0) <= 0xffff), line);
    assert.ok(line.length <= 140 + 40, line);
  }
});

test("the E2E workflow runs the actions from the branch and has its own status", () => {
  const e2e = readFileSync(new URL(".github/workflows/e2e.yml", root), "utf8");
  assert.ok(e2e.includes("uses: ./actions/review-script"));
  assert.ok(e2e.includes("uses: ./actions/run-agent"));
  assert.ok(e2e.includes("AI_REVIEW_STATUS_CONTEXT: E2E / gate text check"));
  assert.ok(e2e.includes("E2E running"));
  assert.ok(e2e.includes("Gate text accepted"));
  assert.ok(e2e.includes("if: always() && steps.pending.outcome == 'success'"));
  // A run started by hand has the secrets, so it must be on the commit it reports for.
  assert.ok(e2e.includes('[ "$repo" != "$GITHUB_REPOSITORY" ] || [ "$sha" != "$GITHUB_SHA" ]'));
  const afterCtx = e2e.slice(e2e.indexOf("The status shows that E2E is running"));
  assert.ok(!afterCtx.includes("github.event.pull_request"));
  assert.ok(e2e.indexOf("id: ctx") < e2e.indexOf("actions/checkout@"));
});

test("status descriptions have no icons, because GitHub shows the state itself", () => {
  const script = readFileSync(new URL("actions/review-script/ai-review.sh", root), "utf8");
  for (const line of script.split("\n").filter((l) => /\bset_status (success|failure|pending)\b/.test(l))) {
    assert.doesNotMatch(line, /\p{Extended_Pictographic}/u, line);
  }
});
