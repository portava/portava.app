/**
 * check:discovery-query-paths — census-discovery DC-15 (§54).
 *
 * `docs/specs/discovery-v1/10_Database_Architecture.md` §4:
 *   "Every new query path must have: expected cardinality, index rationale,
 *    EXPLAIN verification where meaningful."
 *
 * docs/discovery/query-paths.md is where Discovery answers that, per hot path,
 * with plans captured on the local harness. A document is only worth something
 * while it stays complete, so this check makes it complete BY CONSTRUCTION:
 *
 *   1. Every `CREATE TABLE`, `CREATE [UNIQUE] INDEX` and UNIQUE/EXCLUDE constraint
 *      (inline or `ALTER TABLE … ADD`, §62) any file in src/migrations/ issues on
 *      a Discovery table must have a registry row in the document (`| table | … |`
 *      / `| index | … |`), naming the migration that creates it. A NEW Discovery
 *      migration that adds an index or a table without one fails here.
 *   2. Every registry row must carry a rationale and either a query-path id
 *      (QP-nn) that the document defines, or the literal words
 *      "not a hot path" with a reason.
 *   3. A registry row naming an object no migration creates is STALE and fails:
 *      a registry that only grows stops describing the schema.
 *
 * WHAT IS A DISCOVERY TABLE: the sixteen 3390 governs, plus any table whose
 * name starts `discovery_` or `trail` — so a NEW Discovery table is caught by
 * its name, not by a list someone has to remember to extend.
 *
 * WHAT IT DOES NOT DO: it cannot tell whether a plan in the document is still
 * the plan PostgreSQL would choose. That needs a database; the document says
 * how to re-run docs/discovery/query-paths-explain.sql on the harness.
 *
 * No database, no network. Exit 0 = complete; 1 = incomplete or stale; 2 = the
 * document or the migrations directory could not be read.
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:discovery-query-paths
 *   pnpm run check:discovery-query-paths -- --print   # the registry rows the migrations imply
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(__dir, "../migrations");
const DOC = resolve(__dir, "../../../../docs/discovery/query-paths.md");

export const DISCOVERY_TABLES = new Set([
  "discovery_places", "discovery_place_saves", "discovery_place_reports", "discovery_cache",
  "discovery_geocode_cache", "discovery_shadow_serves", "discovery_place_photos", "place_momentum",
  "trails", "content_trails", "trail_edges", "trail_follows", "trail_reports",
  "trail_health_snapshots", "recommendations", "rank_events", "rank_event_outcome_receipts",   // §62: 3420's satellite of rank_events
  "place_cooccurrence",   // §95 (W11-X3): 3495's Trail-derived projection — not caught by the name rule
]);

export function isDiscoveryTable(name: string): boolean {
  return DISCOVERY_TABLES.has(name) || name.startsWith("discovery_") || name.startsWith("trail");
}

export interface SchemaObject { kind: "table" | "index"; name: string; table: string; migration: string; /** §62: a UNIQUE/EXCLUDE constraint with no CONSTRAINT name — the registry cannot key it. */ unnamed?: boolean }

/** Strip `--` line comments and C-style block comments. String contents are not parsed; a migration is not a string literal. */
export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, "");
}

const ident = String.raw`(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*))`;
const qualified = String.raw`(?:(?:"public"|public)\.)?${ident}`;
const TABLE_RE = new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${qualified}\s*\(`, "gi");
const INDEX_RE = new RegExp(
  String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s+ON\s+(?:ONLY\s+)?${qualified}`, "gi");

/** Every Discovery table and index one migration's text creates. */
export function discoveryObjectsIn(migration: string, sql: string): SchemaObject[] {
  const text = stripSqlComments(sql);
  const out: SchemaObject[] = [];
  for (const m of text.matchAll(TABLE_RE)) {
    const name = (m[1] ?? m[2] ?? "").toLowerCase();
    if (isDiscoveryTable(name)) out.push({ kind: "table", name, table: name, migration });
  }
  for (const m of text.matchAll(INDEX_RE)) {
    const name = (m[1] ?? m[2] ?? "").toLowerCase();
    const table = (m[3] ?? m[4] ?? "").toLowerCase();
    if (isDiscoveryTable(table)) out.push({ kind: "index", name, table, migration });
  }
  return out.concat(constraintIndexesIn(migration, text));   // §62 DC-15 — UNIQUE/EXCLUDE constraints create indexes too
}

export interface RegistryRow { kind: "table" | "index"; name: string; table: string; migrations: string[]; path: string; rationale: string; line: number }

/**
 * Registry rows: `| index | <name> | <table> | <migration[, migration]> | <QP-nn or "not a hot path"> | <rationale> |`
 * and `| table | <name> | <name> | <migration> | … | … |`. Backticks are ignored.
 */
