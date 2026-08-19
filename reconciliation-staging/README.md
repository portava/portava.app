# Reconciliation staging package — run-order manifest

**This is a review package, not a run-these set.** Nothing in this directory
is applied, nothing is merged into the canonical migration tree
(`artifacts/api-server/src/migrations/`), and nothing has touched any
database. It exists so the owner can see exactly what is ready to review and
what is still waiting on live-database evidence, per
[`RECONCILIATION-PACKET.md`](../RECONCILIATION-PACKET.md) §7 and §8.

Deliberately kept **outside** the canonical tree: dropping any of these files
into `artifacts/api-server/src/migrations/` would make `audit:schema` red and
falsely imply they are ready to apply. They stay here until each is reviewed,
its blocking query (if any) has returned, and — for every policy-touching
file — its rollback has been captured from live.

## Findings caught by hand while authoring 2118

These two are called out on their own, separate from the general corrections
list below, because of what they are: exactly the class of defect
`RECONCILIATION-PACKET.md` §5 Step 5's proposed bidirectional auditor
(`audit:live-unexplained`) exists to catch mechanically, caught here instead
by directly reading three trees' SQL side by side while authoring 2118. That
auditor does not exist yet (Step 5 is not built). Until it is, this is the
only record of these two, so they are surfaced here rather than only in
2118's own header — the next person reads this file, not the SQL.

1. **`discovery_places_public_read` is the same policy NAME with a
   DIFFERENT PREDICATE across trees.** Canonical: `USING (status = 'active')`.
   Legacy and root: `USING (true)` — unfiltered. This is a live instance of
   the exact hole `RECONCILIATION-PACKET.md` §3.3 describes for the forward
   auditor ("a live policy with a different predicate reads as present").
   Only one of the three definitions can ever have successfully applied — a
   second `CREATE POLICY` under an existing name errors rather than
   silently no-opping — so whichever tree's file ran first is what is live
   today, and Q3 is what settles it. **2118 converges on canonical's
   stricter, filtered predicate. If the unfiltered version is what is
   actually live, applying 2118 is a real behavior change** (provisional/
   non-active places stop being publicly visible), not a cosmetic rename —
   treat it as a product decision requiring sign-off, not just a schema fix.
2. **Canonical's own `discovery_places_auth_insert` check is weaker than
   legacy's or root's.** Canonical only requires `auth.uid() IS NOT NULL` —
   it never checks that `submitted_by = auth.uid()`. As declared, any
   authenticated user could insert a row attributing it to a different
   user's profile id. Legacy's and root's checks both correctly require
   `submitted_by = auth.uid()`. **2118 adopts the stricter legacy/root
   check, not canonical's own** — canonical is the gap here, not the fix.

## Corrections made to the packet during authoring

Flagging these rather than silently inheriting or silently fixing them,
per the standing instruction to surface conflicts with prior work instead of
overriding it:

1. **The template files named for this task (2096–2099) do not exist in the
   canonical tree or anywhere in git history.** The highest canonical file is
   `2095_discovery_place_photos.sql`. The four files actually committed this
   week (2026-08-15) are **2092–2095**, and those are what this package's
   house style is drawn from. See git log for confirmation.
2. **2096–2099 are separately claimed, by the owner, to be four migrations
   applied directly to production via the Supabase SQL editor this week and
   never committed to any tree.** This session did not verify that claim and
   did not write DDL reconstructing it — see
   [`2096-2099_OWNER_ASSERTED_APPLIED.md`](./2096-2099_OWNER_ASSERTED_APPLIED.md)
   for the full reasoning, including a mid-task message asserting a detailed
   verification grading for those four that arrived flagged by the system as
   not confirmed human input, and is therefore not relied upon here.
3. **`RECONCILIATION-PACKET.md` §5 Step 1.7 says to "reserve 2096–2099 as an
   unusable buffer."** If the owner's claim in (2) is correct, that ruling
   needs revisiting — the range is not unused, it is undocumented. Flagged
   for the packet owner in `2096-2099_OWNER_ASSERTED_APPLIED.md`; not changed
   here, since the correct fix depends on facts only the owner can confirm.
4. **§5.4's Class-C RLS_UNDISPOSED list (12 tables) is stale.**
   `compass_memories` already has RLS live (independently confirmed) and no
   longer belongs in that list. **2107** covers the remaining 11.
