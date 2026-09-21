# Manual Production Migration Runbook

**Production = `ajrurzioarfkagpuxfnb` (travel-buddy). Nothing in this document has been
applied. Every statement below is for the owner to run manually.**

Applied-state measured directly against production on 2026-09-07 by testing each
migration's own marker object (column / table / function / flag row), not by trusting a
ledger — **production has no `schema_migration_ledger` table at all**, so the ledger
cannot be consulted there.

| Already applied | Evidence |
| --- | --- |
| **2401** | `msg_select` correlated on `messages.thread_id`; `messages_hide_blocked_sender` is RESTRICTIVE |
| **2402** | `authz.is_active_thread_member` exists, SECURITY DEFINER, anon+authenticated hold EXECUTE |

Everything else in scope is **unapplied**.

---

## Dependency chain — the only hard orderings

```
2334 ──> 2337 ──> 2420          (kernel chain)
   authz.is_trip_crew        2337 is the sole creator of authz.is_accepted_trip_member,
   is referenced 48x by      and 2420 requires BOTH helpers
   2337

2217 ──> any flip of map_projection_enabled
   without protected_zones the gateway cannot serve; see the risk note

2224 ──┐
2315 ──┴─> 2333                 (grant-boundary chain) — ADDED 2026-09-07
   2333 REVOKEs on route_flow_contribution_consent and
   sensing_anon_contributions. Neither table exists in production.
   A REVOKE against an absent relation is an ERROR, so 2333 as
   originally written would have ABORTED and landed nothing.
```

Everything else is independent and may be applied in any order.

---

## Batch A — prerequisites

### A1. `2334_route_plan_crew_visibility.sql`
- **Purpose** creates `authz.is_trip_crew(uuid)` and repoints five route-plan crew policies at it. Closes a fail-open where a pending invitee (`role='member', status='invited'`) could read a trip's plan, stops and legs through direct PostgREST.
- **Depends on** nothing.
- **Production change** one new `authz` function; five policies rewritten on `route_plans`, `route_stops`, `route_legs`, `route_plan_members`.
- **Type** policy-changing. **Risk LOW** — those four tables hold **0 rows in production**.
- **App code expects it?** Not required by app code (the API uses the service client, which bypasses RLS). It closes the direct-PostgREST path.
- **PRE-CHECK**
  ```sql
  select to_regclass('public.route_plans') is not null as table_exists,
         exists(select 1 from pg_namespace where nspname='authz') as authz_schema,
         exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='authz' and p.proname='is_trip_crew') as already_applied,
         (select count(*) from public.route_plans) as rows_at_risk;
  ```
- **POST-CHECK**
  ```sql
  select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='authz' and p.proname='is_trip_crew') as helper,
         (select count(*) from pg_policies where schemaname='public'
           and tablename in ('route_plans','route_stops','route_legs','route_plan_members')
           and qual like '%is_trip_crew%') as policies_using_helper;
  -- expect helper = true, policies_using_helper = 5
  ```
- **Rollback** `db/rollback/2026-09-07-2334-route-plan-crew-visibility-rollback.sql`. Its section 1 **re-opens the fail-open** and says so.

### A2. `2337_trip_crew_rls_membership_convergence.sql`
- **Purpose** creates `authz.accepted_trip_ids` / `authz.is_accepted_trip_member`, and converges 32 defective policies across 16 tables onto `requireTripMember`'s actual rule. **Also removes three policies named for membership whose entire predicate was `USING (auth.uid() IS NOT NULL)`** — being PERMISSIVE they were OR-ed and dominated the careful policy beside them, so any authenticated user could read `trip_crew_location_events`, `plan_attendance_events` and `plan_checkins`.
- **Depends on A1** (references `is_trip_crew` 48 times).
- **Production change** two new `authz` functions; ~32 policies rewritten across 16 tables.
- **Type** policy-changing. **Risk MEDIUM** — the widest policy change in this set. It both closes fail-opens (pending invitee) and *opens* correct access that was wrongly denied (accepted `co_host`, `viewer`, and a trip owner holding no `trip_members` row).
- **App code expects it?** No. Same service-client reasoning as A1.
- **PRE-CHECK**
  ```sql
  select (select count(*) from pg_policies where schemaname='public'
           and coalesce(qual,'')||coalesce(with_check,'') like '%trip_members%') as policies_referencing_members,
         (select count(*) from pg_policies where schemaname='public'
           and tablename in ('trip_crew_location_events','plan_attendance_events','plan_checkins')
           and qual like '%auth.uid() IS NOT NULL%') as blanket_policies,
         exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='authz' and p.proname='is_trip_crew') as a1_applied;
  -- a1_applied MUST be true. blanket_policies is expected to be 3 before, 0 after.
  ```
- **POST-CHECK**
  ```sql
  select (select count(*) from pg_policies where schemaname='public'
           and tablename in ('trip_crew_location_events','plan_attendance_events','plan_checkins')
           and qual like '%auth.uid() IS NOT NULL%') as blanket_policies_left,
         exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='authz' and p.proname='is_accepted_trip_member') as kernel_helper;
  -- expect blanket_policies_left = 0, kernel_helper = true
  ```
- **Rollback** `db/rollback/2026-09-07-2337-trip-crew-rls-membership-convergence-rollback.sql`.
- **Known limitation — CORRECTED 2026-09-07** it deliberately does **not** touch `highlights_select_active`, the one policy where CI and production disagree. The CI shape is `2313_highlights_permanent` from **PR #461** (commit `3babd722`, applied to CI 2026-09-07, not merged into this branch); production carries 0026's shape. The earlier claim here — that the CI version was "present in no migration" — was true when 2337 was written and is now false; it was found by opening PR #461, not by re-reading this branch. Migration **2530** repairs the defective `trip_only` branch on either shape without choosing between them. **Apply 2530 after 2337, and apply PR #461's 2313 only after it has been rebased with `docs/architecture/pr461-2313-rebase-onto-2530.patch`** — unpatched, 2313 reintroduces the `trip_members` self-join wherever it runs after 2530, and that regression was demonstrated on a harness rather than predicted.

### A3. `2217_protected_locations.sql` — *prerequisite only for the Map chain*
- **Purpose** creates `protected_zones`, the §24 protection policy the map gateway reads.
- **Depends on** nothing. **Must precede any flip of `map_projection_enabled`.**
- **Production change** one new table, RLS enabled, service-role-only grants.
- **Type** additive. **Risk LOW.**
- **App code expects it?** **Yes.** `loadProtectedZones` returns null without it. Since commit `94ae5d37` the gateway answers `enabled:false, refusal:"protection_unreadable"` in that state rather than `enabled:true, objects:[]` — so a premature flip no longer blanks the map, but the gateway still cannot serve.
- **PRE-CHECK** `select to_regclass('public.protected_zones') as should_be_null;`
- **POST-CHECK**
  ```sql
  select to_regclass('public.protected_zones') is not null as created,
         (select relrowsecurity from pg_class where oid='public.protected_zones'::regclass) as rls_on,
         (select string_agg(privilege_type,',' order by privilege_type)
            from information_schema.role_table_grants
           where table_schema='public' and table_name='protected_zones' and grantee='anon') as anon_grants;
  -- expect created=true, rls_on=true, anon_grants NULL
  ```
- **Rollback** drop the table; nothing references it when the flag row is absent.

---

## Batch B — dependent and independent

### B1. `2420_trip_kernel_foundation.sql` — **requires A1 + A2**
- **Purpose** `trips.version`, append-only `trip_events`, `trip_command_receipts`, `trip_outbox`, and `trip_kernel_execute(jsonb)`. Flag `trip_kernel_enabled` seeded **FALSE**.
- **Type** additive + new function. **Risk LOW while the flag is false** — gated-off byte-identity was measured across 26 requests: 0 differing lines, 0 kernel calls.
- **App code expects it?** Yes, but only behind the flag.
- **PRE-CHECK**
  ```sql
  select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                 where n.nspname='authz' and p.proname='is_accepted_trip_member') as a2_applied,
         to_regclass('public.trip_events') as should_be_null;
  -- a2_applied MUST be true or 2420 will fail
  ```
- **POST-CHECK**
  ```sql
  select to_regclass('public.trip_events') is not null as events,
         to_regclass('public.trip_command_receipts') is not null as receipts,
         to_regclass('public.trip_outbox') is not null as outbox,
         exists(select 1 from information_schema.columns
                 where table_schema='public' and table_name='trips' and column_name='version') as version_col,
         (select enabled from public.feature_flags where flag='trip_kernel_enabled') as flag_should_be_false;
  ```
- **Rollback** `db/rollback/2026-09-07-2420-trip-kernel-foundation-rollback.sql`, idempotent.

### B2. `2333_derived_memory_and_consent_grant_boundary.sql` — **CORRECTED 2026-09-07: requires 2224 + 2315**

> **This entry was wrong.** It said 2333 depends on nothing. It depends on two
> migrations that create two of the eight tables it revokes on:
> `route_flow_contribution_consent` (`2224_route_hop_signal.sql`) and
> `sensing_anon_contributions` (`2315_sensing_anon_contributions.sql`). Measured
> 2026-09-07: **neither table exists in production.** `REVOKE ALL ON` an absent
> relation raises `relation ... does not exist`, which rolls the transaction
> back — so applying B2 before those two would have landed **none** of the
> memory revokes while appearing to be a single clean failure of an unrelated
> kind. 2333 now carries a PRECONDITION block that names both prerequisites in
> the error text.
>
> **Also corrected:** 2333's own header claimed all eight rows were "read from
> BOTH databases". For those two tables that reading was taken on portava-ci
> only. The other six were genuinely read on both and stand.
>
> **Drift:** 2333 is **already applied on portava-ci** (anon and authenticated
> hold nothing on all four derived-memory tables there, and service_role matches
> the eight narrowed sets exactly). Production still carries the full blanket
> set. Do not read a green CI as evidence for production on this file.

- **Purpose** revokes the full privilege set from `anon`/`authenticated` on `memory_events`, `memory_feedback`, `memory_policy`, `memory_projections`, and narrows eight `service_role` grants to what each migration actually enumerated.
- **Measured now** `anon` holds `DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE` on `memory_events`.
- **Type** privilege-only. **Risk LOW** — all four tables have RLS enabled with **zero policies**, so no legitimate `anon`/`authenticated` path exists to break. **TRUNCATE is not policed by RLS**, which is the one capability the grant really conferred.
- **App code expects it?** No change; the server uses `service_role`.
- **PRE-CHECK**
  ```sql
  select table_name, grantee, string_agg(privilege_type,',' order by privilege_type) privs
    from information_schema.role_table_grants
   where table_schema='public'
     and table_name in ('memory_events','memory_feedback','memory_policy','memory_projections')
     and grantee in ('anon','authenticated','service_role')
   group by 1,2 order by 1,2;
  ```
