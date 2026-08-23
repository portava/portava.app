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

### A second prerequisite, in code rather than schema

Once profiles cascades, the cascade reaches `intel_observations`, whose
**statement-level** append-only trigger fires *even when zero rows would be
deleted*. Calling `erase_intel_for_actor()` and letting its transaction end is
not enough: the transaction that deletes the auth user must still hold
`portava.erasure_in_progress`.

Proven on CI — the first end-to-end probe failed exactly there, with
`intel_observations is append-only: DELETE is not permitted at statement level`.
The trigger is doing its job. The worker needs the change before convergence, and
no schema precondition can assert a code change, so it is written down here.

### The 61 blockers are resolved — and cleared the way to a worse problem

`2138_profiles_fk_convergence_prep.sql` converts all 61: **58 → SET NULL** (the
record survives, the actor is severed), **3 → CASCADE** (the row is that person's
own data). 21 columns were `NOT NULL` and are widened first, because a SET NULL
rule on a NOT NULL column does not sever — it raises 23502 and aborts, which is
exactly what made `moderation_reports.reporter_id` the fifth blocker in 2135.

Applied to CI; the postcondition — *zero remaining blockers* — passed, and 2136's
first two gates now report **PROCEED**.

One edge was decided by the schema rather than by the rulings.
`user_deletion_requests.user_id` was classified SET NULL, and Postgres refused:
`column user_id is in a primary key`. It is not part of the key, it **is** the
key. A record whose only identifying column is the identity being erased cannot
outlive it, so it becomes CASCADE — **which means Portava currently has no
deletion audit record at all.** The row proving a deletion was requested,
scheduled and executed dies in the act of executing.
`journey_revocation_jobs` keeps an equivalent record for the Journey scope
because it has a surrogate id, so the two disagree about whether Portava can
evidence its own deletions. If the answer must be yes, that needs a separate
append-only record keyed by a pseudonymous reference — a design decision, not a
constraint edit.

### Completing a deletion is not the same as doing it correctly

Clearing the blockers exposed the more dangerous half. **168 foreign keys point
at `profiles` with `ON DELETE CASCADE`.** They are dormant for the same reason
the blockers were, and they activate on the same event — but they do not reject
a delete, they perform one. Among them are records belonging to other people.

Demonstrated on CI, converged shape, before any gate was written:

| | |
|---|---|
| thread with one message from the departing user and one bystander reply | `messages` before = **2** |
| after the converged deletion | `messages` after = **1** |

The bystander was left holding a reply to a message that no longer exists.
Ruling 3 names this case in as many words — content is deletable *"unless
retaining a minimal tombstone is required to preserve another user's conversation
or transaction integrity."* A conversation is the canonical example, and
convergence would delete one side of it.

2136 therefore gained a **third precondition**, which refuses while any of 18
shared-content edges still cascade:

```
GATE CORRECTLY REFUSES: 18 destructive CASCADE edge(s):
circles.owner_id, discovery_place_reports.reporter_id, event_reviews.reviewer_id,
event_updates.author_id, events.host_id, highlight_replies.replier_id,
live_place_recaps.owner_id, local_guide_contributions.guide_id, meetups.creator_id,
message_thread_members.user_id, message_translations.recipient_id, messages.sender_id, …
```

These 18 need the same ruling-based pass the 61 got. `messages.sender_id` is the
worked example: it should become a tombstone (SET NULL), so the conversation
survives with an anonymous sender, rather than a cascade that removes half of it.

### Order of operations

1. ~~Resolve the 61 dormant blockers~~ **DONE** — 2138, applied to CI.
1b. Rule on the 18 shared-content CASCADE edges. Not optional: without it,
   convergence completes a deletion by destroying other users' conversations.
2. Change the deletion worker to hold the erasure declaration across the auth
   delete.
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

## 5. What remains yours

- **Two tables still straddle two rulings** — `rent_buddy_review_notes`
  (is the author a user or an admin?) and `journey_shadow_cohort_assignments`
  (is research consent evidence Portava must retain, and for how long?). The
  exact ambiguous columns are recorded in `src/lib/d6Classifications.ts`.
- **The 61 dormant blockers** need the same treatment the five got.
- **31 auth users with no profile**, unexplained.
- **`0035_plan_geofences.sql`** — one policy missing on CI, outside the approved
  scope.
