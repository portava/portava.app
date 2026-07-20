---
name: Merge-wave recovery checklist
description: What breaks after rapid task-merge waves and the safe repair order — drift-gate races, semantic type conflicts, orphaned ports.
---

# Merge-wave recovery checklist

After a burst of task merges lands (10+ in quick succession), expect up to three independent failure classes. Repair in this order.

## 1. Drift-gate FAIL may be transient — re-check before repairing
The post-merge hook's drift check can race overlapping merges: it compares mid-wave and reports files "out of date" that a sibling hook run (or the wave settling) already fixed. Hook stdout files in `/tmp/post-merge-setup.*.stdout` don't execute in merge-notification order.

**How to apply:** On a drift FAIL notification, first re-run `bash scripts/sync-standalone.sh --check-source` fresh. If it passes, the failure was a race — nothing to repair. If it still fails, **check drift direction before fixing**: the check output labels each file (`standalone is out of date` = canonical newer = safe to `--fix-source`). If any file is standalone-newer outside the ledger, an agent violated the canonical-only rule — port that work INTO canonical first, never blind-sync over it.
`--dry-run --fix-source` is a true preview (verified: prints "Dry run complete — no files were written").

## 2. Run canonical typecheck after every wave — semantic conflicts pass per-task validation
Two tasks can each typecheck green at their own base yet break main when merged: one changes a shared interface (API result shape, theme tokens), the other adds a consumer of the old shape. Task validation cannot see this; the post-merge hook does NOT typecheck (by design, budget). Main sits silently broken until someone runs it.

**Why:** exactly this happened — a consumer used `res.error` where the interface member is `message`, and spread a nonexistent type token. Both also degraded runtime silently (`?? fallback` always fired; `{...undefined}` no-op styling), so nothing crashed.

**How to apply:** after a wave settles, run the canonical full typecheck (`pnpm --filter @workspace/travel-buddy run typecheck` — includes the import-extension guard) and fix in canonical, then sync. Consider the same for api-server (`api-typecheck` workflow).

## 3. Orphaned port holders
Covered in [stale-port-after-merge-waves](stale-port-after-merge-waves.md): EADDRINUSE or an Expo Y/n port prompt = kill the orphan pid (check `ps -o etime` — orphans predate the workflow restart), then restart the workflow. Don't debug code.

## Final step
Re-run the post-merge pipeline (`runPostMergeSetup`) once everything is fixed so the NEXT merge's hook starts from a green environment.
