# Start a Linear task

Turn a pasted issue link into an isolated checkout and a concrete implementation plan. As requested by the user, task startup also marks the issue In Progress and posts the current thread reference in a Linear comment, without another confirmation. It does not authorize implementation, pushing, opening a PR, or changing the assignee. If the user also requests implementation, finish preparation and planning, then continue within that request. Honor an explicit read-only or no-Linear-updates instruction.

## Resolve the task and repository

- Read applicable `AGENTS.md` instructions and inspect the current repository, remotes, branch, working-tree status, and registered worktrees. Confirm the repository fits the issue; a Linear project name alone is not a repository mapping. If the target is ambiguous, fetch the task and ask which repository before changing Git state.
- Extract the issue identifier from the URL, fetch the actual issue, and verify the returned identifier and workspace URL match. Do not infer requirements from the URL slug. Use the API helper and credential handling in the parent skill; an available Linear connector is also suitable if it returns the needed fields.
- Fetch `identifier`, `title`, `description`, `url`, `branchName`, `state`, `team`, and `project`. Read relevant comments, parent/sub-issues, or linked requirements when needed to resolve scope. If access fails, report the blocker; do not invent the task or branch format.

Example request, with the identifier replaced by the one from the user's link:

```json
{
  "query": "query TaskStart($id: String!) { issue(id: $id) { id identifier title description url branchName state { id name type } team { id key name } project { name } } }",
  "variables": { "id": "ENG-123" }
}
```

If a linked worktree lacks `.env`, use an absolute path to the existing credential file in the original checkout. Do not copy secrets into the worktree.

## Verify the worktree and T3 Code context

Run these in the actual working directory:

```bash
git rev-parse --show-toplevel
git rev-parse --absolute-git-dir
git rev-parse --path-format=absolute --git-common-dir
git status --short --branch
git worktree list --porcelain
```

Match the resolved checkout root to the worktree listing. A linked worktree has its own Git directory separate from the common Git directory. `--is-inside-work-tree` alone also returns true in the main checkout and does not establish isolation.

In T3 Code, inspect exposed current-thread workspace/branch metadata or supported controls if available. A path under `~/.t3/worktrees/` is a useful clue, not proof of the active thread's attachment. Report Git worktree verification separately from T3 attachment verification. Do not modify T3's private database or state files to rebind a thread.

- Reuse the issue's existing worktree when it is suitable and is not occupied by another active task. Do not switch branches underneath another thread or process.
- If already in a suitable isolated worktree for this task, use it. A fresh T3-generated branch can be renamed locally to the Linear name when it is clearly this task's disposable, unpublished branch and the destination does not exist. Verify the T3 branch display through supported controls when available; a Git rename alone does not prove T3 metadata changed.
- If in the main checkout or an unrelated task's worktree, prefer a supported T3 worktree action when exposed. Otherwise create a regular Git worktree using the project's established location convention and use its absolute path for every subsequent command and edit. Do not claim this changed the T3 thread's workspace.
- If T3 attachment cannot be controlled or verified, still complete safe Git preparation and read-only planning. Report the prepared path and the attachment limitation. T3's documented UI offers **New worktree** for a new task and **New thread in this worktree** to use an existing one; labels may differ by installed version.

## Prepare the Linear branch

Use the issue's returned `branchName` exactly by default: it reflects Linear's configured suggestion. Honor an explicit repository naming rule where present while retaining the complete issue identifier. If `branchName` is unavailable, use a demonstrated repository convention with the full identifier and a short title slug, or `<lowercase-identifier>-<title-slug>` if none exists. Identify this as a fallback rather than Linear's returned name. Validate with `git check-ref-format --branch` and quote shell arguments safely.

Inspect local and remote branches and worktrees before creating anything:

