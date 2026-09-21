# Trips production activation — evidence, handoff, recovery

Written 2026-09-17. Production is Supabase project `ajrurzioarfkagpuxfnb`; the
rehearsal database is `hwokxgbmezheskbzskfr` (portava-ci).

This document exists because the schema half and the application half of the
Trips cutover were verified in two different places. The database half is done
and verified here. The application half **cannot be verified from the Claude
Code container** and is handed to Replit below, with the exact checks to run.

---

## 1. State, kept separate

| state | Trips kernel schema | `trip_kernel_enabled` | `trip_operational_projections_enabled` |
|---|---|---|---|
| merged to main | yes | — | — |
| database-applied | **yes, 36 migrations** | — | — |
| kernel runtime-verified | **yes, 21/21 probes** | — | — |
| flag enabled | — | **no** | **no** |
| end-to-end runtime-verified through the API | **no — blocked, see §4** | no | no |

The same states for the §23 recurrence subsystem (2797/2798/2799), kept apart
because it is at a different point in the same pipeline:

| state | 2797 table | 2798 kernel family | 2799 fold |
|---|---|---|---|
| merged to this branch | yes | yes | yes |
| rehearsed on portava-ci | **yes** | **yes** | **yes** |
| applied to production | **no** | **no** | **no** |
| runtime-exercised (portava-ci) | **yes, see §8** | **yes, see §8** | **yes, see §8** |
| runtime-exercised (production) | no | no | no |

Data preserved throughout: **43 trips, 42 trip_members, 8 trip_plan_items**,
re-counted after 2590, after 2772 and at the end of the chain.

## 2. What was applied

36 files: `2450`, `2500`, `2590` (kernel ancestry), then `2764`–`2795`, then
`2796` (a repair, §5). Every one carries a `public.schema_migration_ledger` row
with `applied_by='manual'` and the real sha256 of the repo file.

**Faithfulness evidence.** Production's `trip_kernel_execute` body hashes to

```
4ce0b3e510f151e3e794dcc59e9af9bc790f1ff241464ea90311187783957dec
```

which is **byte-identical** to portava-ci, where the same chain is recorded
`applied_by='ci'` with checksums matching the repo files. 53 `trip*` tables on
both. 2795's own assertions independently pin the kernel to **66 command
branches and 44 family assignments**.

To re-check at any time:

```sql
SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex')
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public' AND p.proname='trip_kernel_execute';
```

**One transcription defect, found and fixed.** The container holds no database
credentials, so every file was hand-transcribed through an MCP SQL channel. The
first transcription of 2794 dropped three blank lines (the reading step filtered
empty lines), leaving the kernel 3 characters shorter than CI. Functionally
identical — every postcondition passed on the shorter text — but these
migrations match on *literal* text, so a future anchor would have missed. It was
caught by the CI-equality check above, repaired with a whitespace-only
transform, and recorded in 2794's ledger note.

## 3. Kernel runtime verification (done, on production)

21 probes inside a single rolled-back transaction against a QA trip, all PASS:

- **authorization** — non-member `ADD_STAGE` → `TRIP_AUTH_NOT_CREW`; user-role
  envelope issuing `ADMIN_HIDE_TRIP` → `TRIP_AUTH_ROLE_NOT_PERMITTED`
- **happy path** — owner `ADD_STAGE` → ok, `trips.version` 0 → 1
- **event / outbox / receipt** — exactly one `trip_events` row (filed under
  `family=stage`), one `trip_outbox` row, one `trip_command_receipts` row
- **idempotency** — replaying the key returns `duplicate=true` and writes no
  second event; a *different* actor reusing the key →
  `TRIP_AUTH_IDEMPOTENCY_KEY_FOREIGN`
- **optimistic concurrency** — stale `expected_trip_version` →
  `TRIP_VERSION_CONFLICT`
- **lifecycle** — `START_STAGE` planned→active, then again →
  `TRIP_STAGE_INVALID_TRANSITION`
- **presence** — setting another user's presence → `TRIP_PRESENCE_NOT_SELF`; own
  presence applies; a *delayed* observation → `applied=false STALE_OBSERVATION`
  (it does not move `observed_at` backwards under a fresh `expires_at`)
