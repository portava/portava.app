---
name: Git branch can be swapped mid-session by another process
description: A concurrent session/process silently checked out a different branch mid-task, landing a commit on the wrong branch tangled with unrelated work.
---

In this repo, many parallel task-agent branches continuously merge into `main`, and something in that
pipeline can silently `git checkout` a *different* branch in the same working tree while you are mid-task —
not triggered by you. A commit made without checking `git branch --show-current` right before `git commit`
can land on the wrong branch, entangled with unrelated concurrent work (e.g. a storage/schema migration).

**Why:** discovered via `git reflog` / `git branch -vv` after a batch of test files ended up on a
`staging-boundary-*` branch instead of the intended `bughunt-*` branch. Oddly, some of the stray commit's
files were byte-identical to files already on the other branch — suggesting an uncommitted working-tree
file can also get scooped up by a background process before you commit it.

**How to apply:** before and after any subagent dispatch or long-running operation, and immediately before
every `git commit`, run `git branch --show-current` and confirm it matches what you expect. Commit each
logical unit promptly rather than batching many changes uncommitted. If a commit lands on the wrong branch:
reset that branch back to its remote tracking ref (removing the stray commit), check out the correct branch,
extract the affected files' content via `git show <stray-commit>:<path>`, rewrite them into the working tree,
verify, and commit fresh on the correct branch.
