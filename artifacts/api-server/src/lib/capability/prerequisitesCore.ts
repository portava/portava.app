/**
 * prerequisitesCore — the PURE half of `check:flag-schema-prerequisites`.
 *
 * THE QUESTION
 * ============
 * For every feature flag the tree reads: does the code behind it name schema
 * that PRODUCTION does not have, and is the flag ON there?
 *
 *   flag ON in production  +  required object absent in production
 *   = the defect class that lost three weeks of media writes
 *
 * `flagPhantomReads.test.ts` catches the inverse (a read of a flag no
 * migration seeds). Nothing caught this direction before this file.
 *
 * HOW "PRODUCTION" IS KNOWN WITHOUT CREDENTIALS
 * ============================================
 * CI cannot see production and must not: every live-DB job refuses a
 * production ref. Production also has NO migration ledger — no
 * `schema_migration_ledger`, and `supabase_migrations.schema_migrations`
 * stops at 2272 — so "which migrations are applied" cannot be asked of it.
 * What CAN be asked, read-only, is `information_schema`, `pg_proc` and
 * `feature_flags`. An operator captures those into the dated snapshot under
 * `snapshots/`; this check is a file-vs-file comparison against it, on the
 * model of `checkProductionDrift.ts`. No socket, no environment variable.
 *
 * HOW "THE CODE BEHIND THE FLAG" IS FOUND
 * =======================================
 * TypeScript AST, per file:
 *   1. every flag read — the shared readers (`isFlagEnabled`,
 *      `isLivePlacesCapabilityEnabled`, `getFlagRow`, compass `isEnabled`),
 *      their per-file shadows of the same name, and direct
 *      `.from("feature_flags")...eq("flag", <lit>)` / `.in("flag", [...])`;
 *   2. the function enclosing each read, plus — transitively — every
 *      function it calls by name, in the same file or through a relative
 *      `import { f } from "./x.js"` (up to three files away): the closure.
 *      A reached function that reads a flag ITSELF is a gate boundary and is
 *      not entered — its schema belongs to its own flag;
 *   3. every schema reference inside that closure: `.from("<t>")` tables,
 *      `.select("...")` column lists, `.insert/.upsert/.update({...})` keys,
 *      filter/order columns (`.eq("<c>", …)`), and `.rpc("<fn>")` functions.
 *
 * This is a FLOOR, deliberately. A payload built in another module, a column
 * reached through a variable, a table named dynamically — none of these are
 * seen, and the count of what was skipped is reported so the floor is
 * visible. Kill switches (`isKillSwitchEngaged`) are excluded: TRUE means
 * STOP there, so "on over missing schema" is not this defect.
 *
 * WHAT A FINDING MEANS
 * ====================
 *   unguarded  flag ON in production, the closure names an absent object, and
 *              no registry entry declares the requirement. The code runs and
 *              fails. THE finding; new ones fail the check.
 *   guarded    the same state, but `lib/capability/registry.ts` declares the
 *              requirement and a consumer refuses before the failing call.
 *              Reported, not failed: the contract is doing its job.
 *   latent     the closure names an absent object but the flag is OFF or has
 *              no row. One `UPDATE feature_flags` away from `unguarded`.
 *
 * Pure: every function is a function of its arguments and the files it is
 * pointed at. No Supabase credential variable is named here, so
 * `check:guard-coverage` classifies it correctly as unable to reach a
 * database.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { requiredObjects, type CapabilityDefinition } from "./schemaRequirement.js";

// ── The production snapshot ──────────────────────────────────────────────────

export interface ProductionSnapshot {
  projectRef: string;
  capturedAt: string;
  tables: Map<string, Set<string>>;
  functions: Set<string>;
  enums: Set<string>;
  /** flag → enabled. A flag with no entry has NO ROW in production. */
  flags: Map<string, boolean>;
}

export function loadProductionSnapshot(path: string): ProductionSnapshot {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const tables = new Map<string, Set<string>>();
  for (const [t, cols] of Object.entries(raw.tables ?? {})) {
    tables.set(t, new Set(cols as string[]));
  }
  return {
    projectRef: String(raw.projectRef ?? ""),
    capturedAt: String(raw.capturedAt ?? ""),
    tables,
    functions: new Set<string>(raw.functions ?? []),
    enums: new Set<string>(raw.enums ?? []),
    flags: new Map<string, boolean>(Object.entries(raw.flags ?? {}).map(([k, v]) => [k, v === true])),
  };
}

