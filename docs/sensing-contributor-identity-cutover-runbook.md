# Sensing contributor-identity cutover runbook (3002 → 3003 → 3310 + code)

**Status: REHEARSED FORWARD ON portava-ci, 2026-09-26. NOT EXECUTED ON PRODUCTION.**

This is the executable procedure for the one migration set in the sensing lane
that is a **coupled schema/code cutover** rather than an additive migration.
"Apply it in the same cutover" is not a mechanism; this document is the
mechanism.

Everything below that states a fact about a database was measured against that
database on 2026-09-26, not inferred from the migration files. Where a step has
not been executed, it says so.

---

## 1. Why this set is coupled

`3002_intel_contribution_identity.sql` replaces the actor identity stored on
sensing rows with a **rotating, epoch-scoped contributor token** derived from a
pepper that lives in `intel_contributor_pepper` — a table with RLS on, zero
policies, and no grant to any application role, including `service_role`.
Nothing outside the database can read it.

That single change breaks compatibility in **both** directions:

### 1a. NEW code on OLD schema → writes fail

`writeObservation` can legitimately produce a row whose `subject_id` is NULL —
the two §18.3 outcomes (`unknown`, `temporary_world_object`) have no canonical
place to point at, and 3002 is the migration that makes the column nullable and
adds `subject_resolution_check` to require a `zone_id` instead.

Production's `intel_observations.subject_id` is **NOT NULL** today (measured).
So new code against the old schema raises `23502` on exactly those captures.

### 1b. OLD code on NEW schema → silent duplicate rows

`findReplayedObservation` on `origin/main` has **no token path**. Post-3002 the
stored contributor id rotates per pepper epoch, so the unique index that makes a
replay detectable no longer matches across an epoch boundary. Old code does not
error — it inserts a second row and reports success. This is the worse
direction, because nothing goes red.

Neither version may serve traffic while the other's schema is live. Hence the
quiesce below.

---

## 2. The write surface — measured, not assumed

Exactly **four** tables carry the token-assignment trigger. Measured on
portava-ci from `pg_trigger`, all four are **`BEFORE INSERT FOR EACH ROW`**:

| Table | Trigger |
|---|---|
| `intel_observations` | `intel_observations_contributor_token` |
| `intel_evidence` | `intel_evidence_contributor_token` |
| `intel_confirmations` | `intel_confirmations_contributor_token` |
| `intel_presence_verifications` | `intel_presence_verifications_contributor_token` |

**Consequence that narrows the whole cutover:** the trigger fires on INSERT
only. UPDATE and DELETE paths — retention sweeps, moderation transitions,
`erase_intel_for_actor` — do not assign tokens and are **not** part of the
quiesce scope. Only insert paths must be stopped.

No database function inserts into these four tables (checked by scanning every
`pg_proc.prosrc` in `public` for an insert against them: zero matches). The
entire write surface is application-side.

### 2a. The quiesce lever is THREE flags, not one

This is the part that a "flip the sensing flag" plan gets wrong.

| Insert path | Gate | Flag(s) that must be OFF |
|---|---|---|
| `intel_observations` via `writeObservation` | `artifacts/api-server/src/services/intel/IntelCaptureService.ts:435#surfaceFlagEnabled(sc,` | `intel_capture_quick_signal` |
| `intel_presence_verifications` via `recordPresenceVerification` (called inside `writeObservation`) | `artifacts/api-server/src/services/intel/IntelCaptureService.ts:352#intel_presence_verifications` | `intel_capture_quick_signal` |
| `intel_confirmations` via `confirmClaim` | `artifacts/api-server/src/services/intel/IntelCaptureService.ts:807#captureSystemEnabled(sc)))` | **both** `intel_capture_quick_signal` **and** `intel_trail_followup` |
| `intel_evidence` via the map-contribution capture | `artifacts/api-server/src/lib/intelEvidenceCapture.ts:205#intel_capture_quick_signal` | `intel_capture_quick_signal` |
| `intel_evidence` via the media evidence link | `artifacts/api-server/src/lib/media/mediaEvidenceLink.ts:130#MEDIA_EVIDENCE_FLAG` | `media_evidence_enabled` (`artifacts/api-server/src/lib/media/mediaEvidenceLink.ts:56#media_evidence_enabled`) |

