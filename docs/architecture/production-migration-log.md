# Production migration log

Migrations applied to **production** (`ajrurzioarfkagpuxfnb`) during the
autonomous pass, in the order applied. Each passed the migration safety gate:
contents inspected, dependencies established, preconditions run, postconditions
proven non-vacuous, applied to portava-ci first and verified there, then applied
to production and re-verified independently.

Production has no `schema_migration_ledger`; provenance is Supabase's own
`supabase_migrations.schema_migrations`, written by the apply.

---

## 2026-09-07 — Meetups: a surface that did not work at all

### Before, measured on production
All four meetup tables were **completely unreadable** through RLS. Probed as
role `authenticated`:

| table | result |
|---|---|
| `meetups` | `42P17` infinite recursion detected in policy for relation "meetups" |
| `meetup_invites` | `42P17` … for relation "meetup_invites" |
| `meetup_time_options` | `42P17` … for relation "meetups" |
| `meetup_time_votes` | `42P17` … for relation "meetups" |

The cause was a **length-two policy cycle**, `meetups → meetup_invites →
meetups`, invisible to a "policy selects from its own table" sweep and found
only by a recursive policy-graph walk. Production held 2 meetups and 4 invites
that no user could read.

### 1. `2460_meetup_invites_self_invite_latent_disclosure` — applied first, deliberately inert

`mi_own` was `FOR ALL` with `WITH CHECK (auth.uid() = user_id)` — binding only
the row's owner, not requiring that an invitation exist. The moment the
recursion was repaired, **any authenticated caller could have inserted their own
invite row to any meetup and thereby read it.** So the defuse lands before the
door opens; this is the 2401 → 2402 ordering applied again.

Adds `authz.is_meetup_invitee(uuid)` — `SECURITY DEFINER`, owned by `postgres`,
`search_path` pinned, in schema `authz` which PostgREST does not expose, and
taking **no user-id parameter** (a `(meetup, user)` signature would be an
invitation oracle to `anon`/`authenticated`, who must hold EXECUTE for the
policy to evaluate at all).

**Inertness verified, not assumed**: after applying to CI, all four tables still
returned `42P17`. Nothing observable changed, which is exactly the claim.

### 2. `2461_meetup_rls_recursion` — the repair

Repoints `meetups_invitee_select` and `mto_invitee_select` at the helper, whose
owner-privileged read of `meetup_invites` is what breaks the cycle.

Its postcondition is self-proving: **inside the migration transaction** it
switches to role `authenticated` and reads all four tables. A surviving cycle
raises `42P17` there and aborts the apply. It cannot report success on a
database where the recursion remains.

### 3. `2462_meetup_time_votes_write_boundary` — the write the repair exposed

`mtv_own` was `FOR ALL` with no `WITH CHECK`, so `USING` doubled as the write
check and a caller could vote on any option once reads worked. Now requires an
option the caller is admitted to.

Also self-proving: the postcondition attempts a real INSERT on a random option
as `authenticated` and **requires `42501`**. If RLS accepts the write, the
migration raises and rolls back.

### After, measured on production

| table | result |
|---|---|
| `meetups` | readable — **0 of 2** visible to an unrelated user |
| `meetup_invites` | readable — **0 of 4** visible |
| `meetup_time_options` | readable — 0 visible |
| `meetup_time_votes` | readable — 0 visible |

Recursion gone; no row disclosed to a user with no relationship to either
meetup. `meetups.test.ts`, `meetupRlsRecursion.test.ts`, `meetupAgeRsvp.test.ts`
→ 57/57, EXIT 0.

### CORRECTION — what this did and did not change for users

My first write-up of this said "Meetups went from raising a database error on
every read to one that works". **That overclaims it, and the correction matters
more than the claim.**

Measured after the fact: `routes/meetups.ts` reaches every meetup table on
`getServiceClient()`, which is `BYPASSRLS`, and a repo-wide search finds **no
direct client read** of `meetups`, `meetup_invites`, `meetup_time_options` or
`meetup_time_votes` outside `artifacts/api-server`. The mobile client holds a
Supabase client but does not use it for these tables.

So the `42P17` recursion **did not break the app's user-facing path**. It broke
the RLS layer, which is a different and narrower thing.

What actually changed:

1. **RLS became a real second layer instead of an accidental brick wall.** Every
   non-service read failing is fail-closed by accident, not by design — and an
   accident that strict is one policy edit away from being an accident that is
   permissive. It is now a predicate that means something.
