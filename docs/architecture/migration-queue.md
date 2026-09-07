# Live migration queue

Sequential, dependency-ordered. **Nothing is batch-applied**; each row completes
its gate before the next begins. Updated as rows land.

`prod ✓` = applied to production `ajrurzioarfkagpuxfnb`.
`ci ✓` = applied to portava-ci `hwokxgbmezheskbzskfr`.

| # | Migration | Depends on | CI | Prod pre-check | Applied | Post-check | Result |
|---|---|---|---|---|---|---|---|
| 1 | `2460` meetup self-invite defuse | 2182 (authz) | ✓ | owner=postgres, no FORCE RLS, `mi_own` FOR ALL, 5 policies | **prod ✓** | in-transaction; inertness re-verified on CI (still 42P17) | **applied** |
| 2 | `2461` meetup recursion repair | **2460** | ✓ | `mi_own` WITH CHECK requires an invite | **prod ✓** | self-proving: reads all 4 tables as `authenticated` inside the transaction | **applied** |
| 3 | `2462` vote write boundary | **2461** | ✓ | non-service read of votes must not raise | **prod ✓** | self-proving: unadmitted INSERT must return 42501 | **applied** |
| 4 | `2334` route-plan crew visibility | 2182 | ✓ | authz present, 4 route tables, `trip_members.status`, **13 policies** | **prod ✓** | 5 routed through helper, 0 referencing `trip_members`, 13 policies | **applied** |
| 5 | `2337` crew RLS convergence (29 policies / 19 tables) | **2334** | ✓ | applied from the file's exact bytes, not retyped | in progress | shape-scoped, not count-scoped | — |
| 6 | `2530` highlights `trip_only` | **2337** (`shares_accepted_trip`) | — | before-state captured: the `tm1 JOIN tm2` self-join is live | queued | shape-agnostic; refuses a shape it does not recognise | — |
| 7 | `2531` crew_session owner-only | — | — | before-state captured: `auth.uid() = ANY(allowed_member_ids)` is live | queued | — | — |
| 8 | `2532` pg_policies snapshot v2 | — | — | diagnostic only | queued | — | — |
| 9 | `2533` drop `shares_trip_with` oracle | — | — | zero app callers verified repo-wide | queued | anon/authenticated cannot execute | — |
| 10 | `2534` `can_see_trip` status gate + checklist write boundary | **2337** | — | 17 dependent policies enumerated | queued | before/after admission matrix | — |
| 11 | `2535` trip_reminders write boundary | `trip_reminders_insert`, `can_see_trip` | — | 4 postconditions all fail today (proven) | queued | no FOR ALL survives; both write verbs gated | — |
| 12 | `2420` trip kernel foundation | **2334 → 2337** | ✓ | production has no `trips.version` | queued | — | — |
| 13 | `2450` trip/participant families | **2420** | — | — | queued | — | — |
| 14 | `2500` `JOIN_VIA_LINK` + host | **2450** | — | — | queued | — | — |
| 15 | `2490` destructive privilege boundary | none | — | 385 offenders, 3 extension-owned excluded | queued | vacuity guard ≥300 relations | — |
| — | `2224`, `2315` → `2333` | each other | — | both tables absent in production | queued | 2333 aborts without them | — |

## Not queued, and why

| Migration | Reason |
|---|---|
| `2470` media canonical columns | **`blocked_by_owner_decision` — MEDIA_CANONICAL_FLAG.** `media_canonical_enabled` is TRUE in production while the columns are absent. Applying takes the decision. |
| `2481` sensing Option A issuer | **`blocked_by_owner_decision` — SENSING_AUTH_POSTURE.** Its CHECK *encodes* Option A; under Option B the file is never run. |
| `2250` media asset canonical model | **`do_not_apply` as written.** Its own postcondition asserts the flag is FALSE; it is TRUE, so it fails on itself. `2470` exists because of this. |
| `2510` layover postconditions | Verify-only, **strictly after `2335`**. Raises by design until then. |
| PR #461's `2313` | **Blocked on the PR.** Unpatched it reintroduces the `trip_members` self-join wherever it runs after `2530`; the rebase patch is in `docs/architecture/`. |

## Rules being followed

- Sequential, in verified dependency order. Never batch.
- CI first where CI is not already ahead; where CI already carries the migration, that standing state is the rehearsal.
- Postconditions run inside the apply transaction, so a failure rolls back whole.
- A migration that would resolve an unresolved owner decision is not applied, however safe it looks.
- Before-state captured and kept for anything that changes an authorization predicate.