Two traps, both load-bearing:

1. **`captureSystemEnabled` is an OR**, not an AND
   (`artifacts/api-server/src/services/intel/IntelCaptureService.ts:140#captureSystemEnabled`).
   Turning off `intel_capture_quick_signal` alone leaves the confirm path open
   for as long as `intel_trail_followup` is on. `surfaceFlagEnabled`
   (`artifacts/api-server/src/services/intel/IntelCaptureService.ts:130#surfaceFlagEnabled`)
   is the AND — the trail surface additionally requires quick-signal — which
   makes it easy to assume one flag closes everything. It does not.
2. **`intel_evidence` has a second writer** behind an entirely different flag,
   in the media lane rather than the sensing lane.

**Therefore the quiesce set is exactly:**

```
intel_capture_quick_signal = false
intel_trail_followup       = false
media_evidence_enabled     = false
```

### 2b. Why the quiesce bites immediately

`isFlagEnabled` (`artifacts/api-server/src/lib/featureFlags.ts:14#isFlagEnabled`)
reads `feature_flags` on **every** call — there is no cache, no TTL, no process
memo. A flag flip therefore takes effect on the very next request, with no
propagation delay to wait out and no instance to restart.

It is also fail-closed: an error returns false, and a **missing row** returns
false too, because `maybeSingle()` yields `data = null` and
`artifacts/api-server/src/lib/featureFlags.ts:22#Boolean((data` coerces that to
`false`.

---

## 3. Measured starting state, 2026-09-26

### Production (`ajrurzioarfkagpuxfnb`) — READ ONLY in this session

| Fact | Value |
|---|---|
| `intel_observations` / `intel_evidence` / `intel_confirmations` / `intel_presence_verifications` rowcounts | **0 / 0 / 0 / 0** |
| `intel_observations.subject_id` nullable | **NO** |
| `intel_contributor_pepper` | absent |
| `intel_contributor_token` function | absent |
| `intel_capture_quick_signal` | **true** |
| `intel_trail_followup` | **true** |
| `media_evidence_enabled` | **row absent** → reads false → path already closed |
| `sensing_presence_context_enabled` | **row absent** (3004 not applied) |

So on production **the sensing write path is OPEN right now**, and 3002/3003/3310
are genuinely unapplied. The four tables being empty is the single biggest
simplifier here: there is no backfill, and nothing to lose if a write is
refused during the window.

### portava-ci (`hwokxgbmezheskbzskfr`) — the rehearsal target

3004, 3110, 3002, 3003 and 3310 are all applied, verified and recorded in
`public.schema_migration_ledger`. 2277 and 2278 were already applied before this
work began. `sensing_presence_context_enabled` and `media_evidence_enabled` are
both `false`; the two capture flags are `true`.

---

## 4. The cutover

Times assume the four tables stay small. Every VERIFY step is a gate: if it does
not return the stated result, **stop** and go to §5.

### Step 0 — preconditions (no writes)

```sql
-- Must be 0/0/0/0, or this runbook's rollback analysis in §5 does not hold.
select
  (select count(*) from public.intel_observations)          as observations,
  (select count(*) from public.intel_evidence)              as evidence,
  (select count(*) from public.intel_confirmations)         as confirmations,
  (select count(*) from public.intel_presence_verifications) as presence_verifications;

-- 3002 refuses unless 2277 and 2278 are present. Check BEFORE the window opens.
select filename from public.schema_migration_ledger
where filename like '2277%' or filename like '2278%';
```

On production, 2277 and 2278 are **absent** and must be applied first, under
their own owner sanction. That is a prerequisite of this cutover, not a step
inside it.

### Step 1 — QUIESCE (opens the window)

```sql
update public.feature_flags
   set enabled = false, updated_at = now()
 where flag in ('intel_capture_quick_signal','intel_trail_followup','media_evidence_enabled');
```

If `media_evidence_enabled` has no row (as on production today), that is fine —
absence already reads false. Do **not** insert it just to set it false; that
changes the flag inventory for no gain.

