# Review guidelines

Report, most important first:
1. Security: injection, secrets, unvalidated input, and anything that lets pull request content reach a token, a secret or a command.
2. Correctness: unhandled errors, and failures that let the gate pass or a run go uncounted.
3. Changes to workflow inputs and outputs: say which callers may break.

Skip: formatting, naming nits, anything a linter catches.
Each finding: file:line, what is wrong, a one-line fix.
If a changed behavior has no test, say so.

## Accepted risks

Decided by a person. Do not report these again, unless a change makes them worse.

- Someone with write access to a calling repository can bypass the review budgets by changing a workflow on a branch. Such a person can already run any workflow with the repository secrets. The hard cap on cost is the spend limit of the API key.
