/**
 * Schema-reference extraction — the AST half of the write-path/read-path check.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * `checkWritePathColumns.ts` did two separable things in one file: it EXTRACTED
 * every `.from("t").select(...)` / `.insert|.upsert|.update({...})` column
 * reference from the TypeScript AST, and it DIFFED those references against the
 * LIVE database over the Supabase Management API.
 *
 * Only the second half needs a database. The first half is a pure function of
 * the repository. But the two were welded together by a module-level
 * `import "../lib/ciProdReadOnlyAuditGuard.mjs"`, which refuses to run without
 * live credentials — so the extraction could not be reused by anything that
 * does not have a database.
 *
 * That mattered, because the live lane is not reliably available: of 100
 * sampled live-DB runs, 64 were cancelled and 45% of commits received no
 * verdict at all. A check that can only run on a starved lane is a check that
 * mostly does not run — which is how `places.country` reached `main`.
 *
 * Extracting this module lets ONE extractor feed TWO checks with different
 * schema sources and different availability:
 *
 *   check:schema-references   (static)  extraction + CANONICAL schema
 *                                       (baseline + migrations, in-repo).
 *                                       No network, no credentials, never
 *                                       starved.
 *   check:write-path-columns  (live)    extraction + LIVE schema.
 *                                       Answers a different question: has the
 *                                       database drifted from what the repo
 *                                       declares?
 *
 * Together they imply "code matches live" without the code check needing the
 * database. Neither duplicates the other: static owns code-vs-declared-schema,
 * live owns declared-schema-vs-database.
 *
 * This file is deliberately free of imports that reach a network or read an
 * environment variable. Adding one would re-create the coupling it exists to
 * remove; `src/test/schemaReferenceStatic.test.ts` asserts that it stays clean.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

// ── AST extraction ────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(["insert", "upsert", "update"]);

export interface WriteSite {
  file: string; // relative to artifacts/api-server
  line: number; // 1-based
  table: string;
  method: string;
  columns: string[]; // statically resolved payload keys
  unresolved: boolean; // payload (or part of it) could not be resolved
}

export interface SkippedSite {
  file: string;
  line: number;
  method: string;
  reason: string;
}


function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walk DOWN a call chain expression (`a.from("t").eq(...).update({...})`
 * seen from the `.update` call) looking for a `.from("<literal>")` call.
 * Returns the table name, "<dynamic>" if `.from()` was called with a
 * non-literal, or null if no `.from()` appears in the chain.
 */
function findTableInChain(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  while (true) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "from") {
          const arg = cur.arguments[0];
          if (arg && ts.isStringLiteralLike(arg)) return arg.text;
          return "<dynamic>";
        }
        cur = callee.expression; // step past this chained call
        continue;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    return null;
  }
}

/** Collect statically visible keys from an object literal. Returns whether
 * anything non-static (spread of unresolvable value, computed key) was hit. */
function keysFromObjectLiteral(
  obj: ts.ObjectLiteralExpression,
  sf: ts.SourceFile,
  usePos: number,
  depth: number,
): { keys: string[]; unresolved: boolean } {
  const keys: string[] = [];
  let unresolved = false;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const name = prop.name;
      if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
        keys.push(name.text);
      } else {
        unresolved = true; // computed key
      }
    } else if (ts.isSpreadAssignment(prop)) {
      const inner = resolvePayload(prop.expression, sf, usePos, depth + 1);
      if (inner) {
        keys.push(...inner.keys);
        unresolved = unresolved || inner.unresolved;
      } else {
        unresolved = true;
      }
    } else {
      unresolved = true; // method/accessor — not a column write anyway
    }
  }
  return { keys, unresolved };
}

/**
 * Resolve a payload expression to its column keys.
 * Handles object literals, arrays of object literals, conditional
 * expressions (union of both branches), and — one level deep — identifiers
 * whose same-file `const` initializer is an object literal.
 */
