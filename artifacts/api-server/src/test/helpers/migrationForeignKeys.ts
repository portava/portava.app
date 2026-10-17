/**
 * migrationForeignKeys — census-layover L295 (wave W, A6): the foreign keys the
 * migration chain DECLARES, so a fake client can refuse to model a PostgREST
 * embed that production cannot perform.
 *
 * PostgREST resolves `x(...)` in a select list only along a foreign key between
 * the two tables (either direction). A test double that answers an embed with
 * no FK behind it asserts a join the real database refuses with PGRST200 — the
 * test is green, the route is dead. This module reads the FK edges out of
 * `src/migrations/*.sql` AND the 2026-08-19 production baseline (wave 5): CREATE
 * TABLE constraints and ALTER TABLE ... REFERENCES. `parseSelectEmbeds` reads the
 * embeds out of a select list, so the double can check one against the other.
 *
 * Deliberately ADDITIVE: an FK dropped by a later migration is still counted.
 * That errs towards accepting an embed, never towards inventing one that no
 * migration ever declared — which is the defect this exists to stop.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../migrations");

let cache: Set<string> | null = null;

const ident = String.raw`(?:"?(?:public|auth)"?\.)?"?([a-z_][a-z0-9_]*)"?`;

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The body of the parenthesised list starting at `open` (index of "("). */
function balanced(sql: string, open: number): string {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  return sql.slice(open + 1);
}

/** Every `from→to` FK edge any migration declares. Exported for the guard's own test. */
export function parseForeignKeyEdges(sqlText: string): Set<string> {
  const edges = new Set<string>();
  const sql = stripComments(sqlText);
  const refRe = new RegExp(String.raw`REFERENCES\s+${ident}`, "gi");
  const createRe = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s*\(`, "gi");
  for (let m; (m = createRe.exec(sql)); ) {
    const from = m[1].toLowerCase();
    const body = balanced(sql, m.index + m[0].length - 1);
    for (let r; (r = refRe.exec(body)); ) edges.add(`${from}→${r[1].toLowerCase()}`);
    refRe.lastIndex = 0;
  }
  const alterRe = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}([^;]*);`, "gi");
  for (let m; (m = alterRe.exec(sql)); ) {
    const from = m[1].toLowerCase();
    for (let r; (r = refRe.exec(m[2])); ) edges.add(`${from}→${r[1].toLowerCase()}`);
    refRe.lastIndex = 0;
  }
  return edges;
}

function edges(): Set<string> {
  if (cache) return cache;
  const out = new Set<string>();
  for (const f of sqlSources()) {
    for (const e of parseForeignKeyEdges(fs.readFileSync(f, "utf8"))) out.add(e);
  }
  cache = out;
  return out;
}

/** May PostgREST embed `embed` from `table`? Only along a migration-declared FK, either direction. */
export function migrationFkBacksEmbed(table: string, embed: string): boolean {
  const e = edges();
  return e.has(`${table}→${embed}`) || e.has(`${embed}→${table}`);
}

const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);

export interface SelectEmbed {
  /** The table the embed hangs off. */
  parent: string;
  /** The embedded relation, alias and `!hint` stripped. */
  embed: string;
}

/**
 * Every embed in a PostgREST select list, nested ones included (a nested embed
 * hangs off its enclosing embed, not the base table). Aggregates (`count()`)
 * are not embeds.
 */
export function parseSelectEmbeds(table: string, cols: string | undefined | null): SelectEmbed[] {
  const out: SelectEmbed[] = [];
  if (!cols) return out;
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { items.push(cur); cur = ""; continue; }
    cur += ch;
  }
  items.push(cur);
  for (const raw of items) {
    const item = raw.trim();
    const open = item.indexOf("(");
    if (open < 0) continue;
    let name = item.slice(0, open).trim().replace(/^\.\.\./, "");
    if (name.includes(":")) name = name.slice(name.lastIndexOf(":") + 1).trim();
    name = name.split("!")[0].trim().toLowerCase();
    if (!name || AGGREGATES.has(name)) continue;
    out.push({ parent: table, embed: name });
    const inner = item.slice(open + 1, item.lastIndexOf(")"));
    out.push(...parseSelectEmbeds(name, inner));
  }
  return out;
}

