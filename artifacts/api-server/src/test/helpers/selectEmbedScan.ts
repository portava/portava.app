/**
 * selectEmbedScan — every PostgREST embed production code issues, read
 * statically and checked against the foreign keys the repository declares.
 *
 * WHY (2026-10-17, wave 5). The embed guard (`migrationForeignKeys.ts`) sits in
 * the test DOUBLES: it refuses an embed with no key behind it, but only for a
 * select some test drives. Four production reads embedded across a pair of
 * tables with no foreign key, and answered PGRST200 (or, with the error unread,
 * nothing) in production: reviews → profiles (routes/reviews.ts), appeals →
 * profiles (routes/appeals.ts), route_plan_members → profiles
 * (routes/routePlan.ts) and posts → discovery_places (lib/eventPostsDiscovery.ts).
 * This scan reads every `.select(...)` under `src/` (tests excluded), whether or
 * not a test drives it, and asks the guard's question of each.
 *
 * WHAT IT RESOLVES. The table is the nearest `.from(x)` down the call chain,
 * through a builder held in a same-file variable (`const q = sc.from("t")` …
 * `q.select(...)`). `x` and the select list may be a literal, a same-file
 * constant, a constant imported (through re-exports) from a file under `src/`,
 * a `+` concatenation, a template literal, a ternary (EVERY branch is checked),
 * a literal array `.join(sep)` (spreads included), `.trim()`, or a call to a
 * function under `src/` (the union of its `return`s, its parameters bound to
 * the call's arguments). A select inside a helper that takes the table or the
 * list as a PARAMETER is resolved at each call of the helper. Anything else is
 * UNRESOLVED and reported with its reason, never guessed.
 *
 * WHAT IT DOES NOT KNOW. What the guard it calls does not: a many-to-many embed
 * through a junction table and a computed relationship are refused, and a
 * relationship PostgREST infers THROUGH A VIEW is invisible (the reader reads
 * keys on tables). A site whose parent is a view lands in `viewSites`, unjudged.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { parseSelectEmbeds, selectEmbedRefusalDetails, type EmbedRefusal } from "./migrationForeignKeys.js";

const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC = path.join(API_ROOT, "src");

/** Bound on the spellings one select may expand to (ternaries multiply). */
const MAX_VARIANTS = 64;
/** A parameterised select is followed up to the calls of the helper it sits in, one level. */
const MAX_CALL_HOPS = 1;

export interface EmbedSite {
  /** The `.select(` site, relative to artifacts/api-server. */
  file: string;
  line: number;
  /** When the select sits in a helper that takes its table or list as a parameter: the call it was resolved through. */
  via: string | null;
  table: string;
  /** Every fully resolved spelling of the select list (one per ternary branch). */
  variants: string[];
  /** `parent→relation` for every embed in any variant. */
  embeds: string[];
  /**
   * Why PostgREST would refuse an embed here, per the declared keys: PGRST200
   * (no key) or PGRST201 (more than one, and no hint that picks one). Empty when
   * every embed resolves to exactly one relationship.
   */
  refusals: Array<{ parent: string; relation: string; why: string; code: EmbedRefusal["code"]; keys: string[] }>;
}

export interface UnresolvedSite {
  file: string;
  line: number;
  via: string | null;
  /** The table, when the chain named one statically. */
  table: string | null;
  reason: "select list not statically resolvable" | "table not statically resolvable";
  /** The argument's source text, whitespace-collapsed, for the report. */
  text: string;
}

export interface EmbedScan {
  embedSites: EmbedSite[];
  /** Embeds whose parent is a VIEW: PostgREST may infer a key through the view's base tables, which this reader cannot see. */
  viewSites: EmbedSite[];
  unresolved: UnresolvedSite[];
  /** `.select(` sites resolved to a table and a list, embed or not (the coverage figure). */
  selectsScanned: number;
}

// ── Files ────────────────────────────────────────────────────────────────────

