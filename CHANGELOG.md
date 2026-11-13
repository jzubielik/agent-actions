# Changelog

## v1.0.0 - 2026-11-13

First release.

- `review.yml`: review of a pull request by an agent session, with comments on the changed lines, a result in the description and the `AI review / Merge gate` commit status.
- Four ways to start the review: on every push, after CI, on every push and again when CI fails, only on demand. `/review` starts one by hand.
- CI results and job logs as input of the review.
- A budget of reviews for each pull request, a size limit, and the `ai-review-override` label.
- `agent.yml`: the `/agent` comment command. The model runs without a credential that can write; a separate job checks its patch and pushes it.
- Configuration from the calling repository: rules, skills, subagents, models and MCP servers, taken from the base branch.
- Pull requests from forks are reviewed only when someone with write access asks.