- **POST-CHECK** same query — expect **no `anon` rows and no `authenticated` rows**, and `service_role` narrowed per table.
- **Rollback** `db/rollback/2026-09-07-2333-grant-boundary-rollback.sql`. Section 1 is **commented out on purpose** because it re-grants `anon` write access to user data.

### B3-note. `2510_layover_write_boundary_postconditions.sql` — **apply strictly AFTER B3**

- **Why it is a separate file.** 2335 has no postcondition block. It cannot gain
  one in place: 2335 is applied on portava-ci and ledgered there by sha256, and
  `src/scripts/checkMigrationLedger.ts` reports an edited applied migration as a
  finding. The verification therefore lives in its own verify-only migration.
- **It changes nothing.** No DDL, no grant, no policy, no row. It reads and raises.
- **It is proven to discriminate, not assumed to.** Run read-only today:
  production has `layover_recs_owner` at `polcmd='*'` (FOR ALL) with
  `authenticated` holding `DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE`
  → it raises. portava-ci has `polcmd='r'` (FOR SELECT) with `SELECT` only and
  `service_role` at `DELETE,INSERT,SELECT,UPDATE` → it passes.
- **So applying it before B3 is a guaranteed failure**, by design. That is the
  point: it is the check that B3 actually landed.
- It also asserts exactly one policy on the table, so a later PERMISSIVE policy
  cannot silently OR-dominate `layover_recs_owner`.

### B3. `2335_layover_recommendation_write_boundary.sql`
- **Purpose** `layover_recs_owner` becomes `FOR SELECT`; grants narrowed; TRUNCATE revoked from `anon`/`authenticated` on four sibling layover tables.
- **Measured now** `PERMISSIVE / ALL, with_check = NULL` — a `FOR ALL` policy with no `WITH CHECK` reuses `USING` as the write check, so an authenticated user can write their own `safety_rating` and `hard_return_time`.
- **Type** policy + privilege. **Risk LOW** — every writer is server-side; all 30 production rows are `source='ai'`; no client-side writer exists in the tree.
- **PRE-CHECK**
  ```sql
  select permissive, cmd, qual, with_check from pg_policies
   where schemaname='public' and tablename='layover_recommendations' and policyname='layover_recs_owner';
  -- expect PERMISSIVE / ALL / with_check NULL
  ```
- **POST-CHECK**
  ```sql
  select permissive, cmd, with_check from pg_policies
   where schemaname='public' and tablename='layover_recommendations' and policyname='layover_recs_owner';
  -- expect PERMISSIVE / SELECT
  select grantee, string_agg(privilege_type,',' order by privilege_type)
    from information_schema.role_table_grants
   where table_schema='public' and table_name='layover_recommendations'
     and grantee in ('anon','authenticated','service_role') group by 1;
  -- expect no TRUNCATE for anon/authenticated
  ```
- **Rollback** `db/rollback/2026-09-07-2335-layover-recommendation-write-boundary-rollback.sql`.

### B4. `2370_trust_tables_privileges.sql`
- **Purpose** makes the trust tables service-role-only.
- **Measured now** `anon` holds all seven privileges on `trust_profiles` **and on `trust_settings`** — i.e. `anon` can currently read the gaming-detection thresholds and holds UPDATE on them.
- **Type** privilege-only. **Risk LOW.**
- **PRE/POST-CHECK** as B2, substituting the trust tables. Expect no `anon` rows afterwards.
- **Rollback** `db/rollback/2026-09-07-2370-trust-tables-privileges-rollback.sql`.

### B5. `2371_trust_profiles_evidence.sql`
- **Purpose** adds `evidence_weight` / `evidence_count` behind trust scores.
- **Type** additive. **Risk LOW.** Two-statement persist, written to be safe against an unmigrated production.
- **PRE-CHECK** `select exists(select 1 from information_schema.columns where table_schema='public' and table_name='trust_profiles' and column_name='evidence_weight') as should_be_false;`
- **POST-CHECK** same, expect true.

### B6. `2410_layover_recommendation_identity.sql`
- **Purpose** `rec_key` + a UNIQUE index giving recommendations a stable identity, behind `layover_stable_recommendation_ids_enabled` seeded FALSE.
- **Why it matters** without it every regeneration returns id-less cards, so the client's "Add to plan" control — rendered only when `rec.id` is set — **has never rendered in production**, and `layover_plan_stops.recommendation_id` was nulled on every dashboard load. That is why plan stops read zero.
- **Type** additive + flag. **Risk LOW.**
- **PRE-CHECK** `select exists(select 1 from information_schema.columns where table_schema='public' and table_name='layover_recommendations' and column_name='rec_key') as should_be_false;`
- **POST-CHECK** column present, unique index present, flag row present and **false**.

### B7. Map chain — `2201`, `2202`, `2218`, `2219`, `2224`, `2295`
- **Purpose** the map gateway flag row (2201), telemetry (2202), crowd flow (2218), locate-my-friends (2219), route-hop consent (2224), world intelligence (2295).
- **Depends on A3 (2217) for anything that serves.**
- **Type** additive. **Risk LOW** individually; the risk is in the *flag flip*, not the DDL.
- **Critical** applying every one of these still leaves **Crowd Flow dark**, because `geo_zones` holds **0 rows** and `routes/mapProjection.ts:836` refuses with `no_zone_model`. Populating `geo_zones` is an **ops action, not a migration**.
- **POST-CHECK**
  ```sql
  select flag, enabled from public.feature_flags where flag like 'map_%' order by flag;
  select to_regclass('public.protected_zones') is not null as zones,
         (select count(*) from public.geo_zones) as geo_zone_rows;
  -- geo_zone_rows = 0 means Crowd Flow stays dark regardless of flags
  ```

### B8. Media canonical columns — **CORRECTED 2026-09-07: 2250 will FAIL as written**

> **This entry was wrong when first written.** `2250_media_asset_canonical_model.sql`
> ends with a postcondition asserting `media_canonical_enabled` is **FALSE**. In
> production that flag is **TRUE**, so applying 2250 today raises
> `POSTCONDITION FAILED` and rolls back the entire transaction. Verified by
> dry-running its DDL plus that verbatim postcondition on production inside a
> rolled-back transaction.
>
> **Two valid orders — pick one:**
>
> **Order A** — set `media_canonical_enabled = false`, apply `2250` as written,
> verify, then decide whether to set it back to true. Turning it off costs
> nothing: the writer has landed zero rows since 2026-08-16.
>
> **Order B** — leave the flag alone and apply
> `2470_media_asset_canonical_columns_flag_agnostic.sql` instead. It is 2250's
> DDL verbatim, plus a precondition that every existing `moderation_status` is
> inside the widened CHECK, with the flag **reported** rather than asserted.
> Dry-run on production confirmed column resolution succeeds (the writer's
> payload advanced from `42703` to a benign FK error on a probe owner).
>
> Either way a **schema-capability guard now stands in front of the writer**, so
> the interim is safe: canonical writes are refused loudly instead of failing
> silently, and the guard picks up an applied migration within 30 seconds
> without a deploy.

### B8-original. `2250_media_asset_canonical_model.sql` — **behaviour-changing, apply deliberately**
- **Purpose** adds `captured_at`, `provenance`, `intelligence_eligibility` and one more column to `media_assets` (production has 23 columns, CI has 27).
- **Why it matters** `media_canonical_enabled` is **TRUE in production**. `recordMediaAsset` sends those columns on every upsert, PostgREST rejects the whole statement with PGRST204, and `if (error) return null` swallows it — **three weeks of silent total write loss since 2026-08-16**.
- **Type** additive schema, but **behaviour-changing in effect**: applying it *restarts canonical writes*, which will populate the §18 Quick Media row and the §30 Uploads count. That is a product-visible change, not a migration detail.
- **Do not batch this one.** See `OWNER DECISION REQUIRED: MEDIA_CANONICAL_FLAG`.
- **PRE-CHECK**
  ```sql
  select count(*) as media_assets_columns from information_schema.columns
   where table_schema='public' and table_name='media_assets';
  select (select enabled from public.feature_flags where flag='media_canonical_enabled') as flag_is_true,
         (select count(*) from public.media_assets) as rows_now,
         (select max(created_at) from public.media_assets) as last_write;
  ```
- **POST-CHECK** column count 27; then watch `select count(*) from public.media_assets` rise as uploads occur — that is the proof the writer recovered.

### B9. Flag-row-only migrations — `2336`, `2338`, `2339`, `2350`, `2360`, `2361`
- All additive, all seeding flags **FALSE** (2338 also adds `memories.location_precision`).
- **Risk LOW**; none changes behaviour until a flag is flipped.
- **POST-CHECK** `select flag, enabled from public.feature_flags where flag in (...) order by flag;` — every one must read **false**.
- **2338 caveat** its column DEFAULT is `'exact'`, chosen to reproduce today's behaviour for the 80 existing rows, **not** because it is a good privacy default. See `OWNER DECISION REQUIRED: LOCATION_PRECISION_DEFAULT` before treating that default as settled.

---

## Rollback limitations, stated plainly

- **Production has no `schema_migration_ledger`**, so none of these will self-register there and `apply-migrations.ts` exits 2 without it. Applied-state must be established by querying objects, as this document does.
- **2333 section 1 and 2334 section 1 re-open the defects they closed.** Both say so in the file. They exist because a rollback that cannot reach the prior state is not a rollback, not because they should be run.
- **2250 has no clean reverse.** Dropping the columns again re-breaks the writer; the rows written while it was applied would keep values in columns that no longer exist.
- **2402's rollback restores a *narrowed* non-recursive policy, never the original tautology** — do not "restore" the pre-2401 shape.

---

## Batch C — Trips v4, `2450 → 2777` (22 files)

**PREPARED 2026-09-09. NOTHING IN THIS BATCH HAS BEEN APPLIED TO PRODUCTION.**
Production remains at the 2420-era kernel. Every measurement below was taken
read-only against `ajrurzioarfkagpuxfnb` on 2026-09-09; each row names the query
that produced it, so a reader can re-run it rather than trust it.

This batch exists because the merge of `claude/portava-continuation-uqta94` puts
these 22 migrations on `main`, where `live-db.yml` will apply them to
**portava-ci** automatically. It applies **nothing** to production: there is no
workflow that targets production, and both `live-db.yml` and
`clean-build-proof.yml` name `ajrurzioarfkagpuxfnb` only as the ref their
allowlist guard must REFUSE. Production is an owner action, which is what this
document is for.

### C0. Where production actually is

| Measured | Value | Query |
|---|---|---|
| `trip_kernel_execute` `md5(prosrc)` | `d621c513ef2093054aea014702733649` (11 805 chars) | `md5(prosrc)` on `pg_proc` — a hash, not a length; see census §28 |
| kernel contains 2450's `actor_role` | **no** | `prosrc LIKE '%actor_role%'` → false |
| kernel contains 2500's `JOIN_VIA_LINK` | **no** | same shape |
| kernel contains 2768's `SET_PRESENCE` | **no** | same shape |
| `trips.version` | present | `information_schema.columns` |
| `trip_events` / `trip_outbox` / `trip_command_receipts` | present, **0 rows** in `trip_events` | `to_regclass`, `count(*)` |
| every §5 v4 table (`trip_stages` … `trip_plan_participants`) | **absent** (12 of 12) | `to_regclass` |
| `public.schema_migration_ledger` | **absent** | `to_regclass` |
| `trip_kernel_enabled` | **false** | `feature_flags` |

