# Production change and runtime verification plan — 2972, 2973, 2974

**Status: PREPARATION ONLY. Nothing in this document has been executed against
production.** Execution is a separate, separately authorized act; see
§8. Production (`ajrurzioarfkagpuxfnb`) has been READ from to write this plan and
has not been written to.

Prepared 2026-09-16 against `main` = `a97bfdac0`.

---

## 1. What these three migrations are, and why they travel together

They are one finding in three places. Supabase's `ALTER DEFAULT PRIVILEGES`
hands `anon` and `authenticated` the blanket privilege set on **every object
created in `public`** — tables and functions alike. Three migrations close three
faces of that single mechanism:

| | object class | what it closes |
|---|---|---|
| **2490** (already applied both DBs) | tables, four unpoliced privileges | TRUNCATE/REFERENCES/TRIGGER/MAINTAIN on 375 tables |
| **2972** | the seven stamp tables | INSERT/UPDATE/DELETE held by client roles since `0081` |
| **2973** | `SECURITY DEFINER` functions | EXECUTE on volatile (writing) functions |
| **2974** | one function body | the caller check `toggle_feature_flag_with_audit` never had |

2490 swept tables and said so in a section titled *"THE HALF THIS MIGRATION
CANNOT REACH"*. Functions were not in that list — not considered and excluded,
simply out of that lane's scope. 2973 is that half.

---

## 2. Production state as measured, 2026-09-16

Read-only queries against `ajrurzioarfkagpuxfnb`.

**Migration ledger.** `SELECT ... FROM schema_migration_ledger WHERE filename >=
'2890'` returns **zero rows**. None of 2890–2974 has been applied to production.
Everything below is therefore a first apply, not a re-apply.

**Function exposure.** 90 application (non-extension) `SECURITY DEFINER`
functions exist in `public`. 21 are reachable by a client role:

| category | count | verdict |
|---|---|---|
| policy-referenced `STABLE` boolean predicates | 12 | **legitimate — must keep EXECUTE** |
| `event_is_in_state` (`STABLE`, referenced by nothing) | 1 | harmless, read-only |
| trigger-returning | 5 | EXECUTE irrelevant to trigger firing |
| **`VOLATILE` writers** | **3** | **the finding** |

The three, all reachable by `authenticated` and **not** by `anon`:

- `increment_distribution_stats(p_item_id text, p_viewer_id text, …)` — any
  logged-in user can inflate distribution statistics for any item, attributed to
  any viewer id.
- `purge_old_ranking_debug_samples()` — any logged-in user can purge ranking
  debug samples. Destructive.
- `upsert_hashtag_usage_and_increment(…, p_author_id uuid, …)` — any logged-in
  user can forge hashtag usage attributed to any author.

**What production is not exposed to.** Probed as `anon`, zero-write:
`upsert_city_stamp` returns `42501 permission denied for function`. Production
is correctly locked on that path. `toggle_feature_flag_with_audit` exists,
`feature_flag_audit_log` exists, and `has_function_privilege('authenticated', …)`
is **false** — so the flag-toggle path is not exposed on production either.

### 2.1 The forecast that makes this urgent

portava-ci has **23** such writers where production has 3. The extra twenty are
not CI drift: they are the functions created by the migrations CI has and
production has not. **Applying the remaining chain to production without 2973
hands production those twenty holes**, including `upsert_city_stamp`,
`increment_stamp_progress`, `increment_counter`, `rb_adjust_buddy_counter`,
`claim_invite_link_slot_for_user` and `toggle_feature_flag_with_audit`.

2973 is therefore a **prerequisite of the chain apply, not a follow-up to it.**

---

## 3. The exact production change

Applied in this order, each in its own transaction:

1. **2972** — `REVOKE INSERT, UPDATE, DELETE` from `anon` and `authenticated` on
   the seven stamp tables; `GRANT` them to `service_role`.
