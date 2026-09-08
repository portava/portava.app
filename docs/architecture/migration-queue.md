# Live migration queue

Sequential, dependency-ordered. **Nothing is batch-applied**; each row completes
its gate before the next begins. Updated as rows land.

`prod ✓` = applied to production `ajrurzioarfkagpuxfnb`.
`ci ✓` = applied to portava-ci `hwokxgbmezheskbzskfr`.

**Applied-ness re-read from `supabase_migrations.schema_migrations` on
2026-09-08**, not carried forward from this file. Rows 5-10 and 12 were still
marked `queued` or `in progress` here while production had already had them for a
day — the queue was describing work that was done. Their `Post-check` column now
says "not re-run by me": the migrations landed in an earlier session and I have
verified only that the ledger records them, not that their own postconditions
passed. Row 11 is the exception; its whole gate is mine and is described there.

`2335` and `2510` were applied on 2026-09-08 (`20260908104231` / `20260908104255`)
under the same gate as row 11 — see the Layover row of the blocker ledger for the
before/after measurement. Still not applied to production: `2411`, `2450`,
`2500`, `2600`. Of those, `2411` was MEASURED and found OPTIONAL (30 rows, all
unkeyed, nothing to preserve) and `2600` encodes the open `EVENT_START_TRANSITION`
owner decision — neither is a backlog item.

