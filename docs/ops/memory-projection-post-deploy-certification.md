# Post-deploy certification — `memory_projection`

**Status: NOT YET RUN. Production flag is `false` and must stay `false` until the app is deployed.**

This is the ordered proof to run **after** the Replit workspace is synced to a commit
containing the memory routes and scheduler. Every step has an explicit pass gate. If any
gate fails, **disable the flag immediately** (step L) and stop.

It is a document rather than a script on purpose: it writes to production, and an executable
that enables a production flag is one accidental invocation away from doing so unasked. The
repo's guard architecture (`ciSupabaseGuard`, `ciProdReadOnlyAuditGuard`) also deliberately
refuses production targets, and a script that opted out of that would weaken a control that
exists for good reason. Run these steps deliberately.

Project refs: **PROD `ajrurzioarfkagpuxfnb`**, CI `hwokxgbmezheskbzskfr`. Never run these
against CI expecting a production answer, or the reverse.

---

## Already proven before deploy — do not redo

Verified 2026-08-29 against production, all inside rolled-back transactions, zero residue:

| Precondition | Evidence |
|---|---|
| All 12 memory SQL functions deployed to prod | catalog query |
| First-pass backlog | **108 projections / 104 events** across 42 users (episodic 41, semantic 4, social 63) |
| Projector idempotent | second pass produced identical counts |
| All projections `visibility='private'` | 63 social rows additionally `sensitive` |
| Memory functions reachable by anon/authenticated | **0** |
| RLS on all 4 memory tables | enabled, **0 policies** → deny-default |
| anon/authenticated write attempt | **0 rows affected**, content unchanged (state-verified, not exception-verified) |
| No DB-side scheduler exists | `pg_cron` **not installed** — the app timer is the only driver |

Proven in CI (`test:memory-projection-lifecycle`, `memoryProjectionSchedulerTiming`): startup
delay, 6-hour recurrence, reschedule-after-throw, flag flipped ON mid-run is picked up without
a restart, double-start installs one timer, projection-before-sweep ordering, idempotency
across repeated and **concurrent** passes, blocked relationships never becoming memory, and
private-by-default.

---

## A. Confirm the deployed build contains the memory code

```bash
git log --oneline -1 origin/main
```

The Replit workspace must be synced to that commit or later. **The deploy source is the Replit
workspace, not GitHub** — a green GitHub main proves nothing about what is running.

**Gate:** you can name the commit the workspace was synced from.

## B. Confirm the routes are deployed — 401, not 404

```bash
for p in /api/compass/me/memory /api/compass/me/memory/rediscover /api/compass/recommendations; do
  echo "$(curl -s -o /dev/null -w '%{http_code}' -m 12 "https://portava.replit.app$p")  $p"
done
```

**Gate:** the two memory routes return **401** (exist, auth required). `/api/compass/recommendations`
is the control — it must also be 401, proving the compass router is mounted.

**404 on a memory route means the build predates the memory system. STOP — do not enable.**
This is exactly the state on 2026-08-29.

> Do not use the flag list as evidence. `/api/feature-flags` serves `memory_projection` already,
> because it reads flags from the **database**. It says nothing about the deployed code.

## C. Record the before state

```sql
SELECT flag, enabled, metadata, updated_at FROM public.feature_flags WHERE flag='memory_projection';
SELECT count(*) AS projections FROM public.memory_projections;
SELECT count(*) AS events      FROM public.memory_events;
SELECT now() AS t_before;
```

**Gate:** `enabled = false`. Record all counts and `t_before`.

## D. Enable via the intended control path

Use the admin surface, not a hand-written UPDATE, so the change is audited:

```
PATCH /api/admin/feature-flags/memory_projection   {"enabled": true}
```

Falling back to SQL loses the `feature_flag_audit_log` row. If you must, use
`toggle_feature_flag_with_audit('memory_projection', true, <your-user-id>)` — never a bare UPDATE.

```sql
SELECT flag, enabled, changed_at, old_enabled, new_enabled
  FROM public.feature_flag_audit_log WHERE flag='memory_projection'
 ORDER BY changed_at DESC LIMIT 1;
```

**Gate:** flag is `true` **and** an audit row exists.

## E. Let the SCHEDULER run it — do not call the projector

**Do not run `project_all_memory` by hand.** The whole point is proving the driver works.

Two ways to reach the first pass:

- **Wait** — the running process picks the flag up on its **next pass**, up to **6 hours** away.
  (`isFlagEnabled` is read fresh each pass, so no restart is required; CI proves this.)