/**
 * Throw unless every embed in `cols` (selected from `table`) is backed by a
 * migration-declared FK. The one call a test double makes in its `select()`.
 */
export function assertSelectEmbedsBacked(double: string, table: string, cols: string | undefined | null): void {
  const refusal = selectEmbedRefusals(table, cols)[0];
  if (refusal) throw new Error(`${double}: ${refusal} A fake that answered it would assert a join production cannot perform.`);
}

// ── census-layover L295, wave 5 (2026-10-17): every double, the baseline, and the column a join runs along ──
//
// The first cut read only `src/migrations/*.sql`. Most of production's foreign
// keys predate that chain: they are in the 2026-08-19 structure dump
// (`baseline/20260819_baseline_structure.sql`), so `trip_members → trips`,
// `user_follows → profiles` and `event_reviews → profiles` read as unbacked.
// The baseline is now read too, and stays ADDITIVE: a key in either source counts.
//
// It also reads WHICH COLUMN each key runs along and what it is named, because
// PostgREST resolves two more spellings than a bare table name, and refuses
// a hint that names no key between the two tables:
//   `profiles:submitted_by!left(...)` — an FK COLUMN of the parent; the embed
//     lands on the table that column references.
//   `profiles!reviewer_id(...)`, `profiles!user_follows_following_id_fkey(...)`
//     — a hint naming an FK column (either side) or a constraint. `!inner` and
//     `!left` are join modifiers, not hints.
// NOT MODELLED, and therefore refused: a many-to-many embed through a junction
// table, and a computed relationship. No double sees either today. Also NOT
// MODELLED, and therefore ACCEPTED: an unhinted embed between two tables joined
// by more than one key, which PostgREST refuses as ambiguous (PGRST201). The
// reader is additive (a dropped key still counts), so it cannot call a pair
// ambiguous without risking a refusal production would not make.

const BASELINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../baseline/20260819_baseline_structure.sql");

/** Every SQL source whose foreign keys count: the migration chain, then the production baseline. */
function sqlSources(): string[] {
  const chain = fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort().map((n) => path.join(MIGRATIONS_DIR, n));
  return [...chain, BASELINE];
}

export interface ForeignKey {
  from: string;
  to: string;
  /** The referencing columns on `from`. */
  columns: string[];
  /** The declared constraint name, or Postgres's default `<table>_<cols>_fkey`. */
  name: string;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

function foreignKeyOf(from: string, item: string): ForeignKey | null {
  const ref = new RegExp(String.raw`REFERENCES\s+${ident}`, "i").exec(item);
  if (!ref) return null;
  const tableLevel = /FOREIGN\s+KEY\s*\(([^)]*)\)/i.exec(item);
  let columns: string[];
  if (tableLevel) {
    columns = tableLevel[1].split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);
  } else {
    // A column definition: `[ADD [COLUMN] [IF NOT EXISTS]] name type … REFERENCES …`.
    const col = /^(?:ADD\s+)?(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s/i.exec(item);
    if (!col) return null;
    columns = [col[1].toLowerCase()];
  }
  const named = /CONSTRAINT\s+"?([a-z_][a-z0-9_$]*)"?/i.exec(item);
  const name = named ? named[1].toLowerCase() : `${from}_${columns.join("_")}_fkey`.slice(0, 63);
  return { from, to: ref[1].toLowerCase(), columns, name };
}

/** Every foreign key a SQL text declares, with its columns and name. Exported for the guard's own test. */
export function parseForeignKeys(sqlText: string): ForeignKey[] {
  const out: ForeignKey[] = [];
  const sql = stripComments(sqlText);
  const createRe = new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s*\(`, "gi");
  for (let m; (m = createRe.exec(sql)); ) {
    const from = m[1].toLowerCase();
    for (const item of splitTopLevel(balanced(sql, m.index + m[0].length - 1))) {
      const fk = foreignKeyOf(from, item);
      if (fk) out.push(fk);
    }
  }
  const alterRe = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}([^;]*);`, "gi");
  for (let m; (m = alterRe.exec(sql)); ) {
    const from = m[1].toLowerCase();
    for (const action of splitTopLevel(m[2])) {
      const fk = foreignKeyOf(from, action);
      if (fk) out.push(fk);
    }
  }
  return out;
}

