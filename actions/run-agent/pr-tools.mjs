// The agent's only access to GitHub. It has no shell, and the token, PR and commit are fixed
// here, so a prompt injected through the PR can act on this PR only, through these tools only.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { grepLines, logLines, MAX_CONTEXT, readLines } from "./ci-log.mjs";
import { withCommentLock } from "./comment-lock.mjs";
import { authorText, splitComment } from "./pr-description.mjs";
import { isBudgetComment, publishSummary } from "./publish-summary.mjs";

const { RESOLVE_ENABLED, RUNNER_TEMP, GH_TOKEN, GITHUB_SERVER_URL, GITHUB_API_URL, GITHUB_GRAPHQL_URL, GITHUB_REPOSITORY, PR, HEAD_SHA, AI_REVIEW_BLOCK_ON, AI_REVIEW_SUMMARY, AI_REVIEW_READ_DESCRIPTION, GITHUB_RUN_ID } = process.env;
const SUMMARY_MODE = AI_REVIEW_SUMMARY || "description";
const API = `${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}`;
const BOT_REST = "github-actions[bot]";
const BOT_GRAPHQL = "github-actions";
const HEADERS = {
  Authorization: `Bearer ${GH_TOKEN}`,
  "X-GitHub-Api-Version": "2022-11-28",
};

async function request(url, method, body, accept = "application/vnd.github+json") {
  const response = await fetch(url, {
    method,
    headers: { ...HEADERS, Accept: accept },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GitHub ${method} ${url}: ${response.status} ${await response.text()}`);
  }
  return response;
}

async function github(path, method = "GET", body) {
  return (await request(`${API}${path}`, method, body)).json();
}

async function graphql(query, variables) {
  const response = await request(GITHUB_GRAPHQL_URL, "POST", { query, variables });
  const { data, errors } = await response.json();
  if (errors) throw new Error(`GitHub GraphQL: ${JSON.stringify(errors)}`);
  return data;
}

async function issueComments() {
  const comments = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/issues/${PR}/comments?per_page=100&page=${page}`);
    comments.push(...batch);
    if (batch.length < 100) return comments;
  }
}