- **Restart the app** — the first pass then lands **5 minutes** after boot. A restart is safe:
  a pass over unchanged inputs is a proven no-op, so restarting cannot duplicate state.

Watch for the log line, which only the scheduler emits:

```
"memory projection pass complete"   { projected, swept }
```

**Gate:** that line appears **without anyone invoking the RPC**. Record its timestamp as `t_pass`.

## F. Capture the lifecycle

```sql
SELECT count(*) AS projections, min(created_at) AS first_created, max(last_projected_at) AS last_stamp
  FROM public.memory_projections;
SELECT memory_type, count(*) FROM public.memory_projections GROUP BY 1 ORDER BY 1;
SELECT count(*) AS events FROM public.memory_events;
SELECT user_id, memory_type, subject_id, content, state, visibility, last_projected_at
  FROM public.memory_projections ORDER BY last_projected_at DESC LIMIT 10;
```

**Gate:** counts moved from step C's zero toward the predicted **~108 projections / ~104 events**.
A wildly larger number means the source data changed since this was measured — investigate before
continuing. `last_projected_at` must be ≥ `t_pass`.

## G. Idempotency / retry

Wait for the **second** scheduled pass (or restart again) and re-run F.

**Gate:** projection **count is unchanged** and row **ids are unchanged** — the second pass
updates in place, never duplicates. A growing count means the unique key is not holding.

## H. Negative case

```sql
-- a blocked relationship must never have become memory
SELECT count(*) AS should_be_zero
  FROM public.memory_projections mp
  JOIN public.blocks b
    ON (b.blocker_id = mp.user_id AND b.blocked_id::text = mp.subject_id)
    OR (b.blocked_id = mp.user_id AND b.blocker_id::text = mp.subject_id)
 WHERE mp.memory_type = 'social';
```

**Gate:** `0`. Blocked relationships must be absent from memory entirely — not merely filtered
at read time.

## I. Authorization boundary

```sql
SELECT count(*) AS anon_or_auth_executable
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname='public'
   AND (p.proname LIKE 'memory\_%' OR p.proname LIKE 'project\_%memor%'
        OR p.proname IN ('project_inferred_preferences','erase_memory_for_user'))
   AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));

SELECT count(*) AS leaked_visibility
  FROM public.memory_projections WHERE visibility <> 'private';
```

**Gate:** both `0`. Also confirm an unauthenticated `GET /api/compass/me/memory` returns **401**,
never data.

## J. Expiry / refresh

```sql
SELECT retention_class, count(*), min(valid_to) AS earliest_expiry
  FROM public.memory_projections GROUP BY 1 ORDER BY 1;
```

Semantic (`derived_preference`) rows carry a rolling 180-day `valid_to`; `durable_fact` rows
carry none. A same-day expiry proof is impractical — instead confirm the **sweep ran**
(`swept` in the step-E log line) and that `last_projected_at` advances on each pass, which is
the refresh half of the contract.

**Gate:** `valid_to` is null for durable rows and ~180 days out for derived preferences.

## K. Report

Record: flag before/after, `t_before` / `t_pass` / second-pass time, **observed scheduler delay**,
counts before and after, negative-case result, authorization result, and any residue.

## L. Rollback — if ANY gate failed

```
PATCH /api/admin/feature-flags/memory_projection   {"enabled": false}
```

Then, only if the projection produced unwanted rows:

```sql
-- per user, the supported erasure path
SELECT * FROM public.erase_memory_for_user('<user-id>');
```

Disabling the flag stops all future passes immediately — the projector self-checks it. Existing
rows are inert once the flag is off (retrieval is service-role-only and the routes are the only
reader).

**Leave `memory_projection` enabled only if every gate above passed.**

---

## Known operational characteristics

- **Scheduler delay is real**: up to 6 h without a restart, 5 min with one. Budget for it.
- **Multi-instance is safe but wasteful.** Concurrent passes cannot duplicate rows (unique keys)
  or falsely retract supported memory (each pass re-projects the full supported set before
  retracting) — pinned by CI. With N instances the DB does N× the work every 6 h. At 42 users
  and ~108 rows that is negligible. Revisit a lease/advisory lock if the first-pass row count
  reaches the high tens of thousands, or if passes stop completing well inside the 6 h window.
- **`memory_events` has no retention sweep of its own** beyond `expires_at`, which the projector
  does not currently set. The ledger grows with distinct (user, event, subject, occurred_at).
  Watch it after enablement.
