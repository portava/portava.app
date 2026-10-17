/**
 * schemaColumnScan — every table, column and stored function production code
 * names through PostgREST, read statically and graded against PRODUCTION.
 *
 * WHY (2026-10-17, wave 5). The embed scan (`selectEmbedScan.ts`) found eight
 * reads that production refused because no key backed a join. The next class is
 * a NAME production does not have: a select-list column, a filter column, a
 * write key, a table or an `.rpc()` function. PostgREST fails the WHOLE
 * statement on any of them (42703 / PGRST204 for a column, 42P01 / PGRST205 for
 * a table, PGRST202 for a function), so one dead name in a ten-column read
 * empties the read.
 *
 * `check:schema-references` already asks part of this question, and this does
 * not replace it: it checks base-table select columns and write keys against
 * the CANONICAL schema (the baseline plus EVERY migration), from a literal
 * `.from("t")` in the same file. It cannot see a column that only an UNAPPLIED
 * migration declares (canonical says it exists; production says 42703), a
 * filter column, an embedded table's columns, a table name, an `.rpc()` name, or
 * anything resolved across files. This scan grades all of those against what
 * PRODUCTION has.
 *
 * WHAT "PRODUCTION" IS HERE. The current frozen capture of production's public
 * schema (`lib/capability/snapshots/current.ts` names it): information_schema
 * columns for every table AND view, and every public function, verified by
 * digests production computed itself. Plus the DDL of any migration
 * `production-applied-migrations.json` records AFTER that capture's watermark
 * (none, at 2026-10-17). The 2026-08-19 baseline and the migration chain are
 * read for PROVENANCE only: they say where a name production lacks was declared,
 * which is what decides the class:
 *   A        declared nowhere (no migration, not the baseline): fails everywhere.
 *   dropped  declared only by the baseline (or a migration production has) and
 *            absent from production: it was dropped or renamed; fails in production.
 *   B        declared only by migrations production does not have: fails in
 *            production unless the path is gated (a schema probe, a flag seeded
 *            FALSE, a capability that fails closed). The gate is a judgement the
 *            test's ledger records per site; it is not inferred here.
 *
 * WHAT IT RESOLVES. Select lists: every site `selectEmbedScan` resolves (its
 * constants, imports, ternaries, templates, helper hops), base columns and the
 * columns of every embed (on the table the embed resolves to). Filters (`eq`,
 * `neq`, `gt`…, `in`, `is`, `like`…, `contains`…, `not`, `filter`, `match`,
 * `or`, `order`): the column argument through the same string resolver, an
 * `.or()` template with dynamic VALUES parsed for its static column names, a
 * dotted `embed.col` resolved through the chain's select. Writes (`insert`,
 * `upsert`, `update`): every key the body statically spells, through object
 * literals, spreads, arrays, ternaries, `.map(cb)` and same-file or imported row
 * builders (a partly dynamic body still has its static keys checked), plus
 * `onConflict`. Functions: `.rpc(name)`. Tables: every `.from(x)` reached.
 * Anything else is UNRESOLVED, reported with its reason, never guessed.
 *
 * WHAT IT DOES NOT KNOW. RPC ARGUMENT names (the capture records function names,
 * not signatures); a computed column or relationship (a function taking the
 * row) is accepted when production has a function of that name; a builder
 * reached only through a parameter no call site binds is not seen at all.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  API_ROOT, SRC, NO_ENV, scanSelectEmbeds, productionSources, resolveStrings, initializerIn, unwrap,
  functionNamed, returnExpressions, helperCallBindings, propName, type Env, type EmbedScan,
} from "./selectEmbedScan.js";
import { resolveSelectEmbeds, type ResolvedEmbed } from "./migrationForeignKeys.js";
import { splitStatements, stripSqlComments, parseCreateTableColumns } from "../../scripts/lib/canonicalSchema.js";
import { PRODUCTION_SNAPSHOT_FILENAME } from "../../lib/capability/snapshots/current.js";
import { FROZEN_ROOTS, ALLOWLISTED_ROOTS, FROZEN_LOOSE_FILES } from "../../scripts/frozenMigrationRoots.js";

// ── References ───────────────────────────────────────────────────────────────

export type RefKind = "table" | "select" | "embed" | "filter" | "write" | "conflict" | "rpc";

export interface SchemaRef {
  /** Relative to artifacts/api-server. */
  file: string;
  line: number;
  /** The helper call the site was resolved through, when it was. */
  via: string | null;
  kind: RefKind;
  /** `select`, `eq`, `or`, `insert`, `from`, `rpc`, … */
  method: string;
  /** The table the name is a column of (the embed's target for `embed`); null for `rpc`. */
  table: string | null;
  /** The column, the table (kind `table`) or the function (kind `rpc`). */
  name: string;
}

export interface UnresolvedRef {
  file: string;
  line: number;
  via: string | null;
  kind: "select" | "filter" | "write" | "rpc" | "table";
  method: string;
  reason: string;
  text: string;
}

export interface SchemaRefScan {
  refs: SchemaRef[];
  unresolved: UnresolvedRef[];
  /** Distinct call sites (file:line) read, per kind (the coverage figure). */
  sites: Record<"select" | "filter" | "write" | "rpc", number>;
}