5. **§5.4's Class-A list includes `safe_return_contacts` as "RLS enabled,
   zero policies."** Direct verification of canonical
   (`0167_safety_ddl_reconcile.sql:70-79`) found a live, surviving policy
   (`src_session_owner`) on that table. It is not Class A and is excluded
   from **2109**, which covers the other 6.
6. **§7's row for 2115 says "events + 6 sub-tables" (7 tables).**
   `docs/migrations/0065_events.sql` actually declares 8
   (`events` + 7 sub-tables). **2115** covers all 8 and documents the
   correction; a distinct table, `event_attendees`, is confirmed
   self-contained in canonical and out of scope.
7. **The packet describes the `feature_flags.trip_crew_ghost_mode_enabled`
   conflict as "last-writer-wins."** All five writers found in the repo are
   `INSERT ... ON CONFLICT DO NOTHING`, which is first-writer-wins on the
   primary key, not last-writer-wins. The practical conclusion (live value
   unrecoverable from files) is unchanged; **2111** is written to not depend
   on which characterization is correct.
8. **The three prior-reconciliation documents named for this task**
   (`docs/main-reconciliation-plan.md`, `.agents/memory/legacy-migration-reconciliation.md`,
   `_incoming/prod-apply-flag-reconciliation.sql`) were read in full. None
   conflicts with this package: the first is about an unrelated git-branch
   history reconciliation; the second documents lessons (naming drift,
   `IF NOT EXISTS` pitfalls) that were applied where relevant (e.g. 2102,
   2110); the third documents the already-applied 2084–2086 flag migrations
   and is consistent with — and cited by — 2111.
9. **2102's scope**: the packet's own §4.3 manifest row and its §7
   migration-description text disagree about whether canonical's
   `plan_item_id` (→ `trip_plan_items`) is part of this conflict. 2102 does
   not resolve that disagreement — see its header.
10. **§7's row for 2117 says "four disjoint policy families" for
    `pulse_geo_tags`.** Direct verification found three distinct policy
    identities across four declaration sites — two of the four files
    (`docs/sql/0036`, root `migrations/0036`) declare the exact same two
    policy names with the exact same predicates, which is duplication, not
    disjointness. 2117 still reconciles all four sites; only the count
    description is corrected.
11. **`discovery_places_public_read` / `discovery_places_auth_insert`** —
    see "Findings caught by hand while authoring 2118" above; not repeated
    here.
12. **§7's 2118 grouping (`passport_stamps`, `trip_crew_location_sessions`,
    `discovery_places`, `user_privacy_settings`) is split**, per the
    packet's own instruction to split out a materially riskier item —
    `passport_stamps` depends on a `visibility` column two of three trees
    never declare, a column-existence hazard the other three tables don't
    have. See `2118b_passport_stamps_policy_convergence.sql` and the file
    count note below.

## Read-path audit findings applied in this package

The owner supplied the results of a read-path audit covering all 23
RLS-candidate tables across Class C, Class D, and the Class-A user-facing 7
(RECONCILIATION-PACKET.md §5.4): **the client queries only 10 tables total,
and none of the 23 candidates is among them.** This resolves the
"read-path audit" precondition §7 attached to 2107, 2108, and 2109 — it does
**not** resolve Q1/Q3, which remain required for each. Consequences applied:

- **2107** covers 11 tables (not 12 — see correction 4 above).
- **2108** applies `DENY_ALL_BY_DESIGN` directly rather than the
  "minimal policies" hedge in the packet's original §7 text, since the
  evidence that motivated the hedge (a possible client read path) did not
  hold.
- **2109** collapses to written-disposition comments on 6 tables (not 7 —
  see correction 5 above), since a read-path audit showing zero client
  reads is exactly the condition under which §7 said these tables "prove
  service-role-only ... and are not touched."

## Run-order manifest