2. **2973** — for every function in `public` that is `SECURITY DEFINER` **and**
   `VOLATILE` **and** not trigger-returning **and** not extension-owned **and**
   not referenced by any RLS policy in any schema: `REVOKE EXECUTE FROM PUBLIC,
   anon, authenticated` and `GRANT EXECUTE TO service_role`.
   On production this predicate matches **64 functions**, of which **3** are
   currently client-reachable. The other 61 are already closed; re-asserting is a
   no-op and keeps the file idempotent.
3. **2974** — create `caller_is_privileged_service()` and replace
   `toggle_feature_flag_with_audit` with a body that refuses a non-privileged
   caller. On production this is defence in depth, not a fix: the ACL already
   denies `authenticated`.

**No table is created or dropped. No row of user data is read, written, moved or
deleted by any of the three.** 2972 and 2973 are privilege-only; 2974 replaces
one function body and adds one helper.

---

## 4. Intended access after the change

The four cases the change must be judged against. "Administrator" is listed
separately and deliberately: **an authenticated administrator is a client user
too**, and the honest statement is not "RLS denies client writes".

| surface | anonymous (`anon`) | ordinary user (`authenticated`) | administrator (authenticated, `profiles.role='admin'`) | service (`service_role`) |
|---|---|---|---|---|
| seven stamp tables — SELECT | unchanged (per existing policy) | unchanged | unchanged | unchanged |
| seven stamp tables — INSERT/UPDATE/DELETE | denied before and after | denied before and after | **PERMITTED before → DENIED after** | permitted |
| volatile `SECURITY DEFINER` functions | denied (prod) → denied | **3 PERMITTED → DENIED** | same as ordinary user | permitted |
| `toggle_feature_flag_with_audit` | denied → denied, twice over | denied → denied, twice over | denied → denied, twice over | permitted |
| 12 policy predicate functions | **unchanged — EXECUTE retained** | **unchanged** | unchanged | unchanged |
| RLS policies | not modified by any of the three | | | |

### 4.1 The administrator row is the one that changes, and why it is safe

2972 removes a path an administrator really does have today: the `admin_all`
policies on `stamp_definitions` and `stamp_campaigns` admit an authenticated
admin's direct write. Removing it is safe because that path is **already
server-mediated** — the admin UI does not write these tables with the anon key.

Checked rather than assumed:

- `travel-buddy-standalone/src` contains **zero** `.rpc(` calls, whole workspace.
- Every `.rpc(` in production code is under `artifacts/api-server/src/`.
- `artifacts/api-server/src/lib/supabase.ts` builds its client with
  `serviceRoleKey`. Every `SUPABASE_ANON_KEY` reference in the api-server is
  under `src/test/`.

So administrator actions reach the database as `service_role` after the
api-server has authorized them. The client-role grant was never what made them
work. `admin_set_profile_role` is the worked example: its own guard,
`caller_may_write_profile_role()`, admits `service_role`/`postgres`/
`supabase_admin` and rejects `authenticated` **by name** — an admin's own JWT was
never the thing that made that call legal.

### 4.2 The one risk that would matter, and how it is bounded

If a function the sweep revokes turns out to be referenced by an RLS policy, that
policy silently denies every row to every client — no error, nothing logged. This
is a real hazard and `checkSecurityDefinerOracles.ts` documents it from a live
measurement.

2973 is bounded against it three ways: policy-referenced functions are excluded
from the sweep predicate (scanned across **all** schemas, so `storage` policies
count); an apply-time check fails the migration if any policy-referenced function
lost a privilege; and a re-runnable postcondition fails if any policy-referenced
function is not executable by `authenticated`. On production that last count is
currently **0**.

---

## 5. Prerequisites

Every one of these must hold before execution. Unchecked items are blockers.

- [ ] 2973 and 2974 are merged to `main` and have been applied **and certified**
      against portava-ci by `live-db.yml`, with `certify:migrations` green
      through all five stages.