2. **A latent disclosure was closed before it could open** (`2460`). `mi_own`
   would have let any authenticated caller mint their own invite and read any
   meetup — reachable the moment the recursion was repaired, which is exactly
   what `2461` then did.
3. **A vote-stuffing write boundary was closed** (`2462`).
4. **A direct PostgREST caller now gets correct answers rather than an error** —
   including any future client that reads these tables without going through the
   API.

**Honest production effect: no user-visible behaviour changed. Three real
security defects were closed and a dead authorization layer was brought back to
life.** That is worth doing and it is not the same as fixing a broken feature.


---

## 2026-09-07 — Trip crew: the membership rule the API means

### `2334_route_plan_crew_visibility` — applied to production

Creates `authz.is_trip_crew(uuid)` and repoints five route-plan policies at it.

The helper is the API's rule, not an approximation of it. `lib/http.ts`
`requireTripMember` consults the membership row when one exists and falls back
to `trips.owner_id` **only when none does** — so the helper is a `CASE`, not a
flat `OR`. A flat `OR` would admit a trip owner whose own membership row says
`status='removed'`, a viewer the API denies. `coalesce(status,'accepted')`
mirrors http.ts's backwards-compatibility line and is inert today because the
column is NOT NULL; it is kept so the predicate cannot quietly change meaning if
that constraint is ever relaxed.

**Before**: five policies joined `trip_members` with no status gate, so a
pending invitee (`role='member', status='invited'`) could read a trip's plan,
stops and legs through direct PostgREST.

**Gate**: preconditions verified on production before applying — `authz` present,
all four route-plan tables present, `trip_members.status` present, and the exact
policy count the postcondition demands (**13** across the four tables). CI has
carried 2334 since earlier, which is a longer-running rehearsal than a rollback
transaction.

**Postconditions** (ran inside the apply): all five policies route through the
helper; **zero** route-plan policies still reference `trip_members` directly;
13 policies still present.


---

## 2026-09-07 — `2337_trip_crew_rls_membership_convergence` applied to production

Twenty-nine policies across nineteen tables stop hand-rolling their own idea of
trip membership. Applied **from the file's exact bytes** rather than retyped: at
~400 executable lines, a transcription slip would have been a production RLS
defect, so the file was read and passed through unmodified except for stripping
the outer `BEGIN;`/`COMMIT;`.

### The ordering hazard that was checked first

`2337` was written **before** the meetup chain was applied. Had it recreated
`meetups_invitee_select`, it would have reintroduced the `meetups →
meetup_invites → meetups` cycle repaired an hour earlier. It does not: it names
that policy only in a comment, and the three meetup policies it does recreate
(`meetups_trip_select`, `mi_trip_select`, `mto_trip_select`) point **downward**
in the layering order. Verified before applying, not after.

### Independently verified on production after the apply

| check | result |
|---|---|
| policy cycles anywhere in `public` (recursive graph walk, depth 4) | **NONE** |
| blanket `auth.uid() IS NOT NULL` predicates on the three tables that had one | **NONE** |
| policies still naming `trip_members` on the 19 converged tables | **NONE** |
| live reads as role `authenticated` across 8 tables | all OK, no error |

The three policies whose entire predicate was `auth.uid() IS NOT NULL` —
`trip_crew_location_events`, `plan_attendance_events`, `plan_checkins` — are the
most serious thing this migration closes. All three were **named** for a
membership check they did not perform.

Read as an unrelated authenticated user afterwards: 12 trips visible (matching
the 12 discoverable), 9 public posts, and **0 meetups, 0 trip plan items** —
correct on the permissive side and correct on the restrictive side. A
convergence that silently over-tightened would show as zeros everywhere; one
that over-loosened would show crew data. Neither happened.


---

## 2026-09-07 — the authorization batch: 2531, 2532, 2533, 2534

All four applied to portava-ci first, verified there, then to production.

### `2531_crew_session_owner_select_owner_only`
`crew_session_owner_select` was `auth.uid() = user_id OR auth.uid() = ANY
(allowed_member_ids)` — no membership, status or expiry check — and it
**dominated** `crew_sessions_recipients_read` completely, so a stranger listed
in `allowed_member_ids` read the session. Now owner-only; the crew-gated
recipient path 2337 repaired becomes the one that decides.

### `2532_pg_policies_snapshot_v2`
Diagnostic only, `service_role`-only. Two RPCs the textual policy guard cannot
work without: policy shapes with `qual` and `with_check` kept **separate** (so a
`FOR ALL` policy with a WITH CHECK is distinguishable from one without), and
every boolean function whose body reads `trip_members`, so the captured
`UNGATED_TRIP_MEMBERS_FUNCTIONS` list can be verified against the live catalog
instead of trusted. Its postcondition carries a positive control: it must see
`authz.is_trip_crew`, or it is not reading function bodies at all.