async function reviewThreads() {
  const [owner, name] = GITHUB_REPOSITORY.split("/");
  const nodes = [];
  // A busy pull request can have more than one page of threads; a missed one would not count.
  for (let after = null; ; ) {
    const { repository } = await graphql(
      `query($owner: String!, $name: String!, $pr: Int!, $after: String) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id isResolved isOutdated path line originalLine
                comments(first: 50) { nodes { author { login } body url } }
              }
            }
          }
        }
      }`,
      { owner, name, pr: Number(PR), after },
    );
    const page = repository.pullRequest.reviewThreads;
    nodes.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return nodes.map(({ comments, ...thread }) => ({
    ...thread,
    author: comments.nodes[0]?.author?.login,
    url: comments.nodes[0]?.url,
    body: comments.nodes[0]?.body,
    replies: comments.nodes.slice(1).map((c) => c.body),
    replyAuthors: comments.nodes.slice(1).map((c) => c.author?.login),
  }));
}

// Anyone who can comment can reply in a thread, and the model reads the replies. Only people
// who could change the code anyway get through; other replies are counted, not shown.
const writers = new Map();
async function canWrite(login) {
  if (login === BOT_GRAPHQL || login === BOT_REST) return true;
  if (!login) return false;
  if (!writers.has(login)) {
    const permission = await github(`/collaborators/${encodeURIComponent(login)}/permission`)
      .then((r) => r.permission, () => "none");
    writers.set(login, ["admin", "maintain", "write"].includes(permission));
  }
  return writers.get(login);
}

// Threads started by this bot or by someone with write access, such as a maintainer's review
// that /agent is asked to address; threads from others, including other apps, stay hidden.
async function threadsForModel() {
  const all = await reviewThreads();
  const started = await Promise.all(all.map((thread) => canWrite(thread.author)));
  const visible = all.filter((_, i) => started[i]);
  return Promise.all(visible.map(async ({ replyAuthors, replies, ...thread }) => {
    const allowed = await Promise.all(replyAuthors.map(canWrite));
    return {
      ...thread,
      replies: replies.filter((_, i) => allowed[i]),
      hiddenReplies: allowed.filter((ok) => !ok).length,
    };
  }));
}

// The model decides whether a finding is fixed, wherever the fix is. For an author without write
// access, such as a fork, a 🚧 or 💡 thread closes only once the code under it changed, so text
// in the PR cannot talk the model into closing it. A 📝 note can be answered anywhere.
export function isDefect(body) {
  return /^### (🚧|💡)/.test(body ?? "");
}

async function assertOwnThread(threadId) {
  const thread = (await reviewThreads()).find((t) => t.id === threadId);
  if (thread?.author !== BOT_GRAPHQL) {
    throw new Error(`${threadId} is not a review thread of this bot on this pull request`);
  }
  return thread;
}

// The same rule as cmd_resolve in ai-review.sh: a branch of this repository, opened by a person
// with write access. Not canWrite, which also trusts this bot.
async function fromWriterBranch() {
  const pr = await github(`/pulls/${PR}`);
  if (pr.head.repo?.full_name !== GITHUB_REPOSITORY || pr.user.login.endsWith("[bot]")) return false;
  return canWrite(pr.user.login);
}

async function assertResolvable(threadId) {
  const thread = await assertOwnThread(threadId);
  if (isDefect(thread.body) && !thread.isOutdated && !(await fromWriterBranch())) {
    throw new Error(`${threadId} is a defect, the code under it has not changed and the pull request is not from a writer's branch here; it stays open and keeps counting`);
  }
}

function define(name, description, schema, handler, annotations = {}) {
  return tool(
    name,
    description,
    schema,
    async (args) => {
      try {
        return { content: [{ type: "text", text: await handler(args) }] };
      } catch (error) {
        return { content: [{ type: "text", text: error.message }], isError: true };
      }
    },
    { annotations },
  );
}

const readOnly = { readOnlyHint: true };
const MAX_LOG_BYTES = 20 * 1024 * 1024;

async function ciRuns() {
  const runs = [];
  for (let page = 1; ; page++) {
    const batch = await github(`/actions/runs?head_sha=${HEAD_SHA}&per_page=100&page=${page}`);
    runs.push(...batch.workflow_runs);
    if (batch.workflow_runs.length < 100) break;
  }
  // This session's own run is in progress and says nothing about the code.
  return runs.filter((run) => String(run.id) !== GITHUB_RUN_ID);
}

// A green job says nothing to judge, and a matrix can have dozens: by default only jobs that
// failed or still run are listed in full, the rest are counted.
const QUIET = new Set(["success", "skipped", "neutral"]);

async function ciStatus(allJobs = false) {
  const runs = await ciRuns();
  return Promise.all(runs.map(async (run) => {
    const jobs = [];
    for (let page = 1; ; page++) {
      const batch = await github(`/actions/runs/${run.id}/jobs?per_page=100&page=${page}`);
      jobs.push(...batch.jobs);
      if (batch.jobs.length < 100) break;
    }
    return {
      workflow: run.name,
      event: run.event,
      attempt: run.run_attempt,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url,
      jobs: jobs.filter((job) => allJobs || job.status !== "completed" || !QUIET.has(job.conclusion)).map((job) => ({
        job_id: job.id,
        name: job.name,
        status: job.status,
        conclusion: job.conclusion,
        failedSteps: (job.steps || []).filter((step) => step.conclusion === "failure").map((step) => step.name),
      })),
      ...(allJobs ? {} : {
        passed: jobs.filter((job) => job.status === "completed" && job.conclusion === "success").length,
        skipped: jobs.filter((job) => job.status === "completed" && QUIET.has(job.conclusion) && job.conclusion !== "success").length,
      }),
    };
  }));
}

// A failure is usually at the end of a log, so a log over the limit keeps its last bytes.
export async function logTail(body, limit = MAX_LOG_BYTES) {
  const chunks = [];
  let size = 0;
  let dropped = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    size += chunk.length;
    while (size - chunks[0].length >= limit) {
      size -= chunks[0].length;
      dropped += chunks.shift().length;
    }
  }
  let bytes = Buffer.concat(chunks);
  if (bytes.length > limit) {
    dropped += bytes.length - limit;
    bytes = bytes.subarray(bytes.length - limit);
  }
  const text = bytes.toString("utf8");
  return dropped ? `[log cut: the first ${dropped} bytes are not shown]\n${text.slice(text.indexOf("\n") + 1)}` : text;
}

