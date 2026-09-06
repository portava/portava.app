/**
 * Filter-literal extraction — the AST half of `check:enum-literals`.
 *
 * WHAT IT COLLECTS
 * ----------------
 * Every PostgREST filter in `src/` that compares a column against a STRING
 * LITERAL, resolved back to the table its chain was opened on:
 *
 *     .eq("status", "in_progress")             -> trips.status  "in_progress"
 *     .neq("state", "banned")                  -> events.state  "banned"
 *     .in("status", ["approved", "active"])    -> hidden_gems.status  x2
 *     .not("state", "in", '("a","b")')         -> events.state  x2
 *     .not("account_status", "eq", "banned")   -> profiles.account_status
 *     .or("state.eq.deleted,state.eq.banned")  -> events.state  x2
 *
 * The last three forms matter as much as the first two. `.not(col, op, val)`
 * and `.or(…)` take the same enum cast, so a dead label in them raises the same
 * 22P02 — and they are exactly the forms a naive `.eq|.neq|.in` scanner misses.
 * Two of the thirty-two live sites the 2026-09-05 audit found were hiding in
 * `.not(col, "eq", literal)`.
 *
 * WHY AN AST AND NOT A REGEX
 * --------------------------
 * A text scan cannot tell live code from a comment. The audit's own regex
 * scanner reported 27 dead enum sites, of which 2 were COMMENTS recording an
 * already-fixed defect directly above the corrected line — a 7% false-positive
 * rate on a check meant to gate CI. TypeScript's parser sees no comments.
 *
 * CHAINS THAT SPAN STATEMENTS
 * ---------------------------
 * The single most common shape in this repo is not one expression:
 *
 *     let q = sc.from("events").select(…).eq("visibility", "public");
 *     if (city) q = q.ilike("city", pat);
 *     const { data } = await q.limit(20);
 *
 * so walking down from the filter call finds an identifier, not a `.from()`.
 * A per-file pass therefore binds identifier -> table first, from every
 * `x = <chain containing .from("t")>`. An identifier bound to two different
 * tables anywhere in one file is dropped rather than guessed at — a wrong table
 * would produce a FALSE FAILURE, the one outcome this check must never have.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/** Filters whose SECOND argument is the column name. */
const VALUE_FILTERS = new Set(["eq", "neq", "in", "not", "is"]);

export interface LiteralSite {
  /** Path relative to artifacts/api-server. */
  file: string;
  /** 1-based line of the filter call. */
  line: number;
  table: string;
  column: string;
  /** The literal as it would reach Postgres. */
  literal: string;
  /** `eq` | `neq` | `in` | `not.eq` | `not.in` | `or.eq` | … */
  op: string;
}

export function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const entry of entries.sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Exported so the WRITE-side extractor shares this rule rather than growing a
 * second copy of it. Two implementations of "what is a Supabase chain, and on
 * what table" is how the two halves of a defect end up in two lists that cannot
 * see each other.
 */
export function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isAwaitExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

/**
 * Walk DOWN a chain expression looking for `.from("<literal>")`.
 * Returns the table, "<dynamic>" for a non-literal `.from()`, the identifier
 * name prefixed `id:` when the chain bottoms out on a bare identifier, or null.
 */
export function chainRoot(expr: ts.Expression): string | null {
  let cur = unwrap(expr);
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "from") {
          const arg = cur.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) return arg.text;
          return "<dynamic>";
        }
        cur = unwrap(callee.expression);
        continue;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = unwrap(cur.expression);
      continue;
    }
    if (ts.isIdentifier(cur)) return `id:${cur.text}`;
    return null;
  }
}