| # | Migration | Depends on | CI | Prod pre-check | Applied | Post-check | Result |
|---|---|---|---|---|---|---|---|
| 1 | `2460` meetup self-invite defuse | 2182 (authz) | ✓ | owner=postgres, no FORCE RLS, `mi_own` FOR ALL, 5 policies | **prod ✓** | in-transaction; inertness re-verified on CI (still 42P17) | **applied** |
| 2 | `2461` meetup recursion repair | **2460** | ✓ | `mi_own` WITH CHECK requires an invite | **prod ✓** | self-proving: reads all 4 tables as `authenticated` inside the transaction | **applied** |
| 3 | `2462` vote write boundary | **2461** | ✓ | non-service read of votes must not raise | **prod ✓** | self-proving: unadmitted INSERT must return 42501 | **applied** |
| 4 | `2334` route-plan crew visibility | 2182 | ✓ | authz present, 4 route tables, `trip_members.status`, **13 policies** | **prod ✓** | 5 routed through helper, 0 referencing `trip_members`, 13 policies | **applied** |
| 5 | `2337` crew RLS convergence (29 policies / 19 tables) | **2334** | ✓ | applied from the file's exact bytes, not retyped | **prod ✓** `20260907185750` | not re-run by me | **applied** |
| 6 | `2530` highlights `trip_only` | **2337** (`shares_accepted_trip`) | — | before-state captured: the `tm1 JOIN tm2` self-join is live | **prod ✓** `20260907223359` | not re-run by me | **applied** |
| 7 | `2531` crew_session owner-only | — | — | before-state captured: `auth.uid() = ANY(allowed_member_ids)` is live | **prod ✓** `20260907190129` | not re-run by me | **applied** |
| 8 | `2532` pg_policies snapshot v2 | — | — | diagnostic only | **prod ✓** `20260907222834` | not re-run by me | **applied** |
| 9 | `2533` drop `shares_trip_with` oracle | — | — | zero app callers verified repo-wide | **prod ✓** `20260907222934` | not re-run by me | **applied** |
| 10 | `2534` `can_see_trip` status gate + checklist write boundary | **2337** | — | 17 dependent policies enumerated | **prod ✓** `20260907223139` | not re-run by me; its repair of `trip_reminders_insert` was DECORATIVE until 2535 landed | **applied** |
| 11 | `2535` trip_reminders write boundary | **2534**, `authz.is_trip_crew` | **ci ✓** | 2 policies, `trip_reminders_own` FOR ALL / with_check NULL, 0 rows, deps present | **prod ✓** `20260908103147` | 4 policies, 0 FOR ALL, 0 write policy without WITH CHECK, 0 gating on the read predicate — re-run independently after apply; live smoke returns **42501**, not 23503 | **applied 2026-09-08** |
| 12 | `2420` trip kernel foundation | **2334 → 2337** | ✓ | production has no `trips.version` | **prod ✓** `20260908005403` | not re-run by me | **applied** |
| 13 | `2551` revoke EXECUTE on `increment_hashtag_usage_count` | none (a grant, not a schema object) | **ci ✓** rehearsed end-to-end | 0 of 808 policies reference it; no function body, view, trigger or `src/` string literal names it; `hashtags` RLS write policy is `FOR ALL USING (false)`, so the definer function is the ONLY write path a user token has; `hashtags` holds 0 rows | **prod ✓** `20260908114134` | re-read independently after apply: acl `{postgres,service_role}`, `has_function_privilege` anon=false authenticated=false service_role=true, and an actual call as `authenticated` returns **permission denied for function**; `upsert_hashtag_usage_and_increment` EXECUTE still true; 0 rows seeded | **applied 2026-09-08** |
| 14 | `2741` layover `returning` status + `safe_return_aborted` ledger type | none (widens two CHECKs on 0127 tables) | **ci ✓** applied, second-applied, rolled back, re-applied | status check was (active, completed, cancelled, expired); event_type carried 18 values; 5 sessions (2 cancelled, 3 expired, 0 active), 42 events; flag ABSENT; RLS on both, 2 policies, 44 grants | **prod ✓** `20260908133347` | independent re-read: status domain is exactly the 5 intended values, event_type 19; `returning` and `safe_return_aborted` ACCEPTED, `bogus`/`bogus_event` REJECTED 23514, all inside a transaction that was ROLLED BACK so no production row was written; sibling CHECKs (comfort_level, flight_type) byte-identical; RLS/grants/policies unchanged; 5 sessions / 42 events before and after | **applied 2026-09-08** |
| 15 | `2710` memory command kernel tables | none (4 new tables; `memory_events` collision avoided by rename) | **ci ✓** `20260908142429` | 14 object names enumerated and all free on CI; the one real collision is documented — `public.memory_events` EXISTS on CI and in production as a DIFFERENT table (the §4/§15 projection ledger, 12 columns) that ten migrations and the deletion cascade build on, so 2710's original name would have hit `CREATE TABLE IF NOT EXISTS` and been SILENTLY SKIPPED; renamed to `memory_domain_events` | **not applied to production** | applied bytes re-read from `supabase_migrations.schema_migrations` and md5'd against the file on disk (`c69d15c9af9c319730a25abe6930900e`); own postconditions ran inside the apply | **ci only** |
| 16 | `2711` memory kernel execute | **2710** | **ci ✓** `20260908142652` | same enumeration | **not applied to production** | stored statement md5 `e84267cad3f1b49c0f9c85addadfa4f0` = file on disk; transaction rollback PROVED by fault injection (a `BEFORE INSERT` trigger on the outbox), with a control run that commits when the fault is removed, and an outbox identity gap as physical corroboration | **ci only** |
| 17 | `2700` layover certified computations | none (creates 1 table, alters nothing) | **ci ✓** `20260908145925` applied, second-applied, rollback-rehearsed | 4 object names (`layover_certified_computations`, its pkey, `layover_certcomp_session_idx`, `layover_certcomp_session_hash_uidx`) and the policy name all FREE on CI; `layover_recommendations` carries no `engine_version`/`input_hash` (the co-toucher postcondition would have aborted); `gen_random_uuid` present; `layover_sessions` PK `id`, 0 rows | **not applied to production** — read-only listing of production's `public` schema on 2026-09-08 confirms the table is absent | stored statement md5 `2f7199c11bea8903f80b7da660781164` **equals** `printf '%s' "$(cat 2700….sql)" \| md5sum` — the applied bytes are the committed bytes, not a retyped copy. Independent re-read: RLS on, exactly 1 policy (`layover_certcomp_owner_read`/SELECT), anon holds NOTHING and authenticated holds SELECT only, service_role full, unique index present, 0 rows, `layover_recommendations` still 22 columns. Second apply inside a ROLLED-BACK transaction: all postconditions passed — unlike 2711, no postcondition asserts the table is empty, so it stays re-appliable after use. Rollback rehearsed the same way: 4 relations → 0, 1 policy → 0, grants → 0, `layover_recommendations` unchanged | **ci only** |
| 18 | `2740` layover presence ladder flag | none (one `feature_flags` row) | **ci ✓** `20260908150439` applied, owner-flip survival and rollback both rehearsed | flag row ABSENT on CI; `feature_flags` has 86 rows and the two other layover flags are FALSE; the file's own precondition (the table exists) holds | **not applied to production** | flag seeded FALSE, 86 → 87 rows, the other two layover flags byte-identical. **Owner-flip survival PROVED, not assumed**: the file says its postcondition deliberately omits `enabled = FALSE` so "a later owner flip is an owner decision this migration must survive being re-run over" — flipped ON, re-ran the migration, flag STAYED ON, postcondition passed. **Rollback rehearsed counting the whole table, not just the target row**: residue for a flag migration is OTHER FLAGS, and a `DELETE` that took one too many would read as "capability off" rather than as an error, because `isFlagEnabled` is fail-closed. 87 → 86, layover flags back to exactly the two that predated it | **ci only** |
| 19 | `2730` memory derivative registry | **2710** (a registry keyed on domain-event identity cannot precede the events) | **ci ✓** `20260908151001` applied, constraints exercised, rollback rehearsed | 6 relation names, 2 constraint names and the trigger name all FREE on CI; both stated preconditions hold (`public.set_updated_at()` and `public.memories` present); GIN available | **not applied to production** | RLS on with **ZERO policies**, which is what the file asks for and is checked as an equality rather than a floor — deny-by-default is the design, and one permissive policy would be the defect. anon/authenticated hold nothing; 5 indexes; 3 CHECKs; trigger present; 0 rows; `public.memories` still 21 columns. **The file ships no postcondition block**, so its constraints were asserted by nobody — all five exercised with positive controls (see below). Rollback rehearsed: 5 relations → 0, 3 constraints → 0, 1 trigger → 0, and `set_updated_at()` SURVIVES | **ci only** |
| 20 | `2720` highlight resurfacing preferences | none (creates 1 table; FK to `profiles`) | **ci ✓** `20260908151339` applied, constraints exercised, RLS tested AS THE ROLES, rollback rehearsed | table, both index names, the scope constraint and all four policy names FREE on CI; `profiles` and `highlights` present; no `272x` migration previously applied | **not applied to production** | RLS on, four owner-only policies (SELECT/INSERT/UPDATE/DELETE). The scope constraint refuses a `HIDE_TRIP` row scoped to a highlight, a duplicate control, and an owner that is not a profile, while accepting both legal pairs. **anon and authenticated hold DELETE/INSERT/SELECT/UPDATE** — 2720 issues no REVOKE — so the table is defended by RLS ALONE; tested as the roles rather than argued: an owner-role seed of 1 row is visible to the owner role, **0** to `anon`, **0** to `authenticated` without a JWT, and an `anon` INSERT is refused **42501**. Rollback rehearsed: relations → 0, policies → 0, constraints → 0, `public.profiles` survives | **ci only** |
| 21 | `2721` highlight projection policies | **2720** (same family; ordered, not batched) | **ci ✓** `20260908151706` applied, both ladders and the FK cascade exercised, rollback rehearsed | table, both index names and all four policy names FREE; `highlights` (17 columns) and `profiles` present. **Behaviour-neutrality established by READING THE CONSUMER, not by trusting the header**: `routes/highlights.ts` consumes `resolveLocationDisclosure` only, and its `absent` branch and its `present, no row` branch BOTH return the location unchanged; `consentFromRow`, where unknown REFUSES, has no route caller — so applying an empty table cannot suppress anything | **not applied to production** | RLS on, four owner-only policies, **0 rows** and CI holds 0 highlights, so LOCATION_PRECISION_DEFAULT is demonstrably not taken. The first ladder probe came back **CANNOT-RUN** (no highlight to reference); re-run with the fixture seeded inside the rolled-back transaction rather than recorded as a pass: legal rungs accepted, all five consents default **NULL/NULL/NULL/NULL/NULL** (unknown, refuses), a second policy for the same highlight REFUSED, a bogus location rung REFUSED, a bogus person rung REFUSED, a policy for a nonexistent highlight REFUSED, and deleting the highlight took its policy with it (ON DELETE CASCADE, 0 left). **No `updated_at` trigger** — unlike 2730, that column is writer-maintained. Rollback rehearsed: relations → 0, RLS policies → 0, both FK targets survive, `highlights` still 17 columns | **ci only** |
| 22 | `2450` trip/participant families | **2420** | — | — | queued | — | — |
| 23 | `2500` `JOIN_VIA_LINK` + host | **2450** | — | — | queued | — | — |
| 24 | `2490` destructive privilege boundary | none | ✓ | 375 app-owned offenders → **0**; 3 extension-owned excluded | **APPLIED prod 20260908011416** | vacuity guard ≥300 relations; 3472 `has_table_privilege` probes, 0 held | ✓ |
| — | `2224`, `2315` → `2333` | each other | — | both tables absent in production | queued | 2333 aborts without them | — |