// One download per job and session; the model usually greps a log, then reads around a match.
const logs = new Map();

async function jobLog(jobId) {
  if (!logs.has(jobId)) {
    const job = await github(`/actions/jobs/${jobId}`);
    // The token reads every run in the repository; the model gets only this pull request's.
    if (job.head_sha !== HEAD_SHA) throw new Error(`Job ${jobId} did not run on the head commit of this pull request`);
    if (job.status !== "completed") throw new Error(`Job ${jobId} is ${job.status}; its log is available when it completes`);
    // The API answers with a redirect to storage; fetch drops the token on that other host.
    const response = await request(`${API}/actions/jobs/${jobId}/logs`, "GET");
    logs.set(jobId, logLines(await logTail(response.body)));
  }
  return logs.get(jobId);
}

const jobId = z.number().int().positive().describe("job_id from get_ci_status");

// The description as the review starts, without the block of an earlier review in it.
function description(body, authorWrites) {
  // Precheck rejects other values; should one get here anyway, the description stays hidden.
  if (![undefined, "", "true"].includes(AI_REVIEW_READ_DESCRIPTION)) return `[hidden: AI_REVIEW_READ_DESCRIPTION is ${AI_REVIEW_READ_DESCRIPTION}]`;
  if (!authorWrites) return "[hidden: the author has no write access]";
  return authorText(body);
}

