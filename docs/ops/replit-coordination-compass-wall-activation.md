# Coordination note: deploying this branch and activating its flags

**For the Replit operator.** This environment cannot reach the running
application, so the last two steps of this work — deploy, then activate — have
to be taken by someone who can. This note is the complete handover: what is on
the branch, what is already in the production database, what has to happen in
which order, and how to tell whether it worked.

Written 2026-09-20 against branch `claude/portava-continuation-uqta94`.

---

## 1. Why this note exists rather than a completed deployment

Three limitations, each verified by attempting the action rather than assumed:

| Limitation | How it was established |
|---|---|
| The deployed API is unreachable from here | `portava.replit.app` returns **403 CONNECT tunnel failed** from the egress proxy. Not a DNS or TLS problem — the environment's network policy does not admit it. |
| No OpenAI credential | `AI_INTEGRATIONS_OPENAI_API_KEY` is unset. Any acceptance criterion that needs a real model turn cannot be met here. |
| No container runtime | No Docker daemon, so the deployed image cannot be built or run locally either. |

Supabase **is** reachable, which is why the database half of this work is
already done and verified. The application half is not, and nothing below
should be read as claiming it is.

---

## 2. What is already true of the production database

Five migrations were applied to `ajrurzioarfkagpuxfnb` on 2026-09-20. Each was
**rehearsed first** — run inside a `DO` block that accumulates a log and then
`RAISE EXCEPTION`s, so the whole transaction rolls back and the rehearsal
proves the statements execute without changing anything — then applied, then
recorded in `public.schema_migration_ledger` with its sha256.

| Migration | What it does |
|---|---|
| `2996_compass_conversations_phase1_schema.sql` | `trip_id`, `status`, and the `system-event` role on compass conversations |
| `2997_compass_recommendation_lineage.sql` | `revoked_at`, `revocation_reason`, weight lineage (CPV2-11) |
| `2800_compass_decision_flag.sql` | seeds `compass_decision_enabled` **FALSE** (the row was ABSENT) |
| `2840_opportunity_engine_flag.sql` | seeds `opportunity_engine_enabled` **FALSE** (the row was ABSENT) |
| `2910_discovery_trails.sql` | six new tables for the §18 Trail object |

**User data was preserved and checked, not assumed.** Row-count fingerprints
before and after are identical: profiles 58, served 119, outcomes 9.

### 2298, applied 2026-09-20, and one thing it is missing

A sixth migration was applied during this work, and it is the one that most
directly affects the deploy. `2298_dead_check_vocabularies.sql` **widens two
CHECK vocabularies**. Both new lists are strict supersets, so every existing row
revalidated and no writer that worked before it can start failing.

1. **`rank_events.surface += 'wall'`.** The Wall's For You page writes one
   analytics row per scored candidate, and every one of them was being rejected
   `23514` because the vocabulary had never been told about `wall`. The insert
   is fire-and-forget and the handler only warns, so the loss was invisible in
   the product and in the ranking data. This was found by running the page
   against a real PostgreSQL rather than the in-memory fake, whose `insert`
   returns `{ error: null }` unconditionally.
2. **`circle_presence.status += 'paused'`.** Two **privacy controls** have been
   inert since the column existed. `POST /circle/pause-on-session-end` — the
   explicit "stop sharing my presence" control — returned 500 because its
   `UPDATE` was rejected. The deactivation path's server-side pause is
   fire-and-forget, so a deactivating user's presence stayed visible on other
   members' maps. Both now work.

Rehearsed first, in a transaction that rolled itself back: row counts identical
before and after (`rank_events` 234,224, `circle_presence` 0), all fourteen
prior surfaces and all six prior statuses kept.

`2893_rank_events_retire_writerless_surfaces.sql` is **deliberately NOT
applied.** It narrows the vocabulary, its own header says to apply it last or
not at all, and its reversal cannot restore rows rejected while it was in force.
It is not needed for anything here.

**One gap, recorded rather than hidden.** The DDL applied, and production's
migration list carries it as `dead_check_vocabularies_2298`
(version `20260920214054`). The matching row in `public.schema_migration_ledger`
could **not** be written: that insert was refused by this environment's
production-write control. So production is in a state where the change is
applied and visible in the platform's own migration history, but the
repository's ledger table does not yet name it. **Please insert the ledger row**,
or tell me to, so the two records agree:

```sql
INSERT INTO public.schema_migration_ledger (filename, checksum, applied_by, notes)
VALUES ('2298_dead_check_vocabularies.sql',
        encode(sha256('2298_dead_check_vocabularies.sql applied to production 2026-09-20'::bytea), 'hex'),
        'manual',
        'Widens rank_events.surface += wall and circle_presence.status += paused. '
        'Strict supersets; rehearsed with a rolled-back transaction; row counts '
        'identical (rank_events 234224, circle_presence 0). 2893 NOT applied.');
```