const FILTER_FIRST_ARG = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in", "isDistinct",
  "contains", "containedBy", "overlaps", "textSearch", "rangeGt", "rangeGte", "rangeLt", "rangeLte", "rangeAdjacent",
  "likeAllOf", "likeAnyOf", "ilikeAllOf", "ilikeAnyOf", "not", "filter", "order",
]);
const WRITE_METHODS = new Set(["insert", "upsert", "update"]);
const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);
/** Bound on the helper hops a filter, a write body or an rpc name is followed through (the embed scan's bound). */
const MAX_CALL_HOPS = 1;

/** A column as PostgREST reads it: casts, JSON paths and quotes off. Null for `*` and aggregates. */
export function bareColumn(item: string): string | null {
  let c = item.trim();
  if (!c || c === "*") return null;
  c = c.split("::")[0]!.split("->")[0]!.trim();
  c = c.replace(/^"(.*)"$/, "$1");
  // `amount.sum()` / `id.count()` — an aggregate over a column.
  const agg = /^([a-z_][a-z0-9_]*)\.(?:count|sum|avg|min|max)\(\)$/i.exec(c);
  if (agg) c = agg[1]!;
  if (!c || c === "*" || AGGREGATES.has(c.toLowerCase()) || /\(\)$/.test(c)) return null;
  return c;
}

