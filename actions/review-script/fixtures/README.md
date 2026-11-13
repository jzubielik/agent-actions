GitHub GraphQL responses for the review-thread query in `bot_threads`, in the shape that
`gh api graphql` returns, so the tests check the query's `--jq` against that shape and not one
written by hand. Identifiers and comment text are placeholders.

- `review-threads-note.json`: a 📝 thread resolved by this action's app, and a thread that is not this action's.
- `review-threads-important.json`: four 💡 threads resolved by the app, one of them not outdated.

`resolvedBy` is a `User` in GitHub's schema even for apps, whose login is `<slug>[bot]`.
