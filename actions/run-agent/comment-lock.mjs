// The bot's 👀 reaction on the pull request is a lock around each read and write of its budget
// comment: GitHub has no conditional write for a comment, so two runs writing at once would
// lose one update. GitHub answers 201 to the request that adds the reaction and 200 when the
// same user already has it. ai-review.sh takes the same lock.
export const LOCK_CONTENT = "eyes";

// A run that died holding the lock leaves the reaction; after this long it is taken over.
const STALE_MS = 120_000;

export async function withCommentLock(request, api, pr, fn, { attempts = 75, delayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const url = `${api}/issues/${pr}/reactions`;
  const release = (id) => request(`${url}/${id}`, "DELETE").catch(() => {});
  for (let attempt = 1; ; attempt++) {
    // A failed request (a 5xx, a rate limit, the network) is one more attempt, as in ai-review.sh.
    const answer = await request(url, "POST", { content: LOCK_CONTENT })
      .then(async (response) => ({ response, reaction: await response.json() }))
      .catch(() => null);
    if (answer?.response.status === 201) {
      try {
        return await fn();
      } finally {
        await release(answer.reaction.id);
      }
    }
    // GitHub's clock on both sides, so a runner clock that is off does not matter. A takeover
    // that fails still waits and counts, so it cannot loop without pause.
    if (answer && Date.parse(answer.response.headers.get("date")) - Date.parse(answer.reaction.created_at) > STALE_MS) {
      await release(answer.reaction.id);
    }
    if (attempt >= attempts) throw new Error("Another run kept the review comment locked; nothing was written");
    await sleep(delayMs);
  }
}