function topLevelItems(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = "";
  for (const ch of list) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === "(") depth++;
    if (!quoted && ch === ")") depth--;
    if (!quoted && ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Every (table, column) a select list names: base columns on `table`, each embed's on the table it resolves to. */
export function selectListColumns(table: string, list: string): Array<{ table: string; column: string; embed: boolean }> {
  const out: Array<{ table: string; column: string; embed: boolean }> = [];
  const walk = (t: string, sel: string, nodes: ResolvedEmbed[], embed: boolean) => {
    let next = 0;
    for (const item of topLevelItems(sel)) {
      const open = item.indexOf("(");
      if (open >= 0 && !/^[a-z_][a-z0-9_]*\.(?:count|sum|avg|min|max)\(\)/i.test(item.replace(/^.*:/, "").trim())) {
        const head = item.slice(0, open).replace(/^\.\.\./, "").split(":").pop()!.split("!")[0]!.trim().toLowerCase();
        if (AGGREGATES.has(head)) continue;
        const node = nodes[next++];
        if (node && node.relation === head && !node.refusal) walk(node.target, node.select, node.children, true);
        continue;
      }
      const colon = item.indexOf(":");
      const raw = colon >= 0 && item[colon + 1] !== ":" ? item.slice(colon + 1) : item;
      const col = bareColumn(raw);
      if (col) out.push({ table: t, column: col, embed });
    }
  };
  walk(table.toLowerCase(), list, resolveSelectEmbeds(table, list), false);
  return out;
}

const SENTINEL = "\u0000";

/**
 * The column names a PostgREST logic-tree filter (`.or("a.eq.1,and(b.is.null,c.gt.2)")`)
 * names, from a string whose VALUES may be the sentinel (a dynamic `${…}`).
 * `null` entries mark a condition whose column itself is dynamic.
 */
export function logicTreeColumns(expr: string): Array<string | null> {
  const out: Array<string | null> = [];
  for (const raw of topLevelItems(expr)) {
    const item = raw.replace(/^not\./, "");
    const group = /^(and|or)\((.*)\)$/s.exec(item);
    if (group) { out.push(...logicTreeColumns(group[2]!)); continue; }
    const dot = item.indexOf(".");
    const col = dot >= 0 ? item.slice(0, dot) : item;
    if (col.includes(SENTINEL) || dot < 0) { out.push(null); continue; }
    out.push(bareColumn(col));
  }
  return out;
}

// ── The chain a call runs on ─────────────────────────────────────────────────

interface Chain {
  /** Every spelling of the table, or null when the `.from` argument is not static. */
  tables: string[] | null;
  /** The chain's `.select(` argument, when it has one (for a dotted embed filter). */
  select: { arg: ts.Expression; sf: ts.SourceFile; env: Env } | null;
}

/**
 * Walk DOWN a receiver through builder CALLS only (`.from(x).select().eq()…`)
 * and held builders, to its `.from(x)`. A bare property access (`res.data`)
 * before the `.from` means a RESULT, not a builder: undefined. Undefined, too,
 * for no `.from`, a Storage bucket, or `Array.from`.
 */
function chainOf(expr: ts.Expression, sf: ts.SourceFile, env: Env, depth = 0): Chain | undefined {
  let cur: ts.Expression = expr;
  let select: Chain["select"] = null;
  let curSf = sf;
  let curEnv = env;
  for (let guard = 0; guard < 200; guard++) {
    cur = unwrap(cur);
    if (ts.isAwaitExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (!ts.isPropertyAccessExpression(callee)) return undefined;
      const name = callee.name.text;
      if (name === "from") {
        const recv = unwrap(callee.expression);
        if (ts.isIdentifier(recv) && /^(Array|Buffer|Uint8Array|Object|Set|Map|String)$/.test(recv.text)) return undefined;
        if (ts.isPropertyAccessExpression(recv) && recv.name.text === "storage") return undefined;
        const arg = cur.arguments[0];
        return { tables: arg ? resolveStrings(arg, curSf, cur.getStart(curSf), 0, curEnv) : null, select };
      }
      if (name === "select" && !select && cur.arguments[0]) select = { arg: cur.arguments[0], sf: curSf, env: curEnv };
      cur = callee.expression;
      continue;
    }
    if (ts.isIdentifier(cur) && depth < 4) {
      const bound = curEnv.get(cur.text);
      if (bound) {
        const hit = chainOf(bound.expr, bound.sf, bound.env, depth + 1);
        return hit ? { tables: hit.tables, select: select ?? hit.select } : undefined;
      }
      const hit = initializerIn(curSf, cur.text, cur.getStart(curSf));
      if (!hit || hit.sf !== curSf) return undefined;
      const inner = chainOf(hit.init, curSf, NO_ENV, depth + 1);
      return inner ? { tables: inner.tables, select: select ?? inner.select } : undefined;
    }
    return undefined;
  }
  return undefined;
}

// ── Write bodies ─────────────────────────────────────────────────────────────

interface Keys { keys: Set<string>; complete: boolean }

/** Every key a write body statically spells (union over branches and rows), or null when none of it is static. */
function payloadKeys(expr: ts.Expression, sf: ts.SourceFile, usePos: number, env: Env, depth = 0): Keys | null {
  if (depth > 10) return null;
  const e = unwrap(expr);
  const again = (x: ts.Expression, at = usePos) => payloadKeys(x, sf, at, env, depth + 1);
  if (ts.isAwaitExpression(e)) return again(e.expression);
  if (ts.isObjectLiteralExpression(e)) {
    const out: Keys = { keys: new Set(), complete: true };
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
        const n = propName(p.name);
        if (n !== null) out.keys.add(n); else out.complete = false;
      } else if (ts.isSpreadAssignment(p)) {
        const inner = again(p.expression);
        if (inner) { for (const k of inner.keys) out.keys.add(k); out.complete &&= inner.complete; } else out.complete = false;
      } else {
        out.complete = false;
      }
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(e) || ts.isConditionalExpression(e) || (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken))) {
    const parts = ts.isArrayLiteralExpression(e)
      ? e.elements.map((el) => (ts.isSpreadElement(el) ? el.expression : el))
      : ts.isConditionalExpression(e) ? [e.whenTrue, e.whenFalse] : [e.left, e.right];
    const out: Keys = { keys: new Set(), complete: true };
    let any = false;
    for (const part of parts) {
      const inner = again(part);
      if (inner) { any = true; for (const k of inner.keys) out.keys.add(k); out.complete &&= inner.complete; } else out.complete = false;
    }
    return any ? out : null;
  }
  if (ts.isIdentifier(e)) {
    const bound = env.get(e.text);
    if (bound) return payloadKeys(bound.expr, bound.sf, bound.usePos, bound.env, depth + 1);
    const hit = initializerIn(sf, e.text, usePos);
    if (!hit) return null;
    return payloadKeys(hit.init, hit.sf, hit.sf === sf ? hit.init.getStart(sf) : Number.MAX_SAFE_INTEGER, NO_ENV, depth + 1);
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrap(e.expression);
    // rows.map((r) => ({ … })) / flatMap — the row shape is the callback's return.
    if (ts.isPropertyAccessExpression(callee) && (callee.name.text === "map" || callee.name.text === "flatMap") && e.arguments[0]) {
      const cb = unwrap(e.arguments[0]);
      if (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) return returnsKeys(cb, sf, env, depth);
      if (ts.isIdentifier(cb)) {
        const fn = functionNamed(sf, cb.text);
        return fn ? returnsKeys(fn.decl, fn.sf, NO_ENV, depth) : null;
      }
      return null;
    }
    // xs.filter(…) / xs.slice(…) / xs.concat(…) keep the row shape of xs.
    if (ts.isPropertyAccessExpression(callee) && ["filter", "slice", "concat"].includes(callee.name.text)) return again(callee.expression);
    if (ts.isIdentifier(callee)) {
      const fn = functionNamed(sf, callee.text);
      if (!fn) return null;
      const bindings = new Map(env);
      fn.decl.parameters.forEach((p, i) => {
        const arg = e.arguments[i];
        if (ts.isIdentifier(p.name) && arg) bindings.set(p.name.text, { expr: arg, sf, usePos, env });
      });
      return returnsKeys(fn.decl, fn.sf, bindings, depth);
    }
  }
  return null;
}

function returnsKeys(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, sf: ts.SourceFile, env: Env, depth: number): Keys | null {
  const out: Keys = { keys: new Set(), complete: true };
  let any = false;
  for (const r of returnExpressions(fn)) {
    const inner = r ? payloadKeys(r, sf, r.getStart(sf), env, depth + 1) : null;
    if (inner) { any = true; for (const k of inner.keys) out.keys.add(k); out.complete &&= inner.complete; } else out.complete = false;
  }
  return any ? out : null;
}