VERIFY:

```sql
select flag, enabled from public.feature_flags
 where flag in ('intel_capture_quick_signal','intel_trail_followup','media_evidence_enabled');
```
All returned rows must read `false`.

### Step 2 — DRAIN in-flight requests

The flags bite on the next request, but a request that already passed its gate
is still running. Wait for **in-flight completion**, not for a timer: the
longest capture path is a single insert plus a best-effort audit insert.

Wait `max(request timeout, 30s)` after the VERIFY in step 1, then confirm
quiet.

### Step 3 — VERIFY QUIET (the gate that actually matters)

```sql
select
  (select count(*) from public.intel_observations)           as observations,
  (select count(*) from public.intel_evidence)               as evidence,
  (select count(*) from public.intel_confirmations)          as confirmations,
  (select count(*) from public.intel_presence_verifications) as presence_verifications,
  greatest(
    coalesce((select max(created_at) from public.intel_evidence), 'epoch'::timestamptz),
    coalesce((select max(created_at) from public.intel_confirmations), 'epoch'::timestamptz)
  ) as newest_write;
```

Run it twice, 30 seconds apart. **The counts must be identical across both
runs.** A count that moves means a writer you have not accounted for; stop and
find it before applying anything.

### Step 4 — APPLY, in order, each in its own transaction

`3002` → `3003` → `3310`. Each file carries its own PRE/POST condition blocks
and raises rather than half-applying. Apply through
`scripts/src/apply-migrations.ts` where the environment has
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`, so the ledger row and its checksum
are written by the tooling.

Order is not cosmetic: 3003 rebuilds `erase_intel_for_actor` on top of 3002's
version, and 3310 adds the consent bridge over 3002's pepper. Applying 3310
first leaves the erasure path referencing a pepper that does not exist.

VERIFY after each file, independently of the file's own POST block — the
queries in §6 are the ones used in the rehearsal.

### Step 5 — DEPLOY the code

Deploy the branch carrying the token-aware `findReplayedObservation` and the
nullable-`subject_id` capture path. Until this completes, the **old** code is
running against the **new** schema — direction 1b — which is precisely why the
write path is still quiesced. Do not un-quiesce before the deploy is confirmed
healthy.

### Step 6 — SMOKE, still quiesced

Read-only checks only. The write paths are closed, so a capture cannot be
smoke-tested here; that is deliberate, and it is the cost of a safe window.

### Step 7 — UN-QUIESCE

```sql
update public.feature_flags
   set enabled = true, updated_at = now()
 where flag in ('intel_capture_quick_signal','intel_trail_followup');
```

`media_evidence_enabled` was already false before the window on both databases —
**restore it to its pre-window value, which is `false`.** Turning it on here
would be an unrelated feature launch riding a migration window.

### Step 8 — VERIFY REALIZED

The first real capture after un-quiesce must land with a non-null contributor
token. Until one does, this cutover is *deployed*, not *production-verified*.

---

## 5. Rollback

**Rollback is feasible only while the four tables are empty.** That is true on
both databases today and it is the reason this window is cheap. Once rows carry
tokens, 3002 is not reversible without destroying the actor linkage those rows
no longer store in any other form.

| Failure at | Action |
|---|---|
| Step 1–3 (before any DDL) | Un-quiesce (step 7). Nothing else changed. |
| Step 4, a file raised | That file is atomic and rolled itself back. Leave earlier files applied — each is independently consistent — and un-quiesce. Diagnose with the window closed. |
| Step 5, deploy failed | **Do not un-quiesce.** The old code is live against the new schema (direction 1b). Either roll the deploy forward, or roll the schema back with §5a and then un-quiesce. |
| Step 7+, writes wrong | Re-quiesce (step 1) first, then decide. |

### 5a. Executable schema rollback — NOT REHEARSED

```sql
-- PRECONDITION. If any count is non-zero, STOP: this drops the only copy of
-- those rows' contributor identity.
do $$
declare n bigint;
begin
  select (select count(*) from public.intel_observations)
       + (select count(*) from public.intel_evidence)
       + (select count(*) from public.intel_confirmations)
       + (select count(*) from public.intel_presence_verifications)
    into n;
  if n <> 0 then
    raise exception 'REFUSING ROLLBACK: % sensing rows exist; their contributor identity is stored only as a token and dropping the pepper destroys it', n;
  end if;
