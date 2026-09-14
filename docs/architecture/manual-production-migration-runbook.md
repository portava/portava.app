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
