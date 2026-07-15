---
name: Task validation diff scope
description: Completion review/validation sees other tasks' merged commits as part of your diff; fix their fallout to unblock.
---
The completion code review and validation run diff/test against the task's base commit, not your local changes. Commits merged from other tasks after your base appear as *your* diff, and their broken tests block your validation.

**Why:** A no-op task was rejected twice for regressions (stale tests, deleted Expo routes) introduced by other tasks' merges.

**How to apply:** When validation fails on code you didn't touch, don't revert — repair the stale tests/routes on main (align tests to the current route contracts; restore legacy Expo Router redirect stubs when screens move) and re-run the full suite locally before marking complete.