end $$;

drop trigger if exists intel_observations_contributor_token          on public.intel_observations;
drop trigger if exists intel_evidence_contributor_token              on public.intel_evidence;
drop trigger if exists intel_confirmations_contributor_token         on public.intel_confirmations;
drop trigger if exists intel_presence_verifications_contributor_token on public.intel_presence_verifications;

drop function if exists public.intel_consented_contributor_tokens(uuid[]);
drop function if exists public.intel_contributor_tokens_for_actor(uuid);
drop function if exists public.intel_contributor_token(uuid, timestamptz);
drop function if exists public.intel_assign_contributor_token();
drop function if exists public.intel_self_contributor_tokens();
drop function if exists public.intel_contributor_token_for_pepper(uuid, integer, text);
drop table if exists public.intel_contributor_pepper;

-- Re-tighten only if the column has no NULLs, which the precondition guarantees.
alter table public.intel_observations alter column subject_id set not null;
alter table public.intel_observations drop constraint if exists subject_resolution_check;
```

`erase_intel_for_actor` must then be restored to its pre-3002 body. Four
migrations define that function — `2130_intel_storage.sql`,
`2278_intel_scoped_trust.sql`, then 3002 and 3003 — so the body to replay is
**2278's** where 2278 is applied (portava-ci today) and **2130's** where it is
not (production today, unless 2277/2278 go in first as §4 step 0 requires).
Replaying the wrong one silently reinstates an erasure path that misses the
scoped-trust arms. **This script has been written
and reviewed but NOT executed against any database.** An unexecuted rollback is
a plan, not a proven capability, and this document does not claim otherwise.

---

## 6. Verification queries used in the rehearsal

```sql
-- Token functions: shape, security, volatility, grants.
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       pg_get_function_result(p.oid) as result, p.prosecdef, p.provolatile,
       has_function_privilege('anon', p.oid, 'EXECUTE')          as anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
       has_function_privilege('service_role', p.oid, 'EXECUTE')  as svc_exec
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname like 'intel_c%token%';

-- The pepper must stay unreadable by every application role.
select relrowsecurity,
       (select count(*) from pg_policies where schemaname='public' and tablename='intel_contributor_pepper') as policies,
       has_table_privilege('anon','public.intel_contributor_pepper','SELECT')          as anon_sel,
       has_table_privilege('authenticated','public.intel_contributor_pepper','SELECT') as auth_sel,
       has_table_privilege('service_role','public.intel_contributor_pepper','SELECT')  as svc_sel
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname='intel_contributor_pepper';
```

Expected after 3310: both bridge functions `uuid[] → uuid[]`, SECURITY DEFINER,
volatility `s` (STABLE — they mint nothing, unlike `intel_contributor_token`
which is `v`), `search_path` pinned empty, EXECUTE for `service_role` only; the
pepper with RLS on, **zero** policies, and SELECT false for all three
application roles.

---

## 7. What the rehearsal proved, and what it did not

**Proved on portava-ci:** the four files apply cleanly in order against a
database in production's shape; every POST block passes; the resulting objects
match the verification queries above; the ledger records each with the file's
SHA-256.

**Not proved:**

- The rollback in §5a has never been executed anywhere.
- No capture has been written through the new code against the new schema on
  any database — the rehearsal applied schema, not traffic.
- Nothing here has touched production.

**A fidelity caveat on the rehearsal, recorded because it is true rather than
because it matters:** the SQL executed during the rehearsal was each file with
its SQL comments stripped, including comments inside function bodies. A
controlled probe confirmed the transport preserves comments, so the stripping
was the operator's. Every stored function body was then compared against its
file body with comments and blank lines normalised away and found identical, so
the applied semantics are correct — but a byte-level `pg_proc.prosrc` diff
against these files will differ until the real apply tooling replays them.
