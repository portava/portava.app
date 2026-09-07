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

**Production effect: Meetups went from a surface that raised a database error on
every read to one that works and discloses nothing.**