So production carries 2420 and nothing after it, and the flag is off — which
means none of this is reachable by any user today, before or after the apply.

### C1. Preconditions — all measured, all satisfied

| # | Precondition | Measured | Verdict |
|---|---|---|---|
| P1 | `authz.is_trip_crew(uuid)` exists (2334) | 1 | PASS |
| P2 | `authz.is_accepted_trip_member(uuid,uuid)` exists (2337) | 1 | PASS |
| P3 | `trips.version` exists (2420 applied) | 1 | PASS |
| P4 | roles `anon`, `authenticated`, `service_role` exist | all three | PASS |
| P5 | `pgcrypto` present (`gen_random_uuid`) | 1 | PASS |
| P6 | PostgreSQL ≥ 11 so `ADD COLUMN … DEFAULT` is metadata-only | **17.6** | PASS |
| P7 | 2770's backfill mapping covers every `trip_plan_items.visibility` value | distinct values = `{members}`; 0 rows outside `(members, public)` | PASS |
| P8 | 2750's `NOT VALID` interval CHECK has no violating row today | 0 rows with `ends_at < starts_at` | PASS |
| P9 | none of the constraints or columns this batch adds already exists | 0 of 5 constraints, 0 of 5 columns | PASS |

Rows in the blast radius: **43 `trips`, 42 `trip_members`, 8 `trip_plan_items`,
0 `route_stops`**. `places` holds 11 908 rows and is not written by this batch.

### C2. Destructive review — none of it is destructive at apply time

A text scan of the 22 files finds `DELETE FROM` in five of them and no
`DROP TABLE`, `DROP COLUMN` or `TRUNCATE` anywhere. **Every one of those DELETEs
is inside the kernel function body** — 2450's `REMOVE_PARTICIPANT` / `LEAVE_TRIP`,
2764's `REMOVE_STAGE`, 2766's three remove commands, 2772's attendance
withdrawal. They are runtime command handlers being *defined*, not statements
being *executed* by the migration. Nothing in this batch deletes a row or drops
an object when applied.

The only statements that touch existing data are:

* `2750` — one `CHECK … NOT VALID` on `trip_plan_items`. `NOT VALID` skips the
  existing-row scan on purpose (its own comment says so) and still refuses every
  future violating write. 8 rows, 0 of them violating.
* `2770` — five `ADD COLUMN`s and one `UPDATE public.trip_plan_items SET
  privacy_scope = …` over those same 8 rows, then `SET NOT NULL`. The backfill
  runs BEFORE the `NOT NULL` and before the `visibility`↔`privacy_scope` tie, so
  no row is ever inconsistent mid-migration. On PG 17.6 the `DEFAULT`-bearing
  columns are metadata-only.
* `2767` — `ALTER TABLE public.trip_presence`, on a table this batch itself
  creates two files earlier. Zero rows.

### C3. Rollback posture

**All 22 have a rollback file**, and the whole chain is rehearsed by
`db/harness/run.sh` on a local PostgreSQL 16 cluster: it applies the base
schema, the authz slices, the ancestry `2420→2450→2500→2590`, the schema
migrations, then the eight verified transforms, then rolls every transform back
in reverse and asserts the restored definition is **byte-identical** to what
preceded it, and that a second rollback REFUSES rather than corrupting.

| Migration | Rollback file (`db/rollback/`) |
|---|---|
| 2450 | `2026-09-07-2450-trip-kernel-families-rollback.sql` |
| 2500 | `2026-09-07-2500-trip-kernel-join-via-link-rollback.sql` |
| 2590 | `2026-09-07-2590-trip-kernel-add-plan-attachment-columns-rollback.sql` |
| 2750 | `2026-09-08-2750-trip-plan-item-interval-ordered-rollback.sql` |
| 2760–2777 | `2026-09-09-<n>-…-rollback.sql`, one per migration |

What a rollback does NOT restore, stated rather than implied: kernel history
written while the flag was on (`trip_events`, `trip_outbox`,
`trip_command_receipts` rows and `trips.version` values) and rows written into
the v4 tables. Canonical `trip_plan_items` rows are never touched. With the flag
off there is no such history to lose.

### C4. Backup posture — an owner action, not a claim

This document does not assert that a backup exists, because nothing here has
measured one. Before applying, the owner should confirm in the Supabase
dashboard for `ajrurzioarfkagpuxfnb` that a physical backup or PITR window
covers the apply, and record its timestamp here. **A rollback file is not a
backup**: it reverses DDL, not data.

### C5. The ordered plan

Strict numeric order. Each is one transaction. Stop at the first failure — later
files depend on earlier ones, and continuing past a failure invents a schema
state no environment has ever had.

```
2450  kernel v2: actor_role on trip_events + trip_command_receipts; trip,
      participant, admin, system families                     [requires 2420]
2500  kernel: JOIN_VIA_LINK; ADD_PARTICIPANT/SET_PARTICIPANT_ROLE widen to host
2590  kernel: ADD_PLAN carries added_by, description, city, country
2750  trip_plan_items: interval CHECK, NOT VALID
2760  trip_stages          + 2 indexes + trip_stages_select_crew
2761  trip_legs, trip_commitments + 6 indexes + 2 crew SELECT policies
2762  trip_goals, trip_decision_tasks, trip_risks + 4 indexes
2763  trip_presence, trip_proposals, trip_snapshots, trip_outcomes + 4 indexes
2764  TRANSFORM: stage family
2765  TRANSFORM: leg + commitment families
2766  TRANSFORM: goal, decision-task, risk families
2767  trip_presence: spec vocabulary
2768  TRANSFORM: presence, proposal, outcome families
2769  TRANSFORM (correction): participant roles + terminal lifecycle
2770  trip_plan_items: stage_id, place_id, privacy_scope, plan_scope, version
2771  trip_plan_participants + 2 indexes + crew SELECT policy
2772  TRANSFORM: plan attendance + plan version
2773  trip_snapshot_{seed,fold,fold_all,write,replay,verify_replay}
2774  trip_proposal_votes + trip_proposal_{electorate,tally} + index + policy
2775  TRANSFORM: proposal governance and apply
2776  trip_presence_freshness() + view trip_presence_current
2777  TRANSFORM (correction): presence ordering
```

Eight of these (2764, 2765, 2766, 2768, 2769, 2772, 2775, 2777) are **verified
transforms**: each reads the installed definition with `pg_get_functiondef`,
asserts every anchor occurs EXACTLY once, splices, re-checks that guarantees it
did not author survived, and only then `EXECUTE`s. A transform run against the
wrong base RAISEs instead of producing a wrong function — which is why the
ancestry `2450 → 2500 → 2590` must land first, and why applying 2764 to
production **today** would correctly abort.

### C6. Per-file PRE-CHECK and POST-CHECK

Every file in this batch carries its own `DO $pre$` precondition block and
`DO $post$` postcondition block, in the same transaction as its DDL. That is
stronger than a checklist in a document: a failed precondition aborts the
transaction and lands nothing. The owner does not need to run a separate
pre-check per file — but the whole-batch verdict is worth one query afterwards:

```sql
-- After the batch: 12 tables, 1 view, 9 functions, and a kernel that
-- knows the v4 command set.
select
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and c.relname in
    ('trip_stages','trip_legs','trip_commitments','trip_goals','trip_decision_tasks',
     'trip_risks','trip_presence','trip_proposals','trip_proposal_votes',
     'trip_outcomes','trip_snapshots','trip_plan_participants'))            as tables_expect_12,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='v' and c.relname='trip_presence_current') as view_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
    ('trip_snapshot_seed','trip_snapshot_fold','trip_snapshot_fold_all','trip_snapshot_write',
     'trip_snapshot_replay','trip_snapshot_verify_replay','trip_proposal_electorate',
     'trip_proposal_tally','trip_presence_freshness'))                      as functions_expect_9,
  (select count(*) from pg_tables where schemaname='public' and rowsecurity
    and tablename in ('trip_stages','trip_legs','trip_commitments','trip_goals',
     'trip_decision_tasks','trip_risks','trip_presence','trip_proposals',
     'trip_proposal_votes','trip_outcomes','trip_snapshots','trip_plan_participants'))
                                                                            as rls_on_expect_12,
  (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='trip_kernel_execute')           as kernel_md5,
  (select count(*) from information_schema.columns where table_schema='public'
    and table_name='trip_plan_items'
    and column_name in ('stage_id','place_id','privacy_scope','plan_scope','version'))
                                                                            as plan_item_cols_expect_5,
  (select enabled from public.feature_flags where flag='trip_kernel_enabled') as flag_still_false;
```

`kernel_md5` must NOT be `d621c513ef2093054aea014702733649` afterwards — that is
the 2420-era value recorded in C0, and seeing it again means the chain did not
land.

### C7. The flag stays FALSE, and why that is not caution theatre

`trip_kernel_enabled` is seeded FALSE by 2420 and this batch does not touch it.
Leaving it false after the apply is **not** rollout gating; it is the only
correct state until the apply has actually happened, for a reason that is
measurable rather than cautious:

`domain/trips/commands/tripKernel.ts` declares `TRIP_KERNEL_CONTRACT_VERSION = 2` and the routes
issue v4 command types (`ADD_STAGE`, `SET_PRESENCE`, `PROPOSE`, `CAST_VOTE`,
`ACCEPT_PROPOSAL`, …). Against production's 2420-era function every one of those
is refused as `TRIP_COMMAND_UNKNOWN_TYPE` → HTTP 400. Turning the flag on before
the chain lands would take a working set of legacy write paths and replace them
with 400s. That is a **correctness** reason, not a rollout one.

Once the chain HAS landed on production and the postcondition query above
returns the expected counts, the remaining reason to hold the flag is rollout
protection only — and per the standing instruction that there are no live users,
rollout protection alone is not a reason to leave finished work switched off.
The order is: apply, certify by query, then flip. Not before.

### C8. The literal boundary

Applying migrations to `ajrurzioarfkagpuxfnb` is the one action in this workflow
that cannot be performed from CI or from this session:

* no workflow targets production — `live-db.yml` and `clean-build-proof.yml`
  name it only as the ref their allowlist guard must refuse;
* the in-process guard (`ciProdReadOnlyAuditGuard`) exits before any client is
  constructed if the resolved ref is production;
* and the standing instruction is that production must not be hand-mutated from
  a session.

Everything around it is prepared here: the ordered plan, the measured
preconditions, the destructive review, the rollback inventory, the
postcondition query and the flag decision. **The remaining action is the
owner's: run the 22 files in the order in C5 against production, one
transaction each, stopping at the first failure.**

---

## Batch D — `2778 → 2870` (32 files), and the one of them that is ready alone

*Added 2026-09-14. Every production figure below was read from
`ajrurzioarfkagpuxfnb` read-only on that date. Nothing was applied.*

### D0. Where production is, measured not assumed

| Object | In production? |
| --- | --- |
| `schema_migration_ledger` | **NO** — still absent, as on 2026-09-07 |
| `trip_plans` | **NO** — so Batch C has not been applied either |
| `trip_subgroups`, `trip_subgroup_members`, `trip_decisions`, `trip_transport_segments`, `trip_reservation_events`, `trip_disruptions`, `trip_transport_policies`, `trip_meeting_checkpoints`, `trip_meeting_checkpoint_participants` | NO |
| `telegraph_outbox`, `message_edits`, `message_reactions`, `message_attachments`, `conversation_action_refs`, `telegraph_report_evidence` | NO |
| `airport_fact_observations`, `layover_external_events` | NO |
| `profiles`, `feature_flags`, `trip_members` | yes |

**The absent ledger is the structural fact.** `db:apply-migrations` writes each
migration and its ledger row in one transaction and cannot run without the
table, so the sanctioned applier cannot be pointed at production at all. Batch D
is hand-applied or not applied, exactly like A, B and C. That is not a new
constraint; it is the one this document has recorded since 2026-09-07, restated
because it decides the shape of everything below.

**Batch D sits on top of an unapplied Batch C.** Every trip table Batch D
extends is absent, and `trip_plans` — Batch C's — is absent too. So the trips
half of Batch D (2778–2795) cannot be applied before Batch C, and this document
makes no attempt to order the two: C5 is the plan for C, and D is after it.

### D1. `2870_profiles_verification_level_identity_vocabulary.sql` — READY ALONE

This one is different from every other file in Batch D and it is the file the
owner asked about, so it is stated separately and in full.

**What it does.** One constraint swap on `public.profiles`. A `DO` block finds
the CHECK constraint whose definition matches both `%verification_level%` and
`%buddy_verified%`, drops it by name, and adds
`profiles_verification_level_check` accepting the five values it already
accepted plus `'id_verified'` and `'id_selfie_verified'`. No row is moved, no
value is removed, no grant changes, no flag is flipped.

**Why it matters.** Production's constraint today is exactly:

```
CHECK ((verification_level = ANY (ARRAY['none'::text, 'basic_verified'::text,
  'trusted_traveler'::text, 'host_verified'::text, 'buddy_verified'::text])))
```

`'id_verified'` is not in that list. `routes/verification.ts#applyVerifiedProfile`
writes it through `toVerificationLevel()`. **So a completed government-ID check
is rejected by the constraint and no user can become ID-verified in production
today.** That is measured, not inferred: the constraint definition above was read
from `pg_constraint` on 2026-09-14.

**Preconditions — all four measured, all satisfied.**

1. `public.profiles.verification_level` EXISTS (one matching column in
   `information_schema.columns`).
2. The constraint the `DO` block searches for EXISTS and its definition matches
   both predicates — it is `profiles_verification_level_check`, quoted above. If
   it did not match, the block would fall through and `ADD CONSTRAINT` would
   fail on the duplicate name; it matches, so the drop runs first.
3. `trg_profiles_verification_privileged` (migration 2163) EXISTS and is
   ENABLED, which is the write restriction the new values rely on. Verified from
   `pg_trigger`: `tgenabled = 'O'`.
4. **Every existing row validates against the new constraint.** All 58 profile
   rows hold `'none'`. `ADD CONSTRAINT` validates the table on the way in, so
   this is the precondition that decides whether the statement succeeds or
   aborts — and it is satisfied with no row to correct.

**Dependencies: none inside Batch D.** 2870 names no object created by
2778–2869 — checked by grepping the file for every `trip_*`, `telegraph_*`,
`layover_*`, `airport_*`, `message_*` and `conversation_*` identifier and
finding none. It touches `public.profiles` only. **It therefore does not wait
for Batch C, and it does not wait for the other 31 files in Batch D.**

**Destructive review.** `DROP CONSTRAINT` is the only destructive verb, and it
drops a constraint that is re-added in the same transaction with a strictly
wider predicate. If the transaction aborts after the drop, the rollback restores
it. The window in which `profiles` is unconstrained is inside one transaction
and invisible to any other session.

**Rollback.** Re-add the five-value constraint — but only after confirming no
row has acquired `'id_verified'` or `'id_selfie_verified'` in the meantime, or
the re-add aborts. That check is the rollback's first statement, not an
afterthought.

**What it does NOT do.** It does not make anyone ID-verified. It removes the
database-level refusal; the provider integration, the webhook signature path and
`IMPLEMENTED_PROVIDERS` (still `["mock"]`) all sit above it and are recorded in
`docs/architecture/census-trust.md`. Applying 2870 is necessary and nowhere near
sufficient.

### D2. The rehearsal — 26 of 32 executed on portava-ci, zero failures

*2026-09-14, on the owner's instruction: "apply and certify every pending
migration on the CI project and report exactly which succeed, which fail and
why". Executed inside `BEGIN; … ROLLBACK;` so the CI database is not left ahead
of `main` with no commit accounting for it — the hazard `live-db.yml`'s own
header names. No ledger row was written and production received no statement of
any kind, not even a read.*

| Migrations | Result |
| --- | --- |
| 2800, 2801, 2802, 2803, 2810, 2811, 2812, 2813, 2840, 2841, 2850, 2851, 2860, **2870** | **PASSED** — 14 files, one transaction, first attempt, zero removals |
| 2778, 2779, 2780, 2781, 2782 | **PASSED** — true canonical prefix, every predecessor present |
| 2784, 2788, 2789, 2790, 2791, 2792, 2793 | **PASSED** — canonical relative order, dependency-reduced |
| 2783, 2785, 2786, 2787, 2794, **2795** | **NOT REACHED** |

**Zero failures.** Every `DO $$ … RAISE EXCEPTION $$` postcondition inside the
26 executed and passed. No file was removed from any list, so there are no
"failed only because its predecessor was removed" entries to disambiguate.

**Why six were not reached, and it is not a database result.** The transaction
containing 2778–2795 is a 156 KB payload, above what one statement call can
carry, and transaction state does not span calls — probed and confirmed, not
assumed. So that chunk could not be split and still be one transaction. **NOT
REACHED MEANS UNTESTED. It does not mean probably fine.**

**What two transactions instead of one does not prove.** 2800–2870 references no
object 2778–2795 creates — established by name, by grep, **not by execution**.
That the two halves are order-independent against each other is unproven. The
same caveat, more sharply, applies to the 2784→2793 run: it ran in canonical
relative order but without 2783/2785/2786/2787/2794 preceding it, and that none
of the seven depends on those was established by reading their preconditions
rather than by running them.

#### D2.1 What the runbook needs that the rehearsal surfaced

**1. Thirteen of these are non-idempotent BY DESIGN.** 2779, 2780, 2782, 2783,
2784, 2785, 2786, 2787, 2789, 2791, 2793, 2794 and 2795 each carry a guard of
the form `RAISE EXCEPTION '…already exists; this migration is not idempotent by
design'`. **A retry after a partial apply will not be a no-op — it will fail
loudly.** That is deliberate and it means the plan needs a RESTORE POINT, not a
re-run step.

**2. 2795 is a tripwire and it is one of the six untested.** It hard-pins
`branches_after <> 66` and `family assignments <> 44`, both raising. Its own
comment records that a replica which applied 2779 before amendment `a63d5bf5b`
reports **41** and is STALE. So it refuses a kernel that diverges even slightly
from the canonical replay — exactly the check you want before a production
kernel apply, and exactly the one that has not been exercised. **This is the
highest-risk unknown in the batch.**

**3. Four postconditions pass on an empty CI database and prove much less
against production's real rows:**

* **2870** re-adds a CHECK on `profiles.verification_level`, and `ADD
  CONSTRAINT` validates every existing row. It passed here on essentially
  nothing. Production's 58 rows were separately measured — all `'none'` — so for
  this one the production answer is known and safe (see D1), but the general
  point stands.
* **2779** counts `trip_plan_items` rows with an out-of-vocabulary status and
  refuses if any exist — trivially 0 on CI. It then runs `VALIDATE CONSTRAINT`,
  a full scan under lock.
* **2813** asserts no `message_requests` row is already `origin_verified` —
  vacuous on a column it has just created, but the check is data-shaped.
* **2789**'s postcondition `RAISE NOTICE`s a count of legacy rows with
  coordinate keys. On CI that count is 0 and the `NOT VALID` constraint is never
  exercised. **On production that notice IS the finding, and nobody will see it
  unless the apply captures NOTICE output.** Capture it.

**4. Three full-table writes, invisible on an empty database, long locks on a
populated one.** `UPDATE public.trip_activity_log SET retain_until = …` (2789)
and `UPDATE public.trip_reservations SET raw_text_retain_until = …` (2791)
rewrite every row; 2784's `ADD COLUMN version bigint NOT NULL DEFAULT 0` plus
its status-CHECK swap touches all of `trip_reservations`.

**5. One postcondition has a side effect.** 2781 probes by calling
`public.trip_decisions_prune()`, which executes a real `DELETE`. Harmless
against the table it has just created; worth knowing before it runs anywhere
else.

**6. 2810 leaves an outbox nothing drains.** By design, and gated FALSE —
turning `telegraph_message_kernel_enabled` on without a drainer grows
`telegraph_outbox` unboundedly. Every flag in both chunks seeds FALSE and
several refuse to certify if they find TRUE.

#### D2.2 Proof that the rehearsal left no trace

Asserted afterwards rather than assumed, because a rehearsal that cannot show it
left nothing behind has not been verified:

| Check | Value |
| --- | --- |
| `count(*) FROM schema_migration_ledger` | **500**, unchanged |
| `max(filename)` | **`2777_trip_kernel_presence_ordering.sql`**, unchanged |
| `trip_subgroups`, `trip_subgroup_members`, `trip_meeting_checkpoints`, `trip_decisions`, `trip_transport_segments`, `trip_transport_policies`, `trip_reservation_events` | all absent |
| `telegraph_outbox`, `message_reactions`, `message_edits`, `telegraph_report_evidence`, `airport_fact_observations`, `layover_external_events` | all absent |
| `trip_plan_items_status_known` constraint · `messages.sequence` · `trip_activity_log.retain_until` | 0 · 0 · 0 |
| The six feature flags these files seed | 0 rows |
| Sessions `idle in transaction` | 0 |

Two checks were run BEFORE the rehearsal and are worth recording, because
without them the whole safety model was an assumption: a disposable
`BEGIN; CREATE TABLE …; ROLLBACK;` probe confirmed the connection layer honours
an explicit rollback rather than autocommitting each statement (if it had
autocommitted, everything above would have persisted silently), and the payload
was md5-verified against the files on disk so that a transcription typo could
not be reported as a migration defect.

#### D2.3 Readiness

The 26 that executed are **rehearsed, not ready**. D0 stands: the trips half
depends on a Batch C that production has not received, and nothing here has been
ordered against it. 2870 is the exception and D1 states why.

### D3. The boundary, unchanged

C8 applies verbatim. Applying anything to `ajrurzioarfkagpuxfnb` is the owner's
action; no workflow targets it, the in-process guard refuses it, and the
standing instruction is that production is not hand-mutated from a session.

---

### D4. Independent re-verification and a STANDALONE rehearsal of 2870 — 2026-09-14

D1 and D2 were written by the lane that authored 2870, and D2's rehearsal ran
2870 as one of fourteen files in a single transaction. This section re-measures
D1's four preconditions from scratch and rehearses 2870 **alone**, because a
file the owner may apply by itself should be rehearsed by itself. Everything
below is executed output, not restatement.

#### D4.1 Production preconditions, re-measured read-only

`ajrurzioarfkagpuxfnb`, 2026-09-14, a single read-only query. **All four of
D1's preconditions confirmed unchanged:**

| D1 precondition | measured today |
|---|---|
| 1. `profiles.verification_level` exists | **yes** — `text`. (`date_of_birth` also present, `date`.) |
| 2. The constraint the `DO` block searches for exists and matches both predicates | **yes** — `profiles_verification_level_check`, definition byte-for-byte the five-value form quoted in D1 |
| 3. `trg_profiles_verification_privileged` exists and is ENABLED | **yes** — enabled, alongside `trg_profiles_role_privileged`, `trg_profiles_updated`, `enforce_is_official_trigger` |
| 4. Every existing row validates against the new constraint | **yes** — 58 profiles, **all `'none'`**, no other value present; `identity_verifications` still **0 rows** |

Production was read and not written. **The hold stands.**

#### D4.2 portava-ci is a faithful rehearsal surface — proved, not assumed

A rehearsal only means something if the rehearsal database resembles the target
in the ways the migration depends on. Measured on `hwokxgbmezheskbzskfr` the
same day:

| fact | production | portava-ci |
|---|---|---|
| `profiles_verification_level_check` definition | five-value form | **identical five-value form** |
| `trg_profiles_verification_privileged` | enabled | **enabled** |
| rows holding a non-`'none'` level | 0 of 58 | **0 of 7** |
| ledger newest | — | `2777_trip_kernel_presence_ordering.sql`, 500 rows, **no 2870** |

The two databases agree on every object 2870 touches.

#### D4.3 The connection honours ROLLBACK — proved before anything real was sent

A disposable probe created a table inside `BEGIN … ROLLBACK` and then asked
whether it existed. Answer: **absent — ROLLBACK IS HONOURED.** Only then was the
migration body sent.

#### D4.4 The rehearsal, and what it proves that D2's did not

2870's body ran alone inside `BEGIN … ROLLBACK` on portava-ci, with a
before-test and an after-test in the same transaction:

| step | result |
|---|---|
| 1. **BEFORE** — `UPDATE profiles SET verification_level='id_verified'` | **`23514` check constraint violation** |
| 2. 2870 precondition block | **PASSED** |
| 3. Locate old constraint by DEFINITION and drop it | **found and dropped** — `profiles_verification_level_check` |
| 4. 2870 postcondition block | **PASSED — all 7 values permitted** |
| 5. **AFTER** — write each of the seven values in turn | **7 accepted, 0 rejected** |

**Step 1 is the part D2 could not show.** The batch rehearsal proved 2870
*applies*; this proves the premise it exists to fix — that on a database in
production's exact shape, the value the code writes on every successful
government-ID check is **rejected by the database**. The claim in the migration
header is no longer an argument; it is an observed error code.

**Step 5 is the part that matters for safety.** It confirms the five pre-existing
values are still storable after the swap, so the widening removed nothing. A
migration that accepted the two new values while dropping one of the five would
have passed the postcondition block, which only checks the constraint *text* —
step 5 checks the *behaviour*.

#### D4.5 Nothing persisted

Re-queried after the ROLLBACK:

| probe | value |
|---|---|
| `profiles_verification_level_check` | back to the **five-value** form |
| ledger rows / newest | **500** / `2777_trip_kernel_presence_ordering.sql` |
| profiles by level | **7 × `'none'`** |
| probe table left behind | **none** |
| sessions `idle in transaction` | **0** |

portava-ci is in the state it started in. No migration was applied to any
database by this section.

#### D4.6 What applying 2870 does and does not buy

**Does:** makes the success path of identity verification *storable*. Without it
a completed, billed government-ID check is rejected with `23514`, the webhook
handler returns 5xx on purpose so the provider retries, and the retry writes the
same rejected value — a loop ending in the provider's dead-letter queue with the
user still at `'none'`.

**Does not:** produce a single verified user. `IMPLEMENTED_PROVIDERS` admits only
`"mock"`; both real adapters throw from every method. Applying 2870 changes
nothing any user sees, which is exactly what makes it safe to apply ahead of the
rest — and exactly why it must not be reported as "identity verification works".

Still open after 2870, each with a census row: **TV-6a** (owner — provider
account, D-PROVIDER), **TV-6b** (the adapter), **TV-0e** (no `VerifiedBadge`
component exists), **TRV2-12** (the settings screen renders the *other* five
labels, so an `id_verified` user shows blank).

#### D4.7 The decision this does not take

Whether the two vocabularies sharing `profiles.verification_level` — admin-granted
PLATFORM standing versus provider-attested ID outcome — should be merged, ranked,
or split into separate columns is **D-LEVEL-VOCAB** and remains the owner's.
Widening the constraint takes no position on it: it makes the value the code
already writes storable and leaves every existing value exactly as it is.

#### D4.8 Apply procedure, if and when the owner lifts the hold

```
PRE   SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
      JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname='public' AND t.relname='profiles'
        AND c.conname='profiles_verification_level_check';
      -- expect the FIVE-value form; if it already lists id_verified, 2870 is applied, STOP

PRE   SELECT verification_level, count(*) FROM public.profiles GROUP BY 1;
      -- expect every row 'none'; ANY other value is fine, but a value outside the
      -- seven aborts ADD CONSTRAINT — check before, not after

APPLY the file as written, whole, in its own transaction. It is idempotent.

POST  repeat the PRE constraint query -- expect the SEVEN-value form
POST  SELECT verification_level, count(*) FROM public.profiles GROUP BY 1;
      -- expect the SAME distribution as PRE. 2870 moves no row.
```

**Rollback** is `db/rollback/2026-09-13-2870-profiles-verification-level-identity-vocabulary.sql`.
Its `UPDATE` must run before the constraint is narrowed, and it **erases evidence
of completed ID checks** — so it is only safe while no such check has completed.
That is true today (0 rows) and stops being true the moment a real provider is
wired. **After TV-6b lands, this rollback is no longer safe and the file should
be re-read before use.**

**THE PRODUCTION HOLD REMAINS IN PLACE.** Nothing in D4 applies anything to
production, and D4 is not permission to. It is the evidence an owner would want
before deciding.

---

# Batch E — Discovery MIGRATIONS lane, `2890 → 2893`, plus the Discovery files already in tree but unapplied

Authored and rehearsed 2026-09-14 by the Discovery MIGRATIONS lane. **Nothing in
Batch E was applied to production by the lane that wrote it.** Every statement
below was executed against **portava-ci `hwokxgbmezheskbzskfr`** and nowhere
else. Batch E is the evidence and the procedure; applying is the integration
owner's step.

## E0. Where production is — taken from the integration owner's reading, not re-read here

This lane did not query `ajrurzioarfkagpuxfnb`. The facts Batch E is built on
were measured by the integration owner on 2026-09-14 and are treated as given:

| Fact | Consequence for Batch E |
|---|---|
| `public.schema_migration_ledger` **does not exist**; 2254 never applied | **There is no ledger to roll back against, and no ledger will record Batch E either.** See E5. |
| 442 public tables; production has never been driven by this repo's runner | Every PRE check below reads the live object rather than trusting a filename. |
| `rank_events` exists with exactly 13 columns, **with live rows** | 2890/2891 must be correct on a populated table. The rehearsal DB had to be seeded to test that; see E4. |
| `protected_zones` and `place_momentum` **do not exist** | 2217 and 2892 are creates, not alters. |
| `canonical_locations` has **no** `search_key` | 2220 is unapplied. |
| `feature_flags` key column is **`flag`**, not `key`; 185 rows | Every flag seed below uses `ON CONFLICT (flag)`. |
| `discovery_live_rank_enabled`, `discovery_ranking_modifiers_enabled`, `discovery_candidate_projection_enabled`, `discovery_buddy_launch_gate_enabled` have **no row at all** | These are E1 step 4. **No new migration was written for them** — see E1. |

**What this lane could NOT determine about production, and what the files do
about it.** Three things matter and none was readable:

1. **Whether `2298_dead_check_vocabularies.sql` is applied** — i.e. whether
   `rank_events_surface_check` is the post-2298 FIFTEEN or the pre-2298
   FOURTEEN. `2893` refuses to run unless it finds all fifteen, and names the
   missing label.
2. **The live `surface` distribution on production.** portava-ci's
   `rank_events` held **zero** rows before this lane seeded it, so the CI
   distribution is an artefact of the rehearsal and says nothing about
   production. `2893` therefore counts the rows itself, at apply time, on
   whatever database it is run against, and aborts with per-surface counts if it
   finds any. **The narrowing does not depend on my reading of production, and
   it must not depend on anyone's.**
3. **How large `rank_events` is.** This decides whether `2891`'s index build is
   a blink or a stall. See E2/2891 and the CONCURRENTLY variant.

## E1. The ordered plan

Steps 1–2 are **prerequisites already in tree**. Step 3 is this lane's new work.
Step 4 is seed rows from files that already exist. Step 5 is optional and
separable.

```
STEP 0  BACKUP. A point-in-time restore target, taken and CONFIRMED before
        step 1. See E5 — with no ledger, this is the only real undo.

STEP 1  2254_schema_migration_ledger.sql          ← STRONGLY RECOMMENDED FIRST
        Not required by any file below, and deliberately not a precondition of
        any of them. But production has no record of what has been applied, and
        every step after this one would otherwise be unrecorded too. Applying
        it first is what makes Batch E auditable afterwards.

STEP 2  2298_dead_check_vocabularies.sql          ← REQUIRED ONLY IF STEP 5 IS WANTED
        Widens rank_events.surface by 'wall' and circle_presence.status by
        'paused'. 2893 refuses to run without it. Independently valuable: until
        it lands, every Wall impression is rejected 23514 and every Circle
        pause silently fails.

STEP 3  2890_rank_events_behavior_engine_columns.sql   ← DV-38, DV-39, DV-41
        2891_rank_events_recommendation_id.sql         ← DV-37 (and DC-33's retry leg)
        2892_place_momentum.sql                        ← DC-07, DV-72
        Order among these three is IMMATERIAL — they touch disjoint objects and
        each states its own preconditions. Listed in band order for tidiness.

STEP 4  The four absent Discovery flag rows. NO NEW MIGRATION WAS WRITTEN:
        all four seed files already exist in tree and are simply unapplied.
          2289_discovery_ranking_modifiers_flag.sql
          2360_discovery_buddy_launch_gate_flag.sql
          2361_discovery_candidate_projection_flag.sql
          2850_discovery_live_rank_flag.sql
        Each is one INSERT ... ON CONFLICT (flag) DO NOTHING seeding FALSE, and
        each REFUSES TO COMMIT if it finds its row already reading TRUE.
        Writing a fifth file to seed rows these four already seed would have
        created four duplicate sources of truth for one flag each.

STEP 5  2893_rank_events_retire_writerless_surfaces.sql   ← DV-44, OPTIONAL, LAST
        The ONLY narrowing in the batch and the only file whose reversal is not
        free. Nothing depends on it. Read E2/2893 and E6 before deciding.

SEPARATE, not part of this lane's new work but in the same census scope:
        2220_canonical_locations_search_key.sql   ← B01 (DEPLOY)
        2217_protected_locations.sql              ← B04 (partial — see E7)
```

## E2. Per-file PRE checks, POST checks and RECOVERY

Every PRE check below is **in addition to** the file's own `PRECONDITION`
blocks, which raise and abort. Run them anyway: a PRE check you ran yourself is
how you know what state you started from, and with no ledger that is the only
record of it.

---

### 2890 — `rank_events` behaviour-engine columns (DV-38, DV-39, DV-41)

Adds `schema_version smallint NOT NULL DEFAULT 1`, `privacy_class text NOT NULL
DEFAULT 'raw_behavioral_event'`, `retention_tier text NOT NULL DEFAULT
'raw_recent'`, `dwell_ms integer NULL`, `dwell_kind text NULL`, plus three
value CHECKs and one pairing CHECK. Writes no row, drops nothing, indexes
nothing.

```
PRE   SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='rank_events'
       ORDER BY ordinal_position;
      -- expect exactly the 13 columns. If any of the five new names is already
      -- present, 2890 (or something else) has run — STOP and read E5.

PRE   SELECT count(*) FROM public.rank_events;
      -- RECORD THIS NUMBER. It is the POST comparison and, with no ledger, the
      -- only evidence that nothing was deleted.

APPLY the file whole, in its own transaction, as written. Idempotent.

POST  SELECT count(*) FROM public.rank_events;
      -- MUST equal the PRE number exactly. 2890 writes and deletes no row.

POST  SELECT count(*) FILTER (WHERE schema_version = 1)               AS v1,
             count(*) FILTER (WHERE privacy_class = 'raw_behavioral_event') AS pc,
             count(*) FILTER (WHERE retention_tier = 'raw_recent')    AS rt,
             count(*) FILTER (WHERE dwell_ms IS NOT NULL
                                 OR dwell_kind IS NOT NULL)           AS dwell,
             count(*)                                                 AS total
        FROM public.rank_events;
      -- expect v1 = pc = rt = total, and dwell = 0.
      -- dwell = 0 is the important one: a non-zero value would mean the
      -- migration invented attention data. The file asserts this itself.

POST  SELECT column_name, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema='public' AND table_name='rank_events'
         AND column_name = 'dwell_ms';
      -- expect is_nullable='YES' and column_default IS NULL. NULL means NOT
      -- MEASURED; a default would turn "not measured" into a measurement.
```

**WHY DEFAULT AND NOT BACKFILL.** Both NOT NULL columns take a DEFAULT because
the default is *true of every existing row*, not a placeholder:
`DISCOVERY_EVENT_SCHEMA_VERSION` is 1 and is the only value the tree has ever
produced; every `rank_events` row is by definition one raw behavioural event;
and `rank_events` *is* `04` §11's raw-recent layer. A backfill `UPDATE` would
touch every row for a constant. PostgreSQL 11+ stores a non-volatile ADD
COLUMN DEFAULT in the catalogue and does **not** rewrite the heap, so on a
populated production table this is a catalogue update under a brief ACCESS
EXCLUSIVE lock.

**RECOVERY — free, no data loss.**
```sql
BEGIN;
ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_dwell_pairing_check;
ALTER TABLE public.rank_events DROP COLUMN IF EXISTS dwell_kind;
ALTER TABLE public.rank_events DROP COLUMN IF EXISTS dwell_ms;
ALTER TABLE public.rank_events DROP COLUMN IF EXISTS retention_tier;
ALTER TABLE public.rank_events DROP COLUMN IF EXISTS privacy_class;
ALTER TABLE public.rank_events DROP COLUMN IF EXISTS schema_version;
COMMIT;
```
Executed against a **populated** portava-ci (239 rows) and verified: five
columns gone, 239 rows intact. **EXPIRY:** once a writer populates `dwell_ms`
or `dwell_kind`, this DROP destroys measurements that exist nowhere else.
Reverse before the dwell writer ships, or not at all.

---

### 2891 — `rank_events.recommendation_id` + the idempotency arbiter (DV-37)

Adds `recommendation_id text NULL`, a shape CHECK, and
`UNIQUE (recommendation_id, outcome)`.

```
PRE   SELECT count(*) FROM public.rank_events;                 -- record it
PRE   SELECT relname, pg_size_pretty(pg_relation_size(oid)) AS heap
        FROM pg_class WHERE relname = 'rank_events';
      -- THE LOCK DECISION. CREATE INDEX (non-concurrent) takes a SHARE lock:
      -- reads proceed, INSERTS BLOCK for the build. The index is NOT partial,
      -- so the build scans EVERY row. If this table is large enough that a
      -- blocking build is unwelcome, use the CONCURRENTLY variant below.

PRE   SELECT ic.relname, i.indisunique, i.indpred IS NOT NULL AS is_partial
        FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
       WHERE i.indrelid = 'public.rank_events'::regclass AND i.indisunique;
      -- expect ONLY rank_events_pkey. A second unique index means another lane
      -- defined an arbiter; the file refuses to add a competing one.

APPLY the file whole, in its own transaction, as written. Idempotent.

POST  SELECT count(*) FROM public.rank_events;   -- MUST equal PRE
POST  SELECT count(*) FROM public.rank_events WHERE recommendation_id IS NOT NULL;
      -- MUST be 0. The file writes no token and must not have back-derived one
      -- for history: two historical rows are not "the same exposure" on the
      -- strength of a hash nobody witnessed being computed at serve time.
POST  SELECT pg_get_indexdef(i.indexrelid)
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'rank_events_recommendation_idempotency_idx';
      -- expect exactly:
      --   CREATE UNIQUE INDEX rank_events_recommendation_idempotency_idx
      --     ON public.rank_events USING btree (recommendation_id, outcome)
      -- with NO WHERE clause. A WHERE clause here is a DEFECT — see below.
```

**THE TWO DESIGN POINTS, AND WHY THE OBVIOUS SHAPES ARE BOTH WRONG.**

* **Not `UNIQUE (user_id, item_id, session_id, served_at)`**, which is the other
  settlement DV-37 names. That index is built over existing rows and fails if
  production holds one duplicate tuple — and production could not be read, while
  portava-ci held zero rows, so the rehearsal could have proved nothing about
  it. Worse, `session_id` is NULLABLE and NULLs are DISTINCT in a unique index,
  so every row written without a session would be unique against every other
  such row: the key would guarantee nothing for exactly the rows most likely to
  be replayed, while looking like a guarantee.
* **Not `UNIQUE (recommendation_id)` alone.** `rank_events` stores an exposure
  and each of its outcomes as separate rows, and they share one recommendation
  id. A single-column key rejects the tap and save rows — fire-and-forget, so
  the rejection is a `logger.warn` and the data is gone.
* **NOT PARTIAL, and this was found by rehearsing rather than by reasoning.**
  The first draft used `WHERE recommendation_id IS NOT NULL`. PostgreSQL only
  infers a partial index as an `ON CONFLICT` arbiter if the statement repeats
  the predicate, and **supabase-js's `onConflict` takes a bare column list** —
  PostgREST renders it as `ON CONFLICT (cols)` with no predicate. The rehearsal
  returned `ERROR: 42P10: there is no unique or exclusion constraint matching
  the ON CONFLICT specification`. A partial index would have been an idempotency
  guarantee **the only writer in this codebase cannot invoke**. The cost of the
  full index — one entry per `rank_events` row — is accepted for that reason.

**THE CODE HALF, WHICH THIS FILE DOES NOT SUPPLY.**
`lib/discoveryServeLog.ts:444` is still a bare `.insert(rows)`. DV-37 closes
only when the writer also does:
```ts
recommendation_id: recommendationIdFor({ ... }),         // in the row literal
.upsert(rows, { onConflict: "recommendation_id,outcome", ignoreDuplicates: true })
```
`onConflict` must name **both** columns in that order; `"recommendation_id"`
alone raises 42P10.

**CONCURRENTLY variant — for a large production `rank_events`.** Cannot be used
from inside the file (`CREATE INDEX CONCURRENTLY` may not run in a transaction
block, and the file must be transactional so a failed index cannot leave a
committed column with no arbiter). Run the file with the `CREATE UNIQUE INDEX`
line removed, then, outside any transaction:
```sql
CREATE UNIQUE INDEX CONCURRENTLY rank_events_recommendation_idempotency_idx
  ON public.rank_events (recommendation_id, outcome);
-- then VERIFY it is valid — a failed concurrent build leaves an INVALID index
-- that silently arbitrates nothing:
SELECT i.indisvalid, i.indisready
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname = 'rank_events_recommendation_idempotency_idx';
-- indisvalid MUST be true. If false: DROP INDEX and retry.
```
Then re-run the file's POST checks.

**RECOVERY — free, no data loss.**
```sql
BEGIN;
DROP INDEX IF EXISTS public.rank_events_recommendation_idempotency_idx;
ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_recommendation_id_shape_check;
ALTER TABLE public.rank_events DROP COLUMN IF EXISTS recommendation_id;
COMMIT;
```
**Executed for real on portava-ci and verified**, then the corrected file was
re-applied over a populated table. **EXPIRY:** once the writer above ships, this
DROP destroys the only durable copy of the exposure token and removes the
idempotency guarantee — it stops being a rollback and becomes a behaviour
change.

---

### 2892 — `place_momentum` (DC-07, DV-72)

Creates `public.place_momentum`, two functions
(`place_momentum_classify`, `rebuild_place_momentum`), three indexes, RLS with
no policies, service_role-only grants. **Touches no existing table.**

