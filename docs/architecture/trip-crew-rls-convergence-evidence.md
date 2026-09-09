# Trip-crew RLS convergence — the evidence migration 2337 was committed without

Migration `2337_trip_crew_rls_membership_convergence.sql` and
`src/test/tripCrewRlsMembershipConvergence.test.ts` were committed in `f04abda1`
**without evidence**, because the agent that wrote them was killed by a session
rate limit before it could report. This document is that missing evidence,
recorded after the agent was resumed. Nothing in the tree changed to produce it.

Measured on portava-ci (`hwokxgbmezheskbzskfr`) as role `authenticated` with a
real `request.jwt.claims.sub`, inside transactions that were **rolled back**.
Production (`ajrurzioarfkagpuxfnb`) was read-only, aggregate counts only.

---

## 1. The finding that outranks the one the audit was commissioned for

Three policies **named after a membership check** had
`USING (auth.uid() IS NOT NULL)` as their entire predicate:

| policy | migration | table |
| --- | --- | --- |
| `crew_events_trip_members` | 0041 | `trip_crew_location_events` |
| `attendance_events_trip_members` | 0039 | `plan_attendance_events` |
| `trip_members_view_checkins` | 0039 | `plan_checkins` |

Because RLS policies are **PERMISSIVE by default they are OR-ed together**, so
each of these completely dominated the careful membership policy sitting beside
it on the same table. Any authenticated user — no trip, no invite, no
relationship — satisfied them. The name says membership; the predicate says
"is logged in".

This is identical on production. It also means the defect the audit was
commissioned for (a pending invitee passing a membership test that never reads
`status`) was, on these three tables, **not the binding constraint**: repairing
that neighbouring policy alone would have changed nothing measurable, because
the blanket policy admitted everyone regardless.

Two of the three carry crew **location** data.

## 2. The real count: 34 defective, not 24

The commissioning heuristic — policies mentioning `trip_members` but not
`status` — returned 24. It both over- and under-reported, as its author warned.

| | |
| --- | --- |
| policies referencing `trip_members` | **31** |
| correct as written, untouched | **4** |
| defective among them | **27** |
| further defective policies the heuristic could not see | **7** |
| **total defective** | **34** |
| repaired | **32** |
| deferred with reasons | **2** |

The seven invisible ones: three reach `trip_members` through a function, three
gate on nothing at all (§1), one gates on an array column.

The four **correct as written** are worth naming, because someone got them
right: `trip_members_insert` and `trip_members_delete` gate on `trips.owner_id`
(they govern membership creation, so a status gate would be circular), and
`trip_readiness_items.tri_member_read` / `trip_readiness_snapshots.trs_member_read`
already spell out `role IN (owner,co_host,member,viewer) AND (status IS NULL OR
status='accepted') OR trips.owner_id` — which *is* `requireTripMember`.

## 3. `public.is_accepted_trip_member` — enumerated before repointing

The brief said to leave this shared helper alone unless every dependent was
enumerated first, because a shared helper silently re-authorizing unmeasured
tables is the worst outcome available. It was enumerated, on **both** databases,
across the full dependency closure — views, matviews, check constraints,
indexes, column defaults, triggers, functions and policies — not from
`pg_policies` alone:

| dependent | reached via |
| --- | --- |
| `posts.posts_select` | `can_see_post(id)` |
| `posts.posts_insert` | `can_post_to_trip(trip_id)` |
| `passport_postcards.postcards_select` | `can_see_postcard(id)` |

Nothing else. **No table outside those three was re-authorized.**

Is it dead? No — and that was settled by reading call sites, not by its absence
from `pg_policies`, since an RPC is invoked from application code. A repo-wide
scan of `.rpc(` returns **zero** call sites for it or its three wrappers;
`lib/database.types.ts` declares it but nothing calls it. It is unreachable from
the application and reached by three live policies through SQL functions — so it
was **fixed rather than dropped**.

Each dependent was then measured in isolation, by dropping `posts_select_policy`
inside the rolled-back transaction so `posts` was governed *only* by the shared
helper. `posts_insert` shows no change in either direction because
`anon`/`authenticated` hold **SELECT only** on `posts` — read from the database,
not inferred from a migration — so the probe returns `permission denied` before
and after and the path is unreachable from an end-user JWT.

## 4. Who was wrongly admitted

Both production pending-invite encodings are real (aggregate counts only):
`owner/accepted` 38, `invited/accepted` 2, **`member/invited` 1**,
`member/accepted` 1.

Across the repaired tables the pattern is consistent: a **pending invitee**
(`member`/`invited`) could read crew location events, crew location
preferences, crew location sessions, plan attendance events, plan check-ins,
plan editors, plan geofences, trip plan items, trip reservations, trip and user
availability, quick availability status, trip-only posts, post media and
passport postcards — and could write plan geofences, plan items and their own
availability. On the three §1 tables so could a **complete stranger**.