function isProductionFile(root: string, full: string): boolean {
  const rel = path.relative(root, full).split(path.sep).join("/");
  if (rel.startsWith("test/")) return false;
  if (rel.split("/").includes("__tests__")) return false;
  if (full.endsWith(".test.ts") || full.endsWith(".d.ts")) return false;
  return full.endsWith(".ts");
}

function listFiles(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...listFiles(root, full));
    } else if (isProductionFile(root, full)) {
      out.push(full);
    }
  }
  return out;
}

const sourceCache = new Map<string, ts.SourceFile | null>();
function sourceOf(file: string): ts.SourceFile | null {
  if (sourceCache.has(file)) return sourceCache.get(file)!;
  let sf: ts.SourceFile | null = null;
  try {
    sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  } catch {
    sf = null;
  }
  sourceCache.set(file, sf);
  return sf;
}

function resolveModule(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const cand of [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts"), base]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile() && cand.endsWith(".ts")) return cand;
  }
  return null;
}

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) {
    cur = cur.expression;
  }
  return cur;
}

const isExported = (node: ts.Node) => !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));

// ── Symbols: same-file constants and functions, then imports through re-exports ─

interface Decl { pos: number; init: ts.Expression; exported: boolean }
const declCache = new WeakMap<ts.SourceFile, Map<string, Decl[]>>();

function declarations(sf: ts.SourceFile): Map<string, Decl[]> {
  let map = declCache.get(sf);
  if (map) return map;
  map = new Map();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const stmt = node.parent?.parent;
      const list = map!.get(node.name.text) ?? [];
      list.push({ pos: node.getStart(sf), init: node.initializer, exported: !!stmt && ts.isVariableStatement(stmt) && isExported(stmt) });
      map!.set(node.name.text, list);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  declCache.set(sf, map);
  return map;
}

type FnLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

function topLevelFunction(sf: ts.SourceFile, name: string, mustExport: boolean): FnLike | null {
  for (const stmt of sf.statements) {
    if (mustExport && !isExported(stmt)) continue;
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name && stmt.body) return stmt;
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
          const init = unwrap(d.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
        }
      }
    }
  }
  return null;
}

/** What `name` is when `sf` exports it: a constant's initializer or a function, following `export … from` chains. */
function exportedSymbol(sf: ts.SourceFile, name: string, depth = 0): { sf: ts.SourceFile; init?: ts.Expression; fn?: FnLike } | null {
  if (depth > 6) return null;
  const consts = declarations(sf).get(name)?.filter((d) => d.exported) ?? [];
  if (consts.length === 1) return { sf, init: consts[0].init };
  const fn = topLevelFunction(sf, name, true);
  if (fn) return { sf, fn };
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier) ? stmt.moduleSpecifier.text : null;
    if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      const el = stmt.exportClause.elements.find((x) => x.name.text === name);
      if (!el) continue;
      const original = (el.propertyName ?? el.name).text;
      if (!spec) {
        const local = declarations(sf).get(original);
        if (local?.length === 1) return { sf, init: local[0].init };
        const lf = topLevelFunction(sf, original, false);
        return lf ? { sf, fn: lf } : null;
      }
      const target = resolveModule(sf.fileName, spec);
      const tsf = target ? sourceOf(target) : null;
      return tsf ? exportedSymbol(tsf, original, depth + 1) : null;
    }
    if (!stmt.exportClause && spec) {
      const target = resolveModule(sf.fileName, spec);
      const tsf = target ? sourceOf(target) : null;
      const hit = tsf ? exportedSymbol(tsf, name, depth + 1) : null;
      if (hit) return hit;
    }
  }
  return null;
}

/** `name` as imported into `sf` from a relative module. */
function importedSymbol(sf: ts.SourceFile, name: string): { sf: ts.SourceFile; init?: ts.Expression; fn?: FnLike } | null {
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier) || !stmt.moduleSpecifier.text.startsWith(".")) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const el = bindings.elements.find((x) => x.name.text === name);
    if (!el) continue;
    const target = resolveModule(sf.fileName, stmt.moduleSpecifier.text);
    const tsf = target ? sourceOf(target) : null;
    return tsf ? exportedSymbol(tsf, (el.propertyName ?? el.name).text) : null;
  }
  return null;
}