function resolvePayload(
  expr: ts.Expression,
  sf: ts.SourceFile,
  usePos: number,
  depth = 0,
): { keys: string[]; unresolved: boolean } | null {
  if (depth > 3) return null;
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    (ts.isSatisfiesExpression?.(expr) ?? false)
  ) {
    return resolvePayload(
      (expr as ts.ParenthesizedExpression).expression,
      sf,
      usePos,
      depth,
    );
  }
  if (ts.isObjectLiteralExpression(expr)) {
    return keysFromObjectLiteral(expr, sf, usePos, depth);
  }
  if (ts.isArrayLiteralExpression(expr)) {
    const keys: string[] = [];
    let unresolved = false;
    for (const el of expr.elements) {
      const inner = resolvePayload(el, sf, usePos, depth + 1);
      if (inner) {
        keys.push(...inner.keys);
        unresolved = unresolved || inner.unresolved;
      } else {
        unresolved = true;
      }
    }
    return { keys, unresolved };
  }
  if (ts.isConditionalExpression(expr)) {
    const a = resolvePayload(expr.whenTrue, sf, usePos, depth + 1);
    const b = resolvePayload(expr.whenFalse, sf, usePos, depth + 1);
    if (!a && !b) return null;
    return {
      keys: [...(a?.keys ?? []), ...(b?.keys ?? [])],
      unresolved: !a || !b || a.unresolved || b.unresolved,
    };
  }
  if (ts.isIdentifier(expr)) {
    // Same-file const/let with a statically resolvable initializer.
    const init = findInitializer(expr.text, sf, usePos);
    if (init) return resolvePayload(init, sf, usePos, depth + 1);
    return null;
  }
  return null;
}

// Per-file map of variable name → declarations (position + initializer),
// so identifier payloads resolve against the NEAREST declaration BEFORE the
// call site (files legally reuse names like `payload` in separate handlers).
const initializerCache = new Map<
  ts.SourceFile,
  Map<string, { pos: number; init: ts.Expression }[]>
>();