- **subgroup boundary** (the Safe Return dependency) — a non-crew member →
  `TRIP_SUBGROUP_MEMBER_NOT_CREW`; a crew-only subgroup is created
- **governance** — accepting a `majority` proposal with no votes →
  `TRIP_PROPOSAL_VOTE_NOT_MET` (the vote decides, not the closer)
- **replay determinism** — `trip_snapshot_write` then
  `trip_snapshot_verify_replay` → `equal=true`, `unfolded={}`

This verifies the kernel *function*. It does not verify the routes that call it;
that is §4.

## 4. HANDOFF TO REPLIT — the one thing this container cannot do

`portava.replit.app:443` is refused at the egress gateway with a **policy
denial** (`connect_rejected`, gateway answered 403 to CONNECT). This is not a
TLS or transient failure and cannot be worked around from here. **The running
API version is therefore unknown to me, and no Trips flag should be enabled
until it is known.**

Please run, on the Replit deployment:

1. **Identify the running build.** Confirm the deployed commit. The schema
   assumes main at or after `7d1b1690d`, plus branch
   `claude/portava-continuation-uqta94` for migration 2796.
2. **Confirm the run command actually in use.** `.replit` says
   `pnpm --filter @workspace/api-server run start`, and the file itself warns
   that the Replit UI overrides it. Confirm in the Deployments UI.
3. **Schema compatibility of the running build**, with live credentials:
   ```
   pnpm --filter @workspace/api-server run check:missing-live-columns
   pnpm --filter @workspace/api-server run check:write-path-columns
   pnpm --filter @workspace/api-server run audit:schema
   pnpm --filter @workspace/api-server run check:migration-ledger
   ```
   These exit 2 without credentials, which is "not run", not "passed".
4. **Live kernel test against production:**
   `pnpm --filter @workspace/api-server run test:trip-kernel-live`
5. Only if 1–4 pass, enable in this order, checking after each:
   1. `trip_operational_projections_enabled` → then GET
      `/trips/:id/freedom-windows`, `/health`, `/today`. These read fail-closed
      and probe the schema before use, so a wrong build answers
      `feature_disabled` rather than 500.
   2. `trip_kernel_enabled` → then create a plan item, edit it, and confirm a
      `trip_events` row and a `trip_outbox` row appear for it.
6. **Confirm workers are running** — the outbox drain and
   `lib/tripRetentionScheduler.ts`. `trip_outbox` currently holds 0 rows, so
   there is no evidence either way yet; after step 5.2 an undrained row that
   never clears means the worker is not running.

## 5. Repair applied during this verification (migration 2796)

2784 revoked `DELETE` on `trip_reservations` from `authenticated` *deliberately*
("clients cancel; only the service deletes") while keeping `INSERT`/`UPDATE` and
the `trip_reservations_owner_insert` / `_owner_update` policies. In the same
file it added the history trigger as an ordinary — therefore SECURITY INVOKER —
trigger, and granted `authenticated` only `SELECT` on
`trip_reservation_events`. The trigger appends *as the caller*, so every client
write 42501'd inside it and both owner policies were unreachable.

Measured as `42501 permission denied for table trip_reservation_events` on
**both** production and portava-ci. Latent, not an outage: the API server holds
the service role and `travel-buddy-standalone` has no direct
`trip_reservations` access at all, and production carries 0 reservations.

2796 makes the history trigger `SECURITY DEFINER` with `search_path` pinned.
After it, measured as role `authenticated` with JWT claims: INSERT succeeds,
history `created(v0)`; UPDATE succeeds, version → 1, history `confirmed(v1)`
with `changed_keys={status}`; `cancelled_at` coupling still set by the trigger;
forging a history row still refused 42501; `DELETE` on `trip_reservations` still
refused 42501. The two append-only guards stay SECURITY INVOKER.

## 6. Flags, and what each would actually do today

