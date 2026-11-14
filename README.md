# Agent actions

Reusable GitHub workflows that put an AI agent on your pull requests.

- **Review** (`review.yml`) checks each change against the rules of your repository, comments on the lines it has a problem with, and sets a commit status that can block the merge.
- **`/agent`** (`agent.yml`) is a comment command. It changes the code, answers a question or explains a CI failure, and pushes its change as a commit.

Your repository adds one small workflow file for each, and keeps its own rules, skills and MCP servers. The agent runs on Claude through the Claude Agent SDK. It has no shell: it reads files, and it reaches GitHub only through tools that are tied to the pull request it works on.

## Quick start

1. **Add the API key.** Save it as the repository secret `ANTHROPIC_KEY`. Use a separate key for CI, in its own workspace, with a monthly spend limit in the Anthropic Console. That limit is the only hard cap on cost.
2. **Add the review workflow.** Pick a case in [When the review runs](#when-the-review-runs) and copy its file to `.github/workflows/ai-review.yml`. Take case 2 if the repository has CI, and case 1 if it does not.
3. **Open a pull request.** The review comments on the changed lines, writes its result into the description and sets the `AI review / Merge gate` status.

The rest is optional:

- [Rules for the review](#rules-the-review-follows) in `CLAUDE.md`, `AGENTS.md` and `REVIEW.md`.
- [The `/agent` command](#the-agent-command), which needs a [credential that can push](#writing-to-the-repository).
- A ruleset that [requires the merge gate](#the-merge-gate).

The files below use `v1.0.2`. To pin the exact code, use the full commit sha of that release instead. Keep the `permissions` block as shown: a workflow does not start when a permission it asks for is missing. `id-token: write` is used only with Bedrock.

## When the review runs

The `on:` block of your workflow file and the `wait_for_ci` input decide.

| Case | The review runs | Choose it when |
|---|---|---|
| [1](#1-review-each-push-at-once) | on every push | the repository has no CI, or the review should not wait for it |
| [2](#2-wait-for-ci-then-review-once-with-its-results) | once per commit, after CI finishes | CI results should be judged together with the code |
| [3](#3-review-each-push-at-once-and-again-when-ci-fails) | on every push, and again when CI fails | the early review is worth the price of a second one |
| [4](#4-review-only-on-demand) | only when someone asks | you want to decide for each pull request |

Three things are the same in every case. Someone with write access can always start a review by commenting `/review`, also on a draft. A draft is not reviewed on its own, so pushes to it cost nothing. In cases 1 and 3 the review comes when it is marked ready; for case 2 see its rule about drafts, and in case 4 comment `/review`. A pull request from a fork is never reviewed automatically; see [Security](#security).

### 1. Review each push at once

Each commit is reviewed as soon as it is pushed. The review sees only the CI jobs that have finished by then, which is usually none.

```yaml
name: AI review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened, labeled, unlabeled]
  # /review from someone with write access.
  issue_comment:
    types: [created]
jobs:
  review:
    uses: jzubielik/agent-actions/.github/workflows/review.yml@v1.0.2
    permissions:
      contents: read
      pull-requests: write
      issues: write
      statuses: write
      actions: read
      id-token: write
    secrets:
      ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
      # Optional, to resolve fixed review threads: a token, or a GitHub App (it wins when both
      # are set). See "Writing to the repository" below.
      AGENT_PUSH_TOKEN: ${{ secrets.AGENT_PUSH_TOKEN }}
      AGENT_ACTIONS_CLIENT_ID: ${{ secrets.AGENT_ACTIONS_CLIENT_ID }}
      AGENT_ACTIONS_APP_KEY: ${{ secrets.AGENT_ACTIONS_APP_KEY }}
```

### 2. Wait for CI, then review once with its results

The review waits for your CI and then judges the code together with the CI results. Put the names of your CI workflows in two places: under `workflow_run` and in `wait_for_ci`.

```yaml
name: AI review
on:
  # Only for the override label; the review itself starts from CI.
  pull_request:
    types: [labeled, unlabeled]
  # /review from someone with write access.
  issue_comment:
    types: [created]
  # The names of your CI workflows (their name:), the same as in wait_for_ci.
  workflow_run:
    workflows: [Tests, Lint]
    types: [requested, completed]
jobs:
  review:
    uses: jzubielik/agent-actions/.github/workflows/review.yml@v1.0.2
    permissions:
      contents: read
      pull-requests: write
      issues: write
      statuses: write
      actions: read
      id-token: write
    with:
      wait_for_ci: Tests, Lint
    secrets:
      ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
      # Optional, to resolve fixed review threads: a token, or a GitHub App (it wins when both
      # are set). See "Writing to the repository" below.
      AGENT_PUSH_TOKEN: ${{ secrets.AGENT_PUSH_TOKEN }}
      AGENT_ACTIONS_CLIENT_ID: ${{ secrets.AGENT_ACTIONS_CLIENT_ID }}
      AGENT_ACTIONS_APP_KEY: ${{ secrets.AGENT_ACTIONS_APP_KEY }}
```

What happens after a push:

1. **CI starts.** The merge gate turns to pending, `Waiting for CI`. This takes a few seconds, and no job waits on a runner.
2. **The last CI workflow finishes,** with any result. The review runs once, reads the CI logs and ties each failure to the diff.

The pull request shows the merge gate status, and its link opens the run that set it. The review's own jobs are not in the list of checks, so there are no skipped entries after a push. A change of the override label is the one exception: it runs the gate alone, and the list then shows the other review jobs as skipped.

Because the review starts from CI, a few rules follow:

- **CI must run on every pull request.** The CI workflows must be triggered by `pull_request`. If a `paths:` filter or a branch rule leaves a pull request without CI, it gets no review until someone comments `/review`.
- **Drafts.** A draft is not reviewed. For its review to start when it is marked ready, list `ready_for_review` in the `pull_request` types of your CI workflows. Otherwise comment `/review`.
- **Names must match.** A workflow missing from `wait_for_ci` is not waited for. One missing from `workflow_run` never starts the review.
- **One pull request per branch.** When one branch has open pull requests into two base branches, only one of them is reviewed after CI. Comment `/review` on the other.
- **Re-running CI** does not put the gate back to `Waiting for CI`. A commit that already has a review keeps it when the re-run finishes; comment `/review` for a new one.

### 3. Review each push at once, and again when CI fails

Case 1, plus a second review of any commit whose CI failed, this time with the logs. Every commit with red CI then costs two reviews. Prefer case 2 unless the early review matters.

```yaml
name: AI review
on:
  pull_request:
    types: [opened, synchronize, ready_for_review, reopened, labeled, unlabeled]
  # /review from someone with write access.
  issue_comment:
    types: [created]
  # The names of your CI workflows (their name:).
  workflow_run:
    workflows: [Tests, Lint]
    types: [completed]
jobs:
  review:
    uses: jzubielik/agent-actions/.github/workflows/review.yml@v1.0.2
    permissions:
      contents: read
      pull-requests: write
      issues: write
      statuses: write
      actions: read
      id-token: write
    secrets:
      ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
      # Optional, to resolve fixed review threads: a token, or a GitHub App (it wins when both
      # are set). See "Writing to the repository" below.
      AGENT_PUSH_TOKEN: ${{ secrets.AGENT_PUSH_TOKEN }}
      AGENT_ACTIONS_CLIENT_ID: ${{ secrets.AGENT_ACTIONS_CLIENT_ID }}
      AGENT_ACTIONS_APP_KEY: ${{ secrets.AGENT_ACTIONS_APP_KEY }}
```

### 4. Review only on demand

Nothing runs by itself. Only `/review` sets the merge gate, so with a ruleset that requires the gate, every pull request needs someone to comment `/review`.

```yaml
name: AI review
on:
  # /review from someone with write access.
  issue_comment:
    types: [created]
jobs:
  review:
    uses: jzubielik/agent-actions/.github/workflows/review.yml@v1.0.2
    permissions:
      contents: read
      pull-requests: write
      issues: write
      statuses: write
      actions: read
      id-token: write
    secrets:
      ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
      # Optional, to resolve fixed review threads: a token, or a GitHub App (it wins when both
      # are set). See "Writing to the repository" below.
      AGENT_PUSH_TOKEN: ${{ secrets.AGENT_PUSH_TOKEN }}
      AGENT_ACTIONS_CLIENT_ID: ${{ secrets.AGENT_ACTIONS_CLIENT_ID }}
      AGENT_ACTIONS_APP_KEY: ${{ secrets.AGENT_ACTIONS_APP_KEY }}
```

> **Note:** GitHub starts `workflow_run` only from the workflow file on the default branch. A change to your file takes effect after it is merged.

## What the review produces

### Findings

Each finding is an inline comment on the line it is about.

| Level | What it is | Example | Merge gate |
|---|---|---|---|
| 🚧 Blocking | A defect on a normal input: a security flaw, data loss, a broken contract, a crash | SQL injection; `TypeError` for an unknown user | Blocks |
| 💡 Important | A defect in a specific edge case: a wrong result, missing error handling | An email with an apostrophe returns 500 | Blocks, unless `AI_REVIEW_BLOCK_ON=blocking` |
| 📝 Note | Not a defect. Something a written instruction of the repository asks for is missing, or the intent of a design choice is unclear | `REVIEW.md` asks for tests and a changed behavior has none; a field the API returns but no request can set | Never blocks |

When a later commit fixes a finding, the review says so in the thread and closes it. Closing a thread needs a [credential of your own](#writing-to-the-repository). Without one, the review replies in the thread and a person resolves it.

### The merge gate

The gate is the commit status `AI review / Merge gate`. It follows the number of open findings and nothing else, so the same commit always gets the same result.

A result holds for a commit and the base branch it was reviewed against. Changing the base branch of a pull request starts nothing: the status stays as it was until the next push, label change or `/review`, and from then on the commit counts as not reviewed. After such a change, check the status again before you merge.

| Status | Meaning |
|---|---|
| ✅ Ready to merge | No finding blocks. Notes may be open |
| ✅ Changes requested | Only 💡 findings are open and `AI_REVIEW_BLOCK_ON=blocking` |
| ❌ Merge blocked | A 🚧 finding is open, or a 💡 one with the default setting |
| ❌ Not reviewed | The head commit has no review. Comment `/review` |
| ❌ Too large to review | The change has more lines than `AI_REVIEW_MAX_LINES` |
| ⏳ Waiting for CI | Case 2: CI is still running |
| ⏳ Draft | The pull request is a draft and its head commit has no review |
| ⏳ AI review in progress | The review is running |

Two more things to know:

- **Override.** The `ai-review-override` label turns the gate green without a clean review. The gate does not check who added the label, so everyone who can label pull requests in your repository can use it.
- **Enforcement.** The status blocks a merge only when a ruleset requires it. Rulesets need a paid plan or a public repository.

### Confidence

Next to the result the review gives a confidence from 1 to 5: how sure it is that the change is correct, with one sentence that says why. The number is the model's opinion and never affects the gate. Code keeps it within what the findings allow: 1-2 with a 🚧, 3 with a 💡, at most 4 with a 📝, and 4-5 without findings. The place of a change in the code does not lower it by itself.

### Where the result goes

`AI_REVIEW_SUMMARY` chooses between two places.

- **`description`** (default). The result is a marked block below the author's text in the pull request description.
- **`comment`.** The result is at the top of the bot's review comment and the description stays untouched. The comment appears when the review starts ("Review in progress"), then shows the result, and says "Not reviewed" when a newer commit has no review yet.

Use `comment` when another bot also writes into the description. GitHub saves a description as a whole, so two writers at the same moment can overwrite each other. The merge gate is safe either way: it reads its data from the bot's comment, which the author of a pull request cannot edit.

The review reads the description as it is when the review starts, without its own block. Editing the description does not start a review; comment `/review` for that. When the author has write access, everything in the description reaches the model as the author's text, including what another bot added. `AI_REVIEW_READ_DESCRIPTION=false` keeps the description out of the review.

| Your setup | `AI_REVIEW_SUMMARY` | `AI_REVIEW_READ_DESCRIPTION` |
|---|---|---|
| No other bot writes in the description | `description` | `true` |
| Another bot writes in the description | `comment` | `true` |
| The description should not steer the review | `comment` | `false` |

> **Warning:** changing `AI_REVIEW_SUMMARY` while a pull request is open leaves its earlier result where it was, in the description or in the bot's comment. Delete that block by hand.

## The /agent command

`/agent <request>` asks the agent to change the code, answer a question or explain a CI failure. Write it as a comment on the pull request, or on a line of its diff when the request is about that line. Copy this file to `.github/workflows/ai-agent.yml`:

```yaml
name: AI agent
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
jobs:
  agent:
    uses: jzubielik/agent-actions/.github/workflows/agent.yml@v1.0.2
    permissions:
      contents: read
      actions: read
      pull-requests: write
      issues: write
      id-token: write
    secrets:
      ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
      # One of the two, to push the agent's commit: a token, or a GitHub App (it wins when both
      # are set). See "Writing to the repository" below.
      AGENT_PUSH_TOKEN: ${{ secrets.AGENT_PUSH_TOKEN }}
      AGENT_ACTIONS_CLIENT_ID: ${{ secrets.AGENT_ACTIONS_CLIENT_ID }}
      AGENT_ACTIONS_APP_KEY: ${{ secrets.AGENT_ACTIONS_APP_KEY }}
```

The agent answers in a comment. When it changed files, it pushes one commit to the pull request branch, and CI and the review run on that commit as on any other.

What to expect:

- **Who can use it.** People with write access, on pull requests from a branch of this repository. It never runs on a fork.
- **It cannot run anything.** The agent edits files and reads CI results, but it has no shell, so it does not run tests or generators.
- **Protected files.** It cannot change workflows under `.github/workflows`, or agent configuration: `.claude/`, `.mcp.json`, `CLAUDE.md`, `AGENTS.md` and `REVIEW.md`. Asked for such a change, it describes it in its answer.
- **Symlinks.** It does not run on a pull request that contains a symlink.
- **A moving branch.** If the branch gets a new commit while the agent works, nothing is pushed. Send the request again.
- **Budget.** Each pull request has `AI_AGENT_MAX_RUNS` runs, and the comment of each run shows how many are used.

## Configuration

### Rules the review follows

The review and `/agent` follow the rules in your repository's `CLAUDE.md` or `AGENTS.md`, in the root and in the directories of the changed files. A `REVIEW.md` in the root holds instructions for the review only.

A file can hold rules for the code ("parameterized queries only") and instructions for the review ("if a changed behavior has no test, say so"). A change that breaks a rule is a 🚧 or 💡 finding. Something an instruction asks for and the change lacks is a 📝 note.

All of these files are read from the base branch of the pull request, so a pull request cannot change the rules it is judged by, and `/agent` cannot edit them. The same holds for a file that one of them imports with `@path`.

A pull request that changes a rule is therefore judged by the rules as they were. The review still sees the change in the diff and comments on it like on any other change. The new rule applies from the next pull request.

### Variables

Repository variables, all optional.

| Name | Default | Purpose |
|---|---|---|
| `AI_REVIEW_BLOCK_ON` | `important` | Which findings block the merge: `important` (🚧 and 💡) or `blocking` (🚧 only; 💡 then shows as Changes requested). 📝 notes never block |
| `AI_REVIEW_SUMMARY` | `description` | Where the result goes: `description` or `comment`. See [Where the result goes](#where-the-result-goes) |
| `AI_REVIEW_READ_DESCRIPTION` | `true` | `false` hides the pull request description from the model. It still reads the title and the comments of people with write access |
| `AI_REVIEW_LANGUAGE` | `English` | Language of the prose the agent writes |
| `AI_REVIEW_MAX_AUTO` | `3` | Automatic reviews per pull request |
| `AI_REVIEW_MAX_MANUAL` | `2` | `/review` runs per pull request |
| `AI_REVIEW_MAX_LINES` | `1000` | Changed lines above which the model is not run and the gate stays red. Lock files do not count |
| `AI_AGENT_MAX_RUNS` | `5` | `/agent` runs per pull request, counted separately from reviews |
| `AI_MODELS` | `{}` | Models per role, as a JSON object. See [Models](#models) |
| `AGENT_ACTIONS_RUNNER` | | Runner label for every job. See [Runner](#runner) |
| `AGENT_ACTIONS_APP_SLUG` | | Slug of your GitHub App, when you use one. See [Writing to the repository](#writing-to-the-repository) |
| `AGENT_PROVIDER` | `anthropic` | `anthropic`, or `bedrock` for Amazon Bedrock |
| `AGENT_AWS_ROLE_ARN` | | With `bedrock`: the IAM role the job assumes through GitHub's OIDC token |
| `AGENT_AWS_REGION` | `us-east-1` | With `bedrock`: the AWS region |

### Workflow inputs

Set under `with:` in your workflow file. `review.yml` takes all of them; `agent.yml` takes `runner` and `models`.

| Input | Purpose |
|---|---|
| `wait_for_ci` | Names of the CI workflows the review waits for. See [case 2](#2-wait-for-ci-then-review-once-with-its-results) |
| `models` | The same as `AI_MODELS`, and it wins over the variable |
| `mcp_config` | Your MCP servers, as a JSON object. See [MCP servers](#mcp-servers) |
| `extra_allowed_tools` | The tools of those servers that the review may call |
| `runner` | Runner label for every job; it wins over `AGENT_ACTIONS_RUNNER` |

### Models

`AI_MODELS` maps roles to models, for example `{"review":"opus","agent":"sonnet","rules-reviewer":"sonnet"}`.

- **Roles.** `review` is the main session of the review and `agent` the main session of `/agent`. Every subagent is a role under its own name, both the default ones and those from your repository.
- **Values.** An alias (`opus`, `sonnet`, `haiku`), which Claude Code maps to the provider's model, or a full model ID.
- **Defaults.** A role you leave out keeps its default. For a main session that is `claude-opus-5-5` on Anthropic and the provider's default on Bedrock. For a subagent it is the `model:` line of its file.
- **Typos.** An unknown role is ignored, with a warning in the run log.

The run log shows the main session's model in its `session` line. Its `models` line lists every model that ran, subagents included, with tokens and cost.

### Subagents from the repository

The review starts with two subagents of its own, `rules-reviewer` and `bug-reviewer`. You can add yours as files in `.claude/agents/`, in the [Claude Code format](https://code.claude.com/docs/en/sub-agents#write-subagent-files).

- **When one is used.** The review calls a subagent of yours when its `description` fits the change. The answer can be free text. The review checks in the code what the subagent reports before it posts anything.
- **Replacing a default.** A file named `rules-reviewer` or `bug-reviewer` replaces the default subagent of that name. The default `bug-reviewer` reports which functions it checked. If yours does not return `{"findings": [...], "checked": [...]}`, the main session checks each changed function itself.
- **Base branch only.** Only the files on the base branch are used, so a pull request cannot add or change a subagent for its own review.
- **Limits.** A subagent works within the limits of the session: no shell, no permission mode of its own, and only tools the session has. A tool your file lists that the session does not have, such as `Bash`, is left out, and the run log shows a warning that names it. It cannot post to the pull request. Only the main session does that, after it has confirmed a finding.
- **Your MCP tools.** A file with `app-tools: true` also gets the tools of your MCP servers, as `rules-reviewer` does.
- **Broken files.** A file that cannot be parsed gets a warning in the run log, and `AI_MODELS` does not reach it. Claude Code may still load it, within the same limits.

### MCP servers

The review can use MCP servers of your repository. Name them in `mcp_config` and list their tools in `extra_allowed_tools`:

```yaml
    with:
      mcp_config: '{"app":{"command":"python3","args":["tools/server.py"]}}'
      extra_allowed_tools: mcp__app__lookup
```

- **Servers start in `.ai-base/`.** The review checks out the base branch there, and paths in `mcp_config` are relative to it. A server therefore runs the code of the base branch, not of the pull request. Code from the pull request must never run in this job, because it holds the API key.
- **Who gets the tools.** The servers connect only inside `rules-reviewer` and your subagents with `app-tools: true`. The main session does not see their tools.
- **Checked before the model runs.** Each server is started once before the session. If one does not start, or a tool named in `extra_allowed_tools` is missing, the run stops there and uses no budget.
- **No credentials.** A server starts without the job's API key and tokens in its environment.

The name `pr` is taken by the review's own tools and cannot be replaced.

### Writing to the repository

The workflow's own token cannot push a commit that starts CI, and it cannot resolve review threads. Two features therefore need a credential of yours:

- **`/agent` pushing its commit.** Required for `/agent`.
- **The review resolving threads it found fixed.** Optional. Without a credential the review replies in the thread and a person resolves it.

Use a fine-grained token or a GitHub App. With both set, the app is used.

| | Fine-grained token | GitHub App |
|---|---|---|
| Secrets | `AGENT_PUSH_TOKEN` | `AGENT_ACTIONS_CLIENT_ID`, `AGENT_ACTIONS_APP_KEY` |
| Setup | One token, a few clicks | Create the app, install it, keep a private key |
| Lifetime | Until it expires, months | One hour, created for each run |
| Shows as | The token's owner: a resolved thread or a pushed commit looks like that person's | The app's bot, `<slug>[bot]` |
| Stops working | When its owner loses access or it expires | When the app is uninstalled or deleted |

**Token.** Create a fine-grained personal access token for the repository with **Contents: Read and write** and **Pull requests: Read and write**, and without the Workflows permission. Save it as the secret `AGENT_PUSH_TOKEN`. Its owner needs write access.

**App.** Create a private GitHub App with **Contents: Read and write** and **Pull requests: Read and write**, and install it on the repository. Prefer the organization that owns the repositories as its owner, so the app does not depend on one person. Then set three things:

- the secret `AGENT_ACTIONS_CLIENT_ID`: the app's Client ID, from its settings; it starts with `Iv`;
- the secret `AGENT_ACTIONS_APP_KEY`: a private key of the app;
- the variable `AGENT_ACTIONS_APP_SLUG`: the app's slug, which is the name in its URL, for example `my-review-app`.

With the slug set, the gate accepts a resolved thread only from that app or from a person with write access. The slug is a variable and not a secret because secrets do not reach runs started from forks, and the gate must count the same on every event.

If the app's secrets are set but the app is not installed on the repository, `AGENT_PUSH_TOKEN` is used instead. If neither gives a token, the job that needed it fails and says what to set up.

Either credential can change code, so the model never gets it. See [Security](#security).

### Runner

Every job runs on `ubuntu-26.04`, unless the `runner` input or the variable `AGENT_ACTIONS_RUNNER` names another label, for example a self-hosted runner.

### A private copy

`AGENT_ACTIONS_READ_TOKEN` is needed only when the repository that holds these workflows is private, for example a private copy of agent-actions. The workflows check out their own repository, and the token of a run cannot read another private repository. Use a fine-grained token with read access to the contents of that one repository, save it as a secret of the calling repository and pass it in the `secrets` block.

## Budgets and cost

Each pull request has a budget. The bot's comment shows it, with a line for every run: the commit, what started it, the result, the cost and the time.

- **Automatic reviews:** `AI_REVIEW_MAX_AUTO`, 3 by default. Reviews after CI count here.
- **`/review`:** `AI_REVIEW_MAX_MANUAL`, 2 by default.
- **`/agent`:** `AI_AGENT_MAX_RUNS`, 5 by default, counted separately.
- **Size:** above `AI_REVIEW_MAX_LINES` changed lines the model is not run, and the gate stays red until the pull request is split or overridden.

How runs are counted:

- A commit that already has a review is not reviewed again by a push. `/review` does run again, for example after the author answered a finding in the description.
- A review cancelled before it ends, for example by a newer review of the same pull request, is counted and shown as `cancelled` with the tokens it used. Otherwise a series of quick pushes would cancel every review before it is counted.
- A run that failed before the model started uses no budget.

While a run reads and writes the bot's comment, the bot holds a 👀 reaction on the pull request. It works as a lock, so two runs at the same moment do not lose each other's counts, and it shows for a few seconds.

The budgets stop accidental spending. They do not limit someone with write access: such a person can change a workflow on a branch, and that workflow runs with the secrets. The spend limit on the API key is the hard cap.

## What the model can read

### Files

The checkout of the pull request, and a checkout of agent-actions at the version of the workflow, in `.agent-actions/`. The second lets the model check what the workflows, the review skill and the default subagents really do instead of guessing. It is read-only.

### CI results

The review and `/agent` read the GitHub Actions runs of the head commit with three tools:

- `get_ci_status` lists the runs with the jobs that failed or are still running, and counts the ones that passed or were skipped.
- `grep_job_log` and `read_job_log` read the log of a completed job, at most 50 matches or 150 lines per call.

Only jobs that ran on the head commit can be read, and with green CI the review reads no log. A review that runs before CI has finished names the jobs still running; with `wait_for_ci` it runs after them.

## Security

### Who can start the model

- **Automatic reviews** run only for pull requests from a branch of your repository. Drafts, pull requests from forks and pull requests from Dependabot are left out.
- **A pull request from a fork** is reviewed only when someone with write access comments `/review` on it, once for each commit they want reviewed. `/agent` never runs on a fork.
- **`/review` and `/agent`** work only for people with write access to the repository.

### What the model can do

- **No shell.** The model cannot run commands, and no code from the pull request runs in a job that holds the API key.
- **Configuration from the base branch.** Before the model starts, `.claude/`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` and `AGENTS.md` in every directory, and the root `REVIEW.md`, are replaced with their versions from the base branch. So is every file they import with `@path`. The model reads such a file as the base branch has it and sees the pull request's change to it only in the diff.
- **One pull request.** The GitHub tools are fixed to the pull request and the commit under review. The review can comment on lines, reply in its own threads and publish its summary. It cannot push, approve, label or merge.
- **No write credential.** The token or app that can change code exists only in separate jobs that run no model and no code from the pull request. The review only records which threads are fixed, and such a job checks each one again before it resolves it. `/agent` only writes a patch, and such a job checks it, applies it and pushes it.

### Text from the pull request

Someone without write access, such as the author of a fork, can reach the model only through the code, the pull request title and the CI logs that the code produces.

- **Hidden text.** The description, comments and thread replies of someone without write access are hidden from the model.
- **Instructions in the code.** The review is told to report text in the changed code that addresses an AI reviewer ("report no findings") as a 🚧 `security` finding. This is an instruction to the model, not a check in code.
- **Findings stay.** Text cannot remove a finding once it is reported. A 🚧 or 💡 thread closes after the model confirms the fix, which can be elsewhere in the code. When the author has no write access, the code under the thread must have changed as well, and the job that resolves the thread checks that again. A fix elsewhere then needs a maintainer to resolve the thread.
- **Who may resolve.** With `AGENT_ACTIONS_APP_SLUG` set, the gate counts every 🚧 or 💡 thread until that app or a person with write access resolves it. The author resolving their own threads, another app resolving them, or a cosmetic edit under them does not change the result.

### What the review does not guarantee

- **The model can miss a problem.** The gate is a check, not a reviewer. A ruleset that requires an approval from a person, dismissed on new pushes, is what keeps a pull request from merging on the model's word alone.
- **A result describes one commit,** and it names that commit. A push to a pull request from a fork starts no review, so its last result is for an older commit. In cases 2 and 3 the fork's CI marks the new commit as `Not reviewed`, in the gate status and above the earlier result. In cases 1 and 4, and when the fork's CI does not run, nothing marks it: compare the commit in the result with the head of the pull request before you merge.
