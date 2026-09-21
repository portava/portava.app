# Highlights trip_only and crew-session RLS — the two policies 2337 deferred

Lane B5, 2026-09-07. Companion to
[trip-crew-rls-convergence-evidence.md](trip-crew-rls-convergence-evidence.md).
Migration `2337_trip_crew_rls_membership_convergence.sql` repaired 32 of 34
defective trip-membership policies and deferred exactly two, each for a stated
reason. This document records what those reasons turned out to be, what was
measured, what was built, and what is still not decided.

**Nothing here was applied to any database.** Measurements on portava-ci
(`hwokxgbmezheskbzskfr`) were taken as role `authenticated` with a real
`request.jwt.claims` sub, inside a `DO` block that raises at the end so the
transaction — fixtures, `SET LOCAL ROLE`, everything — is discarded.
Production (`ajrurzioarfkagpuxfnb`) was read structurally only: `pg_policies`,
`pg_proc`, `information_schema`, grants, aggregate counts. The migrations
themselves were executed end-to-end on a local PostgreSQL 16 harness whose
`authz` helper bodies were extracted from 2334/2337 verbatim and whose policies
were pasted verbatim from `pg_policies` on each database.

---

## 1. Two things in the brief that are not true

- **"2337 … not yet applied."** It is applied to portava-ci: `schema_migrations`
  version `20260907102143`, and all five 2337 helpers exist in `authz` there.
  It is **not** applied to production (no `authz.shares_accepted_trip`,
  no `authz.is_accepted_trip_member`; 36 policies still name `trip_members`).
  Both new migrations therefore carry a hard precondition on 2337.
- **"CI carries a restructured version that exists in no migration in this
  repository."** True of this *branch*, false of the repository. The CI shape
  is `2313_highlights_permanent`, applied to CI on 2026-09-07
  (`schema_migrations 20260907024317`), authored in commit `3babd722` on
  `remotes/pr/461` — **PR #461, unmerged** — and already captured in
  `db/rollback/2026-09-07-ci-migrations-rollback.sql` under "2313 — PR #461".
  The runbook's "present in no migration" line is wrong and should be read as
  "present only in PR #461".

## 2. T1 — `highlights_select_active`

### 2.1 What the CI/production drift actually is

Both databases carry five policies on `highlights`; four are byte-identical.
The two SELECT policies (`highlights_select`, `highlights_select_active`)
differ in **exactly one way**, the same on each:

