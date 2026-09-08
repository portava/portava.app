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
| 17 | `2450` trip/participant families | **2420** | — | — | queued | — | — |
| 18 | `2500` `JOIN_VIA_LINK` + host | **2450** | — | — | queued | — | — |
| 19 | `2490` destructive privilege boundary | none | ✓ | 375 app-owned offenders → **0**; 3 extension-owned excluded | **APPLIED prod 20260908011416** | vacuity guard ≥300 relations; 3472 `has_table_privilege` probes, 0 held | ✓ |
| — | `2224`, `2315` → `2333` | each other | — | both tables absent in production | queued | 2333 aborts without them | — |

## Not queued, and why

| Migration | Reason |
|---|---|
| `2470` media canonical columns | **`blocked_by_owner_decision` — MEDIA_CANONICAL_FLAG.** `media_canonical_enabled` is TRUE in production while the columns are absent. Applying takes the decision. |
| `2481` sensing Option A issuer | **`blocked_by_owner_decision` — SENSING_AUTH_POSTURE.** Its CHECK *encodes* Option A; under Option B the file is never run. |
| `2250` media asset canonical model | **`do_not_apply` as written.** Its own postcondition asserts the flag is FALSE; it is TRUE, so it fails on itself. `2470` exists because of this. |
| `2510` layover postconditions | Verify-only, **strictly after `2335`**. Raises by design until then. |
| PR #461's `2313` | **Blocked on the PR.** Unpatched it reintroduces the `trip_members` self-join wherever it runs after `2530`; the rebase patch is in `docs/architecture/`. |

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