Simultaneously the policies were too NARROW in the other direction: an accepted
`co_host` or `viewer`, and a trip owner holding no `trip_members` row at all,
were denied on most of those same tables. The hand-rolled predicates disagreed
with `requireTripMember` in both directions at once.

Three points stated explicitly rather than glossed:

- **The legacy `invited/accepted` encoding measured as already denied on most
  tables — but that is masking, not gating.** `trip_members_select` is
  `USING (can_see_trip(trip_id))`, so a viewer whose role is literally
  `invited` can read no `trip_members` row and every hand-rolled `EXISTS`
  collapses. `can_see_trip` carries the same defect, so it does **not** mask
  `member/invited`. Relying on it would be relying on one bug to hide another.
  Every new predicate is `SECURITY DEFINER` and answers on its own merits.
- **`UPDATE another's plan item` narrows deliberately.** `canEditPlanItem`
  (`http.ts:593-632`) permits only the trip owner or the item's creator; the old
  policy let any accepted crew member through. The policy now matches the API.
- **`meetups`, `meetup_invites` and `meetup_time_options` are unmeasurable.**
  Every SELECT fails with `infinite recursion detected in policy` on **both**
  databases: `meetups_invitee_select` reads `meetup_invites`, while
  `mi_trip_select` / `mi_creator_select` read `meetups`. Three tables entirely
  unreadable through RLS. That is a policy-graph cycle — a different defect
  class — so the predicates were corrected (they would otherwise be wrong the
  moment the cycle is broken) and **the recursion is reported, not fixed**.

## 5. Deliberately left alone

- **`highlights_select_active`** is defective (its `trip_only` branch joins
  `trip_members` to itself with no role and no status; pending member and
  pending co_host both measured as admitted) and was **not touched**, because it
  is the one policy of the 31 where **CI and production disagree**: CI carries a
  restructured version present in no migration in the repo — in-flight work by
  the highlights owner. A policy is replaced whole, so rewriting it would either
  clobber that unreviewed change or smuggle it into production inside an
  unrelated migration. `authz.shares_accepted_trip(uuid)` exists so the fix stays
  one line. Related and also theirs: `routes/highlights.ts` computes its own
  `sharesTripSet` with `.in("role",["owner","member"])` and no status filter.
- **`crew_session_owner_select`** — `auth.uid() = user_id OR auth.uid() =
  ANY(allowed_member_ids)`, with no membership, status or expiry check, so a
  stranger listed in `allowed_member_ids` reads the session. That is a question
  about the *width* of a live-share grant, and `reconciliation-staging/2118` is
  an open, blocked lane holding exactly that question for exactly that table.
- **`routes/tripCrewLocation.ts` `getMemberRole()`** filters
  `role IN (owner,co_host,member)` and never reads `status`, while its own
  comment claims pending invites get 403. Same defect, app-side. Note its
  failure mode is fail-**closed** (undefined → null → 403), not fail-open.
- **The `anon`/`authenticated` grant boundary** — that is 2332/2333's lane.

## 6. Proof

Twelve hand-reverts, every one killing the suite, every one restored
byte-identical: the blanket predicate restored (2 failures), the hand-rolled
join restored (2), the status gate dropped (1), `co_host`/`viewer` dropped (1),
the owner fallback dropped (1), the owner fallback applied unconditionally (1),
`is_accepted_trip_member` reverted to its pre-2337 body (1), a helper made
`SECURITY INVOKER` (1), 2337 rewriting an uncovered policy (1), the rollback no
longer naming the hole it reopens (1), the rollback file deleted (2), and
migration 2337 deleted outright (9).

R10 needed a second pass: the first revert left a `RAISE WARNING` in place and
the test correctly still passed — the guard was doing its job and the revert was
incomplete.

**Migration 2337 is applied to portava-ci**, version `20260907102143`,
postconditions passed. Policies referencing `trip_members` went 31 → 5 (the four
correct-as-written plus the deferred highlights policy); 29 now route through
`authz`. **Production is untouched**: none of the 2337 helpers are present, 36
policies still reference `trip_members`, and the three blanket-read policies of
§1 are still live there.

Fixture cleanup verified: 0 rows remaining across users, profiles, trips,
trip_members, crew events and sessions, geofences, plan items, posts, postcards
and highlights. `posts_select_policy` confirmed restored.

Test file exit 0 (10 tests / 10 pass). `pnpm typecheck` exit 0.
`pnpm typecheck:tests` reads 901 across 122 against the 880/118 baseline, and
all 21 extra diagnostics are sibling agents' files —
`highlightsBlockFailClosed` 3, `highlightsFeedFiniteness` 4,
`mapSensingProjectionGates` 2, `memoryLocationPrecision` 12 — none from this
work. `check:test-registration` exit 0, run last.
