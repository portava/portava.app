/**
 * Write-path column drift check
 *
 * Extracts every column written by `.insert()` / `.upsert()` / `.update()`
 * calls in src/routes and src/services (via the TypeScript AST — not regex,
 * so chained calls and multi-line payloads are handled correctly) and diffs
 * the referenced columns against the LIVE Supabase schema through the
 * Supabase Management API.
 *
 * This is the maintained version of the ad-hoc task-1925 wizard-write-path
 * audit (2026-07-20), which found three live drifts (posts filter columns,
 * rent_buddy_bookings.country_code, rent_buddy_policy_flags.updated_at)
 * using a greedy perl extraction that bled across chained calls.  Running
 * this script catches the whole failure class: any route that starts
 * writing a column before its migration is applied live.
 *
 * What counts as a write site:
 *   - a call chain that contains `.from("<string literal>")` followed
 *     (anywhere later in the chain) by `.insert(...)`, `.upsert(...)` or
 *     `.update(...)`
 *   - payload columns are collected from object-literal arguments, arrays
 *     of object literals, and (one level deep) same-file `const x = {...}`
 *     variables passed by identifier
 *
 * Deliberately skipped (counted and printed in verbose mode, never failed):
 *   - dynamic table names (`.from(tableVar)`)
 *   - payloads that cannot be statically resolved (function results,
 *     imported values, spreads — spread keys that ARE statically visible
 *     are still collected)
 *
 * Usage (from artifacts/api-server):
 *   pnpm run check:write-path-columns          # diff against live schema
 *   pnpm run check:write-path-columns -- --verbose
 *
 * Exit code 0 → every extracted column exists live (or is allowlisted)
 * Exit code 1 → at least one written column is missing from the live schema
 * Exit code 2 → environment / API error
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dir = dirname(fileURLToPath(import.meta.url));
const API_ROOT = resolve(__dir, "../..");
const SCAN_DIRS = [resolve(__dir, "../routes"), resolve(__dir, "../services")];
const VERBOSE = process.argv.includes("--verbose");

// ── Allowlist ─────────────────────────────────────────────────────────────────
//
// "table.column" pairs that are known-good despite not existing in the live
// public schema (or that are intentionally written pre-migration).  Keep this
// list SHORT and annotated — every entry is a hole in the check.
const ALLOWLIST = new Set<string>([
  // (none currently)
]);

// Tables that are not real live relations and should be skipped entirely
// (e.g. test doubles or tables owned by another system).
const SKIP_TABLES = new Set<string>([
  // (none currently)
]);

// ── Environment ───────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer SUPABASE_PROJECT_TOKEN (project-scoped, safe for CI) over the
// personal SUPABASE_ACCESS_TOKEN — mirrors auditMigrationsVsLive.ts.
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN (project-scoped, preferred for CI)\n" +
      "       or SUPABASE_ACCESS_TOKEN (personal access token).",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(
  query: string,
): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    throw new Error(`Management API ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T[];
}

// ── AST extraction ────────────────────────────────────────────────────────────

const WRITE_METHODS = new Set(["insert", "upsert", "update"]);

interface WriteSite {
  file: string; // relative to artifacts/api-server
  line: number; // 1-based
  table: string;
  method: string;
  columns: string[]; // statically resolved payload keys
  unresolved: boolean; // payload (or part of it) could not be resolved
}

interface SkippedSite {
  file: string;
  line: number;
  method: string;
  reason: string;
}

const sites: WriteSite[] = [];
const skipped: SkippedSite[] = [];

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

function scanFile(path: string): void {
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
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ── Main ──────────────────────────────────────────────────────────────────────

for (const dir of SCAN_DIRS) {
  for (const file of listTsFiles(dir)) scanFile(file);
}

const referencedTables = [
  ...new Set(sites.map((s) => s.table).filter((t) => !SKIP_TABLES.has(t))),
].sort();

console.log(
  `Extracted ${sites.length} statically-resolvable write sites across ` +
    `${referencedTables.length} tables (${skipped.length} sites skipped as unresolvable).`,
);

interface LiveCol {
  t: string;
  c: string;
}

console.log(`Fetching live schema (project ${projectRef}) …`);
let liveCols: LiveCol[];
let liveRels: { name: string }[];
try {
  [liveCols, liveRels] = await Promise.all([
    liveQuery<LiveCol>(
      `select table_name as t, column_name as c
       from information_schema.columns where table_schema = 'public'`,
    ),
    liveQuery<{ name: string }>(
      `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r','p','v','m')`,
    ),
  ]);
} catch (err) {
  console.error("ERROR: failed to fetch live schema:", err);
  process.exit(2);
}

const liveColumnSet = new Set(liveCols.map((r) => `${r.t}.${r.c}`));
const liveRelationSet = new Set(liveRels.map((r) => r.name));

// ── Diff ──────────────────────────────────────────────────────────────────────

interface Finding {
  table: string;
  column: string;
  where: string[]; // "file:line (method)"
}

const missingByKey = new Map<string, Finding>();
const missingTables = new Map<string, string[]>();

for (const site of sites) {
  if (SKIP_TABLES.has(site.table)) continue;
  const where = `${site.file}:${site.line} (${site.method})`;
  if (!liveRelationSet.has(site.table)) {
    const list = missingTables.get(site.table) ?? [];
    list.push(where);
    missingTables.set(site.table, list);
    continue;
  }
  for (const col of site.columns) {
    const key = `${site.table}.${col}`;
    if (liveColumnSet.has(key) || ALLOWLIST.has(key)) continue;
    const f = missingByKey.get(key) ?? {
      table: site.table,
      column: col,
      where: [],
    };
    f.where.push(where);
    missingByKey.set(key, f);
  }
}

if (VERBOSE && skipped.length > 0) {
  console.log("\nSkipped (unresolvable) write sites:");
  for (const s of skipped) {
    console.log(`  ${s.file}:${s.line} (${s.method}) — ${s.reason}`);
  }
}

let failed = false;

if (missingTables.size > 0) {
  failed = true;
  console.error("\n✗ Written TABLES missing from the live schema:");
  for (const [table, where] of [...missingTables].sort()) {
    console.error(`  ${table}`);
    for (const w of [...new Set(where)]) console.error(`      ${w}`);
  }
}

if (missingByKey.size > 0) {
  failed = true;
  console.error("\n✗ Written COLUMNS missing from the live schema:");
  for (const [key, f] of [...missingByKey].sort()) {
    console.error(`  ${key}`);
    for (const w of [...new Set(f.where)]) console.error(`      ${w}`);
  }
  console.error(
    "\nEach of these will fail the whole write (PostgREST rejects the " +
      "payload even when the value is null). Apply the migration that adds " +
      "the column via the Management API and record it in docs/migrations.md, " +
      "or add a justified ALLOWLIST entry in this script.",
  );
}

if (!failed) {
  console.log(
    `✓ All ${referencedTables.length} written tables and every extracted ` +
      "column exist in the live schema.",
  );
  process.exit(0);
}
process.exit(1);