export const tools = [
  define(
    "get_pr",
    "Get the state, draft flag, title, description, head commit and comments of this pull request.",
    {},
    async () => {
      const [pr, comments] = await Promise.all([github(`/pulls/${PR}`), issueComments()]);
      // Only text from people who could change the code anyway reaches the model. Someone
      // without write access, such as the author of a fork, is heard only through the code.
      const authorWrites = await canWrite(pr.user.login);
      const allowed = await Promise.all(comments.map((c) => canWrite(c.user.login)));
      return JSON.stringify({
        state: pr.state,
        isDraft: pr.draft,
        title: pr.title,
        body: description(pr.body, authorWrites),
        headRefOid: pr.head.sha,
        // An earlier result is left out wherever it is kept, so the review starts from the code.
        comments: comments
          .filter((_, i) => allowed[i])
          .map((c) => ({ author: c.user.login, body: isBudgetComment(c, BOT_REST) ? splitComment(c.body).rest : c.body })),
        hiddenComments: allowed.filter((ok) => !ok).length,
      });
    },
    readOnly,
  ),
  define(
    "get_diff",
    "Get the unified diff of this pull request.",
    {},
    async () => (await request(`${API}/pulls/${PR}`, "GET", undefined, "application/vnd.github.diff")).text(),
    readOnly,
  ),
  define(
    "list_review_threads",
    "List the review threads of this pull request started by this bot or by people with write access, with replies from people with write access.",
    {},
    async () => JSON.stringify(await threadsForModel()),
    readOnly,
  ),
  define(
    "get_ci_status",
    "List the GitHub Actions runs on the head commit of this pull request. Jobs that failed or still run are listed with their status and failed steps; jobs that passed are counted in passed, and skipped or neutral ones in skipped, unless all_jobs is true. Runs of this review or agent are left out.",
    { all_jobs: z.boolean().default(false).describe("List every job, also those that passed, for example to read a passing job's log") },
    async ({ all_jobs }) => JSON.stringify(await ciStatus(all_jobs)),
    readOnly,
  ),
  define(
    "grep_job_log",
    "Find lines in the log of a completed job from get_ci_status that match a JavaScript regular expression, with numbered lines around each match.",
    {
      job_id: jobId,
      pattern: z.string().min(1).max(200).describe("JavaScript regular expression, e.g. FAILED|Error|assert"),
      context: z.number().int().min(0).max(MAX_CONTEXT).default(3).describe("Lines before and after each match"),
    },
    async ({ job_id, pattern, context }) => grepLines(await jobLog(job_id), pattern, context),
    readOnly,
  ),
  define(
    "read_job_log",
    "Read numbered lines of the log of a completed job from get_ci_status; line numbers are those grep_job_log prints.",
    {
      job_id: jobId,
      start: z.number().int().positive().describe("First line, 1-based"),
      end: z.number().int().positive().describe("Last line, inclusive"),
    },
    async ({ job_id, start, end }) => readLines(await jobLog(job_id), start, end),
    readOnly,
  ),
  define(
    "create_inline_comment",
    "Post one review comment on a line of the head commit of this pull request.",
    {
      path: z.string().describe("Repository-relative file path"),
      line: z.number().int().positive().describe("Line in the new version of the file"),
      body: z.string().min(1).describe("Comment in Markdown"),
    },
    async ({ path, line, body }) => {
      const comment = await github(`/pulls/${PR}/comments`, "POST", {
        commit_id: HEAD_SHA,
        path,
        line,
        side: "RIGHT",
        body,
      });
      return `Posted: ${comment.html_url}`;
    },
  ),
  define(
    "reply_to_thread",
    "Reply to a review thread that this bot started on this pull request.",
    { thread_id: z.string(), body: z.string().min(1) },
    async ({ thread_id, body }) => {
      await assertOwnThread(thread_id);
      await graphql(
        `mutation($thread: ID!, $body: String!) {
          addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) {
            comment { id }
          }
        }`,
        { thread: thread_id, body },
      );
      return "Replied";
    },
  ),
  define(
    "upsert_summary",
    `Publish the review summary in the ${SUMMARY_MODE === "comment" ? "bot's review comment" : "description"} of this pull request.`,
    { body: z.string().min(1).describe("Summary in Markdown, ending with the pr-review marker") },
    async ({ body }) => {
      await publishSummary({
        github,
        readComments: issueComments,
        lock: (fn) => withCommentLock(request, API, PR, fn),
        pr: PR,
        headSha: HEAD_SHA,
        blockOn: AI_REVIEW_BLOCK_ON || "important",
        commitsUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/pull/${PR}/commits/`,
        bot: BOT_REST,
        body,
        mode: SUMMARY_MODE,
      });
      return SUMMARY_MODE === "comment" ? "Summary published in the review comment" : "Summary published in the pull request description";
    },
  ),
];

const THREADS_FILE = "resolve-threads.txt";

export function recordedThreads(dir) {
  const file = join(dir, THREADS_FILE);
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).join(" ") : "";
}

export function writeThreadsOutput(dir, outputFile) {
  const threads = recordedThreads(dir);
  if (threads) appendFileSync(outputFile, `resolve_threads=${threads}\n`);
}

// Resolving needs a token that can also write code, so it stays out of this job. The tool records
// the thread, and a later job without a model checks it again and resolves it.
if (RESOLVE_ENABLED === "true") {
  tools.push(
    define(
      "resolve_thread",
      "Mark a review thread that this bot started on this pull request as fixed, so it gets resolved.",
      { thread_id: z.string().regex(/^[\w-]+$/) },
      async ({ thread_id }) => {
        await assertResolvable(thread_id);
        appendFileSync(join(RUNNER_TEMP, THREADS_FILE), `${thread_id}\n`);
        return "Recorded: the thread is resolved after this session";
      },
    ),
  );
}

export const prTools = createSdkMcpServer({ name: "pr", version: "1.0.0", tools });
