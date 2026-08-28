/**
 * Migration-vs-live schema audit
 *
 * Parses every migration file for the objects it creates (tables, columns,
 * functions, indexes, policies, enums/enum values, triggers, views) and diffs
 * them against the LIVE Supabase schema via the Supabase Management API.
 * This is the committed version of the one-time full audit (2026-07-17) that
 * found ~40 never-applied migrations.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run audit:schema
 * or:
 *   SUPABASE_URL=<url> SUPABASE_PROJECT_TOKEN=<token> \  # or SUPABASE_ACCESS_TOKEN
 *     node --import tsx/esm src/scripts/auditMigrationsVsLive.ts
 *
 * Exit code 0 → no missing objects (ignoring the known-drift allowlist)
 * Exit code 1 → missing objects found (details printed per migration file)
 * Exit code 2 → environment / API error
 *
 * Notes / known gotchas encoded below:
 * - Uses the Management API query endpoint (direct psql is unreachable from
 *   this workspace).
 * - Triggers are checked via pg_trigger, NOT information_schema.triggers,
 *   because the latter omits TRUNCATE triggers.
 * - Tables are matched against tables AND views (legacy buddy_* relations are
 *   compat views over rent_buddy_* tables).
 * - 0050_rent_a_buddy.sql is superseded by the rent_buddy rebuild (0134) and
 *   0105_compass_performance_indexes.sql references columns that never
 *   existed live; both are skipped entirely.
 * - A small allowlist covers columns where the migration file itself is wrong
 *   vs the live schema (e.g. feature_flags.key → flag).
 */

// ── THE ALLOWLIST ASSERTION, IN THE EXECUTION PATH ───────────────────────────
//
// FIRST import, deliberately: ES modules evaluate their imports in source
// order, before the importing module's own body, so this runs before anything
// else in this file. It asserts the project this process is pointed at and
// exits 2 — this script's own "environment / API error" code — if it cannot
// establish it.
//
// It is not a workflow step, so no YAML edit can skip it. This script is
// `audit:schema`, reached from live-db.yml's schema-drift job; deleting the
// `Preflight — Supabase target must be the sanctioned CI project` step from
// that job, disabling it with `if:`, moving it after the install step, or
// adding a brand-new job in a brand-new workflow file all still land here,
// because this process cannot start without it.
//
// This is the READ-ONLY front door, not src/lib/ciSupabaseGuard.mjs. In CI it
// behaves identically — the sanctioned CI project, or exit 2. Outside CI, and
// only outside CI, it additionally permits a read-only audit of the declared
// production project when the operator asks for it by name:
//
//   PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'
//
// This script qualifies because everything it sends is a SELECT: pg_class,
// information_schema.columns, pg_proc, pg_indexes, pg_policies, pg_type/pg_enum
// and pg_trigger. Auditing production is what it is FOR — the drift list in
// docs/migrations.md came from it. If it ever gains a write, move it back to
// src/lib/ciSupabaseGuard.mjs and drop it from the read-only list in
// scripts/check-guard-coverage.mjs, which enforces that list on every run.
//
// See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/README.md.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FROZEN_LEGACY_FILES } from "./frozenLegacyFiles.js";
import { FROZEN_ROOT_FILES } from "./frozenRootFiles.js";

// ── Config ────────────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATION_DIRS = [resolve(__dir, "../migrations")]; // canonical chain

// The legacy chain (artifacts/api-server/migrations/, no src/) is historical
// and diverges heavily from live (e.g. its 0032 creates
// user_location_preferences while the canonical 0032 creates
// location_preferences). Audit it only when explicitly asked.
if (process.argv.includes("--include-legacy")) {
  MIGRATION_DIRS.push(resolve(__dir, "../../migrations"));
}

// ── Frozen-dir guards ─────────────────────────────────────────────────────────
//
// Two migration directories are frozen / archived; neither should receive new
// .sql files.  Both are checked here (no DB credentials required) so that the
// full audit never silently starts against a tampered frozen dir.
//
// FROZEN_LEGACY_FILES / FROZEN_ROOT_FILES are the single sources of truth,
// shared with checkFrozenDir.ts.

function checkFrozenDirGuard(dir: string, frozenSet: Set<string>, label: string): void {
  let entries: string[] = [];
  try {
    entries = (
      readdirSync(dir, { recursive: true }) as string[]
    ).filter((f) => f.endsWith(".sql"));
  } catch {
    // dir not present — nothing to check
    return;
  }
  // A frozen file is stored as a bare filename (no path separator).
  // Anything that contains a "/" (nested) or is not in the known set is rogue.
  const rogueFiles = entries.filter((f) => !frozenSet.has(f));
  if (rogueFiles.length > 0) {
    console.error(
      `\nERROR: ${label} is frozen/archived.\n` +
        "       New database changes must go into artifacts/api-server/src/migrations/ instead.\n\n" +
        "       Unexpected file(s) found:\n" +
        rogueFiles.map((f) => `         • ${f}`).join("\n"),
    );
    process.exit(1);
  }
}

