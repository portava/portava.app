/**
 * Missing-live-columns check
 *
 * Parses every migration file in src/migrations/ for columns it adds or
 * creates, then diffs those columns against the LIVE Supabase schema.
 * If a column is declared by a migration but absent from the live DB the
 * check exits 1 with a clear actionable error — the failure mode that caused
 * the Event Chat "can't send a message" incident (messages.ciphertext was
 * missing live, silently breaking every message send).
 *
 * HIGH-TRAFFIC tables (messages, message_threads) are checked first so the
 * most critical regressions surface at the top of the output.
 *
 * Design decisions vs auditMigrationsVsLive.ts (audit:schema):
 *   - Scope is COLUMNS ONLY — the narrowest check that catches the incident
 *     class (a missing ADD COLUMN making an entire feature fail with a
 *     misleading error).  Full-object audits (indexes, policies, triggers,
 *     functions) are handled by audit:schema.
 *   - ALLOWLIST lets the check run green in CI while a migration is pending
 *     live apply — each allowlisted column must carry an annotation explaining
 *     why it is pending and must be removed once the migration is applied.
 *   - No AST / no TypeScript dependency: pure regex over SQL so the script
 *     is fast and can run before the TypeScript build step.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:missing-live-columns
 *   pnpm run check:missing-live-columns -- --verbose
 *
 * Exit code 0 → every migration-declared column exists live (or is allowlisted)
 * Exit code 1 → one or more columns are missing from the live schema
 * Exit code 2 → environment / API error
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
// reached from live-db.yml's api-server-check-all job via check:all ->
// scripts/run-all-checks.sh; deleting the `Preflight — Supabase target must be
// the sanctioned CI project` step from that job, disabling it with `if:`,
// moving it after the install step, or adding a brand-new job in a brand-new
// workflow file all still land here, because this process cannot start
// without it.
//
// This is the READ-ONLY front door, not src/lib/ciSupabaseGuard.mjs. In CI it
// behaves identically — the sanctioned CI project, or exit 2. Outside CI, and
// only outside CI, it additionally permits a read-only audit of the declared
// production project when the operator asks for it by name:
//
//   PORTAVA_PROD_READ_ONLY_AUDIT='read-only-audit-against-production'
//
// This script qualifies because both of its live queries are SELECTs against
// information_schema.columns and pg_class. Checking production for the missing
// column that broke Event Chat is exactly what it is FOR. If it ever gains a
// write, move it back to src/lib/ciSupabaseGuard.mjs and drop it from the
// read-only list in scripts/check-guard-coverage.mjs, which enforces that list
// on every run.
//
// See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/README.md.
import "../lib/ciProdReadOnlyAuditGuard.mjs";

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isOptionAInForce } from "./lib/sensingPostureOnDisk.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dir, "../migrations");
const VERBOSE = process.argv.includes("--verbose");

// ── High-traffic tables ───────────────────────────────────────────────────────
//
// Columns on these tables are reported FIRST regardless of migration file
// order — a missing column here takes down a core feature for all users.
const HIGH_TRAFFIC_TABLES = new Set([
  "messages",
  "message_threads",
  "posts",
  "profiles",
  "notifications",
]);

// ── Allowlist ─────────────────────────────────────────────────────────────────
//
// "table.column" pairs that are declared by a committed migration but have not
// yet been applied to the live DB.  Each entry MUST include a comment naming
// the migration file and the reason it is pending.  Remove the entry once the
// migration is applied and verified live.
//
// Keep this list SHORT.  Every entry is a gap where a broken deploy can hide.
const ALLOWLIST = new Set<string>([
  // ── Known live column renames (migration file is wrong vs live schema) ──────
  // These mirror the ALLOWLIST in auditMigrationsVsLive.ts.  The live columns
  // are correct; the migration files used the old pre-rename names.
  "user_location_state.latitude",       // live: lat
  "user_location_state.longitude",      // live: lng
  "user_location_state.accuracy",       // live: accuracy_meters
  "user_location_state.location_source", // live: source
  "passport_stamps_gps.latitude",       // live: lat
  "passport_stamps_gps.longitude",      // live: lng
  "highlights.user_id",                 // live: owner_id
  "highlights.trip_id",                 // does not exist live (dropped)
  "highlight_replies.user_id",          // live: replier_id
  "highlight_replies.body",             // does not exist live (thread-based replies)
  "highlight_replies.deleted_at",       // does not exist live
  // 2996_compass_conversations_phase1_schema.sql AND
  // 2997_compass_recommendation_lineage.sql USED TO BE ALLOWLISTED HERE — five
  // entries: compass_conversations.trip_id / .status,
  // compass_served_recommendations.revoked_at / .revocation_reason and
  // compass_outcome_events.weight_nudge.
  //
  // REMOVED 2026-09-20 under this list's own rule ("Remove the entry once the
  // migration is applied and verified live"). Both files were already on
  // portava-ci (2026-09-19, ledger rows) and both reached PRODUCTION on
  // 2026-09-20 — 2996 at 19:46:26 UTC, 2997 at 19:49:28, each rehearsed in a
  // rolled-back transaction first and each carrying a schema_migration_ledger
  // row. All five columns are read back in
  // snapshots/20260920-production-schema.json, so this check now passes on them
  // because they are PRESENT, not because they are excused — which is the only
  // reason to remove an entry from this list, exactly as the 2970 note below
  // states. 2997's validated cascading FK from compass_outcome_events to
  // compass_served_recommendations is not this check's scope (columns only);
  // audit:schema owns it.
  "plan_checkins.plan_item_id",         // live: plan_geofence_id
  "plan_attendance_events.plan_item_id", // live: plan_geofence_id
  "plan_attendance_events.metadata",    // live: details
  "geofence_admin_settings.default_radius", // live: default_radius_meters
  "geofence_admin_settings.min_radius", // live: min_radius_meters
  "geofence_admin_settings.max_radius", // live: max_radius_meters
  "trip_crew_location_preferences.ghost_mode",  // live: ghost_mode_enabled
  "trip_crew_location_preferences.visibility",  // live: visibility_default
  "passport_stamps.earned_at",          // live: awarded_at
  "passport_visibility_preferences.stamps_visibility", // live: stamps_visible
  "passport_visibility_preferences.map_visibility",    // live: map_visible
  "tags.tagged_at",                     // does not exist live
  "hashtags.normalized_name",           // live: slug

  // 2970_stamp_definitions_evidences_presence.sql USED TO BE ALLOWLISTED HERE.
  // It was removed on 2026-09-15: 2970 applied to portava-ci at 18:10:28Z with
  // `applied_by='ci'` and a real sha256, and `stamp_definitions.evidences_presence`
  // is now a live column. This check passes on that entry because the column is
  // PRESENT, not because it is excused — which is the only reason to remove an
  // entry from this list.
  //
  // Said exactly: the removal condition written here was "once the merge-to-main
  // apply is certified in docs/migrations.md". The apply is recorded there under
  // 2026-09-15 / PR #504, and `audit:schema` — which reads ALL 548 migration
  // files against the live schema, not just a run's scope — reports "Live schema
  // contains every object claimed by the migrations". What is NOT true, and is
  // worth saying so nobody later reads more into this than it holds, is that a
  // `certify:migrations` run ever had 2970 in its per-run scope: 2970's own apply
  // run failed at STAGE 3 on 0081's grants, and the run that passed all five
  // stages scoped only 2972. The evidence for this removal is the live column
  // plus audit:schema, not a certify stage naming 2970.

  // ── Pending live apply: 2273_intel_replayable_projection.sql (IG unit I1) ──
  // Table-17 lineage columns on the current-state snapshot. Applied to the CI
  // project by live-db.yml's apply step on merge to main; remove these four
  // entries once that apply is certified.
  "intel_state_snapshots.confidence_components",
  "intel_state_snapshots.algorithm_version",
  "intel_state_snapshots.input_claim_versions",
  "intel_state_snapshots.conflict_state",
  // ── Pending live apply: 2274_intel_claim_observation_model.sql (IG unit I1) ──
  // Table-5 claim fields + the version pair the projection cites. Applied to
  // the CI project on merge to main; remove once that apply is certified.
  "intel_claims.observation_id",
  "intel_claims.source_label",
  "intel_claims.lineage",
  "intel_claims.updated_at",
  "intel_claims.version",

  // ── Pending live apply: Trips §41 batch, 2780/2783/2784/2785 ──────────────
  // Columns on tables portava-ci already carries (2760-2763 block + the older
  // trip_plan_items / trip_crew_location_sessions / trip_reservations /
  // trip_members). This branch is not on main and live-db.yml applies only
  // from main, so they are absent from BOTH databases until it merges. Every
  // reader is behind trip_operational_projections_enabled (FALSE everywhere).
  // Remove each entry once the merge-to-main apply is certified in
  // docs/migrations.md.
  "trip_plan_items.subgroup_id",            // 2780 — subgroup-scoped plan items
  "trip_crew_location_sessions.subgroup_id", // 2780 — subgroup-scoped live shares
  "trip_goals.scope",                       // 2783 — 'shared' | 'personal'
  "trip_goals.owner_user_id",               // 2783 — owner of a personal goal
  "trip_goals.weight",                      // 2783 — §8 weighting
  "trip_members.permissions_version",       // 2783 — bumped on role change
  "trip_reservations.version",              // 2784 — If-Match row version
  "trip_reservations.cancelled_at",         // 2784 — DELETE = cancel, not erase
  "safe_return_sessions.subgroup_id",       // 2794 — §17.4 Safe Return on a subgroup (Trips §52)
  // Trips §46 / §47 retention columns, read only by the retention sweep
  // (server/trips/projectionWorkers/tripRetentionScheduler.ts, behind trip_retention_sweep_enabled FALSE)
  // and by the RPCs 2789 / 2791 define; absent from portava-ci until this
  // branch reaches main. Remove each once its apply is certified.
  "trip_activity_log.retain_until",          // 2789 — §21.3 activity-log retention (Trips §46)
  "trip_reservations.raw_text_retain_until", // 2791 — §21.3 raw_text retention deadline (Trips §47)
  "trip_commitments.at_risk_reason",        // 2785 — §7.2 derived at-risk state
  "trip_commitments.at_risk_at",            // 2785
  "trip_commitments.at_risk_shortfall_minutes", // 2785

  // ── Pending live apply: Telegraph §12–§22 batch, 2810 / 2813 ───────────────
  // The §12.1/§13.3/§17.1 message kernel (2810) and §22's request origin (2813).
  // Every one is declared by a migration on this branch and absent from
  // portava-ci, because applying an unmerged branch's migrations to the shared
  // CI database would leave it ahead of main with no commit accounting for it —
  // the same rule that keeps the schema-drift audit red here by design.
  //
  // WHAT IS AND IS NOT BROKEN WHILE THESE ARE ALLOWLISTED, stated rather than
  // implied: every reader of these columns is behind a flag seeded FALSE, so no
  // traveler reaches one today. The two that would matter the moment the flags
  // go on are message_requests.origin_* (a request with no origin renders as
  // "they say", which is what the census records) and messages.lifecycle_state
  // (unsend has nothing to write to). Remove each entry once its apply is
  // certified in docs/migrations.md — NOT when the migration merges.
  "messages.sequence",                       // 2810 — the per-thread order §12.1 names
  "messages.client_message_id",              // 2810 — the sender's id, for dedupe
  "messages.idempotency_key",                // 2810 — one canonical row per key
  "messages.content_ref",                    // 2810 — body indirection
  "messages.lifecycle_state",                // 2810 — §7's unsend/deleted states
  "message_threads.last_sequence",           // 2810 — the thread's high-water mark
  "message_threads.policy_id",               // 2810 — §14.1's capability policy
  "message_threads.policy_version",          // 2810 — bumped when the policy changes
  "message_thread_members.visible_from_sequence",  // 2810 — §14.3's history bound
  "message_thread_members.visible_until_sequence", // 2810 — a departed member's bound
  "message_thread_members.delivered_sequence",     // 2810 — §7.3 receipts
  "message_thread_members.seen_sequence",          // 2810 — §7.3 receipts
  "message_requests.origin_type",            // 2813 — §22 how this request reached you
  "message_requests.origin_id",              // 2813 — the referent, when there is one
  "message_requests.origin_verified",        // 2813 — whether the server checked it

  // ── Pending live apply: 2745_layover_recommendation_travel_provenance.sql ──
  // Added by this branch for Discovery A14 / the Layover travel-provenance
  // obligation, and absent from BOTH databases: it is not on main, and
  // live-db.yml applies only from main.
  //
  // NOT hand-applied to portava-ci, for the reason the 2970 entry above states
  // in full — hand-applying an unmerged branch's migrations to the shared CI
  // database is the recorded root cause of `CI (live DB)` being red on main's
  // own sha across five consecutive scheduled runs, and trading this visible
  // red for that invisible one is not a fix.
  //
  // WHAT IS AND IS NOT BROKEN WHILE THIS IS ALLOWLISTED, stated rather than
  // implied — and here the honest answer is NOTHING, which is unusual enough to
  // show rather than assert. `travelTimeProvenanceColumn`
  // (services/airport/LayoverTravelTime.ts) returns the key ONLY for a
  // provenance the row cannot reconstruct from its own columns. On this tree
  // every landside leg is `unmeasured` and every airside one is
  // `inside_airport`, both of which ROW_FACTS_RECOVER marks recoverable, so it
  // returns `{}` for every row written today and no insert carries the key.
  // That matters because supabase-js sends every key in the payload, so a
  // column the database lacks fails the WHOLE insert — the hazard 2410's header
  // documents. The read side is equally tolerant:
  // LayoverRecommendationService reads `row.travel_time_source ?? null`.
  //
  // The day a routed provider is assigned, the key starts appearing — and on a
  // database that still lags 2745 the insert would begin failing. So this entry
  // is not merely paperwork: it is safe because no routed provider is
  // configured, which is the same missing measurement that keeps A14 at `W`.
  //
  // Remove this entry once the merge-to-main apply is certified in
  // docs/migrations.md — NOT when the migration merges.
  "layover_recommendations.travel_time_source",  // 2745 — where the row's travel figure came from

  // ── Pending live apply: 2998_story_retention.sql ───────────────────────────
  // The owner-archive retention unit. Declared by a migration on this branch
  // and absent from portava-ci, because live-db.yml applies migrations only
  // from main (live-db.yml:775) and hand-applying an unmerged branch's
  // migrations to the shared CI database is the recorded root cause the 2970
  // entry above sets out in full.
  //
  // WHAT IS AND IS NOT BROKEN WHILE THESE ARE ALLOWLISTED, stated rather than
  // implied. Nothing reaches either column on a deployment today, and that is
  // enforced rather than hoped for: story_purge_queue carries a
  // KNOWN_PRODUCTION_GAPS entry in src/scripts/checkProductionDrift.ts whose
  // note says the retention job must not be enabled while the entry stands, so
  // the scheduler's work is held off until the apply is certified. The archive
  // route reads `deleted_at` through a select list, and supabase-js returns an
  // error for a column the database lacks rather than silently omitting it —
  // which the route treats as a failure to establish the state, so the Deleted
  // tab would report unavailable rather than show a wrong window. Neither
  // column is ever written by application code: the 2998 trigger owns
  // `deleted_at`, and `last_success_at` is written by the scheduler's health
  // bookkeeping, which the same gap entry holds.
  //
  // Remove BOTH once 2998's apply is certified in docs/migrations.md — NOT when
  // the migration merges. `stories.deleted_at` is also carried by the ALLOWLIST
  // in src/scripts/checkWritePathColumns.ts, which reads the live schema from
  // the other direction; the two come out together.
  "stories.deleted_at",          // 2998 — when the owner deleted it; the recovery window runs from here
  "job_health.last_success_at",  // 2998 — last SUCCESSFUL run, so "healthy" cannot be claimed before one
]);


// ── Superseded / known-drifted migration files ────────────────────────────────
//
// These files are skipped entirely — either superseded by a later migration or
// known to reference columns that were renamed/dropped live (see ALLOWLIST for
// individual column renames that appear in non-skipped files).
const SKIP_FILES = new Set<string>([
  // Superseded by 0134_rent_buddy_schema_rebuild.sql — the buddy_* compat
  // views still exist live but the columns declared here were renamed.
  "0050_rent_a_buddy.sql",
  // 2481_sensing_sessions_option_a_issuer.sql — OPTION A ONLY; DELIBERATELY NOT
  // APPLIED, AND MUST NOT BE. The file declares exactly one column,
  // sensing_contribution_sessions.issued_to_profile_id, and its absence is the
  // posture rather than a lag.
  //
  // THE FILE, not the column, is the unit here — which is why this is a
  // SKIP_FILES entry and not an ALLOWLIST one. ALLOWLIST says "this column is
  // pending a live apply, remove the entry once the apply is certified"; 2481
  // is never to be applied, so an entry phrased that way would be waiting for
  // something that must not happen. On 2026-09-16 the owner put Sensing on
  // Option B staged (SENSING_AUTH_POSTURE = `anonymous_capable`,
  // src/lib/sensingAuthPosture.ts), under which the file is never run: the
  // second conjunct of its CHECK is `issuance_class = 'authenticated_profile'`,
  // which makes attested- and unattested-device sessions unrepresentable
  // although production accepts all three, and it hangs a `profiles` foreign key
  // off a sensing table Option B exists to keep free of account identity.
  // portava-ci carried 2481 from an earlier Option A rehearsal; that revert has
  // since happened, and 2480's own objects (the table included) remain applied
  // and are still checked here.
  //
  // This entry and the one in src/scripts/auditMigrationsVsLive.ts are the same
  // ruling stated to two name-keyed checkers; the fuller version is there.
  // DELETE BOTH IF SENSING EVER MOVES TO OPTION A — i.e. if
  // SENSING_AUTH_POSTURE becomes `authenticated_only` and 2481 is applied. From
  // that moment this column must exist live, and this entry would hide its
  // absence. See docs/architecture/census-sensing.md.
  //
  // THE ENTRY ITSELF IS NOT HERE — see the conditional immediately below.
]);

// ── 2481's skip, DERIVED from the posture rather than pinned beside it ────────
//
// The ruling above is #512's and it is right about the MECHANISM: the file is
// the unit, not the column, because ALLOWLIST means "pending a live apply,
// remove the entry once the apply is certified" and 2481 is never to be
// applied. #511 reached the same ruling and put it in ALLOWLIST instead, which
// was the wrong list for exactly that reason; that entry is gone.
//
// What #511 had right is that the entry must EXPIRE BY ITSELF. "Delete both if
// Sensing ever moves to Option A" is an instruction to a future reader, and a
// security-posture auditor should not depend on one being remembered. Deriving
// the skip from the constant that decides the question — lib/sensingAuthPosture.ts,
// a reviewed diff being the only way it moves — makes the deletion automatic.
//
// Both PRs merged within half an hour of each other and git kept both forms
// without a conflict. Because a Set add is idempotent the duplication was
// invisible at runtime, and it silently defeated the gate: measured on the
// merge commit with the posture flipped to `authenticated_only`,
// isOptionAInForce() correctly withheld the add while the permanent literal
// skipped 2481 anyway — so the auditor would have been blind to the very drift
// it exists to catch, on the one posture where those objects MUST exist.
//
// The constant is read as TEXT, not imported: importing it would widen the
// sensing stack's importer set, which sensingCensusRederivation.test.ts §9.1
// guards on purpose. scripts/lib/sensingPostureOnDisk.ts carries the reasoning
// and fails closed — an unreadable posture grants nothing.
if (!isOptionAInForce()) {
  SKIP_FILES.add("2481_sensing_sessions_option_a_issuer.sql");
}

// Tables entirely absent from live (migrations reference them but they haven't
// been applied yet).  Columns on these tables are skipped — the table-missing
// case is already caught by audit:schema.
const SKIP_TABLES = new Set<string>([
  // 2273_intel_replayable_projection.sql (IG unit I1): the append-only
  // projection history. Pending live apply on merge to main; remove once the
  // apply is certified.
  "intel_state_snapshot_versions",
]);

// ── Environment ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).\n" +
      "       Run from artifacts/api-server with .env loaded, or export them manually.",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(
  query: string,
): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
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

// ── SQL parsing helpers ───────────────────────────────────────────────────────

function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** A single declared column: which table it belongs to and its name. */
interface ColClaim {
  table: string;
  column: string;
  /** Human-readable source description for error messages. */
  source: string;
}

