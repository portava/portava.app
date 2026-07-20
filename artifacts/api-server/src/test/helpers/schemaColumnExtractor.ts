/**
 * Shared static column-reference extractor for schema-drift guard tests.
 *
 * Extracts every column name referenced in Supabase query chains rooted at
 * `.from("<table>")` in a source file — .select() lists and the first string
 * argument of filter/order methods — so tests can assert each referenced
 * column exists in a live-verified schema column list.
 *
 * Background: PostgREST fails the WHOLE query on a single unknown column,
 * and admin dashboards using Promise.allSettled + "?? 0" defaults silently
 * zero their counts when that happens.
 *
 * Used by:
 *   - adminCompassSchemaDrift.test.ts (posts/events in adminCompass.ts)
 *   - adminGeoModerationSchemaDrift.test.ts (geo/moderation tables in admin.ts)
 */

// Chained builder methods whose FIRST string argument is a column name.
export const COLUMN_ARG_METHODS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in",
  "contains", "containedBy", "not", "order", "textSearch", "match", "filter",
]);

export type ColumnRef = { column: string; method: string; index: number };

/**
 * Extract the query chain that starts at each `.from("<table>")` call and
 * runs through the subsequent chained method calls, collecting every column
 * name referenced.
 *
 * The chain ends when we hit a token that is not another chained `.method(`
 * call (e.g. a comma ending a Promise.allSettled entry, a semicolon, or a
 * closing bracket).
 *
 * Handles:
 *   - concatenated select strings: select("a, b, " + "c, d") — all string
 *     literals in the first top-level argument are collected.
 *   - embedded resources in selects ("other_table(count)") — skipped; they
 *     are relation names, not columns of the queried table.
 *   - embedded paths in filters ("other_table.count") — skipped for the
 *     same reason.
 */
export function extractColumnRefs(source: string, table: string): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const fromRe = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) {
    let pos = m.index + m[0].length;
    // Walk chained `.method( ... )` calls.
    for (;;) {
      // Skip whitespace and comments between chained calls.
      const rest = source.slice(pos);
      const link = /^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
      if (!link) break;
      const method = link[2]!;
      const argStart = pos + link[0].length;
      // Find the matching close paren (handles nested parens and strings).
      let depth = 1;
      let i = argStart;
      let inStr: string | null = null;
      while (i < source.length && depth > 0) {
        const ch = source[i]!;
        if (inStr) {
          if (ch === "\\") i++;
          else if (ch === inStr) inStr = null;
        } else if (ch === '"' || ch === "'" || ch === "`") {
          inStr = ch;
        } else if (ch === "(") depth++;
        else if (ch === ")") depth--;
        i++;
      }
      const argText = source.slice(argStart, i - 1);

      if (method === "select") {
        // Collect ALL string literals in the first top-level argument (the
        // column list may be split across concatenated literals). The
        // second argument (options object like { count: "exact" }) must be
        // excluded — its values are not columns.
        const firstArg = sliceFirstTopLevelArg(argText);
        const litRe = /["'`]([^"'`]*)["'`]/g;
        let lit: RegExpExecArray | null;
        const parts: string[] = [];
        while ((lit = litRe.exec(firstArg)) !== null) parts.push(lit[1]!);
        for (const raw of parts.join(",").split(",")) {
          const col = raw.trim();
          if (!col || col === "*") continue;
          // Embedded resource (e.g. "reports(count)") — a relation, not a
          // column of this table.
          if (col.includes("(")) continue;
          // Strip aliases / aggregates: take the bare leading identifier
          // (e.g. "id" from "id:renamed" or "id.count()").
          const bare = /^[A-Za-z_][\w]*/.exec(col)?.[0];
          if (bare) refs.push({ column: bare, method, index: m.index });
        }
      } else if (COLUMN_ARG_METHODS.has(method)) {
        const lit = /^\s*["'`]([^"'`]+)["'`]/.exec(argText);
        // Skip embedded paths like "other_table.count" — not this table's
        // columns.
        if (lit && !lit[1]!.includes(".")) {
          refs.push({ column: lit[1]!, method, index: m.index });
        }
      }
      pos = i;
    }
  }
  return refs;
}

/** Text of the first top-level (comma-delimited) argument of a call. */
function sliceFirstTopLevelArg(argText: string): string {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inStr = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) return argText.slice(0, i);
  }
  return argText;
}

export function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}
