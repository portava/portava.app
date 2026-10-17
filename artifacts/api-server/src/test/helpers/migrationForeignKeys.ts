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
// table, and a computed relationship. No double sees either today. An unhinted
// embed between two tables joined by more than one key IS modelled since wave 5
// (2026-10-17) and REFUSED, as PostgREST refuses it (PGRST201): see AMBIGUITY at
// the resolver below. (This paragraph used to say it was ACCEPTED because the
// reader is additive; the resolver says why that error is now the benign one.)

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

/** A parsed key plus the columns it references (`REFERENCES t(col)`; empty when the declaration names none). */
type ParsedKey = ForeignKey & { refColumns: string[] };

function foreignKeyOf(from: string, item: string): ParsedKey | null {
  const ref = new RegExp(String.raw`REFERENCES\s+${ident}(?:\s*\(([^)]*)\))?`, "i").exec(item);
  if (!ref) return null;
  const refColumns = (ref[2] ?? "").split(",").map((c) => c.trim().replace(/"/g, "").toLowerCase()).filter(Boolean);
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
  return { from, to: ref[1].toLowerCase(), columns, name, refColumns };
}

/** Every foreign key a SQL text declares, with its columns and name. Exported for the guard's own test. */
export function parseForeignKeys(sqlText: string): ForeignKey[] {
  return parseKeys(sqlText).map(({ from, to, columns, name }) => ({ from, to, columns, name }));
}

function parseKeys(sqlText: string): ParsedKey[] {
  const out: ParsedKey[] = [];
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

/** One declared key, de-duplicated across the sources that declare it. */
export interface DeclaredKey extends ForeignKey {
  /** The referenced columns on `to`; empty when no declaration names them. */
  refColumns: string[];
  /** Every name the key was declared under (additive: a key re-added under a new name answers to both). */
  names: string[];
}

let fkCache: DeclaredKey[] | null = null;
/**
 * Every declared key, once per (table, columns, target). A key the migration
 * chain AND the baseline both declare is ONE relationship to PostgREST, so
 * counting it twice would invent an ambiguity. The baseline is read last, so
 * `name` is production's when the baseline has the key.
 */
function foreignKeys(): DeclaredKey[] {
  if (fkCache) return fkCache;
  const uniq = new Map<string, DeclaredKey>();
  for (const f of sqlSources()) {
    for (const fk of parseKeys(fs.readFileSync(f, "utf8"))) {
      const k = `${fk.from}|${fk.columns.join(",")}|${fk.to}`;
      const seen = uniq.get(k);
      if (!seen) { uniq.set(k, { ...fk, names: [fk.name] }); continue; }
      seen.name = fk.name;
      if (!seen.names.includes(fk.name)) seen.names.push(fk.name);
      if (fk.refColumns.length > 0) seen.refColumns = fk.refColumns;
    }
  }
  fkCache = [...uniq.values()];
  return fkCache;
}

/** The de-duplicated declared keys (the scan reads the same set the doubles do). */
export function declaredForeignKeys(): readonly DeclaredKey[] {
  return foreignKeys();
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

// ── AMBIGUITY (wave 5, 2026-10-17): modelled, and REFUSED (PGRST201) ──
// PostgREST resolves `x(...)` by collecting every relationship between the two
// tables, in BOTH directions (a key on the parent is many-to-one, a key on the
// embedded table is one-to-many, and a self-referencing key is both), then
// keeping those a `!hint` selects: the constraint name, the key's column, or
// the column it references (single-column keys only). None left: PGRST200.
// More than one left: PGRST201, and the read fails. Five production reads
// embedded unhinted across such a pair and failed in production (posts →
// profiles, whose three keys are author_id, created_by and updated_by, and
// live_place_recaps ↔ live_place_recap_versions, keyed both ways); the doubles
// accepted all five. They now refuse it, as PostgREST does.
// The reader is still additive, so the error it can make is a refusal of an
// unhinted embed across a pair whose extra key was later dropped. That error
// is benign: its remedy, a hint naming the surviving key, is valid in
// production too. The opposite error (accepting what production refuses) is
// the one this exists to stop. Keys are de-duplicated by (table, columns,
// target), so a key declared by a migration AND the baseline counts once.
// NOT MODELLED: a many-to-many relationship through a junction table also
// counts towards PGRST201 in PostgREST; this resolver counts direct keys only.

const JOIN_MODIFIERS = new Set(["inner", "left"]);

/** Which way a relationship runs from the embedding table: its key on the parent (an object), or on the embedded table (an array). */
export type EmbedCardinality = "many-to-one" | "one-to-many";

export interface EmbedRelationship {
  key: Readonly<DeclaredKey>;
  cardinality: EmbedCardinality;
}

/** Why PostgREST would refuse one embed: no relationship (PGRST200), or more than one and no hint that picks one (PGRST201). */
export interface EmbedRefusal {
  code: "PGRST200" | "PGRST201";
  parent: string;
  relation: string;
  why: string;
  /** The candidate relationships, described, when there are any. */
  keys: string[];
}

/** One embed of a select list, resolved the way PostgREST resolves it. */
export interface ResolvedEmbed {
  /** The table the embed hangs off. */
  parent: string;
  /** The name as written (a table, or an FK column of the parent), alias and hints stripped. */
  relation: string;
  /** The key the embed lands under in a row: the alias, else the name as written. */
  outputKey: string;
  /** The table the embed lands on. */
  target: string;
  /** `!hint`s, join modifiers excluded. */
  hints: string[];
  /** `!inner`: a parent row with no match is dropped. */
  inner: boolean;
  /** `...x(...)`: the embed's columns are spread into the parent. */
  spread: boolean;
  /** The select list inside the parentheses. */
  select: string;
  /** The relationship it runs along; null when refused, or when only the table-level reader links the pair. */
  relationship: EmbedRelationship | null;
  refusal: EmbedRefusal | null;
  /** Embeds nested in `select`, hanging off `target`. */
  children: ResolvedEmbed[];
}

/** `posts.author_id → profiles (posts_author_id_fkey, many-to-one)`. */
export function describeRelationship(r: EmbedRelationship): string {
  return `${r.key.from}.${r.key.columns.join("+")} → ${r.key.to} (${r.key.name}, ${r.cardinality})`;
}

/** Every relationship PostgREST would consider between `parent` and `relation`, both directions. */
function relationshipsBetween(parent: string, relation: string): EmbedRelationship[] {
  const out: EmbedRelationship[] = [];
  for (const key of foreignKeys()) {
    if (key.from === parent && key.to === relation) out.push({ key, cardinality: "many-to-one" });
    if (key.from === relation && key.to === parent) out.push({ key, cardinality: "one-to-many" });
  }
  return out;
}

/** Does `hint` select this relationship? A constraint name, or the column (either end) of a single-column key. */
function hintSelects(r: EmbedRelationship, hint: string): boolean {
  if (r.key.names.includes(hint)) return true;
  if (r.key.columns.length === 1 && r.key.columns[0] === hint) return true;
  return r.key.refColumns.length === 1 && r.key.refColumns[0] === hint;
}

function resolveEmbed(parent: string, relation: string, hints: string[]): { target: string; relationship: EmbedRelationship | null; refusal: EmbedRefusal | null } {
  const fks = foreignKeys();
  // An FK COLUMN of the parent: the embed lands on the table it references.
  const viaColumn = fks.find((fk) => fk.from === parent && fk.columns.length === 1 && fk.columns[0] === relation);
  if (viaColumn) return { target: viaColumn.to, relationship: { key: viaColumn, cardinality: "many-to-one" }, refusal: null };
  const between = relationshipsBetween(parent, relation);
  const refuse = (code: EmbedRefusal["code"], why: string, keys: string[] = []) =>
    ({ target: relation, relationship: null, refusal: { code, parent, relation, why, keys } });
  if (between.length === 0) {
    if (migrationFkBacksEmbed(parent, relation)) return { target: relation, relationship: null, refusal: null };
    if (KNOWN_UNBACKED_EMBEDS.some((k) => k.parent === parent && k.relation === relation)) return { target: relation, relationship: null, refusal: null };
    return refuse("PGRST200",
      `\`${relation}(...)\` is embedded from \`${parent}\`, but no migration declares a foreign key between those ` +
      "tables (the 2026-08-19 production baseline included), so PostgREST would refuse it (PGRST200).");
  }
  const keys = between.map(describeRelationship);
  let chosen = between;
  for (const h of hints) {
    const picked = chosen.filter((r) => hintSelects(r, h));
    if (picked.length === 0) {
      return refuse("PGRST200",
        `\`${relation}!${h}(...)\` is embedded from \`${parent}\`, but \`${h}\` names no foreign-key column or ` +
        "constraint between those tables, so PostgREST would refuse it (PGRST200).", keys);
    }
    chosen = picked;
  }
  if (chosen.length > 1) {
    const spelled = hints.length > 0 ? `${relation}!${hints.join("!")}` : relation;
    return refuse("PGRST201",
      `\`${spelled}(...)\` is embedded from \`${parent}\`, but ${hints.length > 0 ? "its hint selects" : "with no hint,"} ` +
      `${chosen.length} relationships join those tables (${chosen.map(describeRelationship).join("; ")}), so PostgREST ` +
      `cannot choose one and refuses it (PGRST201). Name the key: \`${relation}!<constraint or column>(...)\`.`, keys);
  }
  return { target: relation, relationship: chosen[0]!, refusal: null };
}

/**
 * Every embed in `cols` (selected from `table`), resolved as PostgREST resolves
 * it, in select-list order, nested ones under their parent. Nested embeds hang
 * off the table their enclosing embed RESOLVED to (an FK column lands on its
 * target). Aggregates (`count()`) are not embeds.
 */
export function resolveSelectEmbeds(table: string, cols: string | undefined | null): ResolvedEmbed[] {
  const out: ResolvedEmbed[] = [];
  if (!cols) return out;
  for (const item of splitTopLevel(cols)) {
    const open = item.indexOf("(");
    if (open < 0) continue;
    let spec = item.slice(0, open).trim();
    const spread = spec.startsWith("...");
    spec = spec.replace(/^\.\.\./, "");
    let alias: string | null = null;
    if (spec.includes(":")) { alias = spec.slice(0, spec.indexOf(":")).trim(); spec = spec.slice(spec.lastIndexOf(":") + 1).trim(); }
    const [rawName, ...rawHints] = spec.split("!").map((s) => s.trim().toLowerCase());
    if (!rawName || AGGREGATES.has(rawName)) continue;
    const hints = rawHints.filter((h) => h && !JOIN_MODIFIERS.has(h));
    const parent = table.toLowerCase();
    const { target, relationship, refusal } = resolveEmbed(parent, rawName, hints);
    const select = item.slice(open + 1, item.lastIndexOf(")"));
    out.push({
      parent, relation: rawName, outputKey: alias ?? spec.split("!")[0]!.trim(), target, hints,
      inner: rawHints.includes("inner"), spread, select, relationship, refusal,
      children: resolveSelectEmbeds(target, select),
    });
  }
  return out;
}

/** Every refusal in `cols`, outermost first; empty when PostgREST would resolve every embed. */
export function selectEmbedRefusalDetails(table: string, cols: string | undefined | null): EmbedRefusal[] {
  const walk = (nodes: ResolvedEmbed[]): EmbedRefusal[] => nodes.flatMap((n) => [...(n.refusal ? [n.refusal] : []), ...walk(n.children)]);
  return walk(resolveSelectEmbeds(table, cols));
}

/**
 * Why each embed in `cols` (selected from `table`) would be refused by PostgREST,
 * outermost first; empty when every embed resolves to exactly one relationship.
 */
export function selectEmbedRefusals(table: string, cols: string | undefined | null): string[] {
  return selectEmbedRefusalDetails(table, cols).map((r) => r.why);
}