/** The initializer `name` refers to at `usePos`: the nearest preceding same-file declaration, else the sole one, else an import. */
function initializerIn(sf: ts.SourceFile, name: string, usePos: number): { sf: ts.SourceFile; init: ts.Expression } | null {
  const decls = declarations(sf).get(name);
  if (decls && decls.length > 0) {
    let best: Decl | undefined;
    for (const d of decls) if (d.pos < usePos && (!best || d.pos > best.pos)) best = d;
    if (!best && decls.length === 1) best = decls[0];
    if (best) return { sf, init: best.init };
  }
  const imp = importedSymbol(sf, name);
  return imp?.init ? { sf: imp.sf, init: imp.init } : null;
}

function functionNamed(sf: ts.SourceFile, name: string): { sf: ts.SourceFile; decl: FnLike } | null {
  const local = topLevelFunction(sf, name, false);
  if (local) return { sf, decl: local };
  const imp = importedSymbol(sf, name);
  return imp?.fn ? { sf: imp.sf, decl: imp.fn } : null;
}

// ── Strings ──────────────────────────────────────────────────────────────────

/** Parameters bound to call arguments while a function body is resolved. */
type Binding = { expr: ts.Expression; sf: ts.SourceFile; usePos: number; env: Env };
type Env = ReadonlyMap<string, Binding>;
const NO_ENV: Env = new Map();

/**
 * Every string `expr` can evaluate to, or null when any part is not static.
 * A ternary yields both branches; a template or `+` yields the cross product; a
 * call to a function declared under `src/` yields the union of its `return`s,
 * its parameters bound to the call's arguments.
 */
export function resolveStrings(expr: ts.Expression, sf: ts.SourceFile, usePos: number, depth = 0, env: Env = NO_ENV): string[] | null {
  if (depth > 12) return null;
  const e = unwrap(expr);
  const again = (x: ts.Expression) => resolveStrings(x, sf, usePos, depth + 1, env);
  if (ts.isStringLiteralLike(e)) return [e.text];
  if (ts.isAwaitExpression(e)) return again(e.expression);
  if (ts.isIdentifier(e)) {
    const bound = env.get(e.text);
    if (bound) return resolveStrings(bound.expr, bound.sf, bound.usePos, depth + 1, bound.env);
    const hit = initializerIn(sf, e.text, usePos);
    return hit ? resolveStrings(hit.init, hit.sf, hit.sf === sf ? usePos : Number.MAX_SAFE_INTEGER, depth + 1) : null;
  }
  if (ts.isConditionalExpression(e)) {
    const a = again(e.whenTrue);
    const b = again(e.whenFalse);
    return a && b ? cap([...a, ...b]) : null;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = again(e.left);
    const b = again(e.right);
    return a && b ? product(a, b) : null;
  }
  if (ts.isTemplateExpression(e)) {
    let acc: string[] | null = [e.head.text];
    for (const span of e.templateSpans) {
      const sub = again(span.expression);
      if (!sub || !acc) return null;
      acc = product(acc, sub);
      acc = acc ? product(acc, [span.literal.text]) : null;
    }
    return acc;
  }
  // obj.prop, where obj is (bound to) an object literal, or to a call whose every
  // return is one: `readTail(sc, { columns: "…" })` … `input.columns`, and
  // `const p = await highlightColumns(sc)` … `p.columns`.
  if (ts.isPropertyAccessExpression(e)) {
    const objs = objectLiteralsOf(e.expression, sf, usePos, depth + 1, env);
    if (!objs) return null;
    const out: string[] = [];
    for (const obj of objs) {
      let found: string[] | null = null;
      for (const prop of obj.lit.properties) {
        if (ts.isPropertyAssignment(prop) && propName(prop.name) === e.name.text) { found = resolveStrings(prop.initializer, obj.sf, obj.usePos, depth + 1, obj.env); break; }
        if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === e.name.text) { found = resolveStrings(prop.name, obj.sf, obj.usePos, depth + 1, obj.env); break; }
      }
      if (!found) return null;
      out.push(...found);
    }
    return cap(out);
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    if (method === "trim" && e.arguments.length === 0) {
      const v = again(e.expression.expression);
      return v ? cap(v.map((x) => x.trim())) : null;
    }
    if (method === "join") {
      const sep = e.arguments[0] ? again(e.arguments[0]) : [","];
      const items = arrayItems(e.expression.expression, sf, usePos, depth + 1, env);
      return items && sep && sep.length === 1 ? [items.join(sep[0])] : null;
    }
    return null;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const fn = functionNamed(sf, e.expression.text);
    if (!fn) return null;
    const bindings = new Map(env);
    fn.decl.parameters.forEach((p, i) => {
      const arg = e.arguments[i];
      if (ts.isIdentifier(p.name) && arg) bindings.set(p.name.text, { expr: arg, sf, usePos, env });
    });
    const returns = returnExpressions(fn.decl);
    if (returns.length === 0) return null;
    const out: string[] = [];
    for (const r of returns) {
      if (!r) return null;
      const v = resolveStrings(r, fn.sf, Number.MAX_SAFE_INTEGER, depth + 1, bindings);
      if (!v) return null;
      out.push(...v);
    }
    return cap(out);
  }
  return null;
}