| flag | state | prerequisite | effect if switched on today |
|---|---|---|---|
| `trip_kernel_enabled` | false | deployed build must route through the kernel | unknown until §4 |
| `trip_operational_projections_enabled` | false | 2760–2762 (**applied**) | reads fail-closed; wrong build answers `feature_disabled` |
| `trip_retention_sweep_enabled` | false | `trip_activity_log_prune()`, `trip_reservations_forget_raw_text()` (**both exist**) | **deletes nothing.** 0 of 6 activity-log rows are past retention; earliest expiry **2027-07-03**. 0 reservations, 0 decisions |
| `trip_absence_guard_enabled` | false | `trips.show_exact_dates` (**exists**) | **changes nothing visible.** 0 public future trips |
| `safe_return_enabled` | **true** (pre-existing) | `trip_subgroups`, `trip_subgroup_members`, `safe_return_sessions.subgroup_id` — **all now exist** (2780, 2794) | the gap is closed at the storage layer |

The two retention-style flags carry **zero data risk today** — the "irreversible
deletion" caution has no subject. Their real gate is the same as the kernel
flags: whether the deployed build implements the behaviour. A flag whose code is
not deployed is inert, not dangerous.

## 7. Recovery

Every migration ran as **one transaction with its own postconditions**; a failure
rolled the file back whole, so there is no partial-file state to unwind.

- **Roll back the kernel function alone** (schema untouched): re-apply 2450,
  then 2500 and 2590's transforms, from `artifacts/api-server/src/migrations/`.
  The function is the only object the 276x–279x transforms mutate in place.
- **Roll back a table-creating migration:** each is `CREATE TABLE` plus grants;
  `DROP TABLE public.<name> CASCADE` reverses it. The tables added by this chain
  are listed in the ledger rows for 2760–2763, 2771, 2774, 2780–2782, 2784,
  2785, 2793, 2794.
- **The flags are the real kill switch.** With `trip_kernel_enabled=false` every
  write path is exactly what it was before the chain; the new tables have no
  writer and no client grants beyond `SELECT`.
- **Do not** roll back 2796 without also revoking `INSERT`/`UPDATE` on
  `trip_reservations` from `authenticated`, or the 42501 defect returns.
- Ledger query for what ran and when:
  ```sql
  SELECT filename, applied_by, left(checksum,12), notes
    FROM public.schema_migration_ledger
   WHERE filename ~ '^(2450|2500|2590|27[6-9][0-9])_' ORDER BY filename;
  ```

## 8. Runtime exercise on portava-ci, 2026-09-17

§3's 21 probes were the kernel as it stood. This section is the thing the owner
asked for next: **representative commands with controlled test data, covering
authorization, idempotency, event/outbox handling and projections** — run
against the rehearsal database, in three transactions that each ended in a
`RAISE EXCEPTION`, so portava-ci holds **no residue**: no users, no profiles, no
trips, no members, no events, no outbox rows, no receipts.

Why portava-ci and not production: production's kernel is byte-identical to the
one exercised here up to 2795 (prosrc sha256
`4ce0b3e510f151e3e794dcc59e9af9bc790f1ff241464ea90311187783957dec`, 66 command
branches, verified on both), but 2797/2798/2799 are deliberately NOT applied to
production, so the recurrence commands do not exist there. Exercising them on
production was not possible and creating controlled test users there was not
wanted.

**Fixtures.** Three real `auth.users` + `public.profiles` (owner, crew member,
outsider), a real trip, real `trip_members`. Worth recording: inserting a trip
auto-enrols its owner in `trip_members` through a trigger, so the fixture only
needed to add the crew member.

### Phase 1 — authorization, the happy path, event/outbox, idempotency, concurrency

| probe | result |
|---|---|
| outsider issues a crew command | `ok=false` `TRIP_AUTH_NOT_CREW` |
| plain crew issues `CANCEL_TRIP` (owner-only) | `ok=false` `TRIP_AUTH_NOT_OWNER` |
| unknown command type | `ok=false` `TRIP_COMMAND_UNKNOWN_TYPE` |
| crew issues `ADD_RECURRING_COMMITMENT` | `ok=true`, `version: 1`, `duplicate: false` |
| after one accepted command | `trips.version` 0→1, **1** event, **1** outbox row, **1** receipt |
| event type written | `trip.recurring_commitment_added` |
| **anti-bloat** | 1 recurrence row, `trip_commitments` **0 → 0** |
| replay: same `idempotency_key`, NEW `command_id` | `ok=true`, `duplicate: true`, **same** `result.id` and **same** `event_id` |
| after the replay | events **1**, outbox **1**, version **1**, recurrences **1** — all unchanged |
| stale `expected_trip_version` | `ok=false` `TRIP_VERSION_CONFLICT` |