/** identifier name -> table, or null when the binding is ambiguous. */
export function bindIdentifiers(sf: ts.SourceFile): Map<string, string | null> {
  const bound = new Map<string, string | null>();
  const note = (name: string, table: string): void => {
    if (!bound.has(name)) { bound.set(name, table); return; }
    const prev = bound.get(name);
    if (prev !== table) bound.set(name, null); // ambiguous — refuse to guess
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const r = chainRoot(node.initializer);
      if (r && !r.startsWith("id:") && r !== "<dynamic>") note(node.name.text, r);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const r = chainRoot(node.right);
      if (r && !r.startsWith("id:") && r !== "<dynamic>") note(node.left.text, r);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return bound;
}

/** Split a PostgREST `in` argument — `("a","b")` or `(a,b)` — into values. */
export function parseInList(raw: string): string[] {
  const trimmed = raw.trim().replace(/^\(/, "").replace(/\)$/, "");
  if (trimmed.trim() === "") return [];
  return trimmed
    .split(",")
    .map((s) => s.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"))
    .filter((s) => s.length > 0);
}

/**
 * Parse a PostgREST `.or()` / `.and()` expression into (column, op, value)
 * triples. Nested `and(...)` / `or(...)` groups are descended into; anything
 * whose value is not a plain literal (an interpolated id, a pattern) is
 * skipped, since only literals can be judged.
 */
export function parseLogicalTree(expr: string): Array<{ column: string; op: string; value: string }> {
  const out: Array<{ column: string; op: string; value: string }> = [];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  for (const p of parts) {
    const t = p.trim();
    const group = /^(and|or)\((.*)\)$/is.exec(t);
    if (group) { out.push(...parseLogicalTree(group[2]!)); continue; }
    const m = /^([A-Za-z0-9_]+)\.(eq|neq)\.(.+)$/i.exec(t);
    if (!m) continue;
    out.push({ column: m[1]!, op: m[2]!.toLowerCase(), value: m[3]! });
  }
  return out;
}

/** True when a value came from a template hole rather than the source text. */
export function isInterpolated(node: ts.Expression): boolean {
  return ts.isTemplateExpression(node) || !ts.isStringLiteralLike(node);
}

export interface ExtractionResult {
  sites: LiteralSite[];
  filesScanned: number;
}

export function extractFilterLiterals(dirs: string[], apiRoot: string): ExtractionResult {
  const sites: LiteralSite[] = [];
  const files: string[] = [];
  for (const d of dirs) files.push(...listTsFiles(d));

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = relative(apiRoot, file);
    const bound = bindIdentifiers(sf);

    const tableFor = (expr: ts.Expression): string | null => {
      const r = chainRoot(expr);
      if (!r) return null;
      if (r === "<dynamic>") return null;
      if (r.startsWith("id:")) return bound.get(r.slice(3)) ?? null;
      return r;
    };
    const push = (node: ts.Node, table: string, column: string, literal: string, op: string): void => {
      sites.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        table, column, literal, op,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          const args = node.arguments;

          if ((VALUE_FILTERS.has(method) || method === "or") && args.length >= 1) {
            const table = tableFor(callee.expression);
            if (table) {
              if ((method === "eq" || method === "neq") && args.length >= 2) {
                const col = args[0]!;
                const val = args[1]!;
                if (ts.isStringLiteralLike(col) && ts.isStringLiteralLike(val) && !isInterpolated(val)) {
                  push(node, table, col.text, val.text, method);
                }
              } else if (method === "in" && args.length >= 2) {
                const col = args[0]!;
                const arr = unwrap(args[1]!);
                if (ts.isStringLiteralLike(col) && ts.isArrayLiteralExpression(arr)) {
                  for (const el of arr.elements) {
                    const e = unwrap(el);
                    if (ts.isStringLiteralLike(e) && !isInterpolated(e)) {
                      push(node, table, col.text, e.text, "in");
                    }
                  }
                }
              } else if (method === "not" && args.length >= 3) {
                const col = args[0]!;
                const op = args[1]!;
                const val = unwrap(args[2]!);
                if (
                  ts.isStringLiteralLike(col) &&
                  ts.isStringLiteralLike(op) &&
                  ts.isStringLiteralLike(val) &&
                  !isInterpolated(val)
                ) {
                  const o = op.text.toLowerCase();
                  if (o === "eq" || o === "neq") {
                    push(node, table, col.text, val.text, `not.${o}`);
                  } else if (o === "in") {
                    for (const v of parseInList(val.text)) {
                      push(node, table, col.text, v, "not.in");
                    }
                  }
                } else if (
                  ts.isStringLiteralLike(col) &&
                  ts.isStringLiteralLike(op) &&
                  op.text.toLowerCase() === "in" &&
                  ts.isStringLiteralLike(val)
                ) {
                  for (const v of parseInList(val.text)) {
                    push(node, table, col.text, v, "not.in");
                  }
                }
              } else if (method === "or" && args.length >= 1) {
                const arg = unwrap(args[0]!);
                // Only a plain string literal: a template carries runtime ids.
                if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
                  for (const t of parseLogicalTree(arg.text)) {
                    push(node, table, t.column, t.value, `or.${t.op}`);
                  }
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return { sites, filesScanned: files.length };
}
