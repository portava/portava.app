/**
 * check:undeclared-production-objects — production objects that NO migration in
 * this tree declares. The reverse direction of check:production-drift.
 *
 * ─── THE PROBLEM THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * `check:production-drift` asks one question: is every table the tree declares
 * present in production? It never asks the converse. So on 2026-10-24 the
 * capability refresh (PR #788) found BY HAND that production holds two tables
 * (media_upload_sessions, media_upload_chunks), a SECURITY DEFINER function
 * (commit_media_upload_chunk) and three media_assets columns that no file in
 * this repository creates — written by code that is not in this tree, with rows
 * in them — and that not one check had failed when they arrived. Two older
 * groups had been sitting there since the first capture: a deletion execution
 * lease on user_deletion_requests, and the dormant journey-shadow programme
 * (nine tables, 35 functions, six columns) from a branch that was applied to
 * production and never merged. docs/architecture/census-media.md records all
 * three under "Note (2026-10-24, capability refresh, PR #788)", with the DDL,
 * and proposes this check. It was not built then.
 *
 * `audit:live-unexplained` asks the right question but refuses to run anywhere
 * except the CI project, which is not production. checkSchemaReferences'
 * UNDECLARED_LIVE_COLUMNS was kept by hand and consulted only when tree code
 * referenced one of its columns. Neither could notice a new object.
 *
 * ─── THE RESOLUTION ───────────────────────────────────────────────────────────
 *
 * The same move as check:production-drift: CI cannot read production, and it
 * can diff a committed file. One input is the frozen production capture that
 * every refresh digest-verifies against production itself —
 * lib/capability/snapshots/current.ts names it; it holds every public table and
 * view with its column list, every public non-extension function, every enum.
 * The other is what the tree declares: the canonical schema (the 2026-08-19
 * baseline plus every migration, lib/canonicalSchema.ts) for base tables and
 * their columns, and a parse of the same text for views, functions, enums and
 * extensions.
 *
 * This script takes no credentials, opens no socket and reads no environment
 * variable. It runs in the static tier, cannot be starved, and goes red on the
 * refresh PR that brings an out-of-band object into the capture — which is the
 * moment the object can still be asked about.
 *
 * ─── IT IS A RATCHET, NOT AN ALLOWLIST ────────────────────────────────────────
 *
 * Every known object below carries the owner decision that governs it, or the
 * honest statement that none has been made yet, and the ratchet fails in every
 * direction it can rot:
 *
 *   - a production object the tree does not declare and the ratchet does not
 *     name fails: out-of-band DDL nobody recorded;
 *   - a ratcheted object the tree NOW declares fails: it was codified, strike
 *     the entry so the ratchet keeps being read;
 *   - a ratcheted object the capture no longer holds fails: it was dropped,
 *     strike the entry for the same reason.
 *
 * Entries whose decision is `owner-pending` MUST reach zero. They record a
 * question put to the owner, not a steady state.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 *
 * It compares NAMES: tables and views by presence, base-table columns by name,
 * functions by name (overloads collapse), enums by name. Not types, defaults,
 * constraints, indexes, policies or grants — the capture does not carry those,
 * and a claim about them from a name list would be the confident wrong answer
 * .agents/memory/db-column-drift.md warns about. `audit:schema` owns the rest,
 * on the CI project.
 *
 * Judgement is withheld where the parse cannot be confident, in the same
 * superset posture as lib/canonicalSchema.ts. A name the tree creates as a
 * VIEW anywhere is judged by presence only: the capture lists views with their
 * columns, and a view's columns are its query's, not DDL this parser reads
 * (buddy_bookings is a 0050 table replaced by a 0147 view over
 * rent_buddy_bookings, and the view's columns are rent_buddy_bookings'). So is
 * a table the canonical model marks unmodelled, and so are the relations an
 * extension the tree installs brings with it (PostGIS's spatial_ref_sys and the
 * two *_columns views). The parse runs over comment-stripped text with
 * procedural bodies INTACT, so DDL inside a `DO $$` block or an `EXECUTE`
 * string counts as declared: the question is whether the tree knows the name
 * at all, and over-declaring costs a missed catch where under-declaring costs
 * a false failure that blocks unrelated work.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:undeclared-production-objects
 *   pnpm run check:undeclared-production-objects -- --verbose
 *
 * Exit 0 → every object in the capture is declared by the tree or on the ratchet,
 *          and every ratchet entry is still true.
 * Exit 1 → the ratchet is broken in at least one direction.
 * Exit 2 → the capture could not be read (nothing was verified).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalSchema, stripSqlComments } from "./lib/canonicalSchema.js";
import {
  PRODUCTION_SNAPSHOT_FILENAME,
  PRODUCTION_SNAPSHOT_URL,
} from "../lib/capability/snapshots/current.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const API_SERVER_ROOT = join(HERE, "..", "..");
export const BASELINE_PATH = join(API_SERVER_ROOT, "baseline", "20260819_baseline_structure.sql");
export const MIGRATION_DIRS: readonly string[] = [
  join(API_SERVER_ROOT, "migrations"),
  join(API_SERVER_ROOT, "src", "migrations"),
];

// ── The ratchet ───────────────────────────────────────────────────────────────

export type ObjectKind = "table" | "column" | "function" | "enum";

export type Decision =
  /** Recorded; the owner has not chosen. MUST reach zero. */
  | "owner-pending"
  /** The owner chose to write the migration. Struck off the day it lands (the check fails until it is). */
  | "codify"
  /** The owner chose to drop it from production. Struck off the day the capture no longer holds it. */
  | "drop"
  /** The owner chose to keep it undeclared, for the stated reason. The only steady state. */
  | "keep";