export function parseRegistry(doc: string): RegistryRow[] {
  const rows: RegistryRow[] = [];
  doc.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!/^\|\s*(index|table)\s*\|/.test(line)) return;
    const cells = line.split("|").slice(1, -1).map((c) => c.replace(/`/g, "").trim());
    if (cells.length < 6) return;
    rows.push({
      kind: cells[0] as "index" | "table",
      name: cells[1]!.toLowerCase(),
      table: cells[2]!.toLowerCase(),
      migrations: cells[3]!.split(/[,\s]+/).filter(Boolean),
      path: cells[4]!,
      rationale: cells[5]!,
      line: i + 1,
    });
  });
  return rows;
}

export interface CheckResult { missing: SchemaObject[]; stale: RegistryRow[]; malformed: string[] }

export function checkRegistry(objects: SchemaObject[], doc: string): CheckResult {
  const registry = parseRegistry(doc);
  const definedPaths = new Set([...doc.matchAll(/^#{2,4}\s+(QP-\d{2})\b/gm)].map((m) => m[1]!));
  const key = (kind: string, name: string) => `${kind}:${name}`;
  const byKey = new Map(registry.map((r) => [key(r.kind, r.name), r]));
  const created = new Map<string, SchemaObject[]>();
  for (const o of objects) {
    const k = key(o.kind, o.name);
    created.set(k, [...(created.get(k) ?? []), o]);
  }

  const missing: SchemaObject[] = [];
  const malformed: string[] = [];
  for (const [k, os] of created) {
    const row = byKey.get(k);
    if (os[0]!.unnamed) { malformed.push(`${os[0]!.name} (${os[0]!.migration}): an unnamed UNIQUE/EXCLUDE constraint creates an index this registry cannot key — name it (CONSTRAINT <name> UNIQUE …) and add its row`); continue; } if (!row) { missing.push(os[0]!); continue; }
    for (const o of os) {
      if (!row.migrations.some((m) => o.migration.startsWith(m.replace(/\.sql$/, "")))) {
        malformed.push(`${o.kind} ${o.name}: created by ${o.migration}, which its row (line ${row.line}) does not name`);
      }
      if (row.table !== o.table) malformed.push(`${o.kind} ${o.name}: row says table ${row.table}, ${o.migration} says ${o.table}`);
    }
  }
  for (const r of registry) {
    const pathRefs = [...r.path.matchAll(/QP-\d{2}/g)].map((m) => m[0]);
    const notHot = /not a hot path/i.test(r.path);
    if (pathRefs.length === 0 && !notHot) malformed.push(`line ${r.line}: ${r.kind} ${r.name} names no QP-nn path and does not say "not a hot path"`);
    for (const p of pathRefs) if (!definedPaths.has(p)) malformed.push(`line ${r.line}: ${r.name} cites ${p}, which the document does not define as a heading`);
    if (r.rationale.length < 12) malformed.push(`line ${r.line}: ${r.name} has no rationale`);
  }
  const stale = registry.filter((r) => !created.has(key(r.kind, r.name)));
  return { missing, stale, malformed };
}

function main(): void {
  let files: string[];
  let doc: string;
  try {
    files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
    doc = readFileSync(DOC, "utf8");
  } catch (err) {
    console.error(`check:discovery-query-paths: cannot read inputs: ${(err as Error).message}`);
    console.log("RESULT unreadable");
    process.exit(2);
  }
  const objects = files.flatMap((f) => discoveryObjectsIn(f, readFileSync(resolve(MIGRATIONS, f), "utf8")));

  if (process.argv.includes("--print")) {
    const seen = new Set<string>();
    for (const o of objects) {
      const k = `${o.kind}:${o.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const migs = objects.filter((x) => x.kind === o.kind && x.name === o.name).map((x) => x.migration.slice(0, 4));
      console.log(`| ${o.kind} | \`${o.name}\` | \`${o.table}\` | ${[...new Set(migs)].join(", ")} | ? | ? |`);
    }
    return;
  }

  const { missing, stale, malformed } = checkRegistry(objects, doc);
  console.log(`check:discovery-query-paths: ${objects.length} Discovery table/index creations across ${files.length} migrations; registry rows: ${parseRegistry(doc).length}`);
  for (const o of missing) console.log(`  MISSING  ${o.kind} ${o.name} on ${o.table} (${o.migration}) — add a registry row to docs/discovery/query-paths.md with its cardinality, rationale and query path (\`10\` §4)`);
  for (const r of stale) console.log(`  STALE    line ${r.line}: ${r.kind} ${r.name} — no migration creates it`);
  for (const m of malformed) console.log(`  MALFORMED ${m}`);
  if (missing.length + stale.length + malformed.length > 0) {
    console.log("RESULT failed");
    process.exit(1);
  }
  console.log("RESULT clean");
}