// The two frozen-dir guards run inside main() (below), not at module scope, so
// that importing this module for its exported parser/transport (parseMigration,
// fetchLiveSchema, liveQuery — reused by the inverse auditor
// src/scripts/auditLiveVsCanonical.ts) has no side effect: an import must never
// read directories or exit a process, only an actual `main()` call may. The
// order relative to the env check and the audit loop is unchanged for the
// `audit:schema` entrypoint, which still runs them first.
function runFrozenDirGuards(): void {
  // 1. Legacy dir: artifacts/api-server/migrations/ (frozen 2026-07-17)
  checkFrozenDirGuard(
    resolve(__dir, "../../migrations"),
    FROZEN_LEGACY_FILES,
    "The legacy migrations directory (artifacts/api-server/migrations/)\n" +
      "       See artifacts/api-server/migrations/README.md for details.",
  );

  // 2. Repo-root dir: migrations/ (archived 2026-08-08)
  checkFrozenDirGuard(
    resolve(__dir, "../../../../migrations"),
    FROZEN_ROOT_FILES,
    "The repo-root migrations/ directory\n" +
      "       See migrations/README.md for details.",
  );
}

/** Migration files skipped entirely (superseded or known-drifted). */
const SKIP_FILES = new Set([
  "0050_rent_a_buddy.sql", // superseded by 0134_rent_buddy_schema_rebuild.sql
  "0105_compass_performance_indexes.sql", // references columns that don't exist live
  // superseded by canonical src/migrations/0062_notifications_schema.sql: live
  // has equivalently-purposed policies/indexes under canonical names (e.g.
  // notifications_select_own), and notification_category_preferences is
  // intentionally keyed by (user_id, category) with no id column
  "0041_notifications.sql",
  // 2095_discovery_place_photos.sql — DEFERRED; not applied to any environment.
  // Authored 2026-08-15 but the prod apply sequence skipped it: it is ABSENT from
  // the 2026-08-19 baseline (which post-dates it and records 2096-2100/2107/2119),
  // so discovery_place_photos never landed on prod. It is numbered pre-cutover
  // (< "2100"), so the clean-build proof (baseline + canonical >= "2100") does not
  // reproduce it either — applying it would turn live-db audit:schema green while
  // turning the clean-build audit red. Its table backs the discovery photo-cache
  // unit (src/lib/discoveryPlacePhotoStore.ts), which is NOT yet opened; the code
  // is dormant and the table's absence causes no live errors. Held per the owner's
  // HOLD-until-opened ruling. When that unit is intentionally opened, PROMOTE this
  // into the post-cutover band (renumber >= "2100") and apply it then, deleting
  // this skip at that point.
  "2095_discovery_place_photos.sql",
]);

/**
 * Objects the migration files claim but the live schema intentionally differs
 * on (migration files are wrong vs live — see docs/migrations.md).
 * Keys: "column:table.col", "table:name", "index:name", "policy:table.name",
 * "function:name", "enum:name", "enumvalue:enum.value", "trigger:name",
 * "view:name".
 */
