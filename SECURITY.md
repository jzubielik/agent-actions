# Security policy

## Reporting a vulnerability

Report a vulnerability in private: open the **Security** tab of this repository and choose **Report a vulnerability**. Do not open a public issue or pull request for it.

Include the version (tag or commit) you use, the workflow file that calls agent-actions, and the steps that show the problem.

## Supported versions

Fixes go into the latest `v1` release. Older releases get no fixes.

## Scope

In scope is anything that lets a pull request, a comment or a file in the repository make the workflows do what the README says they do not do. Examples: the model gets a credential that can write, a change reaches a protected path, the merge gate shows a result for code that was not reviewed, a pull request from a fork starts a review on its own.

Out of scope are findings the review misses or gets wrong, and the cost of a review. Open a normal issue for those.

The protections and their limits are described in the [Security](README.md#security) section of the README.
