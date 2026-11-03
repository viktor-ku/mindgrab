---
name: create-pr
description: Prepare a branch and create or update a pull request, including synchronization against the local base ref, required pre-commit hooks, and a concise risk-rated description.
---

# Create a pull request

Use this skill when asked to prepare or create a pull request.

## Prepare the branch

- Never bypass or disable pre-commit hooks. Do not use `--no-verify`, environment switches, or equivalent workarounds. Use the repository's normal commit flow so hooks run. If a hook fails, fix the underlying issue and rerun it; if it cannot be made to pass, do not commit or push the affected changes and report the failure.

## Write the PR description

Keep the description short and use the following structure:

1. Start with 1-2 sentences saying what was the purpose of this piece of work.
2. Add a concise bullet list of the most important changes. 1-5 bullet points is expected.

## Recordings

When asked to provide a screenshot or a demo recording, do so with upload via new `gh` CLI method or a t3 browser from the user perspective. Never create new branches for it, never plainly add demo files as git tracked files either.