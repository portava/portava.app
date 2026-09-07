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
