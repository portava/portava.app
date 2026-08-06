---
name: Workflow count limit forces consolidation
description: Replit workspaces cap out at 10 total workflows (including artifact-managed ones); adding one back after a "swap" often requires merging others first.
---

The workspace-wide workflow limit is 10, and it counts artifact-managed
service workflows (e.g. `artifacts/api-server: API Server`) toward that cap,
not just ad-hoc validation workflows. Removing N old workflows before adding
a new one does not guarantee headroom — if the project already has many
single-purpose validation workflows, you can still be over budget after a
2-for-1 swap.

**Why:** discovered when trying to drop two duplicate mobile-test/mobile-typecheck
workflows and restore a third (`check-test-registration`); after removing the
two duplicates the workspace was still at 13/10 because of pre-existing
single-purpose check workflows (frozen-dir, async-handlers, write-path-columns,
missing-live-columns, standalone-test, standalone-typecheck, etc.).

**How to apply:** when a new workflow won't fit, look for existing
single-purpose validation workflows that can be merged into one shell script
that runs each check labeled and sequentially (continue past failures, track
a `FAILED` flag, print clear `✔ PASSED: <label>` / `✘ FAILED: <label>` per
step, exit non-zero overall if any step failed). This preserves every check
and full diagnosability — the merge only reduces workflow *entries*, not
checks run. Confirm the exact list of checks to merge with the user before
doing it, since it changes how they see validation status in the workflow
list.
