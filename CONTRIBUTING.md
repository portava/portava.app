# Contributing

## CI — GitHub Actions workflows

### Workflow self-reference convention

Every workflow that uses a `paths:` filter **must include its own file path** in every `paths` block.

```yaml
paths:
  - ".github/workflows/my-workflow.yml"   # ← always add this
  - "src/**"
```

**Why:** Without the self-reference, editing the workflow file itself (adding a step,
fixing a command, or changing an env var) does not re-trigger the workflow. New logic
runs only on the next unrelated commit that touches a watched path, silently skipping
the commit that introduced it.

**Reference:** none — and that is the current state, not an omission. This rule
linked `.github/workflows/sync-standalone-check.yml`, which has never existed on
this line of history. (It exists on `origin/main`, but `main` and this branch have
no merge base at all — `git merge-base origin/main HEAD` is empty — so nothing
there is a reference for anything here.)

The three workflows that do exist — `ci.yml`, `live-db.yml`, `unwired-checks.yml` —
use no `paths:` filter at all, so none of them is subject to this rule today. It
applies to the next workflow that adds one. Verified 2026-08-14 while archiving
`artifacts/travel-buddy`; `scripts/src/workflow-paths.test.ts` records the same
finding from the other direction, having retired 24 assertions that threw ENOENT
against those two non-existent workflow files.

## Testing rule — verify the resulting STATE, not the return value

**A successful call is not evidence that the intended side effect occurred.**

This is the single most productive rule to come out of the 2026-08-28/29 hardening
sweep. Every one of the following was a control that reported success and did
nothing, and every one passed the tests that existed at the time:

| Defect | The lie |
|---|---|
| `memory_feedback` accepted `kind='incorrect'` | route returned `201`; retrieval never suppressed on it |
| `memory_reset_for_user(p_memory_types)` | returned a category-scoped result; `... OR true` wiped the whole ledger |
| `2190`'s anon-grant postcondition | `LIKE 'memory\\_%'` (doubled backslash) matched nothing, so it passed by matching nothing |
| `rank_events` inserts in `rankLog` / `writeRankAnalyticAsync` | PostgREST rejections **resolve with `{ error }`**, they do not throw — the value was never read and the `catch` was empty |
| `loadPdeViewer` seen-set | the query returned rows, but they were `outcome='analytics'` rows for *scored* candidates, not impressions of *served* ones |

They share one shape: **the assertion was about the call, not about the world
afterwards.**

Concretely, when writing a test or a migration postcondition:

- **Assert the resulting state.** After a write, read it back and check it. After a
  suppression, query the read path and confirm the item is gone. `expect(res.status).toBe(201)`
  proves the handler ran, nothing more.
- **A passing assertion inside an aborted transaction proves nothing.** Observe from a
  SEPARATE connection — see `src/test/migrationDeployability.test.ts` for the incident
  that established this.
- **Prove the check can fail.** A guard that matches nothing, a predicate that is
  always true, and a correct guard are indistinguishable from a green run. Give every
  guard a negative case that fails when the defect is reintroduced.
- **`{ error }` is not an exception.** With PostgREST/Supabase, destructure and inspect
  `error`; a `try/catch` alone silently drops constraint violations.
- **Count, don't estimate.** `pg_stat_user_tables.n_live_tup` is a stale estimate; it
  reported 0 rows for tables holding real data.
