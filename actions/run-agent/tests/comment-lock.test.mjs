import assert from "node:assert/strict";
import { test } from "node:test";
import { withCommentLock } from "../comment-lock.mjs";

const NOW = "2026-11-11T12:00:00Z";

// answers: one { status, created_at } per POST of the reaction, in order.
function fakeRequest(answers, { deleteFails = false } = {}) {
  const calls = [];
  const request = async (url, method, body) => {
    calls.push({ url, method, body });
    if (method === "DELETE") {
      if (deleteFails) throw new Error("GitHub DELETE: 403");
      return { status: 204 };
    }
    const { status, created_at = NOW, id = calls.length, fails } = answers.shift();
    if (fails) throw new Error("GitHub POST: 502");
    return { status, headers: new Headers({ date: new Date(NOW).toUTCString() }), json: async () => ({ id, created_at }) };
  };
  return { calls, request };
}

let slept = 0;
const run = (request, fn = async () => "done", attempts = 3) =>
  withCommentLock(request, "https://api.test/repos/o/r", "7", fn, { attempts, sleep: async () => { slept++; } });

test("the run that adds the reaction writes, then removes it", async () => {
  const { calls, request } = fakeRequest([{ status: 201, id: 5 }]);
  assert.equal(await run(request), "done");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    "POST https://api.test/repos/o/r/issues/7/reactions",
    "DELETE https://api.test/repos/o/r/issues/7/reactions/5",
  ]);
  assert.deepEqual(calls[0].body, { content: "eyes" });
});

test("a run waits while another one holds the reaction", async () => {
  const { calls, request } = fakeRequest([{ status: 200 }, { status: 200 }, { status: 201, id: 9 }]);
  let ran = 0;
  await run(request, async () => ran++);
  assert.equal(ran, 1);
  assert.equal(calls.filter((c) => c.method === "POST").length, 3);
});

test("the reaction is removed when the write fails", async () => {
  const { calls, request } = fakeRequest([{ status: 201, id: 5 }]);
  await assert.rejects(run(request, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(calls.at(-1).method, "DELETE");
});

test("a reaction left by a run that died is taken over", async () => {
  const { calls, request } = fakeRequest([{ status: 200, id: 3, created_at: "2026-11-11T11:55:00Z" }, { status: 201, id: 4 }]);
  assert.equal(await run(request), "done");
  assert.ok(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/reactions/3")));
});

test("nothing is written when the lock stays taken", async () => {
  const { request } = fakeRequest([{ status: 200 }, { status: 200 }, { status: 200 }]);
  let ran = false;
  await assert.rejects(run(request, async () => { ran = true; }), /kept the review comment locked/);
  assert.equal(ran, false);
});

test("a failed lock request is one more attempt", async () => {
  const { request } = fakeRequest([{ fails: true }, { status: 201, id: 4 }]);
  let ran = 0;
  await run(request, async () => ran++);
  assert.equal(ran, 1);
});

test("a takeover that cannot delete the reaction waits and stops at the attempt limit", async () => {
  const old = "2026-11-11T11:55:00Z";
  const { calls, request } = fakeRequest([{ status: 200, created_at: old }, { status: 200, created_at: old }, { status: 200, created_at: old }], { deleteFails: true });
  slept = 0;
  await assert.rejects(run(request), /kept the review comment locked/);
  assert.equal(calls.filter((c) => c.method === "POST").length, 3);
  assert.equal(slept, 2);
});