- [ ] `check:all` is green in CI at the same commit, **including** the five
      credential-dependent checks that exit 2 locally
      (`write-path-columns`, `missing-live-columns`, `authorization-contract`,
      `media-objects`, `rank-events-surfaces`). Exit 2 is *unverified*, not a
      pass; these are only meaningful when they run with credentials.
- [ ] The production ledger still shows zero rows `>= '2890'` at execution time
      (re-read immediately before; do not trust this document's snapshot).
- [ ] Production's postcondition inputs re-measured immediately before, and
      matching §2: population ≥ 40 (measured 90), sweep targets ≥ 3
      (measured 64), policy helpers missing `authenticated` EXECUTE = 0.
- [ ] A named human holds production credentials and is executing. **CI cannot
      do this** — see §8.
- [ ] Decide explicitly whether 2890–2971 are applied in the same window or
      whether 2972–2974 are applied ahead of them. §2.1 argues 2973 should not
      *follow* the chain; applying it first or in the same transaction batch is
      what makes the chain safe.

---

## 6. Runtime verification plan

Run **before** (to record the baseline) and **after**. Every probe below is
read-only or self-rolling-back; none writes a row.

### 6.1 Ledger

```sql
SELECT filename, applied_by, applied_at
FROM schema_migration_ledger
WHERE filename IN ('2972_stamp_family_write_boundary.sql',
                   '2973_security_definer_execute_boundary.sql',
                   '2974_toggle_feature_flag_caller_guard.sql')
ORDER BY filename;
```
Expect three rows after; zero before.

### 6.2 The 2973 invariant, which is also its own postcondition

```sql
SELECT count(*) AS client_reachable_writers,
       string_agg(p.proname, ', ' ORDER BY p.proname) AS names
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
WHERE n.nspname = 'public' AND p.prosecdef AND p.provolatile = 'v'
  AND p.prorettype <> 'trigger'::regtype AND d.objid IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies pol
    WHERE coalesce(pol.qual,'')||' '||coalesce(pol.with_check,'') ~ ('\m'||p.proname||'\M'))
  AND (has_function_privilege('anon', p.oid, 'EXECUTE')
       OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
```
**Before: 3** (`increment_distribution_stats`, `purge_old_ranking_debug_samples`,
`upsert_hashtag_usage_and_increment`). **After: 0.**

### 6.3 The policy predicates still work — the check that matters most

```sql
SELECT count(*) AS broken_policy_helpers,
       string_agg(p.proname, ', ') AS names
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND EXISTS (SELECT 1 FROM pg_policies pol
              WHERE coalesce(pol.qual,'')||' '||coalesce(pol.with_check,'') ~ ('\m'||p.proname||'\M'))
  AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE');
```
**Before and after: 0.** Any non-zero here is a read outage for every logged-in
user and is grounds for immediate recovery (§7).

`authenticated` and not both roles, deliberately: production withholds `anon`
EXECUTE from `post_media_path_is_moderated` **on purpose**, and a check
demanding both would fail on correct state.

### 6.4 service_role keeps what it needs

```sql
SELECT count(*) AS service_role_gaps
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN pg_depend d ON d.objid = p.oid AND d.deptype = 'e'
WHERE n.nspname='public' AND p.prosecdef AND p.provolatile='v'
  AND p.prorettype <> 'trigger'::regtype AND d.objid IS NULL
  AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
```
**After: 0.** Non-zero means a broken RPC path, not a hardening.

### 6.5 The four access cases, exercised rather than reasoned about

Each runs inside `BEGIN … ROLLBACK`. The nonexistent-flag trick is what makes
these safe: `42501` means the guard refused, `P0002` means the guard passed and
the lookup ran, and **neither writes a row**.

```sql
BEGIN;
  SET LOCAL ROLE anon;
  SELECT public.toggle_feature_flag_with_audit('__probe_no_such_flag__', true, NULL);
ROLLBACK;
-- expect: 42501 toggle_feature_flag_with_audit: caller is not privileged
```

```sql
BEGIN;
  SET LOCAL ROLE authenticated;
  SELECT public.upsert_hashtag_usage_and_increment(
    '00000000-0000-0000-0000-000000000000'::uuid,'probe',
    '00000000-0000-0000-0000-000000000000'::uuid,
    '00000000-0000-0000-0000-000000000000'::uuid,'probe','probe');
ROLLBACK;
-- before: executes.  after: 42501 permission denied for function
```

```sql
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims = '{"sub":"<an existing ADMIN profile id>"}';
  INSERT INTO public.stamp_definitions (…) VALUES (…);
ROLLBACK;
-- before: PERMITTED.  after: 42501 — this is the intended change of §4.1
```

```sql
-- service path, unchanged throughout
BEGIN;
  SELECT public.toggle_feature_flag_with_audit('__probe_no_such_flag__', true, NULL);
ROLLBACK;
-- expect: P0002 Flag not found  (the guard passed; the flag simply is not there)
```

### 6.6 Application-level smoke, after the ACL probes pass

Exercise one real user-facing path per affected family against production:
award a stamp (service path through `upsert_city_stamp`), read a passport, load
a discovery ranking surface, and toggle one feature flag off and back on through
the admin UI — confirming the audit row is written with the **real** actor id.

---

## 7. Recovery

Ordered cheapest first. All three migrations are privilege-only or
body-only, so recovery never involves restoring data.

1. **If a postcondition fails, nothing needs undoing.** Each migration runs in
   one transaction and its postconditions raise inside it, so a failure aborts
   and lands nothing. Read the message — each names the offending functions.
2. **If §6.3 is non-zero after a successful apply** (a policy predicate lost
   client EXECUTE — the one outcome with user-visible blast radius), restore that
   function alone, immediately:
   ```sql
   GRANT EXECUTE ON FUNCTION public.<name>(<identity args>) TO anon, authenticated;
   ```
   Then stop and re-derive why the sweep predicate matched it.
3. **If an application path breaks on a revoked function**, grant that one
   function back to the role that needs it, record the reason, and — because the
   function is `SECURITY DEFINER` and therefore its own access control — add a
   caller check to its body in the manner of 2974 rather than leaving the grant
   as the only protection.
4. **To reverse 2974**, `CREATE OR REPLACE` the body from `0119`/`2198` without
   the guard. Note this re-opens nothing on production by itself, because the ACL
   is the active control there.
5. **Full reversal is deliberately not scripted.** Restoring the previous state
   means re-granting write privileges to the unauthenticated public role on
   tables and write functions that no code path uses under those roles. A
   rollback file for that would be a loaded gun. Per-object grants (2, 3) are the
   supported recovery.
6. Ledger rows are not removed on recovery. A migration that was applied and then
   partially reversed by a targeted grant is a fact worth keeping; delete the row
   and the next certify run silently re-applies.

---

## 8. Execution is separate, and is not authorized by this document

**There is no automated production apply path, by design.** `live-db.yml` and
`clean-build-proof.yml` both carry
`KNOWN_PROD_PROJECT_REF: 'ajrurzioarfkagpuxfnb'` as a **denylist**, and
`check:security` fails closed if that value is ever emptied — CI refuses to run
against production even if an operator points it there. Production migrations in
this repository have historically been applied out-of-band by an operator (see
`docs/migrations.md`, e.g. *"Applied 2026-07-24 via Supabase Management API"*).

So execution requires a person with production credentials, acting deliberately.
This document exists to make that act short, checkable and reversible. It does
not authorize it, and the authorization established for this environment is
read-only: production has been read to prepare this plan and has not been
written to.

**Recommended sequence when it is authorized:** apply to portava-ci via the
normal `main` path first (which is where 2972 already is), confirm certify green,
then execute §3 against production inside a maintenance window with §6 run
before and after, 2973 applied **before or together with** the 2890–2971 chain
rather than after it (§2.1).