function propName(n: ts.PropertyName): string | null {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null;
}

type ObjectSite = { lit: ts.ObjectLiteralExpression; sf: ts.SourceFile; usePos: number; env: Env };

/** Every object literal `expr` can be (a binding, a constant, a ternary of literals, or a call whose every return is one), or null. */
function objectLiteralsOf(expr: ts.Expression, sf: ts.SourceFile, usePos: number, depth: number, env: Env): ObjectSite[] | null {
  if (depth > 12) return null;
  const e = unwrap(expr);
  if (ts.isObjectLiteralExpression(e)) return [{ lit: e, sf, usePos, env }];
  if (ts.isAwaitExpression(e)) return objectLiteralsOf(e.expression, sf, usePos, depth + 1, env);
  if (ts.isConditionalExpression(e)) {
    const a = objectLiteralsOf(e.whenTrue, sf, usePos, depth + 1, env);
    const b = objectLiteralsOf(e.whenFalse, sf, usePos, depth + 1, env);
    return a && b ? [...a, ...b] : null;
  }
  if (ts.isIdentifier(e)) {
    const bound = env.get(e.text);
    if (bound) return objectLiteralsOf(bound.expr, bound.sf, bound.usePos, depth + 1, bound.env);
    const hit = initializerIn(sf, e.text, usePos);
    return hit ? objectLiteralsOf(hit.init, hit.sf, hit.sf === sf ? usePos : Number.MAX_SAFE_INTEGER, depth + 1, NO_ENV) : null;
  }
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const fn = functionNamed(sf, e.expression.text);
    if (!fn) return null;
    const bindings = new Map(env);
    fn.decl.parameters.forEach((p, i) => {
      const arg = e.arguments[i];
      if (ts.isIdentifier(p.name) && arg) bindings.set(p.name.text, { expr: arg, sf, usePos, env });
    });
    const out: ObjectSite[] = [];
    for (const r of returnExpressions(fn.decl)) {
      const objs = r ? objectLiteralsOf(r, fn.sf, Number.MAX_SAFE_INTEGER, depth + 1, bindings) : null;
      if (!objs) return null;
      out.push(...objs);
    }
    return out.length > 0 ? out : null;
  }
  return null;
}

/** The string elements of an array literal (spreads of resolvable arrays included), or null. */
function arrayItems(expr: ts.Expression, sf: ts.SourceFile, usePos: number, depth: number, env: Env): string[] | null {
  if (depth > 12) return null;
  let e = unwrap(expr);
  let esf = sf;
  if (ts.isIdentifier(e)) {
    const hit = initializerIn(sf, e.text, usePos);
    if (!hit) return null;
    e = unwrap(hit.init);
    esf = hit.sf;
  }
  if (!ts.isArrayLiteralExpression(e)) return null;
  const out: string[] = [];
  for (const el of e.elements) {
    if (ts.isSpreadElement(el)) {
      const inner = arrayItems(el.expression, esf, usePos, depth + 1, env);
      if (!inner) return null;
      out.push(...inner);
      continue;
    }
    const v = resolveStrings(el, esf, esf === sf ? usePos : Number.MAX_SAFE_INTEGER, depth + 1, env);
    if (!v || v.length !== 1) return null;
    out.push(v[0]);
  }
  return out;
}