let fkCache: ForeignKey[] | null = null;
function foreignKeys(): ForeignKey[] {
  if (fkCache) return fkCache;
  fkCache = sqlSources().flatMap((f) => parseForeignKeys(fs.readFileSync(f, "utf8")));
  return fkCache;
}

/**
 * Embeds production code issues that NO declared key backs, recorded rather than
 * hidden. A double ACCEPTS these (so the suites that drive them stay runnable)
 * and `fakeLayoverDbEmbedGuard.test.ts` pins that each one is still unbacked and
 * still issued, so an entry cannot outlive its defect.
 *
 * EMPTY since 2026-10-17 (census-trust, wave 5). Its one entry was `reviews →
 * profiles`: routes/reviews.ts embedded `profiles!reviewer_id(...)` from
 * `reviews`, whose only key (`reviews_reviewer_id_fkey`, confirmed on the
 * production catalog) runs to auth.users. Production answered PGRST200 and the
 * three review lists answered db_error. The route now reads the reviews, then
 * the reviewers' profiles in one batched `.in("id", ids)` read, and every double
 * REFUSES the old embed again. A new entry needs a finding, an owner, and a case
 * in `fakeLayoverDbEmbedGuard.test.ts` naming the file that still issues it.
 */
export const KNOWN_UNBACKED_EMBEDS: ReadonlyArray<{ parent: string; relation: string; finding: string }> = [];

const JOIN_MODIFIERS = new Set(["inner", "left"]);

function resolveEmbed(parent: string, relation: string, hints: string[]): { target: string; why: string | null } {
  const fks = foreignKeys();
  // An FK COLUMN of the parent: the embed lands on the table it references.
  const viaColumn = fks.find((fk) => fk.from === parent && fk.columns.length === 1 && fk.columns[0] === relation);
  if (viaColumn) return { target: viaColumn.to, why: null };
  const between = fks.filter((fk) => (fk.from === parent && fk.to === relation) || (fk.from === relation && fk.to === parent));
  if (between.length === 0 && !migrationFkBacksEmbed(parent, relation)) {
    if (KNOWN_UNBACKED_EMBEDS.some((k) => k.parent === parent && k.relation === relation)) return { target: relation, why: null };
    return {
      target: relation,
      why:
        `\`${relation}(...)\` is embedded from \`${parent}\`, but no migration declares a foreign key between those ` +
        "tables (the 2026-08-19 production baseline included), so PostgREST would refuse it (PGRST200).",
    };
  }
  // Tables the table-level reader links but whose columns it could not read: accept (additive).
  if (between.length === 0) return { target: relation, why: null };
  for (const h of hints) {
    if (!between.some((fk) => fk.name === h || fk.columns.includes(h))) {
      return {
        target: relation,
        why:
          `\`${relation}!${h}(...)\` is embedded from \`${parent}\`, but \`${h}\` names no foreign-key column or ` +
          "constraint between those tables, so PostgREST would refuse it (PGRST200).",
      };
    }
  }
  return { target: relation, why: null };
}

/**
 * Why each embed in `cols` (selected from `table`) would be refused by PostgREST,
 * outermost first; empty when every embed is backed. Nested embeds hang off the
 * table their enclosing embed RESOLVED to (an FK column lands on its target).
 */
export function selectEmbedRefusals(table: string, cols: string | undefined | null): string[] {
  const out: string[] = [];
  if (!cols) return out;
  for (const item of splitTopLevel(cols)) {
    const open = item.indexOf("(");
    if (open < 0) continue;
    let spec = item.slice(0, open).trim().replace(/^\.\.\./, "");
    if (spec.includes(":")) spec = spec.slice(spec.lastIndexOf(":") + 1).trim();
    const [rawName, ...rawHints] = spec.split("!").map((s) => s.trim().toLowerCase());
    if (!rawName || AGGREGATES.has(rawName)) continue;
    const hints = rawHints.filter((h) => h && !JOIN_MODIFIERS.has(h));
    const { target, why } = resolveEmbed(table.toLowerCase(), rawName, hints);
    if (why) out.push(why);
    out.push(...selectEmbedRefusals(target, item.slice(open + 1, item.lastIndexOf(")"))));
  }
  return out;
}