export type ProductionFlagState = "on" | "off" | "no-row";

export function productionFlagState(snap: ProductionSnapshot, flag: string): ProductionFlagState {
  if (!snap.flags.has(flag)) return "no-row";
  return snap.flags.get(flag) ? "on" : "off";
}

// ── Schema references ────────────────────────────────────────────────────────

export type SchemaRefKind = "table" | "column" | "function";

export interface SchemaRef {
  kind: SchemaRefKind;
  /** `table`, `table.column`, or `fn()` */
  key: string;
  table: string | null;
  name: string;
  file: string;
  line: number;
}

/** An object the snapshot lacks: `table` absent, `table.column` absent, or `fn()` absent. */
export function isAbsentInProduction(snap: ProductionSnapshot, ref: SchemaRef): boolean {
  if (ref.kind === "function") return !snap.functions.has(ref.name);
  const cols = snap.tables.get(ref.table ?? ref.name);
  if (!cols) return true;
  if (ref.kind === "table") return false;
  return !cols.has(ref.name);
}

// ── Flag reads ───────────────────────────────────────────────────────────────

/** Readers whose `true` means "the capability is available". */
export const CAPABILITY_READERS = new Set([
  "isFlagEnabled",
  "isLivePlacesCapabilityEnabled",
  "isEnabled",
  "getFlagRow",
]);

export interface FlagRead {
  flag: string;
  file: string;
  line: number;
  reader: string;
  /** "function" when an enclosing function was found; "module" when the read is top-level. */
  scope: "function" | "module";
  /** Schema references in the closure of the read. */
  refs: SchemaRef[];
  /** `.from(<non-literal>)`, `.upsert(<identifier>)`, etc. inside the closure. */
  unresolved: number;
}

export interface ScanResult {
  reads: FlagRead[];
  filesScanned: number;
  /** Reader calls whose flag argument could not be resolved to a literal. */
  unresolvedReads: Array<{ file: string; line: number; reader: string; expr: string }>;
}

const FILTER_METHODS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in",
  "contains", "containedBy", "order", "not", "textSearch", "match", "overlaps",
]);
const WRITE_METHODS = new Set(["insert", "upsert", "update"]);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "test" || entry === "__tests__" || entry === "node_modules") continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * `.from("<literal>")` at the root of a call chain seen from any call in it.
 * Returns the table, "<dynamic>" for a non-literal, or null when the chain
 * has no `.from`.
 */
function tableOfChain(expr: ts.Expression): string | null {
  let cur: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression;
      if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === "from") {
          const a = cur.arguments[0];
          return a && ts.isStringLiteralLike(a) ? a.text : "<dynamic>";
        }
        cur = callee.expression;
        continue;
      }
      return null;
    }
    if (ts.isPropertyAccessExpression(cur)) { cur = cur.expression; continue; }
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isAwaitExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    return null;
  }
}

/**
 * Column names out of a PostgREST select list. Embedded resources
 * (`rel(...)`) are dropped whole, aliases (`alias:col`) resolve to the
 * column, casts (`col::text`) and modifiers (`!inner`) are stripped, `*` and
 * anything with a path (`a.b`, `a->b`) are ignored. PURE.
 */
export function selectListColumns(list: string): string[] {
  // Split on top-level commas; an item that opens a parenthesis at depth 0 is
  // an embedded resource (`profiles(...)`, `author:profiles!inner(...)`) and
  // is dropped WHOLE — its head is a relation, not a column of this table.
  const items: Array<{ text: string; embedded: boolean }> = [];
  let cur = "";
  let depth = 0;
  let embedded = false;
  for (const ch of list) {
    if (ch === "(") { if (depth === 0) embedded = true; depth++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (ch === ",") { items.push({ text: cur, embedded }); cur = ""; embedded = false; continue; }
    cur += ch;
  }
  items.push({ text: cur, embedded });
  const out: string[] = [];
  for (const it of items) {
    if (it.embedded) continue;
    let item = it.text.trim();
    if (!item || item === "*") continue;
    // PostgREST `alias:column`.
    const colon = item.lastIndexOf(":");
    if (colon >= 0) item = item.slice(colon + 1).trim();
    item = item.replace(/::.*$/, "").replace(/!.*$/, "").trim();
    if (IDENT_RE.test(item)) out.push(item);
  }
  return out;
}

function literalKeys(obj: ts.ObjectLiteralExpression): { keys: string[]; unresolved: boolean } {
  const keys: string[] = [];
  let unresolved = false;
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
      if (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) keys.push(p.name.text);
      else unresolved = true;
    } else if (ts.isSpreadAssignment(p)) {
      if (ts.isObjectLiteralExpression(p.expression)) {
        const inner = literalKeys(p.expression);
        keys.push(...inner.keys);
        unresolved = unresolved || inner.unresolved;
      } else unresolved = true;
    } else unresolved = true;
  }
  return { keys, unresolved };
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n)
  );
}