// ── The scan ─────────────────────────────────────────────────────────────────

const scanCache = new Map<string, SchemaRefScan>();

/**
 * Every schema name production code under `root` issues through PostgREST
 * (default artifacts/api-server/src; tests excluded exactly as the embed scan
 * excludes them). Select lists come from the embed scan, so both scans read
 * the same 5,000-odd selects the same way.
 */
export function scanSchemaReferences(root: string = SRC, embedScan: EmbedScan = scanSelectEmbeds(root)): SchemaRefScan {
  const hit = scanCache.get(root);
  if (hit) return hit;
  const refs: SchemaRef[] = [];
  const unresolved: UnresolvedRef[] = [];
  const siteSets = { filter: new Set<string>(), write: new Set<string>(), rpc: new Set<string>() };
  const files = productionSources(root);
  const rel = (sf: ts.SourceFile) => path.relative(root === SRC ? API_ROOT : root, sf.fileName).split(path.sep).join("/");
  const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const seen = new Set<string>();
  const push = (r: SchemaRef) => {
    const k = `${r.file}:${r.line}:${r.via ?? ""}:${r.kind}:${r.table}:${r.name}`;
    if (!seen.has(k)) { seen.add(k); refs.push(r); }
  };
  const reported = new Set<string>();
  const report = (u: UnresolvedRef) => {
    const k = `${u.file}:${u.line}:${u.via ?? ""}:${u.kind}:${u.reason}`;
    if (!reported.has(k)) { reported.add(k); unresolved.push(u); }
  };

  // Selects: what the embed scan resolved, every spelling of every list.
  for (const s of embedScan.selectSites) {
    push({ file: s.file, line: s.line, via: s.via, kind: "table", method: "from", table: s.table, name: s.table });
    for (const v of s.variants) {
      for (const c of selectListColumns(s.table, v)) {
        push({ file: s.file, line: s.line, via: s.via, kind: c.embed ? "embed" : "select", method: "select", table: c.table, name: c.column });
        if (c.embed) push({ file: s.file, line: s.line, via: s.via, kind: "table", method: "select", table: c.table, name: c.table });
      }
    }
  }
  for (const u of embedScan.unresolved) {
    if (u.reason === "select list not statically resolvable") report({ file: u.file, line: u.line, via: u.via, kind: "select", method: "select", reason: u.reason, text: u.text });
  }

  /** The embed a dotted filter (`profiles.handle`) names, through the chain's select: its target table. */
  const embedTarget = (chain: Chain, table: string, alias: string): string | null => {
    if (!chain.select) return null;
    const lists = resolveStrings(chain.select.arg, chain.select.sf, chain.select.arg.getStart(chain.select.sf), 0, chain.select.env);
    if (!lists) return null;
    const targets = new Set<string>();
    for (const l of lists) {
      for (const n of resolveSelectEmbeds(table, l)) if (n.outputKey === alias || n.relation === alias) targets.add(n.target);
    }
    return targets.size === 1 ? [...targets][0]! : null;
  };

  function visit(sf: ts.SourceFile, node: ts.CallExpression, env: Env, via: string | null, hops: number) {
    const callee = node.expression as ts.PropertyAccessExpression;
    const method = callee.name.text;
    const recv = callee.expression;
    const site = { file: rel(sf), line: lineOf(sf, node), via };
    const usePos = node.getStart(sf);
    const kind = method === "rpc" ? "rpc" : WRITE_METHODS.has(method) ? "write" : "filter";
    const hop = (parts: ts.Node[]): boolean => {
      if (hops >= MAX_CALL_HOPS) return false;
      const calls = helperCallBindings(sf, node, parts, env, files);
      if (!calls) return false;
      for (const c of calls) visit(sf, node, c.env, `${c.helper}() called at ${rel(c.sf)}:${lineOf(c.sf, c.call)}`, hops + 1);
      return true;
    };
    const text = (n?: ts.Node) => (n ? n.getText(sf).replace(/\s+/g, " ").slice(0, 160) : "");

    if (method === "rpc") {
      const arg = node.arguments[0];
      if (!arg) return;
      const names = resolveStrings(arg, sf, usePos, 0, env);
      if (!names) {
        if (hop([arg])) return;
        report({ ...site, kind: "rpc", method, reason: "function name not statically resolvable", text: text(arg) });
        return;
      }
      siteSets.rpc.add(`${site.file}:${site.line}`);
      for (const n of names) push({ ...site, kind: "rpc", method, table: null, name: n });
      return;
    }

    const chain = chainOf(recv, sf, env);
    if (!chain) return; // not a PostgREST builder this scan can see
    const args = node.arguments;
    if (kind === "filter") {
      const first = args[0];
      if (!first) return;
      const f = unwrap(first);
      // Array#filter(cb), String#match(re): not PostgREST.
      if (ts.isArrowFunction(f) || ts.isFunctionExpression(f) || ts.isRegularExpressionLiteral(f)) return;
    }
    if (chain.tables === null) {
      if (hop([recv])) return;
      report({ ...site, kind: "table", method, reason: "table not statically resolvable", text: text(recv).slice(-160) });
      return;
    }
    const tables = chain.tables;

    if (kind === "write") {
      siteSets.write.add(`${site.file}:${site.line}`);
      const body = args[0];
      const keys = body ? payloadKeys(body, sf, usePos, env) : null;
      if (!keys || (!keys.complete && keys.keys.size === 0)) {
        if (body && hop([body])) return;
        report({ ...site, kind: "write", method, reason: "write body not statically resolvable", text: text(body) });
      }
      for (const t of tables) {
        push({ ...site, kind: "table", method, table: t, name: t });
        for (const k of keys?.keys ?? []) push({ ...site, kind: "write", method, table: t, name: k });
      }
      // upsert(rows, { onConflict: "a,b" })
      const opts = args[1] ? unwrap(args[1]) : null;
      if (method === "upsert" && opts && ts.isObjectLiteralExpression(opts)) {
        for (const p of opts.properties) {
          if (!ts.isPropertyAssignment(p) || propName(p.name) !== "onConflict") continue;
          const v = resolveStrings(p.initializer, sf, usePos, 0, env);
          if (!v) { report({ ...site, kind: "write", method, reason: "onConflict not statically resolvable", text: text(p.initializer) }); continue; }
          for (const t of tables) for (const spec of v) for (const c of spec.split(",")) {
            const col = bareColumn(c);
            if (col) push({ ...site, kind: "conflict", method, table: t, name: col });
          }
        }
      }
      return;
    }

    // Filters.
    siteSets.filter.add(`${site.file}:${site.line}`);
    for (const t of tables) push({ ...site, kind: "table", method, table: t, name: t });
    const opts = args[method === "order" || method === "or" ? 1 : args.length - 1];
    const referenced = (() => {
      const o = opts ? unwrap(opts) : null;
      if (!o || !ts.isObjectLiteralExpression(o)) return null;
      for (const p of o.properties) {
        const n = ts.isPropertyAssignment(p) ? propName(p.name) : null;
        if (n === "referencedTable" || n === "foreignTable") return ts.isPropertyAssignment(p) ? resolveStrings(p.initializer, sf, usePos, 0, env) ?? [] : [];
      }
      return null;
    })();
    const columnsOn = (t: string, raw: string): { table: string; column: string } | "unresolved" | null => {
      if (referenced) {
        // `.order("x", { referencedTable: "embed" })`: a column of the EMBED.
        const alias = referenced.length === 1 ? referenced[0]! : null;
        const target = alias ? embedTarget(chain, t, alias) : null;
        const col = bareColumn(raw);
        return target && col ? { table: target, column: col } : "unresolved";
      }
      const jsonFree = raw.split("->")[0]!;
      if (jsonFree.includes(".")) {
        const alias = jsonFree.slice(0, jsonFree.indexOf("."));
        const target = embedTarget(chain, t, alias);
        const col = bareColumn(raw.slice(raw.indexOf(".") + 1));
        return target && col ? { table: target, column: col } : "unresolved";
      }
      const col = bareColumn(raw);
      return col ? { table: t, column: col } : null;
    };

    if (method === "match") {
      const keys = args[0] ? payloadKeys(args[0], sf, usePos, env) : null;
      if (!keys) { if (args[0] && hop([args[0]])) return; report({ ...site, kind: "filter", method, reason: "match object not statically resolvable", text: text(args[0]) }); return; }
      for (const t of tables) for (const k of keys.keys) {
        const c = columnsOn(t, k);
        if (c && c !== "unresolved") push({ ...site, kind: "filter", method, table: c.table, name: c.column });
      }
      return;
    }

    if (method === "or") {
      const arg = args[0]!;
      const strings = resolveStrings(arg, sf, usePos, 0, env) ?? skeleton(arg, sf, usePos, env);
      if (!strings) { if (hop([arg])) return; report({ ...site, kind: "filter", method, reason: "or() filter not statically resolvable", text: text(arg) }); return; }
      let dynamic = false;
      for (const t of tables) for (const s of strings) for (const raw of logicTreeColumns(s)) {
        if (raw === null) { dynamic = true; continue; }
        const c = columnsOn(t, raw);
        if (c === "unresolved") { dynamic = true; continue; }
        if (c) push({ ...site, kind: "filter", method, table: c.table, name: c.column });
      }
      if (dynamic) report({ ...site, kind: "filter", method, reason: "an or() condition's column is not statically resolvable", text: text(arg) });
      return;
    }

    const arg = args[0]!;
    const cols = resolveStrings(arg, sf, usePos, 0, env);
    if (!cols) {
      if (hop([arg])) return;
      report({ ...site, kind: "filter", method, reason: "filter column not statically resolvable", text: text(arg) });
      return;
    }
    for (const t of tables) for (const raw of cols) {
      const c = columnsOn(t, raw);
      if (c === "unresolved") { report({ ...site, kind: "filter", method, reason: "embedded-resource filter not resolvable through the chain's select", text: text(arg) }); continue; }
      if (c) push({ ...site, kind: "filter", method, table: c.table, name: c.column });
    }
  }

  for (const sf of files) {
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const m = node.expression.name.text;
        if (m === "rpc" || m === "match" || m === "or" || WRITE_METHODS.has(m) || FILTER_FIRST_ARG.has(m)) visit(sf, node, NO_ENV, null, 0);
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  const sites = {
    select: new Set(embedScan.selectSites.map((x) => `${x.file}:${x.line}`)).size,
    filter: siteSets.filter.size, write: siteSets.write.size, rpc: siteSets.rpc.size,
  };
  const result = { refs, unresolved, sites };
  scanCache.set(root, result);
  return result;
}

/**
 * A template whose substitutions are VALUES (`user_a.eq.${id}`): its static
 * text with each unresolvable substitution replaced by the sentinel, so the
 * column names can still be read. Null for anything that is not a template.
 */
function skeleton(expr: ts.Expression, sf: ts.SourceFile, usePos: number, env: Env): string[] | null {
  const e = unwrap(expr);
  if (ts.isTemplateExpression(e)) {
    let acc = [e.head.text];
    for (const span of e.templateSpans) {
      const v = resolveStrings(span.expression, sf, usePos, 0, env);
      const parts = v && v.length <= 8 ? v : [SENTINEL];
      acc = acc.flatMap((a) => parts.map((p) => a + p + span.literal.text));
      if (acc.length > 64) return null;
    }
    return acc;
  }
  if (ts.isIdentifier(e)) {
    const bound = env.get(e.text);
    if (bound) return skeleton(bound.expr, bound.sf, bound.usePos, bound.env);
    const hit = initializerIn(sf, e.text, usePos);
    return hit && hit.sf === sf ? skeleton(hit.init, sf, hit.init.getStart(sf), NO_ENV) : null;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // `and(a.eq.${x},b.eq.${y}),` + `and(a.eq.${y},b.eq.${x})`
    const side = (x: ts.Expression) => resolveStrings(x, sf, usePos, 0, env) ?? skeleton(x, sf, usePos, env);
    const a = side(e.left);
    const b = side(e.right);
    if (!a || !b || a.length * b.length > 64) return null;
    return a.flatMap((x) => b.map((y) => x + y));
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "join") {
    // [`a.eq.${x}`, `b.eq.${x}`].join(",")
    const recv = unwrap(e.expression.expression);
    if (!ts.isArrayLiteralExpression(recv)) return null;
    const sep = e.arguments[0] ? resolveStrings(e.arguments[0], sf, usePos, 0, env) : [","];
    if (!sep || sep.length !== 1) return null;
    const pieces: string[] = [];
    for (const el of recv.elements) {
      if (ts.isSpreadElement(el)) return null;
      const v = resolveStrings(el, sf, usePos, 0, env) ?? skeleton(el, sf, usePos, env);
      if (!v || v.length !== 1) return null;
      pieces.push(v[0]!);
    }
    return [pieces.join(sep[0]!)];
  }
  return null;
}

// ── Production, and where everything else was declared ──────────────────────

export interface ProductionSchema {
  /** table or view → its columns. */
  tables: Map<string, Set<string>>;
  functions: Set<string>;
  snapshot: string;
  watermark: string;
  /** Migrations the applied list records after the capture's watermark, whose DDL is added on top. */
  appliedAfterWatermark: string[];
}

const SNAPSHOT_DIR = path.join(SRC, "lib/capability/snapshots");
const APPLIED = path.join(SRC, "lib/capability/production-applied-migrations.json");
const BASELINE = path.join(API_ROOT, "baseline/20260819_baseline_structure.sql");
const MIGRATION_DIRS = [path.join(API_ROOT, "migrations"), path.join(SRC, "migrations")];
const REPO_ROOT = path.resolve(API_ROOT, "../..");

let prodCache: ProductionSchema | null = null;
export function productionSchema(): ProductionSchema {
  if (prodCache) return prodCache;
  const snap = JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, PRODUCTION_SNAPSHOT_FILENAME), "utf8")) as {
    tables: Record<string, string[]>; functions: string[]; productionMigrationWatermark: string;
  };
  const tables = new Map(Object.entries(snap.tables).map(([t, cols]) => [t, new Set(cols)]));
  const functions = new Set(snap.functions);
  const applied = (JSON.parse(fs.readFileSync(APPLIED, "utf8")) as { migrations: Array<{ version: string; name: string }> }).migrations;
  const after = applied.filter((m) => m.version > snap.productionMigrationWatermark).map((m) => m.name);
  for (const name of after) {
    const file = migrationFiles().find((f) => path.basename(f, ".sql") === name);
    if (!file) continue;
    const d = declarationsIn(fs.readFileSync(file, "utf8"));
    for (const [t, cols] of d.columns) {
      const set = tables.get(t) ?? new Set<string>();
      for (const c of cols) set.add(c);
      tables.set(t, set);
    }
    for (const v of d.views) if (!tables.has(v)) tables.set(v, new Set());
    for (const f of d.functions) functions.add(f);
  }
  prodCache = { tables, functions, snapshot: PRODUCTION_SNAPSHOT_FILENAME, watermark: snap.productionMigrationWatermark, appliedAfterWatermark: after };
  return prodCache;
}

