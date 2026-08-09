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
 *   - adminRemainingDashboardsSchemaDrift.test.ts (incl. the shared admin
 *     guard in lib/requireAdmin.ts — see "Column lists held in a const")
 */

// Chained builder methods whose FIRST string argument is a column name.
export const COLUMN_ARG_METHODS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in",
  "contains", "containedBy", "not", "order", "textSearch", "match", "filter",
]);

export type ColumnRef = { column: string; method: string; index: number };

/**
 * Column lists held in a const, e.g.
 *
 *   const columns = opts.withDisplayName
 *     ? "role, display_name, username, handle"
 *     : "role";
 *   ...
 *   .select(columns)
 *
 * `.select(<identifier>)` carries no string literal, so the literal-only
 * scan below sees nothing and the selected columns go UNVALIDATED — the
 * extractor silently reports "no columns referenced" rather than failing,
 * which is the worst possible outcome for a drift guard.
 *
 * This resolves single-assignment `const`/`let` string initialisers in the
 * same file, including ternaries of string literals (EVERY branch is
 * collected — a drift guard must cover the branch that is not taken too).
 *
 * Deliberately shallow: same-file, literal-only, no cross-module resolution
 * and no reassignment tracking. A name it cannot resolve yields no refs,
 * exactly as before — so this only ever ADDS coverage. If you need a select
 * list to be checked, keep it a literal or a same-file const of literals.
 */
function resolveStringConsts(source: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const declRe = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*([^;]*);/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    const name = m[1]!;
    const rhs = m[2]!;
    // Only treat it as a column list if the RHS is made of string literals
    // (optionally selected by a ternary). Anything else — a call, a member
    // expression — is not statically a column list.
    const withoutStrings = rhs.replace(/["'`][^"'`]*["'`]/g, "");
    if (!/^[\s?:+]*$/.test(withoutStrings.replace(/[A-Za-z_$][\w$.]*/g, (t) =>
      // allow the ternary condition identifiers, nothing else
      /^[A-Za-z_$][\w$.]*$/.test(t) ? "" : t))) continue;
    const lits = [...rhs.matchAll(/["'`]([^"'`]*)["'`]/g)].map((x) => x[1]!);
    if (lits.length === 0) continue;
    // A name assigned twice is not statically resolvable — drop it rather
    // than guess which assignment reaches the .select().
    if (map.has(name)) map.set(name, []);
    else map.set(name, lits);
  }
  return map;
}

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
  const stringConsts = resolveStringConsts(source);
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
        if (parts.length === 0) {
          // `.select(columns)` — a bare identifier. Resolve it to the string
          // literal(s) it was assigned in this file, so a column list hoisted
          // into a const is still checked. See resolveStringConsts.
          const ident = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(firstArg)?.[1];
          if (ident) parts.push(...(stringConsts.get(ident) ?? []));
        }
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

/**
 * Extract the top-level object-literal keys of every `.insert({...})` (and
 * `.upsert({...})`, `.update({...})`) payload in query chains rooted at
 * `.from("<table>")`. These keys are column names sent to PostgREST — one
 * unknown key fails the whole write (PGRST204), which silently kills
 * fire-and-forget audit-log inserts.
 *
 * Only object-literal payloads (`{` as first non-space char, or an array of
 * object literals `[{...}, ...]`) are extracted; variable payloads are
 * skipped (can't be statically resolved). Nested objects/arrays inside
 * values are skipped — only depth-1 keys are columns.
 */
export function extractInsertPayloadKeys(
  source: string,
  table: string,
): ColumnRef[] {
  const refs: ColumnRef[] = [];
  const WRITE_METHODS = new Set(["insert", "upsert", "update"]);
  const fromRe = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g");
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(source)) !== null) {
    let pos = m.index + m[0].length;
    for (;;) {
      const rest = source.slice(pos);
      const link = /^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(rest);
      if (!link) break;
      const method = link[2]!;
      const argStart = pos + link[0].length;
      // Find matching close paren (handles nested parens and strings).
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
      if (WRITE_METHODS.has(method)) {
        const argText = sliceFirstTopLevelArg(source.slice(argStart, i - 1));
        for (const key of extractObjectLiteralKeys(argText)) {
          refs.push({ column: key, method, index: m.index });
        }
      }
      pos = i;
    }
  }
  return refs;
}

/**
 * Given the text of a payload argument, collect depth-1 keys of every
 * object literal in it (handles a single `{...}` or an array `[{...},{...}]`).
 * Returns [] if the argument is not an object/array literal.
 */
function extractObjectLiteralKeys(argText: string): string[] {
  const keys: string[] = [];
  const trimmed = argText.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return keys;
  let depth = 0; // brace/bracket depth; keys live at object depth 1
  let objDepth = 0; // depth counted in `{` only
  let inStr: string | null = null;
  let expectKey = false;
  for (let i = 0; i < argText.length; i++) {
    const ch = argText[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "{") { objDepth++; depth++; if (objDepth === 1) expectKey = true; continue; }
    if (ch === "}") { objDepth--; depth--; continue; }
    if (ch === "[" || ch === "(") { depth++; continue; }
    if (ch === "]" || ch === ")") { depth--; continue; }
    if (objDepth === 1) {
      if (ch === ",") { expectKey = true; continue; }
      if (ch === ".") { expectKey = false; continue; } // spread `...x`
      if (expectKey && /[A-Za-z_$]/.test(ch)) {
        const rest = argText.slice(i);
        // `key:` or shorthand `key,`/`key}` — spread (...x) has no ident start.
        const km = /^([A-Za-z_$][\w$]*)\s*(?::|,|\})/.exec(rest);
        if (km) {
          keys.push(km[1]!);
          i += km[1]!.length - 1;
        }
        expectKey = false;
      }
    }
  }
  return keys;
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