const SKIP_COLUMN_KEYWORDS = new Set([
  "constraint",
  "primary",
  "unique",
  "foreign",
  "check",
  "exclude",
  "like",
]);

/**
 * Parse one migration file's SQL and return every column it declares.
 * Handles:
 *   ALTER TABLE t ADD [COLUMN] [IF NOT EXISTS] col ...
 *   CREATE TABLE [IF NOT EXISTS] t (col type, ...)
 */
function extractColumnClaims(sql: string, filename: string): ColClaim[] {
  const src = stripComments(sql);
  const claims: ColClaim[] = [];

  // Named identifier: quoted or unquoted.
  const ident = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))`;
  // Optional schema-qualified: schema.table — we only want the table name.
  const qualIdent = String.raw`(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\.)?${ident}`;

  function nameFromMatch(m: RegExpMatchArray, startGroup = 1): string {
    return (m[startGroup] ?? m[startGroup + 1] ?? "").toLowerCase();
  }

  // ── ALTER TABLE ... ADD [COLUMN] ──────────────────────────────────────────
  //
  // Match the whole ALTER TABLE statement up to the next semicolon, then scan
  // the body for ADD [COLUMN] clauses.
  const alterRe = new RegExp(
    String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${qualIdent}([\s\S]*?);`,
    "gi",
  );
  for (const m of src.matchAll(alterRe)) {
    const table = nameFromMatch(m);
    const body = m[3] ?? "";
    const addRe = new RegExp(
      String.raw`\badd\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?${ident}`,
      "gi",
    );
    for (const cm of body.matchAll(addRe)) {
      const col = nameFromMatch(cm);
      if (SKIP_COLUMN_KEYWORDS.has(col)) continue;
      claims.push({ table, column: col, source: filename });
    }
  }

  // ── CREATE TABLE [IF NOT EXISTS] t ( ... ) ────────────────────────────────
  //
  // Extract the parenthesized column-definition list and split on top-level
  // commas; the first identifier of each part is the column name (unless it
  // starts with a constraint keyword).
  const createRe = new RegExp(
    String.raw`create\s+table\s+(?:if\s+not\s+exists\s+)?${qualIdent}`,
    "gi",
  );
  for (const m of src.matchAll(createRe)) {
    const table = nameFromMatch(m);
    const bodyStart = (m.index ?? 0) + m[0].length;
    const parenOpen = src.indexOf("(", bodyStart);
    // If there's a semicolon before the opening paren it's a CREATE TABLE AS
    // SELECT form — no column list to parse.
    if (
      parenOpen === -1 ||
      /;/.test(src.slice(bodyStart, parenOpen))
    ) {
      continue;
    }

    // Walk to the matching closing paren (track depth and string literals).
    let depth = 1;
    let i = parenOpen + 1;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "'") {
        i++;
        while (i < src.length) {
          if (src[i] === "'" && src[i + 1] === "'") i += 2;
          else if (src[i] === "'") break;
          else i++;
        }
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      i++;
    }
    const body = src.slice(parenOpen + 1, i - 1);

    // Split on top-level commas, skipping over single-quoted string literals
    // (e.g. DEFAULT '{"a":1,"b":2}' contains commas that must not split).
    const parts: string[] = [];
    let cur = "";
    let d = 0;
    let bi = 0;
    while (bi < body.length) {
      const bch = body[bi];
      if (bch === "'") {
        cur += bch;
        bi++;
        while (bi < body.length) {
          if (body[bi] === "'" && body[bi + 1] === "'") {
            cur += body[bi] + body[bi + 1];
            bi += 2;
          } else if (body[bi] === "'") {
            cur += body[bi];
            bi++;
            break;
          } else {
            cur += body[bi];
            bi++;
          }
        }
        continue;
      }
      if (bch === "(") d++;
      else if (bch === ")") d--;
      if (bch === "," && d === 0) {
        parts.push(cur);
        cur = "";
      } else cur += bch;
      bi++;
    }
    if (cur.trim()) parts.push(cur);

    for (const part of parts) {
      const cm = /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(part);
      if (!cm) continue;
      const col = (cm[1] ?? cm[2]).toLowerCase();
      if (SKIP_COLUMN_KEYWORDS.has(col)) continue;
      claims.push({ table, column: col, source: filename });
    }
  }

  return claims;
}