/** Same-file callables by name: `function f`, `const f = (...) =>`, class methods. */
function indexCallables(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name) out.set(n.name.text, n);
    else if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) out.set(n.name.text, n);
    else if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) out.set(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Top-level `const NAME = "literal"` (exported or not). */
function indexStringConsts(sf: ts.SourceFile): Map<string, string> {
  const out = new Map<string, string>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.initializer) {
        let init: ts.Expression = d.initializer;
        while (ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
        if (ts.isStringLiteralLike(init)) out.set(d.name.text, init.text);
      }
    }
  }
  return out;
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

function enclosingFunction(n: ts.Node): ts.Node | null {
  let cur: ts.Node | undefined = n.parent;
  while (cur) {
    if (isFunctionLike(cur)) return cur;
    cur = cur.parent;
  }
  return null;
}

/** One parsed source file with the indexes the closure walk needs. */
interface ParsedFile {
  abs: string;
  rel: string;
  sf: ts.SourceFile;
  callables: Map<string, ts.Node>;
  consts: Map<string, string>;
  /** local name → { module abs path, exported name } for relative imports. */
  imports: Map<string, { abs: string; name: string }>;
}

/** `import { a, b as c } from "./x.js"` → local → (abs path of x.ts, exported name). */
function indexImports(sf: ts.SourceFile, fileAbs: string): Map<string, { abs: string; name: string }> {
  const out = new Map<string, { abs: string; name: string }>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause?.namedBindings) continue;
    if (!ts.isStringLiteralLike(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    if (!spec.startsWith(".")) continue;
    const nb = st.importClause.namedBindings;
    if (!ts.isNamedImports(nb)) continue;
    const base = join(fileAbs, "..", spec).replace(/\.js$/, "");
    for (const el of nb.elements) {
      out.set(el.name.text, { abs: base, name: (el.propertyName ?? el.name).text });
    }
  }
  return out;
}