| | production (0026) | portava-ci (2313, PR #461) |
| --- | --- | --- |
| structure | `deleted_at IS NULL AND expires_at > now() AND NOT blocked AND (owner OR public OR circle OR trip_only)` | `deleted_at IS NULL AND (owner OR ((expires_at IS NULL OR expires_at > now()) AND NOT blocked AND (public OR circle OR trip_only)))` |
| `highlights.expires_at` | `NOT NULL` | nullable, `CHECK (expires_at IS NULL OR expires_at > created_at) NOT VALID` |
| `trip_only` branch | self-join, no role, no status | **identical** self-join |

Semantically the CI shape (a) lets the owner see their own expired highlights
and (b) treats `expires_at IS NULL` as never-expiring. Both are the two owner
rulings of 2026-09-06 that 2313's commit message records ("a Highlight may be
PERMANENT"; "an expired Highlight is ARCHIVED, not invisible"). So the drift is
**reviewed but unmerged, and coupled to a column change** production does not
have.

### 2.2 The decision: neither (a) nor (b) — rewrite one branch in place

Option (a), carrying the CI shape to production, applies half of PR #461 — the
policy without the column, the index or the routes — inside a migration about
membership. Option (b), writing the production shape, reverts an owner ruling
on CI. The decision between them belongs to PR #461's review, not to this
lane, and **it is not needed**: the defect is confined to the `trip_only`
branch, which both shapes share byte-for-byte.

`2530_highlights_trip_only_accepted_crew.sql` therefore reads the live `qual`
from `pg_policies`, requires the defective self-join to appear **exactly once**,
replaces that fragment with
`((visibility = 'trip_only'::text) AND authz.shares_accepted_trip(owner_id))`,
and **proves minimality before writing**: the old qual with the fragment cut
out must equal the new qual with the replacement cut out, character for
character, and `trip_members` must be gone. Command, roles and permissiveness
are read back from `pg_policies` and asserted, never assumed. Any other shape
is refused.

Dry-run as a pure `SELECT` against each database's live `qual` (2026-09-07):
`matched = true, match_count = 1, rest_identical = true,
still_has_trip_members = false` on **both**. CI's output keeps 2313's
owner-first / NULL-arm structure; production's keeps 0026's.

Executed on the local harness (real helper bodies, both shapes pasted
verbatim): CI shape rewritten (rc 0); rerun is a no-op with a NOTICE;
production shape rewritten (rc 0); refused when the branch appears twice
(`found 2 time(s)`), when the policy is `TO public` instead of `TO
authenticated`, and when `authz.shares_accepted_trip` is absent. Rollback
restores the self-join on both shapes and 2530 re-applies after it.

### 2.3 Before/after admission, measured on portava-ci

Fixture: trip T1 owned by U_OWNER (owner row present); trip T2 owned by
U_OWNER_NOROW with **no** membership row, on which U_OWNER is `member/accepted`;
a `trip_only` highlight owned by U_OWNER, expiring in one hour. "before" is a
`SELECT count(*) FROM highlights WHERE id = H` as that viewer under the live
policy; "after" is `authz.shares_accepted_trip(U_OWNER)` as that viewer — the
exact expression that replaces the branch, everything else in the policy being
unchanged. The local harness then evaluated the **actual rewritten policy**
and agreed with the "after" column on every row.

| viewer of U_OWNER's trip_only highlight | before | after |
| --- | --- | --- |
| U_OWNER (owner) | 1 | 1 |
| member / accepted | 1 | 1 |
| co_host / accepted | 1 | 1 |
| viewer / accepted | 1 | 1 |
| **member / invited** (pending, current encoding) | **1** | **0** |
| **co_host / invited** (pending co-host) | **1** | **0** |
| invited / accepted (pending, legacy encoding) | 0 (masked, not gated — 2337 §4) | 0 |
| **member / removed** | **1** | **0** |
| stranger | 0 | 0 |
| **owner of T2 holding no row** (shares T2 with U_OWNER) | **0** | **1** |

Three fail-open rows closed (the removed-member one was not in 2337's brief);
one fail-closed row opened. `anon` and `authenticated` hold `SELECT` on
`highlights` on both databases (they hold the full privilege set, in fact), so
this is the direct-PostgREST path. Production holds 23 highlights, 5 of them
`trip_only`, none with a NULL expiry.

### 2.4 The app side — `routes/highlights.ts`

Five sites computed "shares a trip" as `trip_members WHERE role IN
('owner','member')` on both sides, with no status. They now go through one
helper, `sharesAcceptedTrip(sc, viewerId, ownerIds)`, which applies
`requireTripMember`'s rule to **both** people — `role IN (owner, co_host,
member, viewer) AND coalesce(status,'accepted') = 'accepted'` where a row
exists, `trips.owner_id` where none does — with every read `.error`-checked.
On error the caller **withholds** every `trip_only` highlight and logs it; the
public ones are still served. `?tripId=` on `/highlights/active` scopes to the
trip's accepted crew and is `db_error` on an unreadable crew and an **empty**
page for a trip with none — it used to be an *unfiltered* page in both cases.

`src/test/highlightsTripMembership.test.ts` — 56 tests, exit 0 — drives four
routes (`/users/:id/highlights`, `/highlights/active`,
`/highlights/following-feed`, `/highlights/:id/view`) for eleven viewer
classes through an in-memory client that really filters. Mutation proofs, each
restored byte-identical afterwards:

| mutation | result |
| --- | --- |
| status gate dropped | 17 fail |
| role set back to `owner,member` | 8 fail |
| owner fallback removed, highlight-owner side | 4 fail |
| owner fallback removed, viewer side | 4 fail |
| owner fallback made unconditional (removed-row owner admitted) | 4 fail |
| `.error` unchecked on the four membership reads | 8 fail |
| `?tripId=` filter back to role-only | 1 fail |

The first version of this suite let the owner-side fallback mutation through
(it only covered the viewer side); the two extra fixtures exist because of
that.

### 2.5 The hazard 2530 leaves open

PR #461's 2313 reproduces the `trip_only` self-join "byte-for-byte from the
baseline". On CI it has already run, so 2530 lands on top of it. **On
production, if PR #461 is merged and applied after 2530, 2313 will reintroduce
the defect.** 2313 must be rebased to emit
`authz.shares_accepted_trip(owner_id)` in that branch before it is applied
anywhere 2530 has been. The live shape guard (§4) fails on CI the moment any
policy on any table reintroduces the shape.

## 3. T2 — `crew_session_owner_select`

### 3.1 Is 2118 live, and does it hold this?

`reconciliation-staging/2118_trip_crew_discovery_privacy_policy_convergence.sql`
is **staged, not applied, blocked on Q3**, committed once (`a745ba11`) and
never updated. Two facts settle whether it holds this defect:

- Its converged SELECT predicate for the table is `auth.uid() = user_id OR
  auth.uid() = ANY(allowed_member_ids)` — **byte-identical to the defective
  predicate**. 2118 re-emits the stranger case; it does not repair it. What
  2118 holds is the *any-crew-vs-recipients-only* question, which it answers
  "recipients only" with no membership gate on the recipient.
- It predates 2334/2337: its DROP list names `crew_loc_sessions_trip_member_read`
  and `crew_sessions_recipients_read` in their pre-2337 forms and its
  postcondition expects exactly four policies on the table. Applied to CI as
  written it would drop 2337's repaired policies.

So 2118 does not cover this defect, and 2531 takes it without deciding 2118's
question: `crew_session_owner_select` becomes `USING (auth.uid() = user_id)`
— what its name says. `crew_loc_sessions_trip_member_read` (any accepted crew)
and `crew_sessions_recipients_read` (active, unexpired, listed **and** crew)
are untouched, so the admitted set afterwards is {owner} ∪ {accepted crew}.
The only people who lose access are people who are **not crew** of the
session's trip. If 2118 later narrows "any crew" to "recipients only", it
must be rebased so it does not re-emit the array branch without a crew gate.

### 3.2 Before/after, measured on portava-ci

Three sessions owned by U_OWNER on T1 — active, stopped, expired — each
listing the viewers below in `allowed_member_ids`. "before" is a `SELECT` as
that viewer under the live policies; "after" is the OR of the two surviving
policies plus the owner-only one, and the local harness evaluated the actual
post-2531 policies and agreed on every row.

| viewer | before (active, stopped, expired) | after |
| --- | --- | --- |
| session owner | 1,1,1 | 1,1,1 |
| member / accepted (listed) | 1,1,1 | 1,1,1 |
| co_host / accepted, viewer / accepted (not listed) | 1,1,1 | 1,1,1 |
| **member / invited** (listed) | **1,1,1** | **0,0,0** |
| co_host / invited (not listed) | 0,0,0 | 0,0,0 |
| **invited / accepted**, legacy (listed) | **1,1,1** | **0,0,0** |
| **member / removed** (listed) | **1,1,1** | **0,0,0** |
| **stranger** (listed) | **1,1,1** | **0,0,0** |
| **owner of an unrelated trip** (listed) | **1,1,1** | **0,0,0** |

Note the "stopped" and "expired" columns: today a listed stranger reads a
session that has *ended*. Production holds 0 sessions; the API reads the table
through the service client; `anon`/`authenticated` hold `SELECT` on it on both
databases.

2531 refuses to run unless `crew_sessions_recipients_read` and
`crew_loc_sessions_trip_member_read` are already the 2337 forms (verified on
the harness against the production-state table: `PRECONDITION FAILED:
crew_sessions_recipients_read is not the 2337 form`).

## 4. T3 — making the class un-reintroducible

`src/scripts/rlsDispositions.ts` now carries three **textual** rules — it says
so in its own header, because a substring heuristic over `pg_policies` is what
mis-counted 2337 in both directions — plus the lists that make a textual rule
honest, and `src/test/rlsPolicyShapeLive.test.ts` evaluates them against the
live CI catalog on every live-db run:

1. **trip_members without role AND status.** Direct references need both
   words; references through a public function whose body reads
   `trip_members` without a status gate are caught by name. That function
   list (`can_see_trip`, `shares_trip_with`) was **read from `pg_proc` on
   CI**, every function whose source mentions `trip_members` having been
   inspected — 2337 repointed `is_accepted_trip_member`, `can_see_post`,
   `can_post_to_trip` and `can_see_postcard` at `authz.is_trip_crew`, so they
   are gated and deliberately not listed.
2. **FOR ALL without WITH CHECK**, outside a captured, shrink-only baseline.
   Exempt by rule, because reuse cannot widen them: `TO service_role` only,
   `USING (false)`, `USING (auth.role() = 'service_role')`. The 59-entry
   baseline was captured from CI and verified by set-difference against the
   live catalog: 59 = 59, no entry only on one side.
3. **`auth.uid() = ANY(<array column>)` without a crew gate** on a SELECT.

Every allowlist is explicit and reviewed or explicitly *not* reviewed:
`TRIP_MEMBERS_REVIEWED_ALLOWLIST` (2 entries, with reasons),
`TRIP_MEMBERS_KNOWN_OPEN` (18: `highlights_select_active` until 2530 lands on
CI, and the 17 `can_see_trip` callers), `ARRAY_GRANT_KNOWN_OPEN` (1:
`crew_session_owner_select` until 2531 lands), `FOR_ALL_WITHOUT_WITH_CHECK_BASELINE`
(59, **not individually reviewed**, stated as such). Each known-open row names
the event that removes it, and the stale-entry check **fails by design** once
that event has happened — the same mechanism the meetup cycle entry already
uses. The lists were cross-checked against CI: the live set of ungated direct
references is exactly {the 2 reviewed, highlights}; the live set of ungated
array grants is exactly {crew_session_owner_select}; the 17 callers match.

Vacuity is failure: credentials absent, snapshot RPC missing, zero rows, or a
snapshot without the two sentinel policies each **fail** — the old `t.skip`
branches are gone (they were unreachable anyway: `ciSupabaseGuard` exits 2
first, and running the suite against the dead-port URL reports `fail 1,
skipped 0`, exit 1).

Rule 2 needs `qual` and `with_check` **separately**, and 2199's
`pg_policies_snapshot` fuses them. `2532_pg_policies_snapshot_v2.sql` adds a
service-role-only RPC that keeps them apart (same posture as 2199, asserted by
postcondition: anon/authenticated cannot execute it). Until 2532 is applied to
CI the rule 2 test **fails**, by design — a rule that cannot see the column it
judges must not report green.

`src/test/rlsPolicyShapeRules.test.ts` — 31 tests, exit 0, no database —
proves every verdict of every rule on policy text copied verbatim from CI,
shows each mutation surfacing (a new self-join, a new `can_see_trip` caller,
a new `FOR ALL` without `WITH CHECK`, a new array grant, a baseline entry that
gains `WITH CHECK`, a reviewed entry that disappears), shows `assertSnapshotExamined`
throwing on `[]` and on a sentinel-free snapshot, and **reads 2530's regex out
of the migration file** and applies it to both live shapes, asserting one
match, no `trip_members` left, and byte-identical remainder on each.

## 5. Findings outside this lane, reported not fixed

- **`public.shares_trip_with(uuid)`** — SECURITY DEFINER, `trip_members`
  self-join with no role or status gate, `EXECUTE` held by `anon` and
  `authenticated` on **both** databases, in `public`, so PostgREST exposes it
  as `POST /rest/v1/rpc/shares_trip_with`. "Do I share any trip, in any state,
  with X" — a social-graph oracle of exactly the class 2182 closed. Named in
  no policy.
- **`public.can_see_trip(uuid)`** gates on role and never on status; 17 live
  policies reach `trip_members` through it (`trips_select`,
  `trip_members_select`, checklists, notes, documents, saved places, map pins,
  destinations, reminders). A pending invitee passes all of them. 2337 named
  the defect and did not repair it; nothing does.
- **`trip_checklists::trip_checklists_members` and
  `trip_checklist_items::trip_checklist_items_members`** are `FOR ALL USING
  (can_see_trip(trip_id))` with no `WITH CHECK`, and `can_see_trip` admits any
  viewer of a **public** trip — so anyone who can see a public trip can
  insert, update and delete its checklist rows. Recorded in the baseline with
  that sentence beside it.
- **`typecheck:tests` reads 881/119 against the 880/118 baseline**; the one
  extra diagnostic is `src/test/tripKernelExpansion.test.ts` (a sibling's
  file). This lane's files contribute zero.

## 6. Dispositions (first pass)

| file | disposition | depends on |
| --- | --- | --- |
| `2530_highlights_trip_only_accepted_crew.sql` | **ready_for_manual_apply** — shape-agnostic; on production apply after 2334 → 2337; on CI apply now. **Then rebase PR #461's 2313 before it is applied anywhere 2530 has run** (§9). | 2337 |
| `2531_crew_session_owner_select_owner_only.sql` | **ready_for_manual_apply** — does not decide 2118's any-crew-vs-recipients question; 2118 must be rebased onto the post-2337 table before it could ever apply | 2337 |
| `2532_pg_policies_snapshot_v2.sql` | **ready_for_manual_apply** — additive, two service_role-only RPCs; until it lands on CI the FOR ALL rule and the function-list check fail by design | 2199 (convention only) |
| `db/rollback/2026-09-07-2530-…`, `…-2531-…` | rollbacks; each banner says which hole it reopens | — |

---

# Second pass — the three follow-ups from §5

## 7. `shares_trip_with` dropped (2533)

Facts re-checked before writing: `pg_depend` shows **nothing** depending on
`public.shares_trip_with(uuid)` on either database; no policy expression, no
other function body, no view names it; the repository has no `.rpc(...)`
call site (the coordinator's grep, re-run: hits are generated types, this
guard's captured list, and migration prose). Its body is md5-identical on
both databases. EXECUTE is held by `anon`, `authenticated` and `PUBLIC` on
both.

`2533_drop_shares_trip_with_oracle.sql` drops it. Its precondition
re-derives the dependency facts at apply time (`pg_depend`, `pg_policies`
text, `pg_proc` bodies, `pg_views`) and refuses if anything has come to
depend on it; it also requires `authz.shares_accepted_trip` (2337) to exist
first so the correct predicate is present before the wrong one goes.
Harness: applies (rc 0), reruns as a NOTICE no-op, rolls back (function and
grants restored), re-applies, and **refuses** when a policy is created on
top of it (`PRECONDITION FAILED: 1 object(s) depend on
public.shares_trip_with ... policy zz_dep on table trip_notes`).

Two things the owner must do that are not SQL: `src/scripts/auditMigrationsVsLive.ts`
derives declared functions from `CREATE FUNCTION` text and does not read
`DROP FUNCTION`, so after 2533 it will report `function:shares_trip_with`
as declared-but-missing until `"function:shares_trip_with"` joins its
`ALLOWLIST` (as `4754a9e8` did for `is_blocked`); and the two generated
`database.types.ts` files still declare the RPC type until regenerated.

**The guard's captured function list is deliberately NOT edited yet.** The
coordinator asked for `shares_trip_with` to be removed from
`UNGATED_TRIP_MEMBERS_FUNCTIONS` on drop. That list must describe the CI
catalog as it *is*, and on CI the function still exists; 2532 now ships a
second RPC, `pg_trip_members_readers_snapshot()`, and the live suite asserts
the list **equals** the live set of `public` boolean functions reading
`trip_members` without a status gate — in both directions. So the entry is
removed when 2533 lands on CI, and the suite fails until it is, exactly the
rule the coordinator applied to the seventeen `can_see_trip` entries. Same
mechanism, same reason: a captured list that is edited ahead of the
database is a memory, not a fact.

## 8. `can_see_trip` repaired, and the write boundary (2534)

### 8.1 Dependants, enumerated

`pg_depend` on `public.can_see_trip(uuid)`, both databases: **the seventeen
policies named in §4 and nothing else** — no view, function, trigger or
default. All thirty-five policies on the ten tables they live on are
md5-identical between CI and production. 2534's precondition refuses if the
live dependant set differs from the measured one (verified on the harness:
adding a policy yields `PRECONDITION FAILED: unmeasured dependants of
can_see_trip: policy zz_extra on table map_pins`).

### 8.2 What the API means (read, not assumed)

`routes/trips-expansion.ts`, 2026-09-07: `GET /trips/:id` gives an accepted
member or the owner the full view; anyone else gets the stripped preview of
a **public** trip and 404 for private/invite — a **pending invitee is
"anyone else"**. Checklist create/rename and item create gate on
`requireTripMember` (accepted crew, viewer included). Item update/delete gate
on owner or role in `owner/co_host/member` — viewer excluded. Checklist
delete gates on creator or owner.

One more reader matters and it is not the API: `travel-buddy-standalone/src/services/trips.ts`
reads the viewer's **own** `trip_members` row through the anon key to learn
its role — `'invited'` included — and `src/services/trips.ts` reads `trips`
the same way. RLS on these tables is a client contract, not only a
PostgREST hardening.

### 8.3 What 2534 does

- `can_see_trip(t)` := owner **or** `authz.is_trip_crew(t)` (role AND
  status, owner fallback) **or** public-and-not-blocked. Body no longer
  names `trip_members`. The owner branch is kept and the divergence from
  `requireTripMember` stated: an owner whose own row says `removed` keeps
  reading their trip, because `trips_update`/`trips_delete` still gate on
  `owner_id`.
- `trip_members_select` := `user_id = auth.uid() OR can_see_trip(trip_id)`
  — a person always sees their own row, so the standalone client's role read
  keeps working for pending invitees.
- The two `FOR ALL` policies become `FOR SELECT`; writes get explicit
  per-command policies with `WITH CHECK`: checklist insert/rename and item
  insert on `authz.is_trip_crew`; item update/delete on
  `authz.accepted_trip_role(trip_id) IN (owner, co_host, member)`; checklist
  delete unchanged (creator or owner — already the API's rule).
- The four other INSERT policies that borrowed the read predicate as a write
  gate (`trip_notes`, `trip_documents`, `trip_saved_places`, `trip_reminders`)
  move to `authz.is_trip_crew`.

### 8.4 Before/after, measured

On portava-ci (rolled back), a private trip P and a public trip Q, each with
a checklist and an item:

| viewer | reads P | P's member rows | inserts checklist into P | inserts / updates / deletes on Q, inserts a note on Q |
| --- | --- | --- | --- | --- |
| accepted member / co_host of P | yes | 5 | yes | yes |
| **pending member, status=invited** | **yes** | **5** | **yes** | yes |
| **removed member** | **yes** | **5** | **yes** | yes |
| stranger (public viewer of Q) | no | 0 | denied | **yes, yes, yes, yes** |

The same fixture on the local harness with the verbatim CI policies
reproduces that table, and after 2534 (real policies, not predicates):

| viewer | trips | P rows | checklists | ins cl P | ins cl Q | rename Q | ins item Q | upd item Q | del item Q | note/doc/place Q | reminder Q |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| owner / member / co_host / viewer of P | 2 | 6 | 2 | OK | denied | 0 | denied | 0 | 0 | denied | OK |
| pending member of P | 1 | **1 (own)** | 1 | denied | denied | 0 | denied | 0 | 0 | denied | OK |
| removed member of P | 1 | **1 (own)** | 1 | denied | denied | 0 | denied | 0 | 0 | denied | OK |
| stranger (public viewer of Q) | 1 | 0 | 1 | denied | **denied** | **0** | **denied** | **0** | **0** | **denied** | OK |
| accepted member of Q | 1 | 0 | 1 | denied | OK | 1 | OK | 1 | 1 | OK | OK |
| accepted **viewer** of Q | 1 | 0 | 1 | denied | OK | 1 | OK | **0** | **0** | OK | OK |

Every cell matches §8.2. The one column that stays `OK` for everyone —
reminders — is `trip_reminders_own`, `FOR ALL USING (user_id = auth.uid())`
with no `WITH CHECK`: any user may insert a reminder naming *their own id*
against *any* trip, which makes the crew gate on `trip_reminders_insert`
decorative. 2534's header reports it and does not decide it (a reminder is
the user's own object). Rollback restores the before-table exactly.

Harness sequence: apply (rc 0) → matrix → rerun is a NOTICE no-op that
expects the nine-reader dependant set (rc 0, 9 bound) → rollback (function
body restored, both `FOR ALL` back, 17 bound) → refusal on an unmeasured
dependant → refusal when `authz.accepted_trip_role` is absent → re-apply.

### 8.5 The guard, after 2534

The seventeen `TRIP_MEMBERS_KNOWN_OPEN` entries are **not** removed here;
their `removeWhen` now names 2534 and says what to do in the same change:
remove `can_see_trip` from `UNGATED_TRIP_MEMBERS_FUNCTIONS` (the live
function-list check fails while it is stale), at which point the seventeen
read as stale and are deleted. Without the new RPC this would have lingered
silently — the textual rule keeps reporting "via can_see_trip" for as long
as the list says so.

## 9. PR #461's 2313, rebased (patch, not a file on this branch)

2313 does not exist on this branch; it exists on `remotes/pr/461`
(`3babd722`). A migration file with that name cannot land here without
colliding with PR #461's on merge, so the deliverable is a patch against
that commit: [`pr461-2313-rebase-onto-2530.patch`](pr461-2313-rebase-onto-2530.patch)
(`git apply`-verified against the PR's file). It replaces the self-join with
`authz.shares_accepted_trip(owner_id)`, adds a precondition on 2337, and adds
a postcondition that no policy on `highlights` names `trip_members`; every
other line of 2313 is untouched.

Harness, production shape: 2530 then **unpatched** 2313 → self-join back
(the hazard, demonstrated); 2530 then patched 2313 → helper kept, 2313 shape
present; patched 2313 then 2530 → 2530 is a no-op NOTICE; patched 2313 twice
→ idempotent; patched 2313 without 2337 → `PRECONDITION FAILED`.

`rlsPolicyShapeRules.test.ts` ("2530 rewrites exactly one branch") still
passes on both shapes; the live rule "no policy reaches trip_members without
both a role and a status gate" would catch an unpatched 2313 on CI because
the recreated policy names `trip_members` with neither word.

**Runbook correction** (the coordinator's document; text to paste): replace
the bullet under 2337 that reads *"it deliberately does not touch
`highlights_select_active`, the one policy where CI and production disagree
(CI carries a restructured version present in no migration). That policy
remains defective and is a separate, one-line change."* with:

> **Known limitation** it deliberately does **not** touch `highlights_select_active`, the one policy where CI and production disagree. The CI shape is `2313_highlights_permanent` from **PR #461** (commit `3babd722`, applied to CI 2026-09-07, not merged into this branch); production carries 0026's shape. Migration **2530** repairs the defective `trip_only` branch on either shape without choosing between them. **Apply 2530 after 2337, and apply PR #461's 2313 only after it has been rebased with `docs/architecture/pr461-2313-rebase-onto-2530.patch`** — unpatched, 2313 reintroduces the self-join wherever it runs after 2530.

## 10. Dispositions (second pass)

| file | disposition | depends on |
| --- | --- | --- |
| `2533_drop_shares_trip_with_oracle.sql` | **ready_for_manual_apply** — then add `function:shares_trip_with` to `auditMigrationsVsLive.ts`'s ALLOWLIST and remove the entry from `UNGATED_TRIP_MEMBERS_FUNCTIONS` once it is on CI | 2337 |
| `2534_can_see_trip_status_gate_and_checklist_write_boundary.sql` | **ready_for_manual_apply** — after 2334 → 2337; one product note for the owner: a pending invitee no longer reads a private trip through PostgREST (the API already 404s them; the standalone client's own-row read is preserved) | 2334, 2337 |
| `2532` (extended) | **ready_for_manual_apply** — unapplied anywhere, so extending it in place is safe | — |
| `pr461-2313-rebase-onto-2530.patch` | **blocked_by_owner_decision**: PR #461 is the owner's to merge; the patch is verified and ready for that branch | PR #461 |
| `db/rollback/…-2533-…`, `…-2534-…` | rollbacks; banners say which holes they reopen | — |
