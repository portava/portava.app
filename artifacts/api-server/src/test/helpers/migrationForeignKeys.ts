/**
 * migrationForeignKeys — census-layover L295 (wave W, A6): the foreign keys the
 * migration chain DECLARES, so a fake client can refuse to model a PostgREST
 * embed that production cannot perform.
 *
 * PostgREST resolves `x(...)` in a select list only along a foreign key between
 * the two tables (either direction). A test double that answers an embed with
 * no FK behind it asserts a join the real database refuses with PGRST200 — the
 * test is green, the route is dead. This module reads the FK edges straight out
 * of `src/migrations/*.sql` (CREATE TABLE column/table constraints and
 * ALTER TABLE ... REFERENCES), and `parseSelectEmbeds` reads the embeds out of
 * a select list, so the double can check one against the other.
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
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")).sort()) {
    for (const e of parseForeignKeyEdges(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))) out.add(e);
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
  for (const { parent, embed } of parseSelectEmbeds(table, cols)) {
    if (!migrationFkBacksEmbed(parent, embed)) {
      throw new Error(
        `${double}: \`${embed}(...)\` is embedded from \`${parent}\`, but no migration declares a foreign key ` +
          "between those tables, so PostgREST would refuse it (PGRST200). A fake that answered it would assert " +
          "a join production cannot perform.",
      );
    }
  }
}