const ALLOWLIST = new Set([
  // 2130_intel_storage.sql creates intel_append_only_stmt(), and
  // 2137_intel_stmt_trigger_removal.sql DROPS it. The drop was deliberate: the
  // statement-level trigger fired on zero-row cascades and broke the live-DB RLS
  // suite's purgeFixtures, which had passed for weeks. The auditor reads each
  // migration's claimed objects independently, so it cannot see that a later
  // migration removed this one — hence an entry here rather than skipping all of
  // 2130, whose other claimed objects must still be verified.
  //
  // The ROW-level intel_append_only() guard that actually enforces append-only is
  // untouched and still audited; only the statement-level variant is gone.
  "function:intel_append_only_stmt",
  // 0035_plan_geofences.sql claims a single broad policy, FOR ALL, granting any
  // trip member full control. Live CI instead carries the four granular policies
  // from reconciliation-staging/2100_plan_geofences_policy_convergence.sql
  // (select/insert/update restricted to ACCEPTED members, delete to the owner),
  // which is strictly tighter. Allowlisted because live is deliberately not what
  // 0035 says — the auditor's own contract for this list.
  //
  // RESOLVED 2026-08-23 by migration 2143_plan_geofences_policy_convergence.sql.
  // Production and CI now carry the identical four-policy family — verified by
  // md5 fingerprint over every polqual/polwithcheck on both (54638f2c…). Before
  // that, three disjoint families existed and production was LOOSER on DELETE:
  // its pgf_delete_accepted permitted `owner OR member with role='member'`,
  // where CI permitted the trip owner alone.
  //
  // This entry stays regardless, because 0035 still CLAIMS the superseded broad
  // policy and the auditor reads each migration's claims independently. It is
  // removable only if 0035 itself is rewritten.
  "policy:plan_geofences.trip_members_manage_geofences",
  "column:feature_flags.key", // live column is `flag`
  "column:highlights.user_id", // live column is `owner_id`
  "column:highlight_replies.user_id", // live column is `replier_id`
  "column:events.status", // live column is `state`
  "column:tags.tagged_at", // does not exist live
  "index:tags_tagged_idx", // index on tags.tagged_at, which does not exist live
  // CREATE TABLE bodies drifted vs live (verified 2026-07-17: tables exist,
  // columns were renamed/dropped live):
  "column:user_location_state.latitude", // live: lat
  "column:user_location_state.longitude", // live: lng
  "column:user_location_state.accuracy", // live: accuracy_meters
  "column:user_location_state.location_source", // live: source
  "column:passport_stamps_gps.latitude", // live: lat
  "column:passport_stamps_gps.longitude", // live: lng
  "column:highlights.trip_id", // does not exist live
  "column:highlight_replies.body", // does not exist live (thread-based replies)
  "column:highlight_replies.deleted_at", // does not exist live
  "column:plan_checkins.plan_item_id", // live keys by plan_geofence_id
  "column:plan_attendance_events.plan_item_id", // live keys by plan_geofence_id
  "column:plan_attendance_events.metadata", // live: details
  "column:geofence_admin_settings.default_radius", // live: default_radius_meters
  "column:geofence_admin_settings.min_radius", // live: min_radius_meters
  "column:geofence_admin_settings.max_radius", // live: max_radius_meters
  "column:trip_crew_location_preferences.ghost_mode", // live: ghost_mode_enabled
  "column:trip_crew_location_preferences.visibility", // live: visibility_default
  "column:passport_stamps.earned_at", // live: awarded_at
  "column:passport_visibility_preferences.stamps_visibility", // live: stamps_visible
  "column:passport_visibility_preferences.map_visibility", // live: map_visible
  "column:hashtags.normalized_name", // live: slug
  // Legacy-vs-legacy supersessions (verified 2026-07-17 while reconciling the
  // legacy migrations dir — see docs/migrations.md):
  "policy:feature_flags.ff_select_all", // superseded by live feature_flags_public_read (same predicate)
  "policy:plan_geofences.pgf_select_member", // dropped by legacy 0038 RLS fix; replaced by pgf_select_accepted

  // ── REVIEWED AND DELIBERATELY NOT APPLIED (2026-08-10) ──────────────────────
  //
  // Everything above this line is drift that was discovered and explained. The
  // three below are different: they are declared policies that were reviewed
  // object by object and a decision was taken NOT to create them. They are
  // allowlisted so the audit reads zero unexplained objects, which is only
  // honest if the explanation is written down — so it is written down here.
  //
  // AN ALLOWLIST ENTRY MEANS THE POLICY DOES NOT EXIST. It does not mean the
  // table is unprotected: on media_assets and media_attachments RLS IS enabled
  // and an owner-select policy DOES exist. What is absent is the additional
  // public-read grant, and its absence is the restrictive direction.
  //
  // media_assets_public_select / media_attachments_public_select
  // (20260811_media_rls.sql) — would let any `authenticated` JWT holder read
  // every row where visibility='public' AND moderation_status='approved'
  // directly, bypassing the API. Not applied, because nothing needs it and it
  // is a pure widening:
  //   * Every reader in this repo uses the service-role client, which bypasses
  //     RLS entirely — lib/mediaAccess.ts, lib/mediaAssets.ts,
  //     services/accountDeletion/AccountDeletionService.ts,
  //     routes/sharedMoments.ts and scripts/backfill-media-assets.ts. There is
  //     no user-scoped (RLS-bound) client path to either table.
  //   * NEITHER mobile app references either table: zero hits for
  //     `media_assets` / `media_attachments` across travel-buddy-standalone/src
  //     and travel-buddy-standalone/src.
  //   * So the migration's stated motivation ("needed for the public feed,
  //     profile cards, place cards") describes a direct-from-client read
  //     pattern that does not exist here. Applying it would grant read access
  //     no consumer requires — attack surface with no corresponding benefit.
  // The migration itself is correctly written (visibility, moderation_status
  // and owner_user_id all exist live; `TO authenticated` does exclude anon), so
  // this is a decision about need, not a defect. If a client ever reads these
  // tables directly, apply it and delete these two entries in the same change.
  "policy:media_assets.media_assets_public_select",
  "policy:media_attachments.media_attachments_public_select",
  //
  // users_view_highlight_replies — claimed by BOTH 0026_highlights.sql and
  // 2033_rls_hardening.sql, and absent live because 2033 ITSELF retires it:
  // 2033 creates the policy at its section 8 and then drops it again later in
  // the same file ("our new users_view_highlight_replies was too permissive —
  // NOT viewer_is_blocked only, no content gate"), replacing it with
  // hreplies_select. Production and portava-ci both carry hreplies_select with
  // exactly 2033's final predicate, and viewer_is_blocked() exists, so 2033's
  // net effect is applied and correct. 0026's older declaration cannot be
  // applied as written in any case: it reads USING (deleted_at IS NULL) and the
  // live table has neither `deleted_at` nor `user_id` (see the two entries for
  // those columns above, and docs/migrations.md "Replay-fidelity breaks").
  // Nothing to create; the object is superseded, not missing.
  "policy:highlight_replies.users_view_highlight_replies",
  //
  // ── DELIBERATELY REVOKED (2026-08-14, migration 2089) ───────────────────────
  //
  // post_media_storage_public_read is declared by 0103_post_media.sql and
  // REVOKED by 2089_revoke_post_media_public_read.sql. This audit asks "does
  // every object a migration claims exist live", which is the right question
  // for a create-only history and the wrong one the moment a later migration
  // deliberately drops an earlier declaration. Without this entry, 2089 makes
  // schema-drift permanently red — against production too, not just CI — and a
  // permanently red check is one discarded exit code away from being no check
  // at all.
  //
  // AN ALLOWLIST ENTRY MEANS THE POLICY DOES NOT EXIST, and here that absence
  // IS the fix, not a gap. What 0103 declared was:
  //
  //     FOR SELECT TO public USING (bucket_id = 'post-media')
  //
  // — an unconditional read grant over every object in the bucket, to `public`,
  // which includes `anon`. 0103's comment calls these policies
  // "defence-in-depth for clients that attempt direct bucket access", accurate
  // while the bucket was public. The 2026-08-06 bucket-privacy cutover set
  // public=false and moved rendering onto the signed-URL relay; it closed
  // /object/public/ and left this policy in place. Measured against production
  // on 2026-08-14 with only the publishable key that ships in the mobile
  // client: object GET 200, bucket LIST returned real user-UUID prefixes.
  //
  // Nothing needs it. Rendering goes through the relay (GET /api/media/file,
  // POST /api/media/sign), which signs with the service role — signing does not
  // consult RLS, so the drop cannot affect it. profile-media is the existence
  // proof: zero storage.objects policies, private, and its whole avatar/cover
  // surface renders in production today.
  //
  // If a direct-from-client read of post-media is ever required, restore the
  // policy from 2089's DOWN block and delete this entry in the same change.
  "policy:objects.post_media_storage_public_read",
  //
  // ── RELOCATED TO `authz` (2026-08-28, migration 2182) ───────────────────────
  //
  // is_blocked(uuid,uuid) is declared by 0015_blocks.sql in `public` and MOVED
  // to the `authz` schema by 2182_close_authz_rpc_oracle.sql
  // (ALTER FUNCTION … SET SCHEMA). This auditor asks "does every object a
  // migration claims exist live", keyed by function NAME in the `public`
  // schema — so after 2182 it reports `public.is_blocked` missing. It is not
  // missing; it is `authz.is_blocked`, with the same OID/ACL/body, and all four
  // RLS policies (loc_select, messages_hide_blocked_sender, highlights_select,
  // highlights_select_active) still bind to it by OID. Without this entry 2182
  // makes schema-drift permanently red — against production too once pressed —
  // and a permanently red check is one discarded exit code away from being no
  // check at all.
  //
  // AN ALLOWLIST ENTRY MEANS THE `public` OBJECT DOES NOT EXIST, and here that
  // absence IS the fix: the anonymous PostgREST RPC oracle (POST /rpc/is_blocked
  // with a caller-supplied identity) is closed precisely BY the function no
  // longer living in an exposed schema. The purpose the relocation serves is the
  // reason `public.is_blocked` is gone.
  //
  // Scope note: 2182 also relocated in_accepted_circle and can_see_location, but
  // 0015 is the only file in THIS auditor's chain (api-server src/migrations,
  // + the archived legacy chain) that declares any of the three, and it declares
  // only is_blocked — so this is the sole entry the move requires here. The other
  // two are declared in migration roots this auditor does not scan
  // (migrations/, travel-buddy-standalone/migrations/, supabase/migrations/).
  //
  // If is_blocked is ever collapsed into viewer_is_blocked (the deduplication
  // 2182's header flags as future cleanup) and 0015's declaration is retired,
  // delete this entry in the same change.
  "function:is_blocked",
  //
  // ── DELIBERATELY NOT IN `public` (2026-08-28, migration 2198) ──────────────
  //
  // 2198 declares authz.is_thread_member(uuid,uuid) — the SECURITY DEFINER
  // membership predicate that breaks the 42P17 recursion in mtm_select. This
  // auditor drops the schema qualifier when parsing (see `qualIdent`) and asks
  // only about `public` (the live side reads pg_proc joined to nspname='public'),
  // so it reports this one missing. It is not missing; it is authz.
  //
  // The schema is the point, for exactly the reason the is_blocked entry above
  // exists. A SECURITY DEFINER authorization predicate in `public` is a
  // PostgREST oracle: POST /rpc/is_thread_member with a caller-supplied thread
  // and user id answers "who is in which conversation" to anyone holding the
  // publishable key. 2182 closed that class by moving three such functions OUT
  // of public; creating a fourth in public would have reopened it under a new
  // name. `authz` is not one of PostgREST's exposed schemas, so the EXECUTE
  // grant `authenticated` needs (a policy expression is evaluated as the caller,
  // so revoking it would break RLS rather than tighten it) is not an endpoint.
  //
  // If is_thread_member is ever moved into public, delete this entry in the same
  // change — and expect the RPC oracle back with it.
  "function:is_thread_member",
]);

