/**
 * census-discovery §118 (DV-83 round 21, lane W11-X2; the round-20 verifier's B23): what a PostgREST-shaped test double
 * needs to answer a KEYSET page the way the real server does.
 *
 * `readAllPages` (lib/pagedRead.ts) pages a keyed read by asking for the rows AFTER the last row it received: one column
 * is `.gt(col, v)`, a composite key is `.or("a.gt.v,and(a.eq.v,b.gt.w)")` (PostgREST's logic-tree grammar). A double
 * that ignores `.or()` answers the first page again, which `readAllPages` refuses as a repeated row; a double that sorts
 * by the LAST `.order()` only pages a composite key out of order. These helpers model both, so a double can serve pages
 * whose rows, count and order are the real server's:
 *
 *   - `logicFilter(expr)` parses an `.or()` argument (`col.op.value` terms, nested `and(...)` / `or(...)`, values
 *     optionally double-quoted with `\` escapes) into a row predicate over eq/neq/gt/gte/lt/lte; `null` when the
 *     expression is not of that grammar (so the double can fall back to its own `.or()`);
 *   - `sortByOrders(rows, orders)` sorts by every `.order()` column in turn, as `ORDER BY a, b` does, NULLs where
 *     PostgreSQL puts them (census-discovery §122).
 */

type Pred = (row: Record<string, unknown>) => boolean;

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let quoted = false; let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) { cur += ch; if (ch === "\\") { cur += s[++i] ?? ""; continue; } if (ch === '"') quoted = false; continue; }
    if (ch === '"') { quoted = true; cur += ch; continue; }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, "$1");
  return v;
}

function term(t: string): Pred | null {
  const m = /^(and|or)\((.*)\)$/s.exec(t);
  if (m) {
    const parts = splitTop(m[2]).map(term);
    if (parts.some((p) => p === null)) return null;
    const ps = parts as Pred[];
    return m[1] === "and" ? (r) => ps.every((p) => p(r)) : (r) => ps.some((p) => p(r));
  }
  const tn = /^([A-Za-z_][A-Za-z0-9_]*)\.is\.null$/.exec(t); if (tn) return (r) => r[tn[1]] === null || r[tn[1]] === undefined;  // census-discovery §119: `col.is.null`
  const t2 = /^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|gt|gte|lt|lte)\.(.*)$/s.exec(t);
  if (!t2) return null;
  const [, col, op, raw] = t2;
  const v = unquote(raw);
  return (r) => {
    const x = r[col];
    if (x === null || x === undefined) return false;
    const a = String(x);
    switch (op) {
      case "eq": return a === v;
      case "neq": return a !== v;
      case "gt": return a > v;
      case "gte": return a >= v;
      case "lt": return a < v;
      default: return a <= v;
    }
  };
}

/** The row predicate an `.or(expr)` argument means, or `null` when `expr` is not of the grammar modelled here. */
export function logicFilter(expr: string): Pred | null {
  const parts = splitTop(expr).map(term);
  if (parts.length === 0 || parts.some((p) => p === null)) return null;
  const ps = parts as Pred[];
  return (r) => ps.some((p) => p(r));
}

/**
 * `rows` sorted by every `.order()` column in turn (ascending unless `asc` is false), as `ORDER BY a, b` does. A NULL
 * (or absent) key sorts where PostgreSQL puts it: LAST ascending and FIRST descending, unless `nullsFirst` (supabase-js's
 * option, `NULLS FIRST` / `NULLS LAST`) says otherwise (census-discovery §122: it sorted NULL first ascending, so no
 * double could hold an undated event behind a dated one).
 */
export function sortByOrders<T extends Record<string, unknown>>(rows: T[], orders: Array<{ col: string; asc?: boolean; nullsFirst?: boolean }>): T[] {
  if (orders.length === 0) return rows;
  return [...rows].sort((x, y) => {
    for (const o of orders) {
      const a = x[o.col] as any, b = y[o.col] as any;
      const an = a === null || a === undefined, bn = b === null || b === undefined;
      if (an && bn) continue;
      const nullsFirst = o.nullsFirst ?? (o.asc === false);
      if (an) return nullsFirst ? -1 : 1;
      if (bn) return nullsFirst ? 1 : -1;
      if (a === b) continue;
      return (a > b ? 1 : -1) * (o.asc === false ? -1 : 1);
    }
    return 0;
  });
}
