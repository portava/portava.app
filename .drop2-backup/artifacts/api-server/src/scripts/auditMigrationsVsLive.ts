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

// THE CHOKEPOINT. Side-effect import, deliberately FIRST: it asserts this
// process is pointed at the sanctioned non-production Supabase project
// before any client is constructed. Not skippable by editing workflow YAML.
// See src/lib/ciSupabaseGuard.mjs and docs/ci/BOOTSTRAP.md.
import "../lib/ciSupabaseGuard.mjs";

import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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

/** Migration files skipped entirely (superseded or known-drifted). */
const SKIP_FILES = new Set([
  "0050_rent_a_buddy.sql", // superseded by 0134_rent_buddy_schema_rebuild.sql
  "0105_compass_performance_indexes.sql", // references columns that don't exist live
  // superseded by canonical src/migrations/0062_notifications_schema.sql: live
  // has equivalently-purposed policies/indexes under canonical names (e.g.
  // notifications_select_own), and notification_category_preferences is
  // intentionally keyed by (user_id, category) with no id column
  "0041_notifications.sql",
]);

/**
 * Objects the migration files claim but the live schema intentionally differs
 * on (migration files are wrong vs live — see docs/migrations.md).
 * Keys: "column:table.col", "table:name", "index:name", "policy:table.name",
 * "function:name", "enum:name", "enumvalue:enum.value", "trigger:name",
 * "view:name".
 */
const ALLOWLIST = new Set([
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
]);

// ── Environment ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer SUPABASE_PROJECT_TOKEN (project-scoped, safe for CI) over the personal
// SUPABASE_ACCESS_TOKEN so CI runners never need a developer account token
// (mirrors the convention in scripts/check-db-triggers.sh).
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

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
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

// ── Live schema snapshot ──────────────────────────────────────────────────────

interface LiveSchema {
  relations: Set<string>; // tables + views + matviews
  columns: Set<string>; // "table.column"
  functions: Set<string>;
  indexes: Set<string>;
  policies: Set<string>; // "table.policy"
  enums: Set<string>;
  enumValues: Set<string>; // "enum.value"
  triggers: Set<string>; // "table.trigger"
}

async function fetchLiveSchema(): Promise<LiveSchema> {
  const [rels, cols, fns, idxs, pols, enums, trgs] = await Promise.all([
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
  };
}

// ── Migration parsing ─────────────────────────────────────────────────────────

interface Claim {
  kind:
    | "table"
    | "column"
    | "function"
    | "index"
    | "policy"
    | "enum"
    | "enumvalue"
    | "trigger"
    | "view";
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

function parseMigration(sql: string): Claim[] {
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
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`Auditing migrations against live schema (project ${projectRef}) …`);

let live: LiveSchema;
try {
  live = await fetchLiveSchema();
} catch (err) {
  console.error(`ERROR: failed to fetch live schema: ${(err as Error).message}`);
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