/** Every `return <expr>` of a function body (nested functions excluded); `null` marks a bare `return;`. */
function returnExpressions(fn: FnLike): Array<ts.Expression | null> {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: Array<ts.Expression | null> = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) { out.push(node.expression ?? null); return; }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

function product(a: string[], b: string[]): string[] | null {
  const out: string[] = [];
  for (const x of a) for (const y of b) out.push(x + y);
  return cap(out);
}

function cap(list: string[]): string[] | null {
  const uniq = [...new Set(list)];
  return uniq.length > MAX_VARIANTS ? null : uniq;
}

// ── The table a `.select(` runs on ───────────────────────────────────────────

/**
 * Walk DOWN a receiver chain to its `.from(x)`. `undefined`: no `.from` (not a
 * PostgREST builder this scan can see); `null`: a `.from` whose argument is not
 * static; otherwise every spelling of the table.
 */
function tableOfChain(expr: ts.Expression, sf: ts.SourceFile, usePos: number, env: Env, depth = 0): string[] | null | undefined {
  let cur: ts.Expression = expr;
  for (let guard = 0; guard < 200; guard++) {
    cur = unwrap(cur);
    if (ts.isAwaitExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (!ts.isPropertyAccessExpression(callee)) return undefined;
      if (callee.name.text === "from") {
        const recv = unwrap(callee.expression);
        if (ts.isIdentifier(recv) && /^(Array|Buffer|Uint8Array|Object|Set|Map|String)$/.test(recv.text)) return undefined;
        const arg = cur.arguments[0];
        return arg ? resolveStrings(arg, sf, usePos, 0, env) : null;
      }
      cur = callee.expression;
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isIdentifier(cur) && depth < 4 && !env.has(cur.text)) {
      const hit = initializerIn(sf, cur.text, usePos);
      if (!hit || hit.sf !== sf) return undefined;
      return tableOfChain(hit.init, sf, hit.init.getStart(sf), env, depth + 1);
    }
    return undefined;
  }
  return undefined;
}

// ── Helpers that take the table or the list as a parameter ───────────────────

/** The named function a node sits in, when it has one this scan can find calls of. */
function enclosingNamedFunction(node: ts.Node): { name: string; decl: FnLike } | null {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionDeclaration(cur)) return cur.name && cur.body ? { name: cur.name.text, decl: cur } : null;
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur))) {
      const p = cur.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return { name: p.name.text, decl: cur };
      return null;
    }
    if (ts.isMethodDeclaration(cur) || ts.isClassDeclaration(cur)) return null;
  }
  return null;
}

/** The block a NESTED `const name = (…) => …` helper is declared in; null for a top-level one. */
function enclosingBlockOf(decl: FnLike): ts.Node | null {
  const v = decl.parent;
  if (!v || !ts.isVariableDeclaration(v)) return null;
  const stmt = v.parent?.parent;
  const block = stmt?.parent;
  return block && !ts.isSourceFile(block) ? block : null;
}