/** The names of migrations production-applied-migrations.json records (by file stem). */
export function recordedAppliedMigrations(): Set<string> {
  return new Set((JSON.parse(fs.readFileSync(APPLIED, "utf8")) as { migrations: Array<{ name: string }> }).migrations.map((m) => m.name));
}

let migrationList: string[] | null = null;
function migrationFiles(): string[] {
  if (migrationList) return migrationList;
  const out: string[] = [];
  for (const d of MIGRATION_DIRS) {
    if (!fs.existsSync(d)) continue;
    for (const n of fs.readdirSync(d).sort()) if (n.endsWith(".sql")) out.push(path.join(d, n));
  }
  migrationList = out;
  return out;
}

interface Declared { columns: Map<string, Set<string>>; tables: Set<string>; views: Set<string>; functions: Set<string> }

const ident = String.raw`(?:"?[a-z_][a-z0-9_]*"?\.)?"?([a-z_][a-z0-9_]*)"?`;
const CREATE_TABLE = new RegExp(String.raw`CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}\s*\(`, "gi");
const CREATE_VIEW = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${ident}`, "gi");
const CREATE_FUNCTION = new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${ident}\s*\(`, "gi");
const ALTER_TABLE = new RegExp(String.raw`ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${ident}`, "i");
const ADD_COLUMN = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?\s+[a-z]/gi;
const RENAME_COLUMN = /\bRENAME\s+(?:COLUMN\s+)?"?([a-z_][a-z0-9_]*)"?\s+TO\s+"?([a-z_][a-z0-9_]*)"?/gi;
const NOT_A_COLUMN = new Set(["constraint", "primary", "unique", "foreign", "check", "exclude", "column"]);