### `2533_drop_shares_trip_with_oracle` — a DROP
`public.shares_trip_with(uuid)`: SECURITY DEFINER, in PostgREST-exposed
`public`, EXECUTE held by `anon` and `authenticated`, **no role gate and no
status gate** — a social-graph oracle answering "do these two share a trip" for
pending invitees and removed members alike, callable as
`POST /rest/v1/rpc/shares_trip_with`.

Destructive-rule evidence, measured on production before dropping: **0** policies
reference it, **0** functions call it, **0** views reference it, `pg_depend`
reports no dependants, and there is no `.rpc("shares_trip_with")` anywhere in
the repository. The replacement, `authz.shares_accepted_trip`, had to exist
first — the migration refuses otherwise. Rollback:
`db/rollback/2026-09-07-2533-drop-shares-trip-with-oracle-rollback.sql`.

### `2534_can_see_trip_status_gate_and_checklist_write_boundary`
The riskiest of the batch. `can_see_trip` read `role` and never `status`, so
`role='member', status='invited'` passed — and **seventeen** policies bound to
it, including two `FOR ALL` policies with no `WITH CHECK`
(`trip_checklists_members`, `trip_checklist_items_members`) where USING doubled
as the write check. Any viewer of a **public** trip could INSERT, UPDATE or
DELETE checklist rows.

Its precondition asserts the dependant set is **exactly** the seventeen that
were measured, so it refuses to run on a database in an unmeasured state. The
before-state was captured independently first and matched.

Read and write are now separated: `can_see_trip` stays the READ predicate and
routes membership through `authz.is_trip_crew`; writes gate on
`authz.is_trip_crew` or `authz.accepted_trip_role`. Checklist item updates and
deletes require owner / co_host / member — **not viewer**, matching the API.

| after, on production | |
|---|---|
| policies bound to `can_see_trip` | **17 → 9**, all reads |
| `FOR ALL` policies on the checklist tables | **NONE** |
| write policies gating on the read predicate | **NONE** |
| reads as role `authenticated` across 9 tables | all OK |
| `trips` / `trip_members` visible to an unrelated user | 12 / 12, unchanged |

That last row is the check that matters: a status gate applied carelessly would
have shown as a drop in visible rows.


---

## 2026-09-07 — `2530_highlights_trip_only_accepted_crew`, and the end state

`highlights_select_active`'s `trip_only` branch joined `trip_members` to itself
with **no role filter and no status filter**, so a pending invitee read the
`trip_only` highlights of everyone on a trip they had not joined.

2530 does not rewrite the policy; it rewrites **one branch of whatever is live**.
It reads the current `qual`, matches the self-join fragment, refuses if the
policy is not `(SELECT, PERMISSIVE, TO authenticated, no WITH CHECK)`, refuses if
the fragment does not appear exactly once, and — before writing anything —
proves the rewrite changed nothing outside that branch by masking the branch on
both sides and comparing. Then it re-reads what Postgres actually stored and
compares again, because Postgres re-deparses what you give it.

That shape-agnosticism matters here: PR #461's `2313` restructures both SELECT
policies on `highlights` and reproduces the self-join byte-for-byte, so whichever
of the two lands second must not undo the other. 2530 was written to be the one
that adapts.

## End state on production, measured

| invariant | result |
|---|---|
| policy cycles anywhere in `public` (recursive walk, depth 6) | **NONE** |
| blanket `auth.uid() IS NOT NULL` read policies | **NONE** |
| `public.shares_trip_with` social-graph oracle | **DROPPED** |
| `highlights` `trip_members` self-join | **GONE** |
| policies still naming `trip_members` | **4** |

Those four are the ones `2337` measured as **correct as written** and
deliberately did not touch:

- `trip_members_insert` / `trip_members_delete` — they govern who may create or
  remove a membership row. A membership gate here would be circular.
- `tri_member_read` / `trs_member_read` — they already spell out
  `role IN (owner, co_host, member, viewer) AND status accepted OR
  trips.owner_id`. That is `requireTripMember` exactly; somebody got these right
  first, and they are the proof the rule is expressible.

So the residue is not leftover work. It is the set that was already correct.


---

## 2026-09-08 — Trust: `2370` + `2371` applied to production

### `2370_trust_tables_privileges`