class FileCache {
  private files = new Map<string, ParsedFile | null>();
  constructor(private srcRoot: string) {}
  /** `abs` may lack its extension (an import specifier); `.ts` and `/index.ts` are tried. */
  get(abs: string): ParsedFile | null {
    const candidates = abs.endsWith(".ts") ? [abs] : [`${abs}.ts`, join(abs, "index.ts")];
    for (const c of candidates) {
      if (this.files.has(c)) return this.files.get(c)!;
      let text: string;
      try { text = readFileSync(c, "utf8"); } catch { this.files.set(c, null); continue; }
      const sf = ts.createSourceFile(c, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const pf: ParsedFile = {
        abs: c,
        rel: relative(this.srcRoot, c).split("\\").join("/"),
        sf,
        callables: indexCallables(sf),
        consts: indexStringConsts(sf),
        imports: indexImports(sf, c),
      };
      this.files.set(c, pf);
      return pf;
    }
    return null;
  }
}

/** Resolve a bare `f(...)` / `this.f(...)` callee to its declaration, same file or one import away. */
function resolveCallee(c: ts.CallExpression, f: ParsedFile, cache: FileCache): { node: ts.Node; file: ParsedFile } | null {
  const name = calleeName(c);
  const e = c.expression;
  const bare = ts.isIdentifier(e);
  const viaThis = ts.isPropertyAccessExpression(e) && e.expression.kind === ts.SyntaxKind.ThisKeyword;
  if (!name || !(bare || viaThis)) return null;
  const local = f.callables.get(name);
  if (local) return { node: local, file: f };
  if (!bare) return null;
  const imp = f.imports.get(name);
  const target = imp ? cache.get(imp.abs) : null;
  const fn = target?.callables.get(imp!.name);
  return target && fn ? { node: fn, file: target } : null;
}

/** A string literal, a same-file `const X = "..."`, or an imported one. */
function resolveFlagIn(arg: ts.Expression | undefined, f: ParsedFile, cache: FileCache): string | null {
  if (!arg) return null;
  let a: ts.Expression = arg;
  while (ts.isAsExpression(a) || ts.isParenthesizedExpression(a)) a = a.expression;
  if (ts.isStringLiteralLike(a)) return a.text;
  if (ts.isIdentifier(a)) {
    if (f.consts.has(a.text)) return f.consts.get(a.text)!;
    const imp = f.imports.get(a.text);
    const target = imp ? cache.get(imp.abs) : null;
    if (target?.consts.has(imp!.name)) return target.consts.get(imp!.name)!;
  }
  return null;
}

interface ClosureNode { node: ts.Node; file: ParsedFile }

/** Flags a callable reads DIRECTLY (literal or const-resolved); markers for the unresolvable. */
function directFlagReads(node: ts.Node, f: ParsedFile, cache: FileCache): string[] {
  const out = new Set<string>();
  const visit = (c: ts.Node) => {
    if (ts.isCallExpression(c)) {
      const name = calleeName(c);
      if (name && CAPABILITY_READERS.has(name)) {
        out.add(resolveFlagIn(c.arguments.length === 1 ? c.arguments[0] : c.arguments[1], f, cache) ?? "<unresolved>");
      } else if (name === "isKillSwitchEngaged") {
        out.add("<kill-switch>");
      } else if (ts.isPropertyAccessExpression(c.expression) && (name === "eq" || name === "in")) {
        const a0 = c.arguments[0];
        if (a0 && ts.isStringLiteralLike(a0) && a0.text === "flag" && tableOfChain(c.expression.expression) === "feature_flags") {
          out.add((name === "eq" ? resolveFlagIn(c.arguments[1], f, cache) : null) ?? "<unresolved>");
        }
      }
    }
    ts.forEachChild(c, visit);
  };
  visit(node);
  return [...out];
}

/**
 * A PURE GATE HELPER is a callable that answers "is this on" and does nothing
 * else: it reads a flag (directly, or through another pure gate helper) and
 * names NO schema of its own. `isTripKernelEnabled`, `tripKernelClient`,
 * `liveLabelsServable`, `isTrustEnabled` are the shape:
 *
 *     if (!(await isTripKernelEnabled(sc))) return;   // caller is gated HERE
 *     ...the caller's own schema work...
 *
 * A call to one gates the CALLER at that point exactly as a direct read
 * would, so `scanFlagReads` records a synthetic read there with the caller's
 * closure. A callable that reads a flag AND does schema work of its own is
 * not a helper: its work belongs to its own read (scanned as a root), and
 * an outer closure must stop at it rather than charge its schema outward.
 *
 * Memoised per node; cycles resolve to "not a helper".
 */
/** Every callable reachable from `root` by name, with NO gate cutting — for purity. */
function uncutClosure(root: ts.Node, file: ParsedFile, cache: FileCache, maxHops = 3): ClosureNode[] {
  const seen = new Set<ts.Node>([root]);
  const queue: Array<{ node: ts.Node; file: ParsedFile; hops: number }> = [{ node: root, file, hops: 0 }];
  const out: ClosureNode[] = [];
  while (queue.length) {
    const { node, file: f, hops } = queue.shift()!;
    out.push({ node, file: f });
    const visit = (c: ts.Node) => {
      if (ts.isCallExpression(c)) {
        const r = resolveCallee(c, f, cache);
        if (r && !seen.has(r.node)) {
          seen.add(r.node);
          const hop = r.file === f ? hops : hops + 1;
          if (hop <= maxHops) queue.push({ node: r.node, file: r.file, hops: hop });
        }
      }
      ts.forEachChild(c, visit);
    };
    visit(node);
  }
  return out;
}

const helperFlagsMemo = new Map<ts.Node, string[] | null>();
function pureGateHelperFlags(node: ts.Node, f: ParsedFile, cache: FileCache, hops = 0): string[] | null {
  if (helperFlagsMemo.has(node)) return helperFlagsMemo.get(node)!;
  helperFlagsMemo.set(node, null); // cycle guard
  // Purity is TRANSITIVE: `runPipeline` names no schema itself and delegates
  // to stages that do; it is a pipeline, not a gate.
  const reach = collectRefs(uncutClosure(node, f, cache)).refs;
  if (reach.length > 0) return null;
  const flags = new Set<string>(directFlagReads(node, f, cache));
  const visit = (c: ts.Node) => {
    if (ts.isCallExpression(c)) {
      const r = resolveCallee(c, f, cache);
      if (r && r.node !== node) {
        const hop = r.file === f ? hops : hops + 1;
        if (hop <= 3) for (const fl of pureGateHelperFlags(r.node, r.file, cache, hop) ?? []) flags.add(fl);
      }
    }
    ts.forEachChild(c, visit);
  };
  visit(node);
  const v = flags.size ? [...flags] : null;
  helperFlagsMemo.set(node, v);
  return v;
}

/**
 * A GATE BOUNDARY is a callable that is gated somewhere inside — it reads a
 * flag directly, or calls a pure gate helper. An outer flag's closure stops
 * at it: the schema below belongs to the nearest gate, not the outer flag.
 */
const boundaryMemo = new Map<ts.Node, boolean>();
function isGateBoundary(node: ts.Node, f: ParsedFile, cache: FileCache): boolean {
  if (boundaryMemo.has(node)) return boundaryMemo.get(node)!;
  let v = directFlagReads(node, f, cache).length > 0;
  if (!v) {
    const visit = (c: ts.Node) => {
      if (v) return;
      if (ts.isCallExpression(c)) {
        const r = resolveCallee(c, f, cache);
        if (r && r.node !== node && pureGateHelperFlags(r.node, r.file, cache) !== null) { v = true; return; }
      }
      ts.forEachChild(c, visit);
    };
    visit(node);
  }
  boundaryMemo.set(node, v);
  return v;
}


/**
 * The closure: `root` plus every callable it reaches by name — same-file
 * functions and, following relative `import { f } from "./x.js"` up to
 * `maxHops` files away, the exported function of that name in the imported
 * module. `obj.f(...)` is never followed: it is the driver's or another
 * object's method, not a module function.
 */
function closureOf(root: ts.Node, file: ParsedFile, cache: FileCache, maxHops = 3): ClosureNode[] {
  const seen = new Set<ts.Node>([root]);
  const queue: Array<{ node: ts.Node; file: ParsedFile; hops: number }> = [{ node: root, file, hops: 0 }];
  const out: ClosureNode[] = [];
  while (queue.length) {
    const { node, file: f, hops } = queue.shift()!;
    out.push({ node, file: f });
    const visit = (c: ts.Node) => {
      if (ts.isCallExpression(c)) {
        const r = resolveCallee(c, f, cache);
        if (r && !seen.has(r.node)) {
          seen.add(r.node);
          const hop = r.file === f ? hops : hops + 1;
          if (hop <= maxHops && !isGateBoundary(r.node, r.file, cache)) queue.push({ node: r.node, file: r.file, hops: hop });
        }
      }
      ts.forEachChild(c, visit);
    };
    visit(node);
  }
  return out;
}

function collectRefs(nodes: ClosureNode[]): { refs: SchemaRef[]; unresolved: number } {
  const refs = new Map<string, SchemaRef>();
  let unresolved = 0;
  for (const { node, file } of nodes) {
    const { sf, rel } = file;
    const add = (kind: SchemaRefKind, table: string | null, name: string, at: ts.Node) => {
      const key = kind === "function" ? `${name}()` : kind === "table" ? name : `${table}.${name}`;
      if (refs.has(key)) return;
      refs.set(key, { kind, key, table, name, file: rel, line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1 });
    };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const method = n.expression.name.text;
        const a0 = n.arguments[0];
        if (method === "from") {
          if (a0 && ts.isStringLiteralLike(a0)) { if (a0.text !== "feature_flags") add("table", null, a0.text, a0); }
          else unresolved++;
        } else if (method === "rpc") {
          if (a0 && ts.isStringLiteralLike(a0)) add("function", null, a0.text, a0);
          else unresolved++;
        } else {
          const table = tableOfChain(n.expression.expression);
          if (table && table !== "<dynamic>" && table !== "feature_flags") {
            if (method === "select" && a0) {
              if (ts.isStringLiteralLike(a0) || ts.isNoSubstitutionTemplateLiteral(a0)) {
                for (const c of selectListColumns(a0.text)) add("column", table, c, a0);
              } else if (ts.isIdentifier(a0) && file.consts.has(a0.text)) {
                for (const c of selectListColumns(file.consts.get(a0.text)!)) add("column", table, c, a0);
              } else unresolved++;
            } else if (WRITE_METHODS.has(method) && a0) {
              const payload = ts.isArrayLiteralExpression(a0) ? a0.elements[0] : a0;
              if (payload && ts.isObjectLiteralExpression(payload)) {
                const k = literalKeys(payload);
                for (const c of k.keys) add("column", table, c, a0);
                if (k.unresolved) unresolved++;
              } else unresolved++;
            } else if (FILTER_METHODS.has(method) && a0 && ts.isStringLiteralLike(a0)) {
              if (IDENT_RE.test(a0.text)) add("column", table, a0.text, a0);
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
  }
  return { refs: [...refs.values()], unresolved };
}

/**
 * Scan `srcRoot` for flag reads and the schema each read's closure names.
 * `excludeDirs` are top-level directory names under `srcRoot` to skip
 * (tests are always skipped; `scripts` and `migrations` are the usual extra).
 */
export function scanFlagReads(srcRoot: string, excludeDirs: string[] = ["scripts", "migrations"]): ScanResult {
  const reads: FlagRead[] = [];
  const unresolvedReads: ScanResult["unresolvedReads"] = [];
  const skip = new Set(excludeDirs);
  const files = listTsFiles(srcRoot).filter((f) => !skip.has(relative(srcRoot, f).split(/[\\/]/)[0]!));
  const cache = new FileCache(srcRoot);

  for (const abs of files) {
    const file = cache.get(abs);
    if (!file) continue;
    const { sf, rel } = file;
    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    const resolveFlag = (arg: ts.Expression | undefined): string | null => resolveFlagIn(arg, file, cache);

    const record = (flag: string, reader: string, at: ts.Node) => {
      const fn = enclosingFunction(at);
      const root = fn ?? sf;
      const { refs, unresolved } = collectRefs(closureOf(root, file, cache));
      reads.push({ flag, file: rel, line: lineOf(at), reader, scope: fn ? "function" : "module", refs, unresolved });
    };

    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (name && CAPABILITY_READERS.has(name)) {
          // A reader's own body calling another reader with its parameter
          // (`isLivePlacesCapabilityEnabled` → `isFlagEnabled(sc, flag)`) has a
          // non-literal argument and lands in unresolvedReads, where it
          // belongs: it is a helper, not a gate.
          const flag = n.arguments.length === 1 ? resolveFlag(n.arguments[0]) : resolveFlag(n.arguments[1]);
          if (flag) record(flag, name, n);
          else {
            const expr = (n.arguments.length === 1 ? n.arguments[0] : n.arguments[1])?.getText(sf) ?? "(empty)";
            unresolvedReads.push({ file: rel, line: lineOf(n), reader: name, expr });
          }
        } else if (name && !ts.isPropertyAccessExpression(n.expression) || (name && ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword)) {
          // A call to a GATE HELPER — a function that reads a flag and returns
          // the answer (`if (!(await isTripKernelEnabled(sc))) return`). The
          // caller is gated on that flag at this point exactly as if it had
          // read it, so a synthetic read is recorded here with the CALLER's
          // closure. Without this, code guarded through a helper has no flag
          // and code reached from an outer flag is charged to the wrong one.
          const r = resolveCallee(n, file, cache);
          if (r && r.node !== enclosingFunction(n)) {
            const helperFlags = pureGateHelperFlags(r.node, r.file, cache);
            if (helperFlags) for (const fl of helperFlags) if (!fl.startsWith("<")) record(fl, `via ${name}()`, n);
          }
        } else if (ts.isPropertyAccessExpression(n.expression) && (name === "eq" || name === "in")) {
          const table = tableOfChain(n.expression.expression);
          const a0 = n.arguments[0];
          if (table === "feature_flags" && a0 && ts.isStringLiteralLike(a0) && a0.text === "flag") {
            const a1 = n.arguments[1];
            if (name === "eq") {
              const flag = resolveFlag(a1);
              if (flag) record(flag, "direct", n);
              else unresolvedReads.push({ file: rel, line: lineOf(n), reader: "direct", expr: a1?.getText(sf) ?? "(empty)" });
            } else if (a1 && ts.isArrayLiteralExpression(a1)) {
              for (const el of a1.elements) {
                const flag = resolveFlag(el);
                if (flag) record(flag, "direct", n);
              }
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { reads, filesScanned: files.length, unresolvedReads };
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export type Classification = "unguarded" | "guarded" | "latent" | "ok";

export interface FlagFinding {
  flag: string;
  production: ProductionFlagState;
  classification: Classification;
  registered: boolean;
  reads: Array<{ file: string; line: number; reader: string }>;
  /** Every absent object, with where the closure names it. */
  missing: SchemaRef[];
  /** All distinct objects the closures name (absent or not). */
  refCount: number;
  unresolved: number;
}

export function evaluateFlags(
  scan: ScanResult,
  snap: ProductionSnapshot,
  registry: Readonly<Record<string, CapabilityDefinition>>,
): FlagFinding[] {
  const byFlag = new Map<string, FlagRead[]>();
  for (const r of scan.reads) {
    if (!byFlag.has(r.flag)) byFlag.set(r.flag, []);
    byFlag.get(r.flag)!.push(r);
  }
  const out: FlagFinding[] = [];
  for (const [flag, reads] of [...byFlag.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const refs = new Map<string, SchemaRef>();
    let unresolved = 0;
    for (const r of reads) {
      unresolved += r.unresolved;
      for (const ref of r.refs) if (!refs.has(ref.key)) refs.set(ref.key, ref);
    }
    const missing = [...refs.values()].filter((ref) => isAbsentInProduction(snap, ref));
    const production = productionFlagState(snap, flag);
    const registered = flag in registry;
    let classification: Classification = "ok";
    if (missing.length > 0) {
      if (production === "on") classification = registered ? "guarded" : "unguarded";
      else classification = "latent";
    }
    out.push({
      flag,
      production,
      classification,
      registered,
      reads: reads.map((r) => ({ file: r.file, line: r.line, reader: r.reader })),
      missing: missing.sort((a, b) => a.key.localeCompare(b.key)),
      refCount: refs.size,
      unresolved,
    });
  }
  return out;
}

// ── Registry evaluation ──────────────────────────────────────────────────────

export interface RegistryFinding {
  flag: string;
  production: ProductionFlagState;
  /** Required objects absent from the production snapshot. */
  missingInProduction: string[];
  /** Required objects no migration in the tree declares — a registry typo. */
  undeclared: string[];
  /** Consumers listed that do not exist, or do not name the flag. */
  badConsumers: string[];
  /** Flag reads in the tree for this flag (the registry must guard something). */
  readSites: number;
}

export function evaluateRegistry(
  registry: Readonly<Record<string, CapabilityDefinition>>,
  snap: ProductionSnapshot,
  scan: ScanResult,
  declares: { column: (table: string, column: string) => boolean; table: (table: string) => boolean; fn: (name: string) => boolean },
  readConsumer: (rel: string) => string | null,
): RegistryFinding[] {
  const out: RegistryFinding[] = [];
  for (const def of Object.values(registry)) {
    const missingInProduction: string[] = [];
    const undeclared: string[] = [];
    for (const [table, req] of Object.entries(def.requires.tables)) {
      const cols = snap.tables.get(table);
      if (!declares.table(table)) undeclared.push(table);
      if (!cols) { missingInProduction.push(table); continue; }
      for (const c of req.columns) {
        if (!cols.has(c)) missingInProduction.push(`${table}.${c}`);
        if (!declares.column(table, c)) undeclared.push(`${table}.${c}`);
      }
    }
    for (const f of def.requires.functions ?? []) {
      if (!snap.functions.has(f)) missingInProduction.push(`${f}()`);
      if (!declares.fn(f)) undeclared.push(`${f}()`);
    }
    const badConsumers: string[] = [];
    for (const c of def.consumers) {
      const src = readConsumer(c);
      if (src === null) badConsumers.push(`${c} (not found)`);
      else if (!src.includes(def.flag)) badConsumers.push(`${c} (does not name ${def.flag})`);
      else if (!/capability\/|SchemaCapability|schemaCapability/.test(src)) badConsumers.push(`${c} (does not reach lib/capability)`);
    }
    out.push({
      flag: def.flag,
      production: productionFlagState(snap, def.flag),
      missingInProduction,
      undeclared,
      badConsumers,
      readSites: scan.reads.filter((r) => r.flag === def.flag).length,
    });
    void requiredObjects; // re-exported for the shell's report
  }
  return out;
}

export { requiredObjects };