The anti-bloat row is the §23 clause made observable: the rule written was
"every weekday 09:00 for 45 days", which is 33 occurrences, and it added
**zero** rows to `trip_commitments`.

### Phase 2 — the recurrence lifecycle, its refusals, tenancy, and the fold

| probe | result |
|---|---|
| `SKIP_RECURRENCE_OCCURRENCE` 2026-10-08 | `skip_dates = {2026-10-08}` |
| skip 10-15, then `UNSKIP` 10-08 | `skip_dates = {2026-10-15}` |
| `UPDATE_RECURRING_COMMITMENT` patch | `local_time` 10:00, `by_weekday {4}`; `freq` and `label` untouched |
| timezone `Mars/Olympus_Mons` | `TRIP_RECURRENCE_TIMEZONE_UNKNOWN` |
| 731-day range | `TRIP_RECURRENCE_RANGE_TOO_LONG`, `days: 730` |
| skip a date outside the rule's range | `TRIP_RECURRENCE_DATE_OUT_OF_RANGE` |
| patch `freq` to `fortnightly` | `TRIP_COMMAND_MALFORMED` |
| **trip A's command naming trip B's recurrence** | `TRIP_RECURRENCE_NOT_FOUND`; trip B's row **unchanged** |
| patch that moves ONE end past the cap | `TRIP_RECURRENCE_RANGE_TOO_LONG`, `days: 609` |
| `REMOVE`, then `REMOVE` again | first `ok=true`; second `TRIP_RECURRENCE_NOT_FOUND` |
| after `REMOVE` | trip A rules 0, **trip B rules 1**, `trip_commitments` 0 |

**Projections.** All five events this phase produced were folded through
`public.trip_snapshot_fold` in sequence: `unfolded` absent, both collections
byte-unchanged, and **outbox rows = events = 5** — 1:1, no gap, no duplication.
The stream was `recurring_commitment_added | occurrence_skipped |
occurrence_skipped | occurrence_restored | recurring_commitment_updated`.