**Before, measured:** all seven trust tables — `trust_admin_actions`, `trust_caps`,
`trust_events`, `trust_profiles`, `trust_restrictions`, `trust_reviews`,
`trust_settings` — granted the **full blanket privilege set to `anon` AND
`authenticated`**: DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER,
TRUNCATE, UPDATE. Supabase's `ALTER DEFAULT PRIVILEGES` set that at CREATE TABLE
time and no migration took it back.

Two of the seven (`trust_admin_actions`, `trust_reviews`) already had RLS on with
**zero policies**, so reads were denied — but **RLS does not police TRUNCATE**, so
the destructive capability was live on all seven regardless of policy.

**The gate's decisive check** was the one that could have broken the feature:
`2370` issues `ENABLE ROW LEVEL SECURITY`, which on a table where RLS is off and
no policy exists is a deny-all trap. Measured first: **RLS is already enabled on
all seven**, so the clause is a no-op.

**Nothing can break, established rather than assumed:** every access path is
server-side. Five routes name a trust table (`admin.ts`, `events.ts`,
`rentABuddyMarketplace.ts`, `pulse.ts`, `trust-admin.ts`) and all five use the
service client, as do the trust services. A repo-wide search finds **zero direct
client reads** of any `trust_*` table outside `artifacts/api-server`.

| after, on production | |
|---|---|
| privileges held by `anon` / `authenticated` / PUBLIC on trust tables | **0** |
| `service_role` privileges | 28 — four verbs across seven tables |
| `service_role` TRUNCATE | **0** |
| `trust_events` rows | 5, intact |

**Honest effect: no user-visible change. A live privilege exposure closed.**

### `2371_trust_profiles_evidence`

Two nullable, default-less columns. NULL means "not yet measured", 0 means
"measured, no evidence" — the distinction is load-bearing and is why there is no
backfill.

This one is not a defect being fixed so much as a degradation being lifted, and
the reason is worth recording: `TrustScoreService.ts:350-358` **already handles
the absence correctly**. The evidence write is deliberately kept out of the score
upsert, because folding it in would make PostgREST reject the whole statement and
stop every score persist on a database without 2371 — "silently, exactly as
lib/mediaAssets did for three weeks". It logs a warning naming the migration.

So production was degraded-but-safe, not silently broken, and applying restores
the evidence fields. `trust_engine_enabled` was one of the eleven flags ON in
production over missing schema; this is one of them closed.


---

## 2026-09-08 — `2420` → `2520` → `2610`: the kernel and Map schema exist in production

Applied in dependency order, CI-first for 2520 and 2610 (CI already carried
2420). Each from the file's exact bytes.

### `2420_trip_kernel_foundation`
`trips.version`, `trip_events`, `trip_command_receipts`, `trip_outbox`,
`trip_kernel_execute()` and `trip_events_refuse_update()`.

The fact that made it safe on 43 live rows: **PostgreSQL 17.6**, so
`ADD COLUMN NOT NULL DEFAULT 0` is metadata-only — no table rewrite.

**Row visibility did not change**, which is the check that mattered. Probed as
role `authenticated` with a random subject BEFORE and AFTER: trips 12 → 12,
trip_members 12 → 12, trip_plan_items 0 → 0, posts 9 → 9. A convergence that
quietly widened or narrowed reads would show here and did not.

43 trips read back, all `version = 0`, none NULL.

### `2520_trip_map_projection_worker` and `2610_map_trip_projection_anchor`
The projection tables, the drain and rebuild functions, and the Map-owned
anchor columns with their fill trigger. Both CI-first, both verified there
before production.

### Independently verified after all three (not taken from the applying lane)

| check | result |
|---|---|
| migrations in `supabase_migrations` | `2420`, `2520`, `2610` all present |
| trips | 43, all `version = 0`, 0 NULL |
| `trip_kernel_enabled` / `trip_map_projection_worker_enabled` / `map_trip_projection_read_enabled` | present, **all FALSE** |
| new tables | 5 of 5 present; `trip_outbox` 0 rows, `trip_map_projections` 0 rows |
| **policy cycles across `public`, depth 6** | **NONE** |
| client privileges on the five new tables | **exactly one**: `trip_events` SELECT to `authenticated` |
| client EXECUTE on the four new functions | **NONE** |
| blanket `auth.uid() IS NOT NULL` predicates | **NONE** |

The single client-facing grant is correctly gated: `trip_events_crew_select`
`USING authz.is_trip_crew(trip_id)` — the accepted-crew predicate 2334
installed. The other four new tables carry RLS with no client grant and no
policy, so they are deny-all to clients and reachable only by `service_role`.