## Not queued, and why

| Migration | Reason |
|---|---|
| `2470` media canonical columns | **`blocked_by_owner_decision` — MEDIA_CANONICAL_FLAG.** `media_canonical_enabled` is TRUE in production while the columns are absent. Applying takes the decision. |
| `2481` sensing Option A issuer | **`blocked_by_owner_decision` — SENSING_AUTH_POSTURE.** Its CHECK *encodes* Option A; under Option B the file is never run. |
| `2250` media asset canonical model | **`do_not_apply` as written.** Its own postcondition asserts the flag is FALSE; it is TRUE, so it fails on itself. `2470` exists because of this. |
| `2510` layover postconditions | Verify-only, **strictly after `2335`**. Raises by design until then. |
| PR #461's `2313` | **Blocked on the PR.** Unpatched it reintroduces the `trip_members` self-join wherever it runs after `2530`; the rebase patch is in `docs/architecture/`. |

## What was proved about 2730's constraints, since the file proves nothing itself

2730 has preconditions and no postconditions. Every constraint below was
exercised on CI inside a transaction that was ROLLED BACK, each with a POSITIVE
CONTROL, because a constraint that refuses everything is as useless as one that
refuses nothing.

| Attempt | Result |
|---|---|
| a well-formed ACTIVE row | **accepted** (control) |
| `REVOKED` with no `revoked_at` / `revocation_reason` | **refused** — an unexplained revocation is as unauditable as an unrecorded one |
| `REVOKED` still carrying `row_count = 5` | **refused** — a revoked derivative holds no content |
| `REVOKED` with a reason, a timestamp and `row_count = 0` | **accepted** (control) |
| a second row on the same `(projection_id, scope_key)` | **refused** — one registration per built artifact |
| `revocation_state = 'BOGUS'` | **refused** |
| an `UPDATE` over a writer-supplied `updated_at` of 2001-01-01 | **overwritten with transaction-now** — a writer cannot forge it |