function balancedBody(sql: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(open + 1, i);
  }
  return null;
}

/**
 * What one SQL text declares: tables (with columns), views, functions, added and
 * renamed-to columns — including DDL inside `DO $$ … $$` / EXECUTE bodies, which
 * counts as declared (conditional DDL MAY run; the class it decides is "where
 * was this declared", and over-including errs towards B, never towards A).
 */
export function declarationsIn(sqlText: string): Declared {
  const sql = stripSqlComments(sqlText).replace(/''/g, "'");
  const out: Declared = { columns: new Map(), tables: new Set(), views: new Set(), functions: new Set() };
  const addCol = (t: string, c: string) => {
    const set = out.columns.get(t) ?? new Set<string>();
    set.add(c);
    out.columns.set(t, set);
  };
  for (const m of sql.matchAll(CREATE_TABLE)) {
    const t = m[1]!.toLowerCase();
    out.tables.add(t);
    const body = balancedBody(sql, m.index! + m[0].length - 1);
    const cols = body ? parseCreateTableColumns(body) : null;
    for (const c of cols ?? []) if (!NOT_A_COLUMN.has(c.toLowerCase())) addCol(t, c.toLowerCase());
    if (!out.columns.has(t)) out.columns.set(t, new Set());
  }
  for (const m of sql.matchAll(CREATE_VIEW)) out.views.add(m[1]!.toLowerCase());
  for (const m of sql.matchAll(CREATE_FUNCTION)) out.functions.add(m[1]!.toLowerCase());
  // ALTER TABLE statements, top-level and inside procedural bodies alike.
  const statements = splitStatements(sql).flatMap((s) => (/\$[a-z_]*\$/i.test(s) ? [s, ...s.split(/;|\$[a-z_]*\$|'/i)] : [s]));
  for (const stmt of statements) {
    for (const piece of stmt.split(/(?=ALTER\s+TABLE)/i)) {
      const target = ALTER_TABLE.exec(piece);
      if (!target || target.index !== piece.search(/ALTER\s+TABLE/i)) continue;
      const t = target[1]!.toLowerCase();
      const rest = piece.slice(target.index + target[0].length);
      for (const m of rest.matchAll(ADD_COLUMN)) if (!NOT_A_COLUMN.has(m[1]!.toLowerCase())) addCol(t, m[1]!.toLowerCase());
      for (const m of rest.matchAll(RENAME_COLUMN)) addCol(t, m[2]!.toLowerCase());
    }
  }
  return out;
}

export interface Provenance {
  /** `table.column` → the files (relative to artifacts/api-server) that declare it. */
  columns: Map<string, string[]>;
  /** table or view → the files that create it. */
  tables: Map<string, string[]>;
  /** The subset of `tables` some file creates as a VIEW (its columns are a SELECT, not modelled here). */
  views: Set<string>;
  functions: Map<string, string[]>;
}

const BASELINE_REL = "baseline/20260819_baseline_structure.sql";

/**
 * SQL outside the canonical chain that still DECLARES things: the frozen
 * historical roots and the review-staging area (`scripts/frozenMigrationRoots.ts`
 * lists them). Production may or may not have run any of it; a name declared
 * only there is graded B (declared, not in production), never A.
 */
function otherSqlFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".sql")) out.push(full);
    }
  };
  const canonical = new Set([path.resolve(API_ROOT, "baseline"), ...MIGRATION_DIRS.map((d) => path.resolve(d))]);
  for (const r of [...FROZEN_ROOTS, ...ALLOWLISTED_ROOTS]) {
    const dir = path.join(REPO_ROOT, r.relPath);
    if (!canonical.has(path.resolve(dir))) walk(dir);
  }
  for (const f of Object.keys(FROZEN_LOOSE_FILES)) {
    const full = path.join(REPO_ROOT, f);
    if (f.endsWith(".sql") && fs.existsSync(full)) out.push(full);
  }
  return [...new Set(out)].sort();
}