### What this does and does not mean

**The schema exists; the features do not run.** All three flags are FALSE, the
outbox is empty, the projection is empty, and none of the application code that
would produce or consume them is deployed — the branch is unmerged. What changed
is that the Map and Discovery capabilities can now become *ready* rather than
being permanently latent, and that the Trip Kernel has somewhere to write.

Three of the eleven ON-and-dead flags depended on `trip_kernel_execute()`
existing — `airport_mode_enabled`, `layover_plans_enabled`, `hidden_gems_enabled`
— and that half of their requirement is now met.


---

## 2026-09-08 — `2490`: `anon` and `authenticated` lose the four privileges RLS does not police

Applied to portava-ci first (`20260908011111`), then production
(`20260908011416`), from the file's exact bytes
(md5 `9f314a7f65a020608e7f6455448b5192`).

### What it closes

`anon` — the **unauthenticated** public role — held `TRUNCATE` on hundreds of
tables in `public`. RLS never consults `TRUNCATE`, `REFERENCES`, `TRIGGER` or
`MAINTAIN`: a policy cannot restrict, narrow or log them. So every carefully
written policy on those tables sat behind a privilege that discards the whole
table without consulting it once.

This is the argument `2333` makes for four derived-memory tables, applied to the
rest of the schema in one statement instead of forty.

### Production, measured before and after

| check | before | after |
|---|---|---|
| app-owned relations granting any of the four to anon/authenticated | **375** | **0** |
| extension-owned (PostGIS) relations still granting them | 3 | 3 *(unreachable — see below)* |
| `service_role` privileges in `public` | 3346 | **3346** |
| client `SELECT/INSERT/UPDATE/DELETE` privileges | 3019 | **3019** |
| `postgres` default ACL re-issuing the four | 8 | **0** |
| `supabase_admin` default ACL re-issuing the four | 8 | 8 *(unreachable)* |

The two unchanged middle rows are the point: this migration is privilege-only
and touches **no DML privilege and no policy**. `service_role` is the server's
own identity and the purge and account-deletion paths depend on it, so it is
deliberately untouched.

### Verified by effective privilege, not only by catalog ACL

The counting query above reads `pg_class.relacl`. That misses two things: a
privilege reachable through **role membership**, and one granted to the
**`PUBLIC` pseudo-role** (whose grantee is `0` and does not join to `pg_roles`).
So the result was re-proved with `has_table_privilege`, which resolves both:

**3472 probes** (434 relations x 2 roles x 4 privileges), **0 held** on any
app-owned relation. The 24 remaining are the three PostGIS relations x 2 roles x
4 privileges.

### Future tables — proved, not assumed

Revoking on existing tables does nothing for the next one created. The migration
also fixes the `postgres` default ACL, and that was verified by creating a real
table and reading its inherited ACL inside a transaction deliberately aborted so
nothing persisted:

- four-privilege leaks on a brand-new table: **NONE**
- DML still inherited normally: `anon:SELECT/INSERT`, `authenticated:SELECT/INSERT`,
  `service_role:SELECT/INSERT`

So the boundary holds going forward *without* breaking ordinary table creation.
Confirmed afterwards that the probe table left nothing behind (0 relations
matching, `public` still at 434).

### The residue, stated rather than hidden

Two things this migration cannot reach, both recorded in the file header:

1. **The `supabase_admin` default ACL.** `ALTER DEFAULT PRIVILEGES` may only be
   issued `FOR ROLE` a role you are a member of, and `postgres` is not a member
   of `supabase_admin`. A relation created *by supabase_admin* in `public` would
   inherit the blanket set again. Every application table is created by
   `postgres`.
2. **PostGIS's three relations** — `spatial_ref_sys`, `geography_columns`,
   `geometry_columns`, all owned by `supabase_admin`. They are excluded by
   **extension ownership** (`pg_depend.deptype = 'e'`), not by name: that states
   the actual reason `postgres` cannot revoke on them, covers all three without
   enumerating them, and will cover the next extension object.

   This exclusion was a correction. The first draft named only `spatial_ref_sys`,
   which would have made the migration **fail its own postcondition** — revoke
   everything reachable, then RAISE because two PostGIS views still held the
   grants, aborting and landing nothing. None of the three holds user data.

### Smoke

`trips` 43, `trust_events` 5, `trip_events` 0, 750 policies in `public`,
relations 434 — all unchanged, and `supabase_migrations` accepted the row, so
the migration path is still operational.
