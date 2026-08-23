# D6 — CI apply record, production constraint state, and the convergence plan

Owner rulings of 2026-08-23, executed. Every database read below was read-only.
**Nothing in this document was applied to production.**

---

## 1. Migrations 2128–2133 applied to `portava-ci`

Approved explicitly: *"You now have approval to apply migrations 2128–2133 to
`portava-ci` only … Applying them to the CI project is reconciliation, not
permission to touch production."*

### Before

| probe | value |
|---|---|
| `intel_*` tables | **NONE** |
| `intel_*` indexes | 0 |
| `intel_*` policies | 0 |
| `erase_intel_for_actor` | ABSENT |
| `purge_expired_intel_snapshots` | ABSENT |
| `intel_append_only` | ABSENT |
| the four intel/location flags | NONE |
| `sources` rows | 8 (2121 already applied) |
| `freshness_policies` rows | 4 (2122 already applied) |

### After

| probe | value |
|---|---|
| `intel_*` tables | 5 — observations, claims, evidence, confirmations, state_snapshots |
| `intel_*` indexes | 16 |
| `intel_*` policies | 2 |
| `intel_*` triggers | 9 (3 tables × row/statement/truncate) |
| RLS enabled | **5 of 5** |
| `erase_intel_for_actor` | PRESENT |
| `purge_expired_intel_snapshots` | PRESENT |
| feature flags | all four present, **all `false`** |
| dotted claim types | 13 |
| `freshness_policies.hard_expiry_seconds` | PRESENT |
| anon/PUBLIC grants on `intel_*` | **none** |

Every migration's own postconditions passed. All four flags are seeded OFF, so
applying this changed no runtime behaviour.

### Schema drift result

Before: many missing objects across the intel files. After: **one**, and it is
not from this set — `missing policy "trip_members_manage_geofences" on
plan_geofences`, claimed by `0035_plan_geofences.sql`. Outside the approval
scope, so it was left alone and is reported here instead.

---

## 2. Production constraint state, captured before changing anything

Ruling: *"First capture the exact production constraint state, then make the
repo describe the intended relationship, then migrate production deliberately
later."*

| probe | production |
|---|---|
| foreign keys on `public.profiles` | **NONE — no FK at all** |
| all constraints on `profiles` | `profiles_pkey`, `profiles_handle_key`, and 4 CHECKs |
| `profiles.id` | `uuid NOT NULL` |
| profiles with no auth user | **0** |
| auth users with no profile | **31** |
| totals | 58 profiles, 89 auth users |
| triggers on `auth.users` | **NONE** |

Two consequences:

- **The FK can be added without cleanup.** Zero orphan profiles means nothing
  violates it. Feasibility is not the obstacle.
- **31 auth users have no profile row and no trigger creates one.** That is a
  separate integrity question. It does not block the FK — which points from
  profiles to users, not the reverse — but signup is evidently not reliably
  creating a profile, and nobody has been watching.

---

## 3. Why converging is gated, not merely sequenced

`2136_profiles_auth_users_convergence.sql` declares the canonical relationship
in the repository. It is **not applied anywhere**, and it refuses to apply
itself where it would do harm.

The reason is a finding that is easy to miss:

> **61 foreign keys point at `public.profiles` with `ON DELETE NO ACTION` or
> `RESTRICT`.** They block nothing today for exactly one reason — production
> never deletes the profiles row, so the parent delete those rules would reject
> never happens.

Add the FK and every one of them wakes up. Deleting an auth user would cascade
into profiles, and 61 constraints would reject it. That is not "deletion works
properly"; it is the same failure this quarter has been removing, moved from
five edges to sixty-one.

So 2136 counts them and refuses while any remain. Verified: run against CI today
it raises

```
PRECONDITION CORRECTLY REFUSED: 54 foreign key(s) would reject a cascading delete
```

(54 on CI, 61 on production — CI lacks the `journey_*` family.)

### A prerequisite that was true and no longer is

An earlier version of this document said the deletion worker must hold
`portava.erasure_in_progress` across the auth delete. That was true of the
**statement-level** append-only trigger, which fired when a delete statement
began and so fired even for a zero-row cascade. `2137` removed that trigger —
it was refusing work with nothing to protect, and it broke the live-DB RLS suite
doing so.

The **row-level** trigger remains and fires once per actual row. The worker
already calls `erase_intel_for_actor()` before deleting the auth user, so the
cascade finds nothing to fire on. Verified:

```
seeded intel rows=1 | after erase=0 | auth delete SUCCEEDED without holding the flag
```

No worker change is required. The ordering requirement stands — erase intel
before the auth delete — and the worker already does that.