export interface RatchetEntry {
  decision: Decision;
  /** Where the object came from, what production holds, and what the decision rests on. */
  note: string;
}

const CENSUS_NOTE =
  'docs/architecture/census-media.md, "Note (2026-10-24, capability refresh, PR #788)"';

/** Group 3 — long-standing: the dormant journey-shadow programme. */
const JOURNEY_SHADOW: RatchetEntry = {
  decision: "owner-pending",
  note:
    "The dormant journey-shadow programme: migration 2127 on a branch never merged to main, applied to " +
    "production anyway (2976's header establishes the origin). Nine tables with RLS on and no client grant, " +
    "35 functions executable by service_role only (SECURITY DEFINER unless the census marks them invoker), and " +
    "six columns on location_sessions and user_location_preferences. One row, in journey_retention_health; " +
    "every observation, segment, cohort, stage and revocation table is empty, no location session carries " +
    "journey_purpose = 'journey_observation_v1', and no preference row has the observation switch on. " +
    `Recorded, with each function's definition digest, at ${CENSUS_NOTE}. ` +
    "Owner decision pending: codify, drop, or keep.",
};

function entries(
  kind: ObjectKind,
  names: readonly string[],
  entry: RatchetEntry,
): Record<string, RatchetEntry> {
  return Object.fromEntries(names.map((name) => [`${kind}:${name}`, entry]));
}

/**
 * Production objects no migration in this tree declares, keyed `kind:name`
 * (`column:table.column`). Seeded 2026-11-04 from the three groups the
 * 2026-10-24 capability refresh recorded, re-measured against the 2026-11-04
 * capture. Later the same day the owner chose "codify" for the first two:
 * 4001_media_upload_store_codified.sql declares the chunked-upload store (two
 * tables, commit_media_upload_chunk, three media_assets columns) and
 * 4002_user_deletion_execution_lease_codified.sql the deletion lease (three
 * user_deletion_requests columns), so their 9 entries are struck. The
 * journey-shadow programme (44 entries) stays owner-pending.
 */