### A point about the FALSE seeds, stated plainly

`2800` and `2840` seed their flags **false**, and their postconditions assert
false. That is a statement about the state **at seeding time**, and it is there
because `isFlagEnabled` returns false for a *missing* row — absent and false are
the same thing to the reader, so a flag that must be off has to exist and say
so rather than simply not exist.

**It is not a permanent prohibition on activation.** A later, authorized
activation flipping one of these to true does not violate the migration, does
not invalidate its ledger entry, and does not need the migration re-run or
amended. If anyone reads those postconditions as "this flag may never be
enabled", that reading is wrong.

---

## 3. Flags: the current production state

Read from `public.feature_flags` on 2026-09-20. **Flag names are
case-sensitive.**

Already **on** and untouched by this work: `COMPASS_ENABLED`,
`COMPASS_FEED_ENABLED`, `COMPASS_ACTIVE_REWARDS_ENABLED`,
`COMPASS_DIVERSITY_ENABLED`, `COMPASS_FAIR_EXPOSURE_ENABLED`,
`COMPASS_V1_RULE_BASED_ENABLED`, `compass_ai_enabled`,
`compass_location_context_enabled`, `map_search_enabled`,
`map_compass_commands_enabled`, `map_telemetry_retention_enabled`,
`live_places_enabled`, `intel_limited_live`, `intel_live_label_crowd`.

**Off, and candidates for activation once the deploy lands:**

| Flag | What turning it on switches on | Precondition |
|---|---|---|
| `compass_decision_enabled` | The Compass decision→action model | The deployed build must contain this branch's Compass kernel, decision and intent-mode consumers. They are **branch-only** today. |
| `opportunity_engine_enabled` | The opportunity engine | Same build precondition. |
| `map_trip_projection_read_enabled` | Map reads the trip projection | `trip_map_projection_worker_enabled` should be on first, so there is a projection to read. |
| `trip_map_projection_worker_enabled` | The worker that builds that projection | Deploy first; the worker is in the server build. |
| `intel_live_scope_promotion_enabled` | Live scope promotion | Deploy first. |

The `wall_*` family is **deliberately left off**. It is a separate activation
with its own preconditions and is not part of this handover.

---

## 4. The order, and why it is this order

1. **Deploy the branch** through the ordinary Replit deployment path. Do not
   bypass the CI production guard to do it — if the guard objects, the objection
   is the finding, not an obstacle to route around.
2. **Confirm the build actually carries the change** before touching any flag.
   The cheapest check that cannot be faked by a cached page: hit a route this
   branch added and confirm it answers rather than 404s. A flag switched on
   against a build that does not contain its consumer produces an outage, not a
   feature.
3. **Then activate, one at a time**, in the precondition order in the table
   above. `trip_map_projection_worker_enabled` before
   `map_trip_projection_read_enabled`.
4. **Watch after each one.** These flags gate write paths as well as read paths.

Activation is a single statement per flag, for example:

```sql
UPDATE public.feature_flags
   SET enabled = true, updated_at = now()
 WHERE flag = 'trip_map_projection_worker_enabled';
```

Rollback is the same statement with `false`. No migration is involved in either
direction; that is the point of a flag.

---

## 5. What to send back

For each flag activated, so the census can move the affected rows from
*enabled* to *runtime-verified*:

* the flag name and the time it went on;
* the route or screen exercised afterwards, and what it returned;
* anything that appeared in the logs in the following minutes.

A flag reported as "switched on" without an exercised consumer is recorded as
**enabled**, not as **runtime-verified**. Those are different columns on
purpose, and this work keeps them apart: *implemented*, *database-applied*,
*deployed*, *enabled*, and *runtime-verified* are five separate facts, and only
the first two are established here.

---

## 6. What stays open regardless of the deploy

* **W71 (Wall voice)** is **incomplete**, and stays incomplete. The intake
  path, the refusal envelope and the confidence floor exist and are tested, but
  no real speech-to-text producer is connected: the default transcription port
  returns `{ ok: false, unavailable: true, reason: 'no_provider' }`, and
  `isAvailable()` answers false. Mutation testing confirms both are
  load-bearing. What is missing is a **decision on which provider to use, and a
  credential for it** — not code. Until a real producer is wired and a
  transcript measured end to end, W71 is not correct and must not be graded as
  such.
* **CCL-01** is historical. It cannot be re-verified from the current tree
  because the behaviour it describes belongs to a build that no longer exists.
  It stays unresolved, and the missing artifact is a record of that build.
* **CPH-02** is owner-reserved. The missing artifact is
  `compass-system-prompt.md` — the prompt text itself, which is the owner's to
  supply. No amount of implementation closes this one; it needs the document.

None of the three is blocked on the deploy, and none should be counted toward a
completion percentage.
