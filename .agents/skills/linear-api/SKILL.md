---
name: linear-api
description: Start work from a pasted Linear issue link by fetching the task, preparing its branch and worktree, marking it In Progress, commenting with the current thread reference, and planning implementation. Also read and update Linear through its GraphQL API using a local LINEAR_API_KEY.
---

# Linear API

Use the bundled Bun helper to send GraphQL requests to `https://api.linear.app/graphql`. It uses a personal API key as the raw `Authorization` header. No SDK or package installation is needed.

## Pasted task links

When the user pastes a Linear issue URL as a task handoff, including a bare URL, follow [references/task-start.md](references/task-start.md): fetch the issue and suggested branch name, verify the repository and worktree (including T3 Code when observable), prepare the branch, mark the task In Progress, add a comment with the current thread ID and a verified link when available. Plan it and implement it. The user has requested these two Linear updates as part of task startup; perform them without another confirmation. A link supplied only for a summary, discussion, or another explicit purpose does not trigger this startup workflow or its writes.

## Credentials and execution

The main Mindgrab checkout's `.env` already contains `LINEAR_API_KEY`. Reuse that file. When in the main checkout, run with `bun --bun --env-file=.env`. When in a linked worktree, pass the absolute path to the main checkout's `.env` (resolve the main checkout root with `git worktree list --porcelain` if needed). Bun loads `LINEAR_API_KEY`; an already exported variable takes precedence, so unset a stale exported key if it selects the wrong workspace. Never print or source `.env`, put the key in command arguments, or copy it into skill files. If the main checkout's `.env` is unavailable or the key is missing, ask the user to set `LINEAR_API_KEY` locally rather than paste it into chat.

Resolve the helper at `.agents/skills/linear-api/scripts/linear.ts` from the repository root. The helper accepts a JSON request file or `-` for stdin. Use a quoted heredoc to preserve GraphQL `$variables` and avoid shell expansion:

```bash
bun --bun --env-file=.env .agents/skills/linear-api/scripts/linear.ts - <<'JSON'
{"query":"query { viewer { id name } teams(first: 50) { nodes { id key name } pageInfo { hasNextPage endCursor } } }"}
JSON
```

Request fields are `query`, optional `variables` (an object), and optional `operationName`. Use variables for user-provided text and IDs. For larger requests, write a JSON file and pass its path. Do not enable Bun's verbose fetch logging, which exposes authorization headers.

## Working with Linear

- Resolve the intended workspace, team, issue, project, user, and team-specific workflow state before writes. Use returned IDs instead of guessing names or states. Ask only when the target or requested change is materially ambiguous.
- For a known issue identifier, query `issue(id: $id)` with a `String!` variable (for example `ENG-123`). Select useful fields such as `id identifier title description url state { id name }`.
- Use bounded connections (`first: 50`) and `pageInfo { hasNextPage endCursor }`; pass the cursor as `after` until the requested scope is covered. Do not present one page as a complete result.
- Execute mutations only within the user's requested scope. Task startup includes the status update and thread comment authorized above; other comments require an explicit request. Existing authorization to create or update an issue is sufficient; installing, editing, or testing this skill alone does not authorize live changes.
- For issue creation use `issueCreate(input: $input)` with `IssueCreateInput!`. For updates use `issueUpdate(id: $id, input: $input)` with `String!` and `IssueUpdateInput!`. Request `success` and the resulting `issue { id identifier title url }`, and check `success` before reporting completion.
- The helper prints JSON and exits nonzero for HTTP failures or GraphQL errors, including partial failures returned with HTTP 200. Inspect errors and partial data before proceeding. It makes one attempt with a 30-second timeout and does not automatically retry. After an uncertain mutation outcome, read the target to establish whether the change happened before considering another attempt. For throttling, honor `Retry-After` when present and stop if the next attempt is also throttled.
- Report useful results and issue links; never include credentials.

Consult [Linear's API guide](https://linear.app/developers/graphql) or use targeted GraphQL introspection when fields, filters, or mutation inputs are uncertain. The API supports introspection; avoid dumping the entire schema when a single type suffices. See [rate limits](https://linear.app/developers/rate-limiting) for throttling behavior.
