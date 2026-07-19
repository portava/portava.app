---
name: Task validation diff scope
description: Completion review/validation sees other tasks' merged commits as part of your diff; fix their fallout to unblock.
---
The completion code review and validation run diff/test against the task's base commit, not your local changes. Commits merged from other tasks after your base appear as *your* diff, and their broken tests block your validation.

**Why:** A no-op task was rejected twice for regressions (stale tests, deleted Expo routes) introduced by other tasks' merges.

**How to apply:** When validation fails on code you didn't touch, don't revert — repair the stale tests/routes on main (align tests to the current route contracts; restore legacy Expo Router redirect stubs when screens move) and re-run the full suite locally before marking complete.

Known manifestations beyond stale tests:
- Merged partial work from a since-cancelled task importing an undeclared npm package → typecheck fails for every subsequent merge. Fix: add the missing dependency; the merged code itself cannot be trimmed from the diff.
- Reviewer flags a functional regression from another task's merged commit and rejects until it's fixed in *your* tree. Fix it surgically, add targeted tests, and explain the diff-scope situation in `drift_reason`.

If a validation run hangs (a workflow stuck RUNNING with a stale log for 10+ min): find the stuck child test process via `ps`, confirm the file passes in isolation, then cancel + restart the attempt with `markTaskComplete({ request_fresh_code_review: true })` — transient hangs (e.g. port contention under parallel validation) clear on rerun.
