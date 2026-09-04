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
]);

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