- Reuse an existing branch for the same issue instead of creating duplicates on every pasted link. If it is checked out elsewhere, use that worktree only when suitable; never force a second checkout or steal a busy checkout.
- Fetch the relevant remote to get a fresh base. Resolve the base from repository instructions or the remote default branch, not an assumed `main` or the current unrelated feature branch. Create a new issue branch from that base, or track the existing remote issue branch when resuming work.
- Prefer rebase over merge when an existing task branch needs updating. Preserve dirty files and existing commits; do not auto-stash, reset, force-rename, or discard work to make setup succeed. If fetching or updating is blocked, continue useful read-only planning and report the precise setup limitation.

Typical creation from a resolved base, with safely populated shell variables:

```bash
git worktree add -b "$issue_branch" "$task_worktree" "$base_ref"
```

Recheck the actual path, branch, and status after setup. Including the issue identifier enables PR linking when the repository's Linear–GitHub integration is configured; creating a local branch does not prove that synchronization is enabled or has occurred.

## Mark started and record the thread

After verifying the task and preparing its checkout, perform these updates before presenting the plan. If setup is blocked before work can start, report that limitation without claiming the task has started.

### In Progress status

Resolve the issue team's workflow states using a bounded, paginated query. Select the state whose name matches `In Progress` case-insensitively. If there is no exact match, use the team's sole state with type `started`; if there are multiple candidates or none, ask which status to use while continuing independent local work. Never reuse a state ID from another team. Skip the mutation if the issue is already in the target state. Do not reopen a completed or canceled issue unless reopening is requested.

Use `issueUpdate` with the resolved issue ID and `stateId`; request `success` and `issue { id identifier state { id name } }`, and verify the returned state before reporting success. See [Linear's update example](https://linear.app/developers/graphql) for the mutation shape.

### Thread comment

Obtain the current thread ID from exposed current-thread metadata or an explicitly provided current-session environment value. In T3 Code, prefer its current conversation ID and verified thread URL when available. A provider session ID and a T3 thread ID may differ; label the source accurately and include both when useful. Do not infer a thread ID from the worktree suffix or use an unrelated recent session.

Include a clickable thread link when the host exposes one or its URL format is verified; do not invent an application deep link. If only the ID is available, post that ID with the host/provider name. If no trustworthy ID is available, ask for the current thread ID or URL while continuing local work; leave the comment pending instead of posting a placeholder. The status update can still proceed independently.

Read the issue's comments with pagination before posting. If a comment already records this same thread ID, reuse it and skip creation. A different thread working on the same issue gets its own reference. Keep the comment concise, for example:

```markdown
Task started in T3 Code.
Thread ID: `actual-thread-id`
[Open thread](verified-thread-url)
```

Replace the example values with verified values and omit the link line when unavailable. Use `commentCreate(input: $input)` with `CommentCreateInput!`, passing the resolved `issueId` and Markdown `body` as variables. Request `success` and `comment { id body }` and verify success. The [Linear comment schema](https://github.com/linear/linear-node-sdk/blob/master/schema.md#commentcreateinput) describes the input fields; use targeted introspection if the live schema differs.

Apply the parent skill's uncertain-outcome and retry handling separately to each mutation. After a timeout or partial failure, reread the issue state or comments before retrying; do not repeat a successful status update or create a duplicate comment. Report partial completion and continue authorized local work when a Linear write fails.

## Plan from the description and code

Read the relevant implementation, existing tests, and project commands in the selected checkout before proposing changes. Use `bun --bun` for this user's JavaScript/TypeScript commands and follow repository-specific instructions.

Present the issue link/title and concise requirements, confirmed checkout path and branch, and T3 verification result when relevant. Report the actual Linear status and whether the thread comment was created, already present, or blocked; include the recorded thread ID/link. Give an actionable plan tied to the affected code, acceptance criteria, meaningful verification, and any unresolved decisions. Distinguish task requirements from your assumptions. Ask only questions that materially affect scope or approach, and continue independent investigation while answers are pending.

Stop at the plan for a bare link or planning request. Do not imply that describing the workflow switches the host application into a special Plan mode. For a combined planning-and-implementation request, proceed with the authorized implementation.

Sources for integration behavior and T3 UI guidance: [Linear GitHub integration](https://linear.app/docs/github), [T3 Code threads](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md).