// ── Live schema fetch ─────────────────────────────────────────────────────────

async function fetchLiveColumns(): Promise<Set<string>> {
  const rows = await liveQuery<{ t: string; c: string }>(
    `select table_name as t, column_name as c
     from information_schema.columns
     where table_schema = 'public'`,
  );
  return new Set(rows.map((r) => `${r.t.toLowerCase()}.${r.c.toLowerCase()}`));
}

async function fetchLiveTables(): Promise<Set<string>> {
  const rows = await liveQuery<{ name: string }>(
    `select c.relname as name from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','p','v','m')`,
  );
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(
  `check:missing-live-columns — scanning migrations against live schema (project ${projectRef}) …`,
);

let liveColumns: Set<string>;
let liveTables: Set<string>;
try {
  [liveColumns, liveTables] = await Promise.all([
    fetchLiveColumns(),
    fetchLiveTables(),
  ]);
} catch (err) {
  console.error(
    `ERROR: failed to fetch live schema: ${(err as Error).message}`,
  );
  process.exit(2);
}

// Collect and deduplicate all column claims from migration files.
// Use a Map keyed by "table.column" so each pair is reported at most once,
// with the FIRST file that declared it.
const claimMap = new Map<string, ColClaim>();

let files: string[];
try {
  files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
} catch {
  console.error(
    `ERROR: migrations directory not found: ${MIGRATIONS_DIR}`,
  );
  process.exit(2);
}

for (const file of files) {
  if (SKIP_FILES.has(file)) {
    if (VERBOSE) console.log(`  ⤳ ${file} (skipped: superseded/known-drifted)`);
    continue;
  }
  const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
  for (const claim of extractColumnClaims(sql, file)) {
    const key = `${claim.table}.${claim.column}`;
    if (!claimMap.has(key)) claimMap.set(key, claim);
  }
}

console.log(
  `  Scanned ${files.length} migration files, found ${claimMap.size} unique column declarations.`,
);

// ── Diff ──────────────────────────────────────────────────────────────────────

interface MissingEntry {
  table: string;
  column: string;
  source: string;
  key: string;
}

const missing: MissingEntry[] = [];
const allowlisted: string[] = [];
let skippedCount = 0;

for (const [key, claim] of claimMap) {
  const { table, column, source } = claim;

  // Skip tables that don't exist live at all (covered by audit:schema).
  if (SKIP_TABLES.has(table) || !liveTables.has(table)) {
    skippedCount++;
    if (VERBOSE) console.log(`  ⤳ ${key} (table ${table} not live — skipped)`);
    continue;
  }

  if (liveColumns.has(key)) {
    if (VERBOSE) console.log(`  ✔ ${key}`);
    continue;
  }

  if (ALLOWLIST.has(key)) {
    allowlisted.push(key);
    if (VERBOSE) console.log(`  ~ ${key} (allowlisted — pending live apply)`);
    continue;
  }

  missing.push({ table, column, source, key });
}

// ── Report — high-traffic tables first ───────────────────────────────────────

const highTrafficMissing = missing.filter((e) =>
  HIGH_TRAFFIC_TABLES.has(e.table),
);
const otherMissing = missing.filter(
  (e) => !HIGH_TRAFFIC_TABLES.has(e.table),
);

if (missing.length === 0) {
  if (allowlisted.length > 0) {
    console.log(
      `  ~ ${allowlisted.length} allowlisted column(s) pending live apply (see ALLOWLIST in the script).`,
    );
  }
  if (skippedCount > 0) {
    console.log(
      `  ⤳ ${skippedCount} column claim(s) skipped (table not yet live — audit:schema covers those).`,
    );
  }
  console.log("✔ check:missing-live-columns PASSED — no missing columns.");
  process.exit(0);
}

// Print high-traffic failures prominently.
if (highTrafficMissing.length > 0) {
  console.error(
    "\n⚠️  CRITICAL: missing columns on HIGH-TRAFFIC tables (core features broken NOW):\n",
  );
  for (const e of highTrafficMissing) {
    console.error(`  ✖  ${e.key}   (declared in ${e.source})`);
  }
}

if (otherMissing.length > 0) {
  console.error("\n✖  Missing columns on other tables:\n");
  for (const e of otherMissing) {
    console.error(`  ✖  ${e.key}   (declared in ${e.source})`);
  }
}

console.error(
  `\n${missing.length} missing column(s) found across ${new Set(missing.map((e) => e.table)).size} table(s).\n` +
    "\nTo fix, apply the migration(s) via the Supabase Management API:\n" +
    "  pnpm run audit:schema   # full object audit to confirm what else is missing\n" +
    "\nIf the migration is intentionally pending live apply, add the column to the\n" +
    "ALLOWLIST in src/scripts/checkMissingLiveColumns.ts with an explanatory comment.\n",
);
process.exit(1);