/** Does `node`'s subtree name one of `fn`'s parameters? */
function mentionsParameter(node: ts.Node, fn: FnLike): boolean {
  const params = new Set(fn.parameters.filter((p) => ts.isIdentifier(p.name)).map((p) => (p.name as ts.Identifier).text));
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isIdentifier(n) && params.has(n.text)) { found = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

let callIndex: Map<string, Array<{ sf: ts.SourceFile; call: ts.CallExpression }>> | null = null;
function callsNamed(name: string, files: ts.SourceFile[]): Array<{ sf: ts.SourceFile; call: ts.CallExpression }> {
  if (!callIndex) {
    callIndex = new Map();
    for (const sf of files) {
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
          const list = callIndex!.get(n.expression.text) ?? [];
          list.push({ sf, call: n });
          callIndex!.set(n.expression.text, list);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return callIndex.get(name) ?? [];
}

// ── Views (a relationship through a view is invisible to the key reader) ─────

let viewCache: Set<string> | null = null;
function views(): Set<string> {
  if (viewCache) return viewCache;
  const out = new Set<string>();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;
  const files = [
    path.join(API_ROOT, "baseline/20260819_baseline_structure.sql"),
    ...fs.readdirSync(path.join(SRC, "migrations")).filter((n) => n.endsWith(".sql")).map((n) => path.join(SRC, "migrations", n)),
  ];
  for (const f of files) for (const m of fs.readFileSync(f, "utf8").matchAll(re)) out.add(m[1].toLowerCase());
  viewCache = out;
  return out;
}

// ── The scan ─────────────────────────────────────────────────────────────────

const EMBED_SHAPE = /[a-z_]\s*(?:![a-z_]+)?\s*\(/i;
const scanCache = new Map<string, EmbedScan>();

/**
 * Scan every production `.ts` file under `root` (default: artifacts/api-server/src;
 * `test/`, `__tests__/`, `*.test.ts` and `*.d.ts` excluded). Paths in the result
 * are relative to artifacts/api-server. A different `root` is for the scan's own
 * planted controls.
 */
export function scanSelectEmbeds(root: string = SRC): EmbedScan {
  const hit = scanCache.get(root);
  if (hit) return hit;
  callIndex = null;
  const embedSites: EmbedSite[] = [];
  const viewSites: EmbedSite[] = [];
  const unresolved: UnresolvedSite[] = [];
  let selectsScanned = 0;
  const viewSet = views();
  const files = listFiles(root).sort().map(sourceOf).filter((x): x is ts.SourceFile => x !== null);
  const rel = (sf: ts.SourceFile) => path.relative(root === SRC ? API_ROOT : root, sf.fileName).split(path.sep).join("/");
  const lineOf = (sf: ts.SourceFile, n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  function judge(site: { file: string; line: number; via: string | null }, tables: string[], variants: string[]) {
    selectsScanned++;
    for (const table of tables) {
      const embeds = [...new Set(variants.flatMap((v) => parseSelectEmbeds(table, v).map((x) => `${x.parent}→${x.embed}`)))];
      if (embeds.length === 0) continue;
      const refusals: EmbedSite["refusals"] = [];
      const seen = new Set<string>();
      for (const v of variants) {
        for (const r of selectEmbedRefusalDetails(table, v)) {
          if (seen.has(r.why)) continue;
          seen.add(r.why);
          refusals.push({ parent: r.parent, relation: r.relation, why: r.why, code: r.code, keys: r.keys });
        }
      }
      (viewSet.has(table.toLowerCase()) ? viewSites : embedSites).push({ ...site, table, variants, embeds, refusals });
    }
  }

  const reported = new Set<string>();
  function report(u: UnresolvedSite) {
    const key = `${u.file}:${u.line}:${u.via ?? ""}:${u.reason}`;
    if (!reported.has(key)) { reported.add(key); unresolved.push(u); }
  }

  /** Resolve one `.select(` under `env`; on failure, follow the helper it sits in up to its calls. */
  function visitSelect(sf: ts.SourceFile, node: ts.CallExpression, env: Env, via: string | null, hops: number) {
    const usePos = node.getStart(sf);
    const site = { file: rel(sf), line: lineOf(sf, node), via };
    const recv = (node.expression as ts.PropertyAccessExpression).expression;
    const arg = node.arguments[0];
    const tables = tableOfChain(recv, sf, usePos, env);
    const variants = arg ? resolveStrings(arg, sf, usePos, 0, env) : ["*"];
    const text = arg ? arg.getText(sf).replace(/\s+/g, " ").slice(0, 160) : "";
    if (tables === undefined) {
      // Not traceable to `.from()` (a builder passed in, a non-PostgREST `.select`): reported only when it embeds.
      if (variants?.some((v) => EMBED_SHAPE.test(v))) report({ ...site, table: null, reason: "table not statically resolvable", text });
      return;
    }
    if (tables !== null && variants !== null) { judge(site, tables, variants); return; }
    const helper = enclosingNamedFunction(node);
    const parameterised = helper && (mentionsParameter(recv, helper.decl) || (arg && mentionsParameter(arg, helper.decl)));
    if (helper && parameterised && hops < MAX_CALL_HOPS) {
      // A top-level helper is called wherever its name resolves to it; a helper
      // declared inside a function (`const run = async (cols) => …`) only within
      // the block that declares it.
      const scope = enclosingBlockOf(helper.decl);
      const calls = callsNamed(helper.name, files).filter(({ sf: csf, call }) =>
        functionNamed(csf, helper.name)?.decl === helper.decl ||
        (scope !== null && csf === sf && call.getStart(csf) >= scope.getStart(sf) && call.getEnd() <= scope.getEnd()));
      if (calls.length > 0) {
        for (const { sf: csf, call } of calls) {
          const bindings = new Map(env);
          helper.decl.parameters.forEach((p, i) => {
            const a = call.arguments[i];
            if (ts.isIdentifier(p.name) && a) bindings.set(p.name.text, { expr: a, sf: csf, usePos: call.getStart(csf), env: NO_ENV });
          });
          visitSelect(sf, node, bindings, `${helper.name}() called at ${rel(csf)}:${lineOf(csf, call)}`, hops + 1);
        }
        return;
      }
    }
    if (variants === null) report({ ...site, table: tables?.length === 1 ? tables[0] : null, reason: "select list not statically resolvable", text });
    else if (variants.some((v) => EMBED_SHAPE.test(v))) report({ ...site, table: null, reason: "table not statically resolvable", text });
  }

  for (const sf of files) {
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "select") {
        visitSelect(sf, node, NO_ENV, null, 0);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const result = { embedSites, viewSites, unresolved, selectsScanned };
  scanCache.set(root, result);
  return result;
}

/** Every unbacked embed (PGRST200), keyed the way the allow-list is: `file → parent→relation`. */
export function unbackedEmbedKeys(scan: EmbedScan = scanSelectEmbeds()): Map<string, EmbedSite[]> {
  const out = new Map<string, EmbedSite[]>();
  for (const s of scan.embedSites) {
    for (const r of s.refusals) {
      if (r.code !== "PGRST200") continue;
      const key = `${s.file} → ${r.parent}→${r.relation}`;
      const list = out.get(key) ?? [];
      if (!list.includes(s)) list.push(s);
      out.set(key, list);
    }
  }
  return out;
}

// ── Ambiguity: an embed across a pair joined by more than one key ──────────
//
// PostgREST refuses `rel(...)` with PGRST201 when more than one relationship
// joins the two tables (either direction) and no `!hint` picks exactly one. The
// guard (`migrationForeignKeys.ts`) MODELS this since wave 5 (2026-10-17), so
// the doubles refuse it and this scan reads the same verdict, from the same
// de-duplicated keys, as a PGRST201 refusal. A hint naming the key is always
// accepted by production when the key exists, so asking for one is never wrong.

export interface AmbiguousEmbed {
  file: string;
  line: number;
  parent: string;
  relation: string;
  keys: string[];
}

/**
 * Every embed PostgREST could not resolve to ONE relationship (PGRST201): no
 * hint across a multiply-keyed pair, or a hint that selects more than one key.
 */
export function ambiguousEmbeds(scan: EmbedScan = scanSelectEmbeds()): AmbiguousEmbed[] {
  const out: AmbiguousEmbed[] = [];
  const seen = new Set<string>();
  for (const s of scan.embedSites) {
    for (const r of s.refusals) {
      if (r.code !== "PGRST201") continue;
      const k = `${s.file}:${s.line}:${r.parent}:${r.relation}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ file: s.file, line: s.line, parent: r.parent, relation: r.relation, keys: r.keys });
    }
  }
  return out;
}
