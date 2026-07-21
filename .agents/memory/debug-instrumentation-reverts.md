---
name: Debug instrumentation reverts
description: Never use `git checkout --` to strip temporary debug logs from files that carry uncommitted task edits.
---

Rule: when removing temporary debug instrumentation from a file you also edited for the current task, remove ONLY the instrumentation (exact string replace). Never `git checkout -- <file>`.

**Why:** `git checkout --` restores the last commit, silently wiping the task's own uncommitted edits along with the debug lines. This once erased a whole feature wiring mid-task; every subsequent test run then "mysteriously" failed (0 listeners, no effect logs) and hours went into re-diagnosing a component that simply no longer contained the code.

**How to apply:** instrument with unique markers (e.g. `DBG `), strip them with the same exact-string edit that added them, and confirm with `git diff --stat` that task edits are still present before continuing to debug.
