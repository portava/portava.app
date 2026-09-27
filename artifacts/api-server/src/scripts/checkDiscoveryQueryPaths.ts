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
 *   1. Every `CREATE TABLE` and every `CREATE [UNIQUE] INDEX` that any file in
 *      src/migrations/ issues against a Discovery table must have a registry
 *      row in the document (`| table | … |` / `| index | … |`), naming the
 *      migration that creates it. A NEW Discovery migration that adds an index
 *      or a table without one fails here.
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
  "trail_health_snapshots", "recommendations", "rank_events",
]);

export function isDiscoveryTable(name: string): boolean {
  return DISCOVERY_TABLES.has(name) || name.startsWith("discovery_") || name.startsWith("trail");
}

export interface SchemaObject { kind: "table" | "index"; name: string; table: string; migration: string }

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
  return out;
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
    if (!row) { missing.push(os[0]!); continue; }
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