export const UNDECLARED_PRODUCTION_OBJECTS: Readonly<Record<string, RatchetEntry>> = {
  // ── The journey-shadow programme (groups 1 and 2 were codified by 4001 and 4002) ──
  ...entries(
    "table",
    [
      "journey_observations",
      "journey_retention_health",
      "journey_revocation_jobs",
      "journey_segment_revisions",
      "journey_shadow_cohort_assignments",
      "journey_shadow_ground_truth",
      "journey_shadow_qa_reports",
      "journey_shadow_session_issuances",
      "journey_shadow_stages",
    ],
    JOURNEY_SHADOW,
  ),
  ...entries(
    "column",
    [
      "location_sessions.journey_purpose",
      "user_location_preferences.journey_observation_enabled",
      "user_location_preferences.journey_consent_scope",
      "user_location_preferences.journey_consent_version",
      "user_location_preferences.journey_consent_granted_at",
      "user_location_preferences.journey_consent_revoked_at",
    ],
    JOURNEY_SHADOW,
  ),
  ...entries(
    "function",
    [
      "_journey_shadow_jsonb_has_forbidden_keys",
      "_journey_shadow_jsonb_has_forbidden_keys_deep",
      "_journey_shadow_require_admin_actor",
      "aggregate_journey_shadow_observations_v1",
      "aggregate_journey_shadow_segment_revisions_v1",
      "append_journey_segment_revisions",
      "append_journey_segment_revisions_v2",
      "assign_journey_shadow_cohort_v1",
      "begin_journey_retention_cycle_v1",
      "claim_journey_revocation_jobs_v1",
      "complete_journey_revocation_job_v1",
      "configure_journey_shadow_stage_v1",
      "delete_journey_observations_for_user_v1",
      "delete_journey_segments_for_user",
      "delete_journey_shadow_rows_v1",
      "fail_journey_revocation_job_v1",
      "finish_journey_retention_cycle_v1",
      "finish_journey_retention_cycle_v2",
      "ingest_journey_observation_v1",
      "ingest_journey_observation_v2",
      "is_valid_journey_world_ref",
      "issue_journey_shadow_session_v1",
      "journey_shadow_authorize_v1",
      "persist_journey_shadow_qa_report_v1",
      "prevent_journey_observation_update",
      "purge_expired_journey_shadow_table_v1",
      "purge_journey_observations_on_consent_revocation",
      "purge_journey_observations_on_session_revocation",
      "read_journey_shadow_observations_v1",
      "read_journey_shadow_qa_observations_v1",
      "read_journey_shadow_qa_segment_revisions_v1",
      "record_journey_shadow_ground_truth_v1",
      "revoke_journey_consent_and_delete_segments",
      "revoke_journey_shadow_cohort_v1",
      "set_journey_observation_consent_v1",
    ],
    JOURNEY_SHADOW,
  ),
};

const OBJECT_KINDS: ReadonlySet<string> = new Set<ObjectKind>(["table", "column", "function", "enum"]);

/** `kind:name` → [kind, name]. Throws on a key no reader could act on. */
export function splitKey(key: string): [ObjectKind, string] {
  const colon = key.indexOf(":");
  const kind = colon === -1 ? "" : key.slice(0, colon);
  const name = key.slice(colon + 1);
  if (!OBJECT_KINDS.has(kind) || name.length === 0) {
    throw new Error(`ratchet key "${key}" is not kind:name with a known kind`);
  }
  if (kind === "column" && !/^[a-z0-9_]+\.[a-z0-9_]+$/.test(name)) {
    throw new Error(`ratchet key "${key}" must be column:table.column`);
  }
  return [kind as ObjectKind, name];
}

/**
 * The columns on the ratchet, as `table.column`. checkSchemaReferences reads
 * this instead of a second hand-kept list: a reference to one of these names a
 * column that genuinely exists, so it is not a dead reference — and the day the
 * column is codified or dropped, this check fails and the entry goes.
 */
export function undeclaredProductionColumns(
  ratchet: Readonly<Record<string, RatchetEntry>> = UNDECLARED_PRODUCTION_OBJECTS,
): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(ratchet)) {
    const [kind, name] = splitKey(key);
    if (kind === "column") out.add(name);
  }
  return out;
}

// ── What production holds ─────────────────────────────────────────────────────

export interface ProductionCapture {
  /** Lower-cased table or view name → lower-cased column names. */
  tables: Readonly<Record<string, readonly string[]>>;
  functions: readonly string[];
  enums: readonly string[];
}

/** Lower-case every name so unquoted identifiers compare the way Postgres folds them. */
export function normaliseCapture(raw: {
  tables: Record<string, string[]>;
  functions: string[];
  enums: string[];
}): ProductionCapture {
  const tables: Record<string, string[]> = {};
  for (const [t, cols] of Object.entries(raw.tables)) {
    tables[t.toLowerCase()] = cols.map((c) => c.toLowerCase());
  }
  return {
    tables,
    functions: raw.functions.map((f) => f.toLowerCase()),
    enums: raw.enums.map((e) => e.toLowerCase()),
  };
}