// ═══════════════════════════════════════════════════════════════════════════════
// census-discovery §62 (DC-15) — constraint-backed indexes
// ═══════════════════════════════════════════════════════════════════════════════
//
// Declared here, below every line a census cites (`:67`, `:114`), and reached
// from `discoveryObjectsIn` by hoisted function declaration.
//
// THE GAP §59 FOUND. `CREATE TABLE (… CONSTRAINT x UNIQUE (…))` and
// `ALTER TABLE … ADD CONSTRAINT x UNIQUE (…)` build a btree exactly as
// `CREATE UNIQUE INDEX x` does — same maintenance cost on every write, same
// planner candidate — but INDEX_RE matches only the CREATE INDEX spelling. So
// `trails_slug_unique`, `place_momentum_place_run_key` and
// `discovery_place_reports_unique` had no row, and a new migration adding one
// passed the check. An EXCLUDE constraint builds an index the same way and is
// registered the same way.
//
// PRIMARY KEY IS NOT REGISTERED — the reading, stated in query-paths.md §4. `10`
// §4 asks each query path for an "index rationale". A primary key is not chosen
// to serve a path; it is the table's row identity, it exists exactly once per
// table, and its rationale is the table's own, which the table's registry row
// already carries (and which this check already requires). Where a path uses a
// primary key, the path's section names it (QP-01, QP-02, QP-06, QP-15). A
// UNIQUE or EXCLUDE constraint is the opposite case: an optional design choice
// with a write cost, so it needs a reason of its own.
//
// AN UNNAMED UNIQUE/EXCLUDE (`UNIQUE (a, b)`, `col text UNIQUE`,
// `ALTER TABLE t ADD UNIQUE (…)`) gets a name PostgreSQL derives, which a
// registry keyed by name cannot match reliably (truncation, collision suffixes).
// It is reported MALFORMED with the instruction to name it, not silently passed.
//
// Scope, stated: DDL issued as a string through EXECUTE is matched only where it
// is spelled out in full like any other statement; DDL assembled with format()
// is invisible, exactly as it is to INDEX_RE.

const CONSTRAINT_INDEX_KIND = String.raw`(?:UNIQUE|EXCLUDE)\b`;
const ALTER_TABLE_RE = new RegExp(
  String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${qualified}\s+([^;]*)`, "gi");
const NAMED_CONSTRAINT_RE = new RegExp(String.raw`\bCONSTRAINT\s+${ident}\s+${CONSTRAINT_INDEX_KIND}`, "i");
const TABLE_LEVEL_RE = /^\s*(?:CONSTRAINT\s|PRIMARY\s+KEY|UNIQUE\b|EXCLUDE\b|CHECK\b|FOREIGN\s+KEY|LIKE\s)/i;

/** Blank out single-quoted literals, so `CHECK (x IN ('unique'))` is not a UNIQUE. */
function withoutStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** The text between the `(` at `open - 1` and its matching `)`; quote-aware. */
function balancedBody(text: string, open: number): string {
  let depth = 1, quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(open, i);
  }
  return text.slice(open);
}

/** Split on commas at parenthesis depth 0; quote-aware. */
function splitTopLevelCommas(sql: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, cur = "";
  for (const ch of sql) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

/**
 * The index one table element (a column definition, a table constraint, or the
 * body of an `ALTER TABLE … ADD`) creates through a UNIQUE/EXCLUDE constraint.
 * `null` when it creates none.
 */
function constraintIndexOf(element: string, table: string, migration: string): SchemaObject | null {
  const el = withoutStringLiterals(element);
  const named = NAMED_CONSTRAINT_RE.exec(el);
  if (named) return { kind: "index", name: (named[1] ?? named[2] ?? "").toLowerCase(), table, migration };
  const isTableLevel = TABLE_LEVEL_RE.test(el);
  const unnamed = isTableLevel
    ? new RegExp(String.raw`^\s*${CONSTRAINT_INDEX_KIND}`, "i").test(el)
    : /\bUNIQUE\b/i.test(el);   // a column definition: `col text UNIQUE`
  return unnamed ? { kind: "index", name: `(unnamed UNIQUE/EXCLUDE on ${table})`, table, migration, unnamed: true } : null;
}

/** Every index a UNIQUE/EXCLUDE constraint creates on a Discovery table, in one migration's (comment-stripped) text. */
export function constraintIndexesIn(migration: string, text: string): SchemaObject[] {
  const out: SchemaObject[] = [];
  for (const m of text.matchAll(TABLE_RE)) {
    const table = (m[1] ?? m[2] ?? "").toLowerCase();
    if (!isDiscoveryTable(table)) continue;
    for (const element of splitTopLevelCommas(balancedBody(text, m.index! + m[0].length))) {
      const o = constraintIndexOf(element, table, migration);
      if (o) out.push(o);
    }
  }
  for (const m of text.matchAll(ALTER_TABLE_RE)) {
    const table = (m[1] ?? m[2] ?? "").toLowerCase();
    if (!isDiscoveryTable(table)) continue;
    for (const action of splitTopLevelCommas(m[3] ?? "")) {
      const add = /^\s*ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([\s\S]*)$/i.exec(action);
      if (!add) continue;
      const o = constraintIndexOf(add[1]!, table, migration);
      if (o) out.push(o);
    }
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