```
PRE   SELECT to_regclass('public.place_momentum');           -- expect NULL
PRE   SELECT to_regclass('public.rank_events');              -- must NOT be NULL
PRE   SELECT proname FROM pg_proc
       WHERE proname IN ('place_momentum_classify','rebuild_place_momentum');
      -- expect no rows

APPLY the file whole, in its own transaction, as written. Idempotent.

POST  SELECT count(*) FROM public.place_momentum;
      -- The file's last postcondition CALLS rebuild_place_momentum(now()), so on
      -- production this will be NON-ZERO: one row per place appearing in
      -- rank_events within the last 30 days. That is intended — it exercises the
      -- rebuild rather than merely describing it. Those rows are derived and
      -- rederivable; see RECOVERY.

POST  SELECT count(*) FROM public.place_momentum
       WHERE trend_state <> public.place_momentum_classify(
               recent_rate, mid_rate, prior_rate, total_weight);
      -- MUST be 0: no row may carry a verdict its own stored evidence does not
      -- produce.

POST  SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='place_momentum';           -- true
POST  SELECT grantee, privilege_type FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name='place_momentum';
      -- expect service_role (and the table owner) ONLY. NO anon, NO
      -- authenticated, NO PUBLIC. This is a per-place behavioural aggregate;
      -- exposed through PostgREST it is an activity feed for the whole product.

POST  SELECT count(*) FROM public.rank_events;   -- MUST equal the 2890 PRE number
```

**THE DRIFT HAZARD, NAMED.** `rebuild_place_momentum` and
`place_momentum_classify` are a **second implementation** of
`lib/discoveryTrendState.computeTrendStates` / `classifyTrendState`, in SQL.
That is the main risk in the file and it is contained three ways: constants
declared once with their TypeScript symbol named beside them; constants stored
on **every row** (`event_weights`, `window_ms`, `thresholds`) so a row written
by a drifted function is self-identifying; and six behavioural assertions in the
file's own postconditions, one per `03` §9 stage.
**The parity test that must still be written and registered:**
`artifacts/api-server/src/test/placeMomentumSqlParity.test.ts` — run
`classifyTrendState` and `public.place_momentum_classify()` over the same
evidence tuples and assert agreement. This lane may not edit
`artifacts/api-server/package.json` to register it.

**RECOVERY — free, and uniquely so.**
```sql
BEGIN;
DROP FUNCTION IF EXISTS public.rebuild_place_momentum(timestamptz);
DROP FUNCTION IF EXISTS public.place_momentum_classify(double precision, double precision, double precision, double precision);
DROP TABLE IF EXISTS public.place_momentum;
COMMIT;
```
This is the only object in Batch E that can be dropped **with rows in it** and
lose nothing, because every row is a pure function of `rank_events` and
`rebuild_place_momentum()` recomputes it. **Proved, not asserted:** on
portava-ci the table was dropped with six rows in it and rebuilt from scratch to
byte-identical values (E4 step 16). **EXPIRY:** if a retention sweep on
`rank_events` ever ships, a snapshot whose source rows have aged out stops being
rederivable and this reversal acquires a real loss.

---

### 2893 — retire seven writerless `rank_events.surface` labels (DV-44) — **OPTIONAL, LAST**

Narrows `rank_events_surface_check` from the post-2298 **fifteen** to **eight**.
Retires `search`, `nearby`, `story`, `event`, `trip`, `profile`, `explore`.

```
PRE   SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c
        JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE n.nspname='public' AND t.relname='rank_events'
         AND c.conname='rank_events_surface_check';
      -- MUST list all FIFTEEN post-2298 labels, 'wall' included. If 'wall' is
      -- missing, 2298 is unapplied: apply it first. The file refuses otherwise,
      -- so that a retirement migration cannot smuggle in 2298's widening.

PRE   SELECT surface, count(*) FROM public.rank_events GROUP BY 1 ORDER BY 2 DESC;
      -- THE DECIDING MEASUREMENT, AND IT MUST BE TAKEN HERE.
      -- Any count against search / nearby / story / event / trip / profile /
      -- explore means a writer exists that this lane's audit did not find.
      -- The file's own precondition counts the same thing and ABORTS with the
      -- per-surface counts, changing nothing — verified on portava-ci by
      -- planting two such rows (E4 step 18).
      -- IF IT ABORTS: investigate the writer. Do NOT delete the rows to make
      -- the constraint fit, and do NOT relabel them onto a permitted surface —
      -- surface is the partition key every exposure denominator groups on, and
      -- relabelling corrupts the surface it borrows.

APPLY the file whole, in its own transaction, as written.

POST  repeat the PRE constraint query -- expect exactly EIGHT labels:
      pulse, discovery, events, compass, live_pulse, living_page, watch_feed, wall
POST  SELECT count(*) FROM public.rank_events;   -- MUST equal the PRE number
POST  SELECT count(*) FROM public.rank_events
       WHERE surface <> ALL (ARRAY['pulse','discovery','events','compass',
             'live_pulse','living_page','watch_feed','wall']::text[]);   -- 0
```

**THE CENSUS SAYS NINE; IT IS SEVEN.** DV-44 lists nine zero-row surfaces and
this file retires only seven. `living_page` and `watch_feed` have **intentional
writers** — `routes/rankEvents.ts:75#surface: "living_page"` and `routes/mediaFeed.ts:1759` — and their
zero production counts are the scar of the pre-0202 CHECK blackout that
`lib/discoveryServeLog.ts:14-35` already documents, not the absence of a
producer. Retiring them would re-open exactly the blackout 0202 closed. **"Zero
rows" and "no writer" are different claims**, and this file retires on writer
evidence with the row count used only as a safety veto.

The seven that *are* retired appear only as members of the `SurfaceName` type
union (`services/ranking/DiscoveryRankingService.ts:29-39`). Its three analytics
writers take `surface: SurfaceName` as a *parameter*, so the union makes the
labels expressible; no production call site passes any of them. The only
occurrences outside the type declaration are a doc comment and
`services/ranking/__tests__/feedSlotAllocator.test.ts:204`, which reaches
`allocateFeedSlots` and never `rank_events`. **A type union is not a writer.**

Independently corroborated: after 2893, `check:enum-literals` derives
`rank_events.surface => ["pulse","discovery","events","compass","live_pulse",
"living_page","watch_feed","wall"]` from baseline + 605 migrations and still
passes — so no filter or write literal anywhere in `src/` names a retired
surface.

**RECOVERY — structurally total, but see E6.**
```sql
BEGIN;
ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_surface_check;
ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_surface_check
  CHECK (surface = ANY (ARRAY['pulse','discovery','events','compass','search',
    'nearby','story','event','trip','profile','explore','live_pulse',
    'living_page','watch_feed','wall']::text[]));
COMMIT;
```
Executed for real on portava-ci and verified, then 2893 re-applied. The widened
list is a strict superset, so the reversal can never fail on a row. **What it
cannot restore is any row rejected while the narrowing was in force** — E6.

---

### 2220 / 2217 — the two Discovery files already in tree and unapplied

```
2220_canonical_locations_search_key.sql  (B01)
PRE   SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name='canonical_locations'
         AND column_name='search_key';                    -- expect NO ROW
PRE   SELECT count(*) FROM public.canonical_locations;     -- record it
POST  SELECT public.input_normalize_city_key('Đà Nẵng');   -- 'da nang'
POST  SELECT count(*) FROM public.canonical_locations WHERE search_key IS NULL;
      -- expect 0 for every row with a non-NULL name: the column is GENERATED
      -- ALWAYS ... STORED, so the ALTER backfills every existing row itself.
POST  SELECT count(*) FROM public.canonical_locations;     -- MUST equal PRE
RECOVERY  DROP INDEX IF EXISTS public.canonical_locations_search_key_trgm_idx;
          ALTER TABLE public.canonical_locations DROP COLUMN IF EXISTS search_key;
          DROP FUNCTION IF EXISTS public.input_normalize_city_key(text);
          -- Free: the column is generated, so nothing user-authored is lost.
          -- It REOPENS the §10 diacritic gap — "da nang" stops matching "Đà Nẵng".

2217_protected_locations.sql             (B04 — see E7, this does NOT close it)
PRE   SELECT to_regclass('public.protected_zones');        -- expect NULL
POST  SELECT count(*) FROM public.protected_zones;         -- expect 0. SHIPS EMPTY.
POST  SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relname='protected_zones';         -- true
POST  SELECT grantee FROM information_schema.role_table_grants
       WHERE table_schema='public' AND table_name='protected_zones';
      -- service_role (and owner) ONLY. The row list is a map of what it protects.
RECOVERY  DROP TABLE IF EXISTS public.protected_zones;
          -- Free while the table is empty, which it is by design. It stops being
          -- free the moment a policy owner writes the first zone.
```

### The four flag seeds (step 4)

```
PRE   SELECT flag, enabled FROM public.feature_flags
       WHERE flag IN ('discovery_ranking_modifiers_enabled',
                      'discovery_buddy_launch_gate_enabled',
                      'discovery_candidate_projection_enabled',
                      'discovery_live_rank_enabled');
      -- expect ZERO ROWS. Each file refuses to commit if its row reads TRUE.

APPLY 2289, 2360, 2361, 2850 — each is one INSERT ... ON CONFLICT (flag) DO NOTHING.

POST  repeat the PRE query -- expect FOUR rows, every `enabled` FALSE.

RECOVERY  DELETE FROM public.feature_flags WHERE flag IN (...the four...);
          -- Free and total: a fail-closed reader treats an absent row exactly as
          -- it treats FALSE, so deleting the seed restores the current behaviour
          -- byte for byte.
```

**DO NOT ENABLE ANY OF THESE.** All four seed FALSE and the readers fail closed
on absent / false / unreadable. Flipping one is a separate owner decision about
a live user-facing surface; seeding the row makes the decision *possible*, and
is not the decision.

## E3. What each file is worth, and what it is not

| File | Unblocks | Does it CLOSE the row? |
|---|---|---|
| 2890 | DV-38, DV-39, DV-41 | **No.** Columns exist; nothing writes them. `lib/discoveryServeLog.ts` writes the same values into the `features` JSONB. No client emits dwell at all. |
| 2891 | DV-37, and DC-33's retry leg | **No.** The arbiter exists; the writer still has no `onConflict` and no column write — and DV-37 itself notes no retry path exists to be idempotent about yet. |
| 2892 | DC-07, DV-72 | **No.** The durable store and its rebuild exist; nothing schedules the rebuild and no reader consults the table. DV-72 stays 1 of 5 — four projections are not this lane's. |
| 2893 | DV-44 | **Arguably yes for the migration half**, and it also corrects the row: seven, not nine. |
| 2220 | B01 | Yes for the DEPLOY blocker. |
| 2217 | B04 | **No** — see E7. |
| 2289/2360/2361/2850 | four FLAG rows | Makes the flags *settable*. Enabling remains an owner decision. |
| — | A10, A11 | **Not this lane's files.** A10 needs `2420_trip_kernel_foundation.sql` (for `trips.version`) plus flag 2550; A11 needs the 2760–2785 Trip schema plus flag 2778. Both are Trips-lane migrations already in tree and unapplied; Batch C and Batch D of this runbook cover them. |
| — | DC-15 | **Partially, and only forward.** 2890/2891/2892/2893 each carry expected cardinality, index rationale and EXPLAIN verification. `10` §7 forbids editing an applied migration, so the Discovery migrations that lack them cannot be fixed in place. |