The cross-trip probe is the one worth calling out: the kernel's `AND trip_id =
v_trip_id` is not decoration. A crew member of both trips could not reach trip
B's rule through trip A's command.

### Phase 3 — Safe Return and subgroup access boundaries, under real RLS

Run under `SET LOCAL ROLE authenticated` with a real `request.jwt.claims`, so
`auth.uid()` resolved and every policy was actually evaluated.

| viewer | `trip_subgroups` | `trip_subgroup_members` | `safe_return_sessions` | recurrence rules |
|---|---|---|---|---|
| subgroup member | 1 | 2 | **1** | 1 |
| crew, NOT in the subgroup | 1 | 2 | **0** | 1 |
| outsider (not on the trip) | 0 | 0 | 0 | 0 |

**State this precisely rather than as "subgroup boundaries enforced", because
the boundary is not where the phrase suggests.** `trip_subgroups` and
`trip_subgroup_members` both gate on `authz.is_trip_crew`, so a subgroup is
visible to the WHOLE CREW — a crew member outside it sees the subgroup and its
membership. What they cannot see is the session: `safe_return_sessions` carries
one owner-only policy (`srs_own`, `auth.uid() = user_id`), and the crew member
outside the subgroup read **0 rows**, as did the outsider. So `subgroup_id` on
that table is metadata for the notify path, **not a read grant**, and 2794
widened nothing about who can see a Safe Return session.

Also verified for all three viewers: a direct `INSERT` into
`trip_commitment_recurrences` as `authenticated` is refused `42501` (no grant),
and `trip_kernel_execute` is refused `42501` as well — `EXECUTE` is
`service_role` only. Every write goes through the API server; there is no client
write path to either.

### What this does NOT establish

- It is **portava-ci**, not production. Production has the same kernel through
  2795 and does **not** have 2797/2798/2799.
- Both flags were **FALSE** throughout; these probes call the kernel directly as
  `service_role`, which is what the API server does, but they do not exercise
  any HTTP route, worker or scheduled job.
- Nothing here answers §4's question, which remains the blocker: **which build
  is actually running on the Replit deployment.**


## 9. The four Memory flags — same handoff, same order of proof (added 2026-09-18)

Census `census-highlights-memories.md` §O.2 counts roughly thirty rows whose whole
blocker is one of four flags. All four are `false` in production
(`artifacts/api-server/src/lib/capability/snapshots/20260917-production-schema.json`,
`flags` block) and `false` on `portava-ci` (measured 2026-09-18). Their storage
IS applied to production (2338, 2339, 2710, 2711 — `production-applied-migrations.json`),
so the gate is the same one §4 names for Trips: **whether the deployed build is
the build that implements the behaviour**, which this container cannot see.

| flag | state (prod / ci) | prerequisite (storage) | effect if switched on today |
|---|---|---|---|
| `memory_kernel_enabled` | false / false | 2710 `memory_command_receipts`, `memory_command_audit`, `memory_domain_events`, `memory_event_outbox`; 2711 `memory_kernel_execute` — **applied** | every Memory write in `routes/memories.ts` routes through `memory_kernel_execute` instead of the direct write (`MemoryDomainService.ts`). Receipts, audit rows and domain events start being written; `memory_event_outbox` rows accumulate with `published_at NULL` because **nothing consumes the outbox** (`lib/memoryOutbox.ts`, certification invariant "CEILING: nothing consumes the outbox"). Not dangerous — an undrained outbox is inert — but the count will only ever grow until a consumer exists |
| `memory_location_precision_enabled` | false / false | 2338 `memories.location_precision` — **applied** | Memory reads and writes in `routes/memories.ts` start naming `location_precision`; the kernel's `CREATE_MEMORY` sets it only when the caller sends it. On a build older than 2338's code the column is never named and the flag is inert |
| `memory_public_feed_projection_enabled` | false / false | `memory_projections` (2183) — **applied** | `GET /memories` public feed serves the §18 projection table instead of the direct query (`routes/memories.ts` around the `useProjection` read). Rows that have never been projected disappear from the public feed until the projector has run — check `memory_projections` is populated before flipping |
| `highlights_feed_bounded_enabled` | false / false | 2339 flag row — **applied** | `GET /highlights/following-feed` gains a page (`limit` ≤ 200, default 60) and a `nextCursor`. Off, the feed is unbounded. No data risk |

**Note on what is NOT behind these flags.** The §10/§11 non-owner gate added
2026-09-18 (`services/highlights/highlightPublicProjection.ts`) and the Highlight
control writer (`PUT /highlights/resurfacing-controls`,
`PUT /highlights/:id/projection-policy`) are live the moment the build is
deployed; no flag guards them. A deployed build older than that commit has
neither the writer nor the gate.

Please run, on the Replit deployment, after §4 steps 1–3:

1. **Live kernel test against production:**
   `pnpm --filter @workspace/api-server run test:memory-kernel-transaction`
   (`memoryKernelTransactionLive.test.ts`; exits "not run" without credentials).
   It creates and cleans up its own fixture users and asserts the receipt,
   audit, event and outbox rows the kernel writes, and that a rejected command
   leaves nothing behind.
2. If 1 passes, enable in this order, checking after each:
   1. `highlights_feed_bounded_enabled` → `GET /highlights/following-feed?limit=2`
      returns at most 2 and a `nextCursor`.
   2. `memory_location_precision_enabled` → create a Memory with a
      `locationPrecision`, read it back as another user and confirm the clamp.
   3. `memory_kernel_enabled` → create a Memory, then confirm one
      `memory_command_receipts` row, one `memory_command_audit` row with
      `outcome='accepted'`, one `memory_domain_events` row `memory.created`, and
      one `memory_event_outbox` row. Repeat the same request with the same
      idempotency key and confirm `outcome='duplicate'` and no second Memory.
   4. `memory_public_feed_projection_enabled` LAST, and only after
      `memory_projections` is populated for the Memories that should be public.
3. **What was rehearsed on `portava-ci` (2026-09-18, rolled back):** the kernel
   sequence in 2.3 exactly — accepted → duplicate → `MEMORY_AUTH_NOT_OWNER` for
   a second actor, with the audit, receipt, event and outbox rows each counted —
   and the writer's contract on 2720/2721 under real RLS (owner-only read and
   write, `42501` for another user, vocabulary CHECKs). Census §P.4 has the
   transcript. `portava-ci` is not production; this is the rehearsal, not the
   verification.
