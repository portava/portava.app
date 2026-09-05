/**
 * PostgREST `.select()` projection, for the in-memory Supabase test doubles.
 *
 * THE BLIND SPOT THIS CLOSES
 * --------------------------
 * Every fake Supabase client in this repo returns the WHOLE seeded fixture row,
 * whatever columns the production code actually selected. Real PostgREST returns
 * only the selected ones. So production code can read `row.some_column` while its
 * own `.select()` never asked for it: against the real database that read is
 * `undefined` and the feature silently degrades to a fallback, but in tests the
 * fixture supplies the value and the assertion passes.
 *
 * Nothing else in the repo covers it. `check:schema-references` parses `.select()`
 * STRINGS and asserts every column NAMED exists — never that every column READ was
 * named. TypeScript cannot see it either, because rows are typed
 * `Record<string, unknown>`, so an unselected read is `unknown`, not an error.
 *
 * Measured before this landed: across the curated suite, 79.5% of rows returned
 * through a projecting double (2,009 of 2,526) were carrying columns the caller
 * had not selected — 44 distinct column sets, including an 18-column `profiles`
 * privacy block. Not one test noticed. That is the leak; this is the plug.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 * It detects nothing retrospectively — landing it turned zero tests red. Its value
 * is prospective: the NEXT unselected-column read fails loudly instead of silently.
 *
 * ONE IMPLEMENTATION, DELIBERATELY
 * --------------------------------
 * There are several doubles (enumAwareSupabase, fakePassportDb, fakeMapDb, plus
 * branch-local ones) and ~136 inline builders. They share this module rather than
 * each growing a copy of the rule — a second implementation of a rule is how the
 * two halves of a defect end up in two lists that cannot see each other.
 */

export type ProjectionRow = Record<string, unknown>;

/**
 * Split a PostgREST select list at top level, respecting nesting.
 * `null` means the list is unbalanced and must not be interpreted.
 */
function splitTopLevel(select: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of select) {
    if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      if (depth < 0) return null;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (depth !== 0) return null;
  parts.push(cur);
  return parts;
}

/**
 * The keys PostgREST would put on a returned row, as `[outputKey, sourceColumn]`.
 *
 * `null` means DO NOT PROJECT — return the whole seeded row, exactly as these
 * doubles have always done. That is the answer for `*`, for a `.select()` with no
 * argument, and for every list this parser will not guess at: an embedded resource
 * or aggregate (`posts!inner(id)`, `related(count)`, `media(*)`), a quoted
 * identifier, a cast, an unbalanced list, or any token that is not a plain
 * identifier.
 *
 * The bail is the safety property. A WRONG projection turns green suites red for
 * no reason, which is strictly worse than the status quo — so anything short of
 * certainty falls back to today's behaviour. Measured on the curated suite: 17% of
 * real call sites took the bail path, all of them `*` or genuine embeds.
 */
export function projectionKeys(select?: string | null): Array<[string, string]> | null {
  if (select === undefined || select === null) return null;
  const raw = String(select).trim();
  if (raw === "" || raw === "*") return null;
  if (raw.includes('"') || raw.includes("::")) return null;
  const parts = splitTopLevel(raw);
  if (!parts) return null;
  const ident = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const pairs: Array<[string, string]> = [];
  for (const part of parts) {
    const p = part.trim();
    if (p === "" || p === "*" || p.includes("(")) return null;
    if (p.includes(":")) {
      // `alias:column` — PostgREST keys the result by the ALIAS, not the column.
      const i = p.indexOf(":");
      const alias = p.slice(0, i).trim();
      const col = p.slice(i + 1).trim();
      if (!ident.test(alias) || !ident.test(col)) return null;
      pairs.push([alias, col]);
    } else {
      if (!ident.test(p)) return null;
      pairs.push([p, p]);
    }
  }
  return pairs.length > 0 ? pairs : null;
}

/**
 * Narrow one row to the selected columns.
 *
 * A column the seeded row does not carry is left ABSENT rather than added as
 * `undefined`, so a `deepStrictEqual` against a fixture keeps comparing the same
 * shape it compared before this existed.
 */
export function projectRow(row: ProjectionRow, pairs: Array<[string, string]>): ProjectionRow {
  const out: ProjectionRow = {};
  for (const [key, col] of pairs) {
    if (Object.prototype.hasOwnProperty.call(row, col)) out[key] = row[col];
  }
  return out;
}

/**
 * Apply a projection to a result set, if there is one to apply.
 *
 * Call this LAST — after filtering, ordering and limiting. The real database
 * filters and sorts on the full row and projects on the way out; projecting first
 * would break `.eq()` on a column that was not selected, which is legal PostgREST.
 */
export function applyProjection<T extends ProjectionRow>(
  rows: T[],
  pairs: Array<[string, string]> | null,
): ProjectionRow[] {
  if (!pairs) return rows;
  return rows.map((r) => projectRow(r, pairs));
}