function findInitializer(
  name: string,
  sf: ts.SourceFile,
  usePos: number,
): ts.Expression | undefined {
  let map = initializerCache.get(sf);
  if (!map) {
    map = new Map();
    const visit = (node: ts.Node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const list = map!.get(node.name.text) ?? [];
        list.push({ pos: node.getStart(sf), init: node.initializer });
        map!.set(node.name.text, list);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    initializerCache.set(sf, map);
  }
  const decls = map.get(name);
  if (!decls) return undefined;
  let best: { pos: number; init: ts.Expression } | undefined;
  for (const d of decls) {
    if (d.pos < usePos && (!best || d.pos > best.pos)) best = d;
  }
  // Fall back to the sole declaration when the variable is declared after
  // the call site textually (e.g. hoisted helpers) — only safe when unique.
  if (!best && decls.length === 1) best = decls[0];
  return best?.init;
}

/**
 * Resolve a `.select(expr)` argument to its string text.
 *
 * Handles:
 *  - string literals and no-substitution template literals → fully resolved
 *  - identifiers whose same-file const initializer is a resolvable string
 *  - binary `+` expressions — concatenates both sides; marks unresolved if
 *    either side could not be statically resolved (e.g. an `await` call)
 *  - template expressions with `${}` substitutions — extracts the literal
 *    head/span text and marks unresolved (substitutions are unknowns)
 *
 * Returns null when the expression is fundamentally unresolvable (not a
 * string at all — e.g. a function call result stored in a variable whose
 * initializer is not a string literal).
 */
function resolveSelectString(
  expr: ts.Expression,
  sf: ts.SourceFile,
  usePos: number,
  depth = 0,
): { text: string; unresolved: boolean } | null {
  if (depth > 6) return null;

  // Strip wrapping parens / type assertions
  if (
    ts.isParenthesizedExpression(expr) ||
    ts.isAsExpression(expr) ||
    ts.isNonNullExpression(expr) ||
    (ts.isSatisfiesExpression?.(expr) ?? false)
  ) {
    return resolveSelectString(
      (expr as ts.ParenthesizedExpression).expression,
      sf,
      usePos,
      depth,
    );
  }

  // Plain string literal or no-substitution template — fully static
  if (ts.isStringLiteralLike(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { text: expr.text, unresolved: false };
  }

  // Identifier → try to resolve to its same-file const initializer
  if (ts.isIdentifier(expr)) {
    const init = findInitializer(expr.text, sf, usePos);
    if (init) return resolveSelectString(init, sf, usePos, depth + 1);
    return null;
  }

  // Binary `+` — recurse on both sides, concatenate whatever we can resolve
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = resolveSelectString(expr.left, sf, usePos, depth + 1);
    const right = resolveSelectString(expr.right, sf, usePos, depth + 1);
    if (!left && !right) return null;
    return {
      text: (left?.text ?? "") + (right?.text ?? ""),
      unresolved: !left || !right || left.unresolved || right.unresolved,
    };
  }

  // Template expression with ${}  substitutions — extract literal spans
  if (ts.isTemplateExpression(expr)) {
    let text = expr.head.text;
    let unresolved = false;
    for (const span of expr.templateSpans) {
      const sub = resolveSelectString(span.expression, sf, usePos, depth + 1);
      if (sub) {
        text += sub.text;
        unresolved = unresolved || sub.unresolved;
      } else {
        // Unknown substitution — leave a placeholder that the embedded-resource
        // parser will skip (it contains a paren, guaranteeing the "(" skip rule)
        text += "(__unresolved__)";
        unresolved = true;
      }
      text += span.literal.text;
    }
    return { text, unresolved };
  }

  return null;
}

/**
 * Parse a PostgREST select list into base column names.
 *
 * Splits on TOP-LEVEL commas (respecting parentheses so embedded resources
 * stay intact), then per item:
 *   - items containing `(` are embedded resources (`rel(...)`, `rel!hint(...)`)
 *     → skipped (their columns belong to another table)
 *   - `*` and bare `count` → skipped
 *   - `alias:col` → col;  `col::cast` → col;  `col->x` / `col->>x` → col
 *   - quoted identifiers keep their inner text
 */
function parseSelectList(list: string): { columns: string[]; skippedEmbedded: number } {
  const items: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  items.push(cur);

  const columns: string[] = [];
  let skippedEmbedded = 0;
  for (const raw of items) {
    const item = raw.replace(/\s+/g, "");
    if (item === "") continue;
    if (item.includes("(")) {
      skippedEmbedded++;
      continue; // embedded resource — another table's columns
    }
    // alias:column — keep the part AFTER the colon (but not `::` casts)
    let col = item;
    const aliasIdx = col.indexOf(":");
    if (aliasIdx !== -1 && col[aliasIdx + 1] !== ":") {
      col = col.slice(aliasIdx + 1);
    }
    // strip cast and JSON path operators
    col = col.split("::")[0].split("->")[0];
    // strip surrounding quotes on quoted identifiers
    col = col.replace(/^"(.*)"$/, "$1");
    if (col === "" || col === "*" || col === "count") continue;
    columns.push(col);
  }
  return { columns, skippedEmbedded };
}

function scanFile(
  path: string,
  API_ROOT: string,
  sites: WriteSite[],
  skipped: SkippedSite[],
): void {
  const text = readFileSync(path, "utf8");
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const rel = relative(API_ROOT, path);

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      WRITE_METHODS.has(node.expression.name.text)
    ) {
      const method = node.expression.name.text;
      const table = findTableInChain(node.expression.expression);
      const line =
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (table === null) {
        // Not a supabase chain (e.g. Map#insert) — ignore silently.
      } else if (table === "<dynamic>") {
        skipped.push({ file: rel, line, method, reason: "dynamic table name" });
      } else {
        const arg = node.arguments[0];
        const payload = arg ? resolvePayload(arg, sf, node.getStart(sf)) : null;
        if (!payload) {
          skipped.push({
            file: rel,
            line,
            method,
            reason: "payload not statically resolvable",
          });
        } else {
          sites.push({
            file: rel,
            line,
            table,
            method,
            columns: [...new Set(payload.keys)],
            unresolved: payload.unresolved,
          });
        }
      }
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "select"
    ) {
      const table = findTableInChain(node.expression.expression);
      const line =
        sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      if (table === null) {
        // Not a supabase chain — ignore silently.
      } else if (table === "<dynamic>") {
        skipped.push({ file: rel, line, method: "select", reason: "dynamic table name" });
      } else {
        const arg = node.arguments[0];
        if (arg === undefined) {
          // `.select()` → `*` — nothing to check.
        } else {
          const resolved = resolveSelectString(arg, sf, node.getStart(sf));
          if (resolved) {
            const { columns } = parseSelectList(resolved.text);
            if (columns.length > 0 || !resolved.unresolved) {
              sites.push({
                file: rel,
                line,
                table,
                method: "select",
                columns: [...new Set(columns)],
                unresolved: resolved.unresolved,
              });
            } else {
              // Resolved to something but extracted 0 columns (e.g. pure `*`
              // or only embedded resources) — no columns to audit; skip.
            }
          } else {
            skipped.push({
              file: rel,
              line,
              method: "select",
              reason: "select list not statically resolvable",
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

/** Everything the extractor found in one pass over `scanDirs`. */
export interface ExtractionResult {
  /** Statically-resolved read/write sites, each with the columns it names. */
  sites: WriteSite[];
  /** Sites whose table or payload could not be statically resolved. */
  skipped: SkippedSite[];
}

/**
 * Extract every statically-resolvable schema reference under `scanDirs`.
 *
 * Pure with respect to the network and the environment: it reads files and
 * returns data. `apiRoot` is only used to make reported paths relative.
 */
export function extractSchemaReferences(
  apiRoot: string,
  scanDirs: string[],
): ExtractionResult {
  const sites: WriteSite[] = [];
  const skipped: SkippedSite[] = [];
  for (const dir of scanDirs) {
    for (const file of listTsFiles(dir)) scanFile(file, apiRoot, sites, skipped);
  }
  return { sites, skipped };
}

export { listTsFiles };