The last row is also a correction of my own first reading. The first probe
asserted `updated_at > created_at` after an UPDATE and got FALSE, which looks
exactly like a dead trigger. It is not: `now()` is TRANSACTION START time, so a
row created and updated inside one transaction has `created_at = updated_at` by
construction and that comparison can never move — the same fact the memory-kernel
lane measured for the outbox. The assertion was wrong, not the trigger.

One observation that is not a defect but should not be silently absorbed: the
migration's `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role` is a no-op.
`service_role` already held all seven privileges — TRUNCATE, REFERENCES and
TRIGGER included — from the Supabase `ALTER DEFAULT PRIVILEGES` blanket that
every `CREATE TABLE` receives. The `REVOKE`s from `anon`/`authenticated` are the
statements doing the work.

## A difference between these files that is incidental, not designed

2700 and 2730 `REVOKE ALL` from `anon` and `authenticated` and then grant back
exactly what is needed. 2720 issues no REVOKE at all and relies on RLS. Both are
safe on CI today, and the reason they are both safe is 2490: it narrowed the
Supabase `ALTER DEFAULT PRIVILEGES` blanket, so a new table's default grant no
longer includes TRUNCATE — the one verb that BYPASSES row-level security. Had
TRUNCATE still been in that blanket, 2720's RLS-only defence would have left
`anon` able to erase every owner's resurfacing preferences, silently
un-hiding every hidden person and trip, and no policy would have stopped it.

Stated because the difference between the three files is not a considered
choice about defence in depth; it is three authors and one guard doing the work
for one of them. Whichever posture the next migration takes, it should be the
one it means.

## Known defects in queued files, found during certification

| File | Defect | Consequence |
|---|---|---|
| `2711` | Its postcondition asserts `NOT EXISTS (SELECT 1 FROM public.memory_domain_events)` — the WHOLE table empty — under the message "a malformed command wrote an event". The predicate flips permanently after the first real command. | **2711 is not re-appliable** to any database that has kernel history. On production, or on CI after today, a re-apply fails with a message that misdescribes the cause. It should be scoped to the probe command (by `causation_id`). Not fixed here: the file is applied to CI at a recorded version and editing it now would break the byte-for-byte provenance recorded above. |
| `2710` | The append-only trigger on `memory_domain_events` is `BEFORE UPDATE` only. A direct `DELETE` succeeds — measured as `postgres` on CI, inside a rolled-back probe. | The header's "DELETE follows the Memory (cascade)" states the intent; the enforcement is UPDATE-immutability, not append-only. `service_role` retains row-level DELETE. |
| `2710` | `memory_command_audit` has NO foreign keys at all. Deliberate for `memory_id`; the consequence for `actor_user_id` is that it survives the user's erasure indefinitely. | Touches the open **D6 deletion fate** owner decision. Reported, not decided. |

## Rules being followed

- Sequential, in verified dependency order. Never batch.
- CI first where CI is not already ahead; where CI already carries the migration, that standing state is the rehearsal.
- Postconditions run inside the apply transaction, so a failure rolls back whole.
- A migration that would resolve an unresolved owner decision is not applied, however safe it looks.
- Before-state captured and kept for anything that changes an authorization predicate.