// ── Environment ───────────────────────────────────────────────────────────────

// projectRef and the access token are resolved LAZILY, inside liveQuery, rather
// than at module scope. The old module-scope `new URL(SUPABASE_URL)` threw at
// import time when SUPABASE_URL was unset — which meant merely importing this
// module (as the inverse auditor now does, to reuse parseMigration /
// fetchLiveSchema / liveQuery) could throw. With the derivation moved here the
// import is pure: only an actual liveQuery call touches the environment, and it
// does so after the env-presence check main() performs.
function resolveProjectRef(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL not set");
  return new URL(url).hostname.split(".")[0];
}

export async function liveQuery<T = Record<string, unknown>>(
  query: string,
): Promise<T[]> {
  const projectRef = resolveProjectRef();
  // Prefer SUPABASE_PROJECT_TOKEN (project-scoped, safe for CI) over the
  // personal SUPABASE_ACCESS_TOKEN so CI runners never need a developer account
  // token (mirrors the convention in scripts/check-db-triggers.sh).
  const accessToken =
    process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

// ── Live schema snapshot ──────────────────────────────────────────────────────

export interface LiveSchema {
  relations: Set<string>; // tables + views + matviews
  columns: Set<string>; // "table.column"
  functions: Set<string>;
  indexes: Set<string>;
  policies: Set<string>; // "table.policy"
  enums: Set<string>;
  enumValues: Set<string>; // "enum.value"
  triggers: Set<string>; // "table.trigger"
  rlsEnabled: Set<string>; // tables with pg_class.relrowsecurity = true
  tableGrants: Set<string>; // "table.grantee.privilege"
  routineGrants: Set<string>; // "function.grantee" (EXECUTE only)
}

export async function fetchLiveSchema(): Promise<LiveSchema> {
  const [rels, cols, fns, idxs, pols, enums, trgs, rls, tgrants, rgrants] =
    await Promise.all([
    liveQuery<{ name: string }>(
      `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m')`,
    ),
    liveQuery<{ t: string; c: string }>(
      `select table_name as t, column_name as c
       from information_schema.columns where table_schema = 'public'`,
    ),
    liveQuery<{ name: string }>(
      `select p.proname as name from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'`,
    ),
    liveQuery<{ name: string }>(
      `select indexname as name from pg_indexes where schemaname = 'public'`,
    ),
    liveQuery<{ t: string; p: string }>(
      // storage included: some migrations create policies on storage.objects
      `select tablename as t, policyname as p from pg_policies where schemaname in ('public','storage')`,
    ),
    liveQuery<{ e: string; v: string }>(
      `select t.typname as e, e.enumlabel as v
       from pg_type t join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname = 'public'`,
    ),
    // pg_trigger (NOT information_schema.triggers — that omits TRUNCATE
    // triggers). Trigger names are table-scoped in Postgres, so key by
    // table.trigger to avoid a same-named trigger on another table masking
    // a missing one.
    liveQuery<{ t: string; g: string }>(
      `select c.relname as t, tr.tgname as g
       from pg_trigger tr join pg_class c on c.oid = tr.tgrelid
       where not tr.tgisinternal`,
    ),
    // RLS is a table FLAG, not an object, which is why it was invisible here
    // until now: a table can sit with RLS off and every object claim still
    // resolve. relrowsecurity is the only thing that answers "did the ENABLE
    // actually happen" — including when the ENABLE was inside a conditional
    // block whose guard was false (see 2070 / post_event_links).
    liveQuery<{ name: string }>(
      `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p') and c.relrowsecurity`,
    ),
    liveQuery<{ t: string; g: string; p: string }>(
      `select table_name as t, grantee as g, privilege_type as p
       from information_schema.role_table_grants where table_schema = 'public'`,
    ),
    // Table grants and ROUTINE grants are different catalogs. 18 of the 19
    // GRANT statements in src/migrations/ are GRANT EXECUTE ON FUNCTION, which
    // role_table_grants cannot see at all — modelling only table grants would
    // have covered 1 of 19 while reporting "GRANT" as a covered claim type.
    liveQuery<{ r: string; g: string }>(
      `select routine_name as r, grantee as g
       from information_schema.role_routine_grants
       where routine_schema = 'public' and privilege_type = 'EXECUTE'`,
    ),
  ]);

  // Everything is lower-cased for comparison: unquoted SQL identifiers fold to
  // lowercase anyway, and quoted ones (policy names) shouldn't produce
  // false positives over case alone.
  const lc = (s: string) => s.toLowerCase();
  return {
    relations: new Set(rels.map((r) => lc(r.name))),
    columns: new Set(cols.map((r) => lc(`${r.t}.${r.c}`))),
    functions: new Set(fns.map((r) => lc(r.name))),
    indexes: new Set(idxs.map((r) => lc(r.name))),
    policies: new Set(pols.map((r) => lc(`${r.t}.${r.p}`))),
    enums: new Set(enums.map((r) => lc(r.e))),
    enumValues: new Set(enums.map((r) => lc(`${r.e}.${r.v}`))),
    triggers: new Set(trgs.map((r) => lc(`${r.t}.${r.g}`))),
    rlsEnabled: new Set(rls.map((r) => lc(r.name))),
    tableGrants: new Set(tgrants.map((r) => lc(`${r.t}.${r.g}.${r.p}`))),
    routineGrants: new Set(rgrants.map((r) => lc(`${r.r}.${r.g}`))),
  };
}

// ── Migration parsing ─────────────────────────────────────────────────────────

export interface Claim {
  kind:
    | "table"
    | "column"
    | "function"
    | "index"
    | "policy"
    | "enum"
    | "enumvalue"
    | "trigger"
    | "view"
    | "rls"
    | "grant"
    | "grantfn";
  /** allowlist / report key, e.g. "column:feature_flags.key" */
  key: string;
  label: string;
}

const ident = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`;
const qualIdent = String.raw`(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\.)?${ident}`;

function name(m: RegExpMatchArray, i = 1): string {
  return (m[i] ?? m[i + 1] ?? "").toLowerCase();
}

function stripSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Given comment-stripped SQL and an offset at/just before an opening paren,
 * return the balanced parenthesized body (without the outer parens), or null.
 * Tracks single-quoted strings and dollar-quoted bodies so parens inside
 * literals don't unbalance the scan.
 */
function extractParenBody(src: string, from: number): string | null {
  let i = src.indexOf("(", from);
  if (i === -1) return null;
  // Give up if there is a statement terminator before the paren (e.g.
  // CREATE TABLE x AS SELECT …; with no column list).
  const between = src.slice(from, i);
  if (/[;]/.test(between)) return null;
  const start = i + 1;
  let depth = 1;
  i = start;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === "'") {
      // skip single-quoted string ('' escapes)
      i++;
      while (i < src.length) {
        if (src[i] === "'" && src[i + 1] === "'") i += 2;
        else if (src[i] === "'") break;
        else i++;
      }
    } else if (ch === "$") {
      const dq = /^\$[A-Za-z_]*\$/.exec(src.slice(i));
      if (dq) {
        const end = src.indexOf(dq[0], i + dq[0].length);
        if (end === -1) return null;
        i = end + dq[0].length - 1;
      }
    } else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    i++;
  }
  if (depth !== 0) return null;
  return src.slice(start, i - 1);
}

const CONSTRAINT_KEYWORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "foreign",
  "check",
  "exclude",
  "like",
]);

/** Extract declared column names from a CREATE TABLE body. */
function parseColumnDefs(body: string): string[] {
  // Split on top-level commas only.
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") {
      cur += ch;
      i++;
      while (i < body.length) {
        cur += body[i];
        if (body[i] === "'" && body[i + 1] === "'") { cur += body[++i]; }
        else if (body[i] === "'") break;
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);

  const cols: string[] = [];
  for (const part of parts) {
    const m = /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(part);
    if (!m) continue;
    const first = (m[1] ?? m[2]).toLowerCase();
    if (CONSTRAINT_KEYWORDS.has(first)) continue;
    cols.push(first);
  }
  return cols;
}

export function parseMigration(sql: string): Claim[] {
  const src = stripSql(sql);
  const claims: Claim[] = [];
  const add = (kind: Claim["kind"], key: string, label: string) =>
    claims.push({ kind, key: `${kind}:${key}`, label });

  const scan = (re: RegExp, fn: (m: RegExpMatchArray) => void) => {
    for (const m of src.matchAll(re)) fn(m);
  };

  // CREATE TABLE [IF NOT EXISTS] <name> ( <column defs> )
  scan(
    new RegExp(
      String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${qualIdent}`,
      "gi",
    ),
    (m) => {
      const table = name(m);
      add("table", table, `table ${table}`);
      // Claim every column declared in the parenthesized body too, so a table
      // created live with a partial column set is still flagged.
      const body = extractParenBody(src, (m.index ?? 0) + m[0].length);
      if (body !== null) {
        for (const col of parseColumnDefs(body)) {
          add("column", `${table}.${col}`, `column ${table}.${col}`);
        }
      }
    },
  );

  // CREATE [OR REPLACE] [MATERIALIZED] VIEW <name>
  scan(
    new RegExp(
      String.raw`create\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?${qualIdent}`,
      "gi",
    ),
    (m) => add("view", name(m), `view ${name(m)}`),
  );

  // ALTER TABLE <t> ... ADD [COLUMN] [IF NOT EXISTS] <col> — possibly several
  // ADD COLUMN clauses in one statement.
  scan(
    new RegExp(
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${qualIdent}([\s\S]*?);`,
      "gi",
    ),
    (m) => {
      const table = name(m);
      const body = m[3] ?? "";
      for (const cm of body.matchAll(
        new RegExp(
          String.raw`add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?${ident}`,
          "gi",
        ),
      )) {
        const col = name(cm);
        // skip ADD CONSTRAINT / ADD PRIMARY KEY etc.
        if (["constraint", "primary", "unique", "foreign", "check", "exclude"].includes(col)) continue;
        add("column", `${table}.${col}`, `column ${table}.${col}`);
      }
    },
  );

  // CREATE [OR REPLACE] FUNCTION <name>
  scan(
    new RegExp(
      String.raw`create\s+(?:or\s+replace\s+)?function\s+${qualIdent}`,
      "gi",
    ),
    (m) => add("function", name(m), `function ${name(m)}`),
  );

  // CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] <name>
  scan(
    new RegExp(
      String.raw`create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?${ident}\s+on\b`,
      "gi",
    ),
    (m) => add("index", name(m), `index ${name(m)}`),
  );

  // CREATE POLICY <name> ON <table>
  scan(
    new RegExp(
      String.raw`create\s+policy\s+${ident}\s+on\s+${qualIdent}`,
      "gi",
    ),
    (m) => {
      const pol = name(m, 1);
      const table = name(m, 3);
      add("policy", `${table}.${pol}`, `policy "${pol}" on ${table}`);
    },
  );

  // CREATE TYPE <name> AS ENUM
  scan(
    new RegExp(String.raw`create\s+type\s+${qualIdent}\s+as\s+enum`, "gi"),
    (m) => add("enum", name(m), `enum ${name(m)}`),
  );

  // ALTER TYPE <name> ADD VALUE [IF NOT EXISTS] '<value>'
  scan(
    new RegExp(
      String.raw`alter\s+type\s+${qualIdent}\s+add\s+value\s+(?:if\s+not\s+exists\s+)?'([^']+)'`,
      "gi",
    ),
    (m) => {
      const enumName = name(m);
      const value = m[3];
      add("enumvalue", `${enumName}.${value}`, `enum value ${enumName}.${value}`);
    },
  );

  // CREATE [OR REPLACE] TRIGGER <name> ... ON <table> — keyed by
  // table.trigger because trigger names are only unique per table.
  scan(
    new RegExp(
      String.raw`create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+${ident}[\s\S]*?\son\s+${qualIdent}`,
      "gi",
    ),
    (m) => {
      const trg = name(m, 1);
      const table = name(m, 3);
      add("trigger", `${table}.${trg}`, `trigger ${trg} on ${table}`);
    },
  );

  // ── ALTER TABLE … ENABLE ROW LEVEL SECURITY ─────────────────────────────────
  //
  // Deliberately matched in the RAW (comment-stripped) text, which means it also
  // matches inside EXECUTE '…' strings. That is the point rather than an
  // accident: 2070 enables RLS exclusively through
  // `EXECUTE 'ALTER TABLE public.X ENABLE ROW LEVEL SECURITY'` inside
  // to_regclass-guarded DO blocks, so a parser that only saw top-level
  // statements would claim nothing for the twelve tables that migration exists
  // to protect — including post_event_links, the case that motivated this.
  //
  // Claiming from inside a conditional is safe because the diff below refuses
  // to report a claim whose table does not exist: "declared for a table nobody
  // created" is not drift.
  scan(
    new RegExp(
      String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${qualIdent}\s+enable\s+row\s+level\s+security`,
      "gi",
    ),
    (m) => add("rls", name(m), `row level security on ${name(m)}`),
  );

  // ── GRANT <privs> ON [TABLE] <table> TO <role> ──────────────────────────────
  // ON FUNCTION / SCHEMA / SEQUENCE / ALL TABLES are excluded here and the
  // function form is handled separately below.
  scan(
    new RegExp(
      String.raw`grant\s+([a-z, ]+?)\s+on\s+(?!function|schema|sequence|all)(?:table\s+)?${qualIdent}\s+to\s+([a-z_][a-z0-9_]*)`,
      "gi",
    ),
    (m) => {
      const privsRaw = m[1].toLowerCase();
      const table = name(m, 2);
      const grantee = m[4].toLowerCase();
      const privs = /\ball\b/.test(privsRaw)
        ? ["select", "insert", "update", "delete", "truncate", "references", "trigger"]
        : privsRaw.split(",").map((x) => x.trim()).filter(Boolean);
      for (const priv of privs) {
        add(
          "grant",
          `${table}.${grantee}.${priv}`,
          `grant ${priv} on ${table} to ${grantee}`,
        );
      }
    },
  );

  // ── GRANT EXECUTE ON FUNCTION <fn>(<args>) TO <role> ────────────────────────
  // Keyed by function NAME only, matching how the "function" claim kind is keyed
  // (the live side reads pg_proc.proname). Overloads therefore collapse to one
  // claim; that is a known imprecision, stated rather than hidden.
  scan(
    new RegExp(
      String.raw`grant\s+execute\s+on\s+function\s+${qualIdent}\s*\([^)]*\)\s*to\s+([a-z_][a-z0-9_]*)`,
      "gi",
    ),
    (m) => {
      const fn = name(m, 1);
      const grantee = m[3].toLowerCase();
      add("grantfn", `${fn}.${grantee}`, `grant execute on ${fn}() to ${grantee}`);
    },
  );

  return claims;
}

// ── Diff ──────────────────────────────────────────────────────────────────────

function isMissing(claim: Claim, live: LiveSchema): boolean {
  const key = claim.key.slice(claim.kind.length + 1);
  switch (claim.kind) {
    case "table":
    case "view":
      // legacy buddy_* relations live as views; any relation kind counts
      return !live.relations.has(key);
    case "column": {
      const [table] = key.split(".");
      // If the table itself is missing it's already reported; a column claim
      // on a view (compat layer) is checked against columns of that view too
      // (information_schema.columns includes view columns).
      if (!live.relations.has(table)) return false;
      return !live.columns.has(key);
    }
    case "function":
      return !live.functions.has(key);
    case "index":
      return !live.indexes.has(key);
    case "policy":
      return !live.policies.has(key);
    case "enum":
      return !live.enums.has(key);
    case "enumvalue":
      return !live.enumValues.has(key);
    case "trigger":
      return !live.triggers.has(key);
    case "rls": {
      // THE DISCRIMINATION THAT MAKES THIS CLAIM TYPE USABLE. A great many RLS
      // claims come from conditional blocks (`IF to_regclass(...) IS NOT NULL`,
      // `EXCEPTION WHEN undefined_table`) written to be safe on environments
      // where the table does not exist. Reporting those as drift would flood
      // the output with statements that were correctly skipped and drown the
      // one case that matters. Absent table → not drift; the missing TABLE is
      // reported separately by its own claim if a migration declares it.
      if (!live.relations.has(key)) return false;
      return !live.rlsEnabled.has(key);
    }
    case "grant": {
      const [table] = key.split(".");
      if (!live.relations.has(table)) return false;
      return !live.tableGrants.has(key);
    }
    case "grantfn": {
      const [fn] = key.split(".");
      if (!live.functions.has(fn)) return false;
      return !live.routineGrants.has(key);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
//
// The audit runs only when this file is the process ENTRYPOINT (audit:schema),
// never on import. The inverse auditor (auditLiveVsCanonical.ts) imports this
// module for parseMigration / fetchLiveSchema / liveQuery, and that import must
// not fetch a schema, read a directory, or exit — only an actual `main()` call
// may. The env-presence check and projectRef derivation live here (not at module
// scope) for the same reason; the output for the audit:schema entrypoint is
// unchanged.

async function main(): Promise<void> {
  runFrozenDirGuards();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const ACCESS_TOKEN =
    process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;
  if (!SUPABASE_URL || !ACCESS_TOKEN) {
    console.error(
      "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
        "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
        "       or SUPABASE_ACCESS_TOKEN (personal access token).\n" +
        "       Run from artifacts/api-server with the .env loaded, or export them manually.",
    );
    process.exit(2);
  }

  const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];
  console.log(
    `Auditing migrations against live schema (project ${projectRef}) …`,
  );

  let live: LiveSchema;
  try {
    live = await fetchLiveSchema();
  } catch (err) {
    console.error(
      `ERROR: failed to fetch live schema: ${(err as Error).message}`,
    );
    process.exit(2);
  }

  let totalClaims = 0;
  let filesWithGaps = 0;
  let missingCount = 0;
  let filesAudited = 0;

  for (const dir of MIGRATION_DIRS) {
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    } catch {
      continue; // dir may not exist
    }
    console.log(`\n── ${dir}`);
    for (const file of files) {
      if (SKIP_FILES.has(file)) {
        console.log(`  ⤳ ${file} (skipped: known superseded/drifted)`);
        continue;
      }
      filesAudited++;
      const claims = parseMigration(readFileSync(join(dir, file), "utf8"));
      totalClaims += claims.length;
      const missing = claims.filter(
        (c) => !ALLOWLIST.has(c.key) && isMissing(c, live),
      );
      if (missing.length > 0) {
        filesWithGaps++;
        missingCount += missing.length;
        console.log(`  ✖ ${file}`);
        for (const c of missing) console.log(`      missing ${c.label}`);
      }
    }
  }

  console.log(
    `\nAudited ${filesAudited} migration files, ${totalClaims} claimed objects.`,
  );
  if (missingCount > 0) {
    console.error(
      `✖ ${missingCount} missing object(s) across ${filesWithGaps} file(s). ` +
        "Apply the migrations via the Supabase Management API and update docs/migrations.md.",
    );
    process.exit(1);
  }
  console.log("✔ Live schema contains every object claimed by the migrations.");
  process.exit(0);
}

// Entrypoint gate: run the audit only when invoked directly (audit:schema),
// so importing this module for its exports runs nothing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
