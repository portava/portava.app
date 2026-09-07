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