| # | file | purpose | blocked on | rollback | risk |
|---|---|---|---|---|---|
| — | `2096-2099_OWNER_ASSERTED_APPLIED.md` | Records an owner claim of four applied-but-uncommitted production migrations; not SQL, not applied by this session | Q1, Q3 (to move off the claim entirely) | n/a — no DDL | n/a |
| 2100 | `2100_plan_geofences_policy_convergence.sql` | Converge 3 disjoint `plan_geofences` policy families into one owner+accepted-member family, closing a write path canonical's unfiltered `FOR ALL` opened | **Q3** | **needs-live-capture** — policy-touching, cannot be derived from repo | **High** — candidate open live defect |
| 2101 | `2101_drop_mismatched_public_read_policies.sql` | Drop 4 mis-named public-read policies (`user_follows`, `profiles`, `passport_postcards`) that canonical's 2033 hardening never actually targeted | **Q3** | **needs-live-capture** | **High** — candidate open live defect |
| 2102 | `2102_plan_checkins_attendance_fk_convergence.sql` | Converge `geofence_id`/`plan_geofence_id` FK naming on `plan_checkins`/`plan_attendance_events`; backfill `details`→`metadata` | Q2, Q6 | derivable-now (backfill + relax NOT NULL) | High if Q2 confirms both NOT NULL — write path may be broken today |
| 2103 | `2103_geofence_admin_settings_radius_convergence.sql` | Converge 3 radius-column vocabularies (`*_radius`/`*_radius_m`/`*_radius_meters`) on `geofence_admin_settings` | Q2 | derivable-now | Low |
| 2104 | `2104_geo_zone_and_geofence_vocabulary_check.sql` | Add `CHECK ... NOT VALID` over the union vocabulary for `geo_zones.zone_type` and `plan_geofences.trigger_type` (both canonical's `CREATE TYPE` attempts are invalid DDL); widen `radius_meters` if integer | Q2, Q5, Q6 | derivable-now | Low — NOT VALID, no scan/rewrite |
| 2105 | `2105_circles_dangling_reference_resolution.sql` | Branch on whether `circles` exists live: adopt (comment-only) or drop the dangling FK on `route_plans.circle_id` | **Q1** | derivable-now (drop branch); n/a (adopt branch) | Medium — real client traffic (`circles.ts:25`) behind the adopt-vs-drop decision; if absent, a live client read path is already broken independent of this migration |
| 2106 | `2106_adopt_viewer_creator_fatigue.sql` | Adopt `viewer_creator_fatigue` (created only in a frozen Supabase root) into canonical so `2058`'s `ALTER TABLE` is no longer orphaned | Q1, Q2, Q3 (accuracy, not safety — see file header) | not needed (additive, deny-all) | Low |
| 2107 | `2107_enable_rls_class_c_internal_caches.sql` | Enable RLS, zero policies, on 11 internal-cache tables with no RLS anywhere in canonical | **Q1, Q3** (read-path audit resolved) | derivable-now (instant DISABLE) | Low, post-read-path-audit; residual risk is an untracked dormant policy Q3 would surface |
| 2108 | `2108_enable_rls_class_d_uncovered_tables.sql` | Enable RLS, zero policies, on 4 tables with no RLS in ANY tree | **Q1, Q3** (read-path audit resolved) | derivable-now | Low, post-read-path-audit — was "highest residual exposure" pre-audit |
| 2109 | `2109_class_a_deny_all_dispositions.sql` | Record written `DENY_ALL_BY_DESIGN` reason on 6 already-RLS-enabled, already-zero-policy user-facing tables | Q3 (read-path audit resolved) | not needed — comment-only | Low |
| 2110 | `2110_location_preferences_table_convergence.sql` | Designate `location_preferences` canonical over `user_location_preferences`; backfill compatible columns only (vocabularies for `pulse_visibility`/`discovery_visibility` are incompatible and deliberately not translated) | Q1, Q2 | derivable-now | Low-medium — data merge, no drop |
| 2111 | `2111_trip_crew_ghost_mode_flag_convergence.sql` | Set `feature_flags.trip_crew_ghost_mode_enabled` to `false` (canonical's own declared value) idempotently | **Q13** | derivable **only if** STEP 0 snapshot is taken first — current value is unknown | Medium-high if flag is currently `true` live — a real product-behavior change, not a schema change |
| 2112 | `2112_document_0027_migration_gap.sql` | Comment-only record of the canonical `0027` numbering-gap resolution | Q1 | not needed — no DDL | None |
| 2113 | `2113_buddy_bookings_kind_convergence.sql` | Branch on `buddy_bookings`'s live `relkind`: rename real table aside + create the compat view 0147 intended, or record it's already a view | **Q1** | derivable-now (rename back, drop view) | Medium — behavior-changing if the rename branch fires (reads switch from stale legacy data to `rent_buddy_bookings`) |
| 2114 | `2114_feature_flags_own_ff_select_all.sql` | Drop `ff_select_all` (frozen root, `USING TRUE`, open to every role); canonical declares its own `feature_flags_service_only` instead of reasoning about a frozen root's policy as its own | **Q3** | needs-live-capture | High — 2071's own header describes this policy incorrectly and cannot have closed it |
| 2115 | `2115_events_family_rls_enable_idempotent.sql` | Declare `ENABLE ROW LEVEL SECURITY` directly in canonical for all 8 tables in the `events` family (currently only in a frozen doc root) | **Q1** | derivable-now (instant DISABLE) | Low on current production (no-op); closes a real clean-rebuild gap |
| 2116 | `2116_post_media_storage_policy_convergence.sql` | Drop composer-pkg's 4 `storage.objects` policies on the `post-media` bucket (incl. a public-read name that reopens exactly what canonical's 2089 closed under a different name); ensure canonical's post-2089 owner insert/delete pair | **Q3** | needs-live-capture | High — candidate open live defect, same shape as 2100/2101 |
| 2117 | `2117_pulse_geo_tags_policy_convergence.sql` | Converge `pulse_geo_tags` onto canonical's public-read + service-write model; drop legacy's 4-policy owner-write family (no client code path uses direct writes) | **Q3** | needs-live-capture | Medium-high |
| 2118 | `2118_trip_crew_discovery_privacy_policy_convergence.sql` | Policy convergence for `trip_crew_location_sessions` (branches on live `allowed_member_ids` element type to avoid a known `::text`-cast defect), `discovery_places` (fixes a same-name-different-predicate hole AND a looser-than-intended canonical INSERT check), `user_privacy_settings` | **Q3** | needs-live-capture | High — apply each of the 3 tables in its own transaction, per §8; do not batch |
| 2118b | `2118b_passport_stamps_policy_convergence.sql` | **Split out of 2118** (packet's own instruction: split a materially riskier item) — `passport_stamps_public_read`'s predicate depends on a `visibility` column two of three trees never declare; file branches on live column presence rather than assuming it | **Q2, Q3** | needs-live-capture | High — column-existence hazard, not just a permission question |

**Note on file count:** this package contains **20 files for the packet's 19
numbered items**, because `RECONCILIATION-PACKET.md` §7 row 2118 explicitly
says "if any one of those four is materially riskier than the others, split
it into its own file rather than grouping a security change with a cosmetic
one" — and direct verification found exactly that (`passport_stamps`'s
policy depends on a column two of three trees don't have). `2118b` is that
split, not a scope addition.

## Reading this table

- **Ready to apply once its query returns, no live capture needed first**:
  2102, 2103, 2104, 2105 (drop branch), 2106, 2107, 2108, 2109, 2110, 2112,
  2113, 2115.
- **Needs Q3 AND a live policy-text capture before it can ever be applied,
  regardless of review**: 2100, 2101, 2114, 2116, 2117, 2118, 2118b. These
  are the seven policy-convergence migrations. Per `RECONCILIATION-PACKET.md` §8: *"Q3's
  output for the affected tables IS the rollback script. It cannot be written
  from the repo, only from live."* No rollback text for a dropped policy has
  been invented anywhere in this package — where a rollback could not be
  derived from the file's own reverse operation, the file says so explicitly
  instead.
- **Needs owner judgment on product impact, not just a query**: 2111 (flag
  flip may be user-visible) and 2113 (view-vs-table switch changes what
  `buddy_bookings` reads return).
- **Comment-only, no schema risk**: 2112, and 2109 in practice (it changes
  no access, only records a reason).

## What this package deliberately does not include

Per `RECONCILIATION-PACKET.md` §7's closing note: most of the packet's
~184-row manifest resolves through the eventual database baseline capture
(§6), not through forward DDL. This package covers only the 19 migrations
§7 names as corrective — it is not a re-derivation of the manifest, the
baseline, the extended freeze guard (§5 Step 1), or the inverse auditor
(§5 Step 5). Those remain separate, larger pieces of work the packet
describes but does not ask this session to build.