let provCache: Provenance | null = null;
/** Where every table, column and function was declared: the 2026-08-19 baseline, every migration, and the frozen roots. */
export function provenance(): Provenance {
  if (provCache) return provCache;
  const out: Provenance = { columns: new Map(), tables: new Map(), views: new Set(), functions: new Map() };
  const note = (m: Map<string, string[]>, k: string, f: string) => {
    const list = m.get(k) ?? [];
    if (!list.includes(f)) list.push(f);
    m.set(k, list);
  };
  for (const file of [BASELINE, ...migrationFiles(), ...otherSqlFiles()]) {
    const relName = path.relative(API_ROOT, file).split(path.sep).join("/");
    const d = declarationsIn(fs.readFileSync(file, "utf8"));
    for (const t of d.tables) note(out.tables, t, relName);
    for (const v of d.views) { note(out.tables, v, relName); out.views.add(v); }
    for (const [t, cols] of d.columns) for (const c of cols) note(out.columns, `${t}.${c}`, relName);
    for (const f of d.functions) note(out.functions, f, relName);
  }
  provCache = out;
  return out;
}

// ── Grading ──────────────────────────────────────────────────────────────────

export type MismatchClass = "A" | "dropped" | "B";

export interface Mismatch {
  class: MismatchClass;
  /** `table`, `column` or `function`. */
  object: "table" | "column" | "function";
  /** `places.country`, `places`, `rpc_name`. */
  name: string;
  /** Where the repository declares it (empty for A). */
  declaredBy: string[];
  /** Every reference to it. */
  sites: SchemaRef[];
}