export function readProductionCapture(url: URL = PRODUCTION_SNAPSHOT_URL): ProductionCapture {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(url, "utf8"));
  } catch (err) {
    console.error(
      `check:undeclared-production-objects: cannot read the production capture at ${url.pathname}` +
        ` (${(err as Error).message}).\n` +
        "This check compares a committed capture against the tree, precisely so it needs no\n" +
        "production credentials. Without the file it has verified NOTHING, so it fails rather\n" +
        "than passing quietly.",
    );
    process.exit(2);
  }
  const r = raw as { tables?: unknown; functions?: unknown; enums?: unknown };
  if (
    !r ||
    typeof r.tables !== "object" ||
    r.tables === null ||
    !Array.isArray(r.functions) ||
    !Array.isArray(r.enums)
  ) {
    console.error(
      `check:undeclared-production-objects: ${PRODUCTION_SNAPSHOT_FILENAME} does not carry tables, functions and enums.`,
    );
    process.exit(2);
  }
  return normaliseCapture(r as { tables: Record<string, string[]>; functions: string[]; enums: string[] });
}

/** True when the capture holds the object a ratchet key names. */
export function captureHolds(capture: ProductionCapture, key: string): boolean {
  const [kind, name] = splitKey(key);
  switch (kind) {
    case "table":
      return name in capture.tables;
    case "column": {
      const dot = name.indexOf(".");
      const cols = capture.tables[name.slice(0, dot)];
      return cols !== undefined && cols.includes(name.slice(dot + 1));
    }
    case "function":
      return capture.functions.includes(name);
    case "enum":
      return capture.enums.includes(name);
  }
}

// ── What the tree declares ────────────────────────────────────────────────────

export interface TreeDeclarations {
  /** Base tables the canonical model built, lower-cased, with their columns. */
  tables: ReadonlyMap<string, ReadonlySet<string>>;
  /** Names the canonical model could not model confidently: presence only. */
  unmodelled: ReadonlySet<string>;
  /** Every relation name the text creates — tables, views, CREATE TABLE AS, extension relations. */
  relations: ReadonlySet<string>;
  /** Names created as a view anywhere in the tree: never column-judged. */
  views: ReadonlySet<string>;
  functions: ReadonlySet<string>;
  enums: ReadonlySet<string>;
  sources: { baseline: string; migrationFiles: number };
}

export interface TextDeclarations {
  relations: Set<string>;
  views: Set<string>;
  functions: Set<string>;
  enums: Set<string>;
  extensions: Set<string>;
}

/**
 * Relations an extension creates in the schema it is installed into. The
 * capture lists them like any other table (information_schema does not know
 * extension ownership for relations, only for functions), and no migration
 * CREATEs them by name. Listed per extension so they count as declared only
 * when the tree installs that extension.
 */
export const EXTENSION_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  postgis: ["spatial_ref_sys", "geometry_columns", "geography_columns"],
};

export function extensionRelationsFor(extensions: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const ext of extensions) for (const r of EXTENSION_RELATIONS[ext] ?? []) out.add(r);
  return out;
}

const TABLE_RE =
  /\bcreate\s+(?:(?:unlogged|temp|temporary)\s+)?table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi;
const VIEW_RE =
  /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?/gi;
const FUNCTION_RE =
  /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?\s*\(/gi;
const ENUM_RE = /\bcreate\s+type\s+(?:"?public"?\.)?"?([a-z0-9_]+)"?\s+as\s+enum\b/gi;
const EXTENSION_RE = /\bcreate\s+extension\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi;

/**
 * The names one SQL text creates. Comments are stripped; string literals and
 * dollar-quoted bodies are kept on purpose, so DDL a `DO` block or an `EXECUTE`
 * string issues counts (0147 creates the buddy_bookings view that way, and
 * every 0108/0134 compatibility view sits inside a block). A name mentioned in
 * a literal can only over-declare, which is the safe direction here.
 */
export function collectDeclarations(sql: string, into?: TextDeclarations): TextDeclarations {
  const out = into ?? {
    relations: new Set<string>(),
    views: new Set<string>(),
    functions: new Set<string>(),
    enums: new Set<string>(),
    extensions: new Set<string>(),
  };
  const text = stripSqlComments(sql);
  for (const m of text.matchAll(TABLE_RE)) out.relations.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(VIEW_RE)) {
    out.views.add(m[1]!.toLowerCase());
    out.relations.add(m[1]!.toLowerCase());
  }
  for (const m of text.matchAll(FUNCTION_RE)) out.functions.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(ENUM_RE)) out.enums.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(EXTENSION_RE)) out.extensions.add(m[1]!.toLowerCase());
  return out;
}

function listSqlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listSqlFiles(p));
    else if (e.endsWith(".sql")) out.push(p);
  }
  return out;
}

export function readTreeDeclarations(
  baseline: string = BASELINE_PATH,
  migrationDirs: readonly string[] = MIGRATION_DIRS,
): TreeDeclarations {
  const schema = buildCanonicalSchema(baseline, [...migrationDirs]);
  const tables = new Map<string, Set<string>>();
  for (const [t, cols] of schema.columns) {
    tables.set(t.toLowerCase(), new Set([...cols].map((c) => c.toLowerCase())));
  }
  const unmodelled = new Set([...schema.unmodelled].map((t) => t.toLowerCase()));

  const files = [baseline, ...migrationDirs.flatMap(listSqlFiles)];
  const text = collectDeclarations("");
  for (const f of files) collectDeclarations(readFileSync(f, "utf8"), text);
  for (const r of extensionRelationsFor(text.extensions)) text.relations.add(r);

  return {
    tables,
    unmodelled,
    relations: text.relations,
    views: text.views,
    functions: text.functions,
    enums: text.enums,
    sources: { baseline, migrationFiles: files.length - 1 },
  };
}

// ── The comparison ────────────────────────────────────────────────────────────

/**
 * Every object in the capture the tree does not declare, as sorted ratchet keys.
 *
 * A relation is declared when any CREATE names it, when the canonical model
 * built it, or when an installed extension brings it. Columns are judged only
 * for a relation the canonical model built as a base table that no CREATE VIEW
 * in the tree names: a view's columns are its query's, and an unmodelled
 * table's are unknown. Functions and enums are judged by name.
 */
export function undeclaredObjects(capture: ProductionCapture, tree: TreeDeclarations): string[] {
  const out: string[] = [];
  for (const [table, columns] of Object.entries(capture.tables)) {
    const declaredColumns = tree.tables.get(table);
    if (declaredColumns === undefined && !tree.relations.has(table)) {
      out.push(`table:${table}`);
      continue;
    }
    if (declaredColumns === undefined || tree.unmodelled.has(table) || tree.views.has(table)) continue;
    for (const c of columns) if (!declaredColumns.has(c)) out.push(`column:${table}.${c}`);
  }
  for (const f of capture.functions) if (!tree.functions.has(f)) out.push(`function:${f}`);
  for (const e of capture.enums) if (!tree.enums.has(e)) out.push(`enum:${e}`);
  return out.sort();
}

export interface RatchetVerdict {
  /** Undeclared in the capture and not on the ratchet: out-of-band DDL nobody recorded. */
  unrecorded: string[];
  /** On the ratchet, still in the capture, and the tree now declares it: codified, strike it. */
  nowDeclared: string[];
  /** On the ratchet and no longer in the capture: dropped, strike it. */
  gone: string[];
}

export function ratchetVerdict(
  ratchet: Readonly<Record<string, RatchetEntry>>,
  undeclared: readonly string[],
  capture: ProductionCapture,
): RatchetVerdict {
  const undeclaredSet = new Set(undeclared);
  const nowDeclared: string[] = [];
  const gone: string[] = [];
  for (const key of Object.keys(ratchet)) {
    if (!captureHolds(capture, key)) gone.push(key);
    else if (!undeclaredSet.has(key)) nowDeclared.push(key);
  }
  return {
    unrecorded: undeclared.filter((k) => !(k in ratchet)),
    nowDeclared: nowDeclared.sort(),
    gone: gone.sort(),
  };
}

// ── Run ───────────────────────────────────────────────────────────────────────

function countByKind(keys: readonly string[]): Record<ObjectKind, number> {
  const out: Record<ObjectKind, number> = { table: 0, column: 0, function: 0, enum: 0 };
  for (const k of keys) out[splitKey(k)[0]]++;
  return out;
}

