---
name: Stash reconciliation across a semantic rename
description: Restoring a stashed multi-day WIP wholesale can silently reintroduce an abandoned/superseded design that conflicts with what has since been merged upstream in the same file(s).
---

When resuming stashed work after other tasks have since merged to the same
files, do not restore stashed files wholesale with `git checkout stash@{N}
-- <path>`. Diff each restored file against current HEAD first
(`git show HEAD:<path>` vs the stash content). A stash can bundle together
multiple different attempts at the same underlying problem (e.g. two
different naming conventions for the same token group tried on different
days) — restoring it wholesale silently overwrites whatever convention was
actually merged with an older, abandoned one, which then only surfaces as
confusing downstream typecheck errors in unrelated-looking files days later.

**Why:** a stashed `tokens.ts` reintroduced a numeric `s<N>`-keyed avatar
scheme (with extra infill values) that had never actually merged, clobbering
the tier-letter (`xs`/`sm`/`smMd`/...) scheme that HAD merged in the
interim. The break only showed up as `Property 'sN' does not exist` errors
in ~20 consumer files, none of which were part of the current task's scope
— because the same stash also contained scattered, uncommitted edits to
those files from an earlier, different, unrelated pass.

**How to apply:** after any `git stash pop`/`checkout stash@{N} --`, run a
full typecheck before doing anything else. If it fails referencing symbols
that don't exist on the currently-merged version of a shared file (tokens,
shared types, etc.), suspect a stale competing design in the stash rather
than a normal merge conflict — diff stash vs. HEAD for that one shared file,
keep only the hunk for the feature you're actually finishing, and revert
everything else in it back to HEAD's current shape.