/** A file stem a migration is recorded under in production-applied-migrations.json. */
const stem = (f: string) => path.basename(f, ".sql");

/**
 * Every name the scan found that production does not have, classed. A column of
 * a table production lacks is graded once, at the TABLE; a column of a table
 * that exists nowhere is graded with it.
 */
export function productionMismatches(scan: SchemaRefScan = scanSchemaReferences(), prod: Pick<ProductionSchema, "tables" | "functions"> = productionSchema()): Mismatch[] {
  const prov = provenance();
  const recorded = recordedAppliedMigrations();
  const byKey = new Map<string, Mismatch>();
  const add = (cls: MismatchClass, object: Mismatch["object"], name: string, declaredBy: string[], ref: SchemaRef) => {
    const k = `${object}:${name}`;
    const m = byKey.get(k) ?? { class: cls, object, name, declaredBy, sites: [] };
    m.sites.push(ref);
    byKey.set(k, m);
  };
  /** B unless every declaring file is the baseline or a migration production is recorded as having. */
  const classOf = (files: string[]): MismatchClass =>
    files.length === 0 ? "A" : files.some((f) => f !== BASELINE_REL && !recorded.has(stem(f))) ? "B" : "dropped";
  for (const r of scan.refs) {
    if (r.kind === "rpc") {
      const fn = r.name.toLowerCase();
      if (prod.functions.has(fn)) continue;
      add(classOf(prov.functions.get(fn) ?? []), "function", fn, prov.functions.get(fn) ?? [], r);
      continue;
    }
    const table = (r.table ?? "").toLowerCase();
    if (r.kind === "table") {
      if (prod.tables.has(table)) continue;
      add(classOf(prov.tables.get(table) ?? []), "table", table, prov.tables.get(table) ?? [], r);
      continue;
    }
    const col = r.name.toLowerCase();
    if (prod.tables.has(table)) {
      if (prod.tables.get(table)!.has(col)) continue;
      // A computed column: a function taking the row, which production has.
      if (prod.functions.has(col)) continue;
      const files = prov.columns.get(`${table}.${col}`) ?? [];
      add(classOf(files), "column", `${table}.${col}`, files, r);
      continue;
    }
    // The table is missing in production: graded at the table. Its column is
    // graded too only when NOTHING declares it (the query fails everywhere) —
    // never on a view, whose columns are a SELECT this reader does not model.
    if (prov.tables.has(table) && !prov.views.has(table) && !prov.columns.has(`${table}.${col}`) && !prov.functions.has(col)) {
      add("A", "column", `${table}.${col}`, [], r);
    }
  }
  return [...byKey.values()].sort((a, b) => `${a.class}${a.name}`.localeCompare(`${b.class}${b.name}`));
}

/** The allow-list key of one mismatched reference: `file → object name`. */
export const mismatchKey = (file: string, m: Pick<Mismatch, "object" | "name">) => `${file} → ${m.object} ${m.name}`;