## E4. The portava-ci rehearsal — transcript

Target: **`hwokxgbmezheskbzskfr` only**. Production was never contacted.

**BEFORE (read before any write).** `rank_events` = **0 rows**, 13 columns
(`user_id` NOT NULL, `session_id` NULLABLE); `rank_events_surface_check` = the
post-2298 FIFTEEN; `rank_events_outcome_check` = the post-2297 eight;
`place_momentum` **absent**; `protected_zones` **present**;
`schema_migration_ledger` **present**; `canonical_locations.search_key`
**present**; `feature_flags` columns `flag,enabled,description,updated_at,metadata`.
**So portava-ci already carries 2217, 2220, 2254, 2297 and 2298, and production
carries none of them — the two databases differ, and every claim below is
scoped to the one that was tested.**

| # | Step | Result |
|---|---|---|
| 1 | Apply **2890** | committed; all preconditions and postconditions passed |
| 2 | Apply **2891** *(first draft, PARTIAL index)* | committed |
| 3 | Rehearse the DV-37 retry: `ON CONFLICT (recommendation_id, outcome) DO NOTHING` | **`ERROR 42P10: there is no unique or exclusion constraint matching the ON CONFLICT specification`** — the partial index cannot be named. **Design changed.** |
| 4 | Execute 2891's RECOVERY block for real | `recommendation_id absent — clean`; 0 rows lost |
| 5 | Seed 236 `rank_events` rows, all with `recommendation_id` absent | 236 rows / 134 impressions / 99 analytics / 5 distinct items |
| 6 | Apply **corrected 2891** over the POPULATED table | committed; index built over 236 NULL-token rows; `CREATE UNIQUE INDEX … (recommendation_id, outcome)`, no WHERE |
| 7 | first impression insert with a token | 1 row |
| 8 | **retry with `ON CONFLICT (recommendation_id, outcome) DO NOTHING`** | **0 rows — deduped. DV-37's guarantee, demonstrated.** |
| 9 | same retry with NO `ON CONFLICT` | **rejected 23505 by the arbiter** |
| 10 | `'tap'` row carrying the SAME token | **1 row — accepted.** The case a single-column key would have destroyed. |
| 11 | 2890 defaults on the 236 PRE-EXISTING rows | **238 of 238 read `schema_version = 1`** (catalogue default, no heap rewrite) |
| 12 | `dwell_kind='idle'` with NULL `dwell_ms` | rejected by `rank_events_dwell_pairing_check` |
| 13 | `dwell_ms = -5` | rejected by `rank_events_dwell_ms_check` |
| 14 | `dwell_ms = 0` with `dwell_kind='idle'` | **stored.** 1 measured-zero row vs 238 NULL rows — `04` §7's distinction holds |
| 15 | malformed token; unknown `privacy_class` | both rejected by their CHECKs |
| 16 | Apply **2892**, run `rebuild_place_momentum(now())` | **6 place rows**; rerun for the same instant → 6 rows touched, **6 total — idempotent**; the 99-row analytics-only place → **0 rows, correctly excluded** |
| 17 | Verify the classifier against hand-computed TypeScript | `node/EMERGING` emerging (recent 10 / 0 / 0) · `node/COOLING` cooling (4 / **20.000** / 0) · `node/REDISC` rediscovered (10 / 0 / **5.217**) · `node/SAVED` emerging (**12.000**) · `node/REHEARSAL2` unknown (1.000). `20.000 = 50/2.5` and `5.217 = 60/11.5` are the window normalisers; `12 = 3×(1+3)` is a save counted at its own time. **Every value matches.** |
| 18 | Plant `surface='search'` and `surface='trip'` rows, then run **2893** | **`PRECONDITION FAILED (2893): 2 row(s) carry a surface this file retires — search=1 trip=1. Nothing has been changed.`** Constraint verified intact afterwards — **the veto fires and the abort rolls back.** |
| 19 | Delete the planted rows, apply **2893** | committed; fifteen → eight; **239 rows preserved**; a post-apply `surface='search'` probe rejected |
| 20 | **RECOVERY REHEARSAL A** — 2890's reversal on the populated table | 5 columns gone, **239 rows preserved**; rolled back, columns restored |
| 21 | **RECOVERY REHEARSAL B** — 2893's reversal, executed for real | fifteen-label vocabulary restored, 239 rows preserved |
| 22 | **RECOVERY REHEARSAL C** — 2892's reversal, executed for real **with 6 rows in the table** | `place_momentum dropped`, 239 source rows preserved |
| 23 | Re-apply 2892 and re-run the rebuild from scratch | **the same 6 rows, byte-identical values** — `10` §10 rebuildability demonstrated end to end, not asserted |
| 24 | Re-apply 2893 | **FINAL CI STATE:** 239 `rank_events` rows, 6 `place_momentum` rows, eight-label surface vocabulary |

**EXPLAIN verification** (`enable_seqscan = off`, so the claim is that the index
is *usable* for the path; portava-ci's row counts make the cost estimates
meaningless and no claim is made from them):

```
Index Scan using rank_events_recommendation_idempotency_idx on rank_events
  (cost=0.27..2.49 rows=1 width=304)
  Index Cond: ((recommendation_id = 'AAAAAAAAAAAAAAAAAAAAAA') AND (outcome = 'impression'))

Limit  ->  Index Scan using place_momentum_place_computed_idx on place_momentum
             Index Cond: (place_id = 'node/EMERGING')            -- no Sort node

Limit  ->  Index Scan using place_momentum_live_state_idx on place_momentum
             Index Cond: (trend_state = 'emerging')              -- partial index chosen
```

**Static checks, whole repo, after all four files:** `npx tsc --noEmit` → 0 ·
`check:migration-prefixes` → PASSED (534 files, band clean) ·
`check:schema-references` → no new undeclared references ·
`check:enum-literals` → no undeclared literals off the ratchets ·
`check:not-null-writes` → no write payload nulls a NOT NULL column.
`check:write-path-columns` **could not run**: it fails closed without
`KNOWN_PROD_PROJECT_REF` / `CI_SUPABASE_PROJECT_REF` (exit 2). That is its
production denylist refusing an unasserted target, not a finding about these
files, and it was deliberately not worked around.

**portava-ci was left in the forward state with rehearsal data in it** (239
`rank_events` rows, 6 `place_momentum` rows, all seeded by this lane on
`surface='discovery'`). It was not restored to empty, because the seeded rows
are what make a future re-rehearsal meaningful. They are synthetic and belong to
one auth user.

## E5. Backup and recovery posture — production has no ledger

**This is the section to read before step 1.**

`public.schema_migration_ledger` does not exist on production, so **recovery
cannot rely on it**, and neither can the question "was this applied?". Three
consequences, stated rather than implied:

1. **A point-in-time restore is the only true undo.** Take one before step 1 and
   **confirm it is restorable** — an unconfirmed backup is not a backup. Every
   per-file RECOVERY block below is a *forward* correction that returns the
   schema to its prior shape; none of them is a restore, and none of them
   recovers a row that a different process deleted in the meantime.
2. **Record what you ran, by hand, as you run it.** File name, timestamp,
   operator, and the PRE/POST numbers each file asks you to record. With no
   ledger, that note *is* the record. This is why step 1 recommends applying
   2254 first: after it, the record is the database's job rather than a person's.
3. **"Is it applied?" must be answered by object inspection, per file, using the
   PRE checks above** — never by the filename and never by the ledger, which
   will not exist. Each PRE check in E2 is written to be that inspection.

**Reversibility, ranked.**

| Class | Files | Cost of reversing |
|---|---|---|
| **Free, no loss** | 2890, 2891, the four flag seeds, 2220 | Additive columns / generated column / seed rows. DROP or DELETE restores the prior shape exactly. Each has an EXPIRY CONDITION naming the moment it stops being free. |
| **Free, and free even with rows in it** | 2892 | Every row is rederivable from `rank_events`. Proven by dropping a populated table and rebuilding it identically. |
| **Free while empty** | 2217 | Ships empty by design; free until a policy owner writes the first zone. |
| **Structurally free, but with a loss window** | **2893** | See E6. |

## E6. NOT CLEANLY REVERSIBLE — `2893`, named

**2893 is the only file in Batch E that is not cleanly reversible, and it is
optional for exactly that reason.**

The DDL reversal is one `ALTER` and restores the pre-2893 vocabulary exactly.
What it cannot restore is **any `rank_events` row rejected while the narrowed
constraint was in force**. Every `rank_events` writer in this codebase is
fire-and-forget: the insert's error goes to a `logger.warn` and the row is gone.
So if a writer for one of the seven retired surfaces appears between the apply
and the reversal — a new feature, a merged branch, a call site that starts
passing `surface: "search"` — its rows are lost silently for the whole window,
and no rollback brings them back.

**The loss set is empty by construction at the moment of apply**, because no
such writer exists today and the file's own precondition proves no such row
exists on the target. It stops being empty the moment one is written. **This is
the only file in the batch whose risk grows with time rather than staying
fixed.**

**The argument for applying it anyway:** a developer who adds
`surface: "search"` *after* this file gets a 23514 that the existing
`logger.warn` reports, in CI, against a constraint that names exactly which
labels are live — instead of writing silently into a vocabulary nobody has
proved anybody reads. `04` §10 is "prove a writer **or retire it**", and a label
kept alive with no writer is the state §10.3-4 exists to end.

**If that trade is not wanted, skip 2893.** Nothing depends on it; 2890, 2891
and 2892 are unaffected.

**A residual asymmetry worth naming:** `SurfaceName`
(`services/ranking/DiscoveryRankingService.ts:29-39`) still lists all seven
retired labels as type members. After 2893, the type permits what the database
refuses. The smallest correct follow-up is to narrow that union to the eight —
but it is application source outside the migrations lane, it is used for
slot-allocation config as well as for `rank_events` writes, and narrowing it was
**deliberately not done here**. Until it is, the type is a standing invitation to
write a surface the database will reject.

## E7. What Batch E does NOT do

* **It does not close B04.** Applying 2217 creates `protected_zones`, but
  `lib/protectedLocations.ts` is still consulted by nothing in
  `routes/discovery*.ts` or `lib/discovery*.ts`. A protected zone that is not a
  hidden gem still has no effect on a Discovery result. B04 needs the consumer
  wiring, which is CODE.
* **It does not close DC-33.** The failing leg is `retry`, and DV-37 records
  that no retry path exists to test. 2891 supplies the arbiter a retry would
  need; the retry itself, and the end-to-end route→service→projection→client
  test, are CODE.
* **It does not touch A10 or A11.** Both are gated on Trips-lane migrations
  already in tree and unapplied (2420, and 2760–2785), covered by Batches C
  and D.
* **It enables no flag**, on any database.
* **It applied nothing to production.**

**THE PRODUCTION HOLD ON EVERYTHING OUTSIDE THIS SCOPE REMAINS IN PLACE.**
Batch E is the evidence and the procedure for the scope the owner released; it
is not permission for anything beyond it.