function describeCounts(keys: readonly string[]): string {
  const c = countByKind(keys);
  return `${c.table} table(s), ${c.column} column(s), ${c.function} function(s), ${c.enum} enum(s)`;
}

function main(): void {
  const verbose = process.argv.includes("--verbose");
  const capture = readProductionCapture();
  const tree = readTreeDeclarations();
  const undeclared = undeclaredObjects(capture, tree);
  const verdict = ratchetVerdict(UNDECLARED_PRODUCTION_OBJECTS, undeclared, capture);

  const captureColumns = Object.values(capture.tables).reduce((n, cols) => n + cols.length, 0);
  console.log(
    `Compared ${Object.keys(capture.tables).length} relation(s) with ${captureColumns} column(s), ` +
      `${capture.functions.length} function(s) and ${capture.enums.length} enum(s) in the production capture ` +
      `(${PRODUCTION_SNAPSHOT_FILENAME}) against what the baseline and ${tree.sources.migrationFiles} ` +
      `migrations declare: ${tree.relations.size} relation(s) by name, ${tree.tables.size} base table(s) with ` +
      `columns, ${tree.functions.size} function(s), ${tree.enums.size} enum(s).`,
  );
  console.log("  no credentials were used, and no database was contacted.");
  if (tree.views.size > 0 || tree.unmodelled.size > 0) {
    console.log(
      `  ${tree.views.size} view(s) and ${tree.unmodelled.size} unmodelled table(s) were judged by presence only.`,
    );
  }
  console.log("");

  let failed = false;

  if (verdict.unrecorded.length > 0) {
    failed = true;
    console.error(
      `✖ ${verdict.unrecorded.length} object(s) exist in production, are declared by NO migration in this tree, and are NOT on the ratchet:`,
    );
    for (const k of verdict.unrecorded) console.error(`    ${k}`);
    console.error(
      "\n  Each is DDL applied out of band. Find out where it came from, then either add the\n" +
        "  migration that records it (after which no entry is needed) or add an entry to\n" +
        "  UNDECLARED_PRODUCTION_OBJECTS with the decision and the reason. Do not add an entry\n" +
        "  without a reason — an entry with no reason is how this becomes an allowlist.",
    );
  }

  if (verdict.nowDeclared.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${verdict.nowDeclared.length} ratcheted object(s) are NOW declared by a migration in this tree and were not struck off:`,
    );
    for (const k of verdict.nowDeclared) console.error(`    ${k}`);
    console.error(
      "\n  They have been codified. Remove them from UNDECLARED_PRODUCTION_OBJECTS. A ratchet\n" +
        "  nobody prunes stops being read.",
    );
  }

  if (verdict.gone.length > 0) {
    failed = true;
    console.error(
      `\n✖ ${verdict.gone.length} ratcheted object(s) are no longer in the production capture:`,
    );
    for (const k of verdict.gone) console.error(`    ${k}`);
    console.error(
      "\n  They have been dropped, or the entry names something that never existed. Remove\n" +
        "  them from UNDECLARED_PRODUCTION_OBJECTS.",
    );
  }

  const keys = Object.keys(UNDECLARED_PRODUCTION_OBJECTS);
  const pending = keys.filter((k) => UNDECLARED_PRODUCTION_OBJECTS[k]!.decision === "owner-pending");

  if (verbose) {
    console.log("Ratchet, by decision:");
    for (const k of [...keys].sort()) {
      console.log(`    ${UNDECLARED_PRODUCTION_OBJECTS[k]!.decision.padEnd(13)} ${k}`);
    }
    console.log("");
  }

  if (!failed) {
    console.log(
      `✓ Every production object is declared by the tree or on the ratchet. ${keys.length} object(s) on the ratchet ` +
        `(${describeCounts(keys)}), of which ${pending.length} await an owner decision and must reach zero.`,
    );
    if (pending.length > 0) {
      console.log(
        `  The pending ones are recorded, with their DDL, at ${CENSUS_NOTE}; codify, drop or keep is the owner's call.`,
      );
    }
  }

  process.exit(failed ? 1 : 0);
}

// Only when RUN, never when imported: checkSchemaReferences imports the ratchet,
// and the test file imports the comparison, and main() ends in process.exit.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) main();