### Order of operations

1. ~~Resolve the 61 dormant blockers~~ **DONE** — 2138, applied to CI.
1b. Rule on the 18 shared-content CASCADE edges. Not optional: without it,
   convergence completes a deletion by destroying other users' conversations.
2. ~~Change the deletion worker to hold the erasure declaration~~ **NOT NEEDED** —
   2137 removed the statement-level trigger that made it necessary. Verified.
3. Apply 2136 to CI. Its preconditions pass only when 1 and 2 are true.
4. Prove one synthetic deletion end to end against the converged CI schema, with
   a before/after inventory.
5. Only then apply to production, behind the existing migration gate.

CI remains the proving ground throughout, as ruled.

---

## 4. Deletion is now completable — proven, not asserted

`2135_deletion_blocking_fks.sql` (applied to CI, **not** production) fixes the
five foreign keys that abort `auth.admin.deleteUser`. A synthetic account holding
a row in all five tables, plus a bystander who owned the event and the trip:

| table | outcome | ruling |
|---|---|---|
| `auth.users` | **delete SUCCEEDED** (it aborted before) | — |
| `event_cohosts` | survives, `added_by = NULL` | 3 — bystander keeps their event |
| `moderation_reports` | survives, `reporter_id = NULL`, `resolver_id = NULL` | 4 — safety record kept, identities severed |
| `post_edits` | **0 rows** | 3 — user content |
| `trip_plan_items` | survives, `creator_id = NULL` | 3 — bystander keeps their itinerary |

The fifth FK was not in the original packet. Sweeping for "rules that cannot do
what they say" found `moderation_reports.reporter_id` set to `ON DELETE SET NULL`
on a `NOT NULL` column — which reads as a severance policy and actually raises
23502 and aborts the delete. That is worse than the four `NO ACTION` edges,
because a reviewer checking delete rules would tick it off as already handled.

---

## 4b. The enablement gate: one synthetic deletion, with its inventory

The owner's condition for ever turning the worker on: *prove one synthetic
account deletion end to end against the reconciled schema and produce a
before/after inventory showing exactly what was erased, anonymised, retained,
and why.*

Run on CI at the converged shape (2135 + 2137 + 2138 + 2139 applied), with a
second "bystander" account owning nothing of the deleter's and sharing a thread
with them. Every assertion is computed by the probe, not read off by eye.

| table | before → after | intended fate | held |
|---|---|---|---|
| `messages` | 2 → **2**, one still identified | TOMBSTONE — the conversation survives, the sender does not | ✓ |
| `message_thread_members` | 2 → **1** | ERASE — membership is keyed by (thread, user) and cannot be severed | ✓ |
| `events` | 1 → **1**, `host_id` NULL | TOMBSTONE — attendees keep the event | ✓ |
| `trips` | 1 → **1**, `owner_id` NULL | TOMBSTONE — co-travellers keep the itinerary | ✓ |
| `posts` | 1 → **0** | ERASE — ruling 3, and the service already deletes them | ✓ |
| `intel_observations` | 1 → **0** | ERASE — via `erase_intel_for_actor` | ✓ |
| `moderation_reports` | 1 → **1**, `reporter_id` NULL | RETAIN + SEVER — ruling 4 | ✓ |
| `moderation_actions` | 1 → **1**, `performed_by` NULL | RETAIN + SEVER — ruling 4 | ✓ |
| `user_account_states` | 1 → **0** | ERASE | ✓ |
| `profiles` (deleter) | 1 → **0** | ERASE — no tombstone survives convergence | ✓ |
| `profiles` (bystander) | 1 → **1** | UNTOUCHED | ✓ |
| `auth.users` | 1 → **0** | ERASE — the email is gone | ✓ |

What this does and does not establish. It establishes that on a schema carrying
2135/2137/2138/2139 the deletion completes, the bystander loses nothing, safety
records survive without identities, and the departing user's own rows go. It
does **not** establish anything about production, which carries none of those
migrations and still has no FK on `profiles`. That is the whole reason the gate
is worded as "against the reconciled schema".

## 5. What remains yours

- **Two tables still straddle two rulings** — `rent_buddy_review_notes`
  (is the author a user or an admin?) and `journey_shadow_cohort_assignments`
  (is research consent evidence Portava must retain, and for how long?). The
  exact ambiguous columns are recorded in `src/lib/d6Classifications.ts`.
- **The 61 dormant blockers** need the same treatment the five got.
- **31 auth users with no profile**, unexplained.
- **`0035_plan_geofences.sql`** — one policy missing on CI, outside the approved
  scope.
