---
name: create-pr
description: Prepare a branch and create or update a pull request, including synchronization against the local base ref, required pre-commit hooks, and a concise risk-rated description.
---

# Create a pull request

Use this skill when asked to prepare or create a pull request. Follow the repository's contribution instructions and established tooling.

## Prepare the branch

- Inspect the current branch, working tree, remotes, and repository instructions before changing branch history or creating a PR. Preserve all existing user changes.
- Before creating the PR, update the PR branch against the existing local `origin/main` ref without fetching from `origin`. Prefer rebasing the branch, consistent with this repository's convention. Resolve conflicts carefully and preserve the branch's intended changes.
- If the local `origin/main` ref is missing or rebasing cannot be completed safely (for example, the working tree has unrelated changes, conflicts cannot be resolved, or updating a published branch would require a force push), stop before the risky operation and explain what is needed. Do not claim the local `origin/main` ref is up to date without evidence.
- Never bypass or disable pre-commit hooks. Do not use `--no-verify`, environment switches, or equivalent workarounds. Use the repository's normal commit flow so hooks run. If a hook fails, fix the underlying issue and rerun it; if it cannot be made to pass, do not commit or push the affected changes and report the failure.
- If hooks are not automatically run by the normal commit flow, find and run the repository's documented pre-commit command before committing or pushing. Do not invent a command or silently assume hooks passed.

## Write the PR description

Keep the description short and use only this structure:

1. Start with one or two sentences saying what changed and why.
2. Add a concise bullet list of the most important changes. Include only meaningful changes, with no more than 12 bullets.
3. End with one sentence giving merge risk on a 0–10 scale and a brief reason. Use 0 for negligible production risk and 10 for very high risk, such as a broad change to a heavily used database table. Base the score on the actual affected behavior, data, and deployment impact; explain whether the change appears safe to merge.

Do not add other sections or filler. Ensure the description matches the changes actually made and does not claim checks or hooks passed unless they did.
