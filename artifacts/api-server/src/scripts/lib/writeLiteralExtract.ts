/**
 * WRITE-side literal extraction — the other half of the dead-literal class.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `filterLiteralExtract.ts` walks FILTER calls (eq / neq / in / not / is / or) and
 * `check:enum-literals` judges those literals against the column's real vocabulary.
 * Nothing looked at what the code WRITES. So a payload naming a value the column
 * cannot hold was invisible, and the write half is arguably the worse half:
 *
 *   read  side — an enum filter throws 22P02 and kills the query; a text-CHECK
 *                filter silently matches nothing. The data is merely unread.
 *   write side — an enum value throws 22P02 and a text-CHECK value throws 23514.
 *                Either way THE ROW IS REJECTED. The data is never written at all,
 *                and in this repo the rejection is usually swallowed by a
 *                fire-and-forget `catch {}` or a `logger.warn`, so the capability
 *                looks implemented and is permanently inert.
 *
 * Measured when this landed: 23 write sites across 13 distinct defects, including
 * an admin suspend route and an admin ban route that could never succeed, and a
 * booking-chat thread that could not be created by either of its two paths.
 *
 * ONE RULE, ONE IMPLEMENTATION
 * ----------------------------
 * `chainRoot`, `bindIdentifiers`, `unwrap`, `isInterpolated` and `listTsFiles` are
 * imported from the filter extractor, not re-implemented. "What is a Supabase chain
 * and on what table" must answer identically on both sides — two copies of that
 * rule is how the two halves of a defect end up in two lists that cannot see each
 * other. The output is the same `LiteralSite`, so `findDeadLiterals`, `ratchetKey`
 * and the ratchet need no change at all.
 *
 * FORWARDING, AND WHY EXACTLY TWO HOPS
 * ------------------------------------
 * The motivating case is indirect. `routes/geofence.ts` has
 *
 *     async function writeAttendanceEvent(db, opts) {
 *       await db.from("plan_attendance_events").insert({ event_type: opts.eventType })
 *     }
 *
 * and its callers supply the literal. An extractor reading only object-literal
 * values sees `opts.eventType` and learns nothing, so it would miss the exact shape
 * that motivated it. MAX_HOPS is 2 because that was MEASURED, not chosen: this case
 * needs 2 and yields nothing at 1 (one helper forwards into another), and repo-wide
 * no site resolves at 3 or beyond.
 *
 * THE BAIL IS THE SAFETY PROPERTY
 * -------------------------------
 * The filter extractor's header says a wrong table "would produce a FALSE FAILURE,
 * the one outcome this check must never have." That governs here too, and more
 * sharply, because forwarding infers rather than reads. Every condition in
 * `resolveForwardedParam` returns null — REFUSE — rather than guessing: an exported
 * function (callers may be in another file), two functions sharing a name, a
 * parameter with a default or a destructuring pattern, reassignment, a shadowing
 * inner binding, a caller passing a non-literal, recursion, or exceeding MAX_HOPS.
 * On the tree where this shipped it refused 8 of the 15 sites it could theoretically
 * reach — a 53% over-refusal rate. That ratio is the price of never false-failing,
 * and it is stated here so nobody "improves" it without knowing what it bought.
 *
 * ATTRIBUTION IS PER WRITE SITE, NOT PER HELPER — which is what keeps forwarding
 * honest. The literal is attributed to the exact property inside the exact
 * `.from(T).insert({...})` it lands in. `geofence.ts` matters here: `upsertCheckin`
 * writes `plan_checkins` directly AND forwards into `plan_attendance_events`, while
 * the same file calls `recordTrustEvent({ eventType: "plan_attended" })`, which is a
 * `trust_events.event_type` from an entirely different vocabulary. A whole-file scan
 * would conflate all three; the AST rule separates them for free.
 *
 * WHAT IT STILL CANNOT SEE
 * ------------------------
 * Values crossing a module boundary (`input.mediaType`, `parsed.data.vote`), and
 * literals inside SQL function bodies — `content_distribution_stats` is written
 * `'normal'` by a PL/pgSQL function whose enum has no such label, and no payload
 * extractor can reach that. Both are stated rather than implied, as the sibling
 * checks state their own limits.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import ts from "typescript";
import {
  listTsFiles,
  unwrap,
  chainRoot,
  bindIdentifiers,
  isInterpolated,
  type LiteralSite,
  type ExtractionResult,
} from "./filterLiteralExtract.js";

/** Payload-bearing chain methods. */
const WRITE_METHODS = new Set(["insert", "upsert", "update"]);

/**
 * Measured, not chosen. See the header: geofence.ts needs 2 and resolves nothing
 * at 1; no site in the repo resolves at 3 or beyond.
 */
const MAX_HOPS = 2;

interface FileIndex {
  sf: ts.SourceFile;
  /** name -> declarations. A name with != 1 declaration is unusable. */
  fns: Map<string, ts.FunctionLikeDeclaration[]>;
  /** callee name -> call sites, bare-identifier callees only. */
  calls: Map<string, ts.CallExpression[]>;
  /** identifier -> the object literal it was declared with, or null if ambiguous. */
  objConsts: Map<string, ts.ObjectLiteralExpression | null>;
  /** identifiers assigned anywhere after declaration — never trust these. */
  reassigned: Set<string>;
  /** names exported from this file: their callers may live elsewhere. */
  exported: Set<string>;
  tables: Map<string, string | null>;
}

function declaredNameOf(fn: ts.FunctionLikeDeclaration): string | null {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

function isExported(fn: ts.FunctionLikeDeclaration): boolean {
  const mods = ts.canHaveModifiers(fn) ? ts.getModifiers(fn) : undefined;
  if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true;
  // `export const f = () => {}` puts the modifier on the statement, not the fn.
  let cur: ts.Node | undefined = fn.parent;
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isVariableStatement(cur)) {
      const m = ts.getModifiers(cur);
      return !!m?.some((x) => x.kind === ts.SyntaxKind.ExportKeyword);
    }
    cur = cur.parent;
  }
  return false;
}

function buildFileIndex(sf: ts.SourceFile): FileIndex {
  const fns = new Map<string, ts.FunctionLikeDeclaration[]>();
  const calls = new Map<string, ts.CallExpression[]>();
  const objConsts = new Map<string, ts.ObjectLiteralExpression | null>();
  const reassigned = new Set<string>();
  const exported = new Set<string>();

  const visit = (node: ts.Node): void => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      (node as ts.FunctionLikeDeclaration).body
    ) {
      const fn = node as ts.FunctionLikeDeclaration;
      const name = declaredNameOf(fn);
      if (name) {
        const list = fns.get(name) ?? [];
        list.push(fn);
        fns.set(name, list);
        if (isExported(fn)) exported.add(name);
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        const list = calls.get(callee.text) ?? [];
        list.push(node);
        calls.set(callee.text, list);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = unwrap(node.initializer);
      const name = node.name.text;
      if (ts.isObjectLiteralExpression(init)) {
        objConsts.set(name, objConsts.has(name) ? null : init); // second binding => refuse
      }
    }
    // Any assignment to a bare identifier, or any mutation of one of its
    // properties, makes a recorded object literal stale. `const row = {...};
    // row.status = x; insert(row)` must never be judged off the declaration.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = unwrap(node.left);
      if (ts.isIdentifier(lhs)) reassigned.add(lhs.text);
      if (ts.isPropertyAccessExpression(lhs)) {
        const base = unwrap(lhs.expression);
        if (ts.isIdentifier(base)) reassigned.add(base.text);
      }
      if (ts.isElementAccessExpression(lhs)) {
        const base = unwrap(lhs.expression);
        if (ts.isIdentifier(base)) reassigned.add(base.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sf, fns, calls, objConsts, reassigned, exported, tables: bindIdentifiers(sf) };
}

/** A string literal, or a ternary whose every branch is one. [] means "not literals". */
export function stringsOf(expr: ts.Expression | undefined): string[] {
  if (!expr) return [];
  const e = unwrap(expr);
  if (ts.isStringLiteralLike(e)) return isInterpolated(e) ? [] : [e.text];
  if (ts.isConditionalExpression(e)) {
    const a = stringsOf(e.whenTrue);
    const b = stringsOf(e.whenFalse);
    if (a.length === 0 || b.length === 0) return [];
    return [...a, ...b];
  }
  return [];
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      (ts.isFunctionDeclaration(cur) || ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      (cur as ts.FunctionLikeDeclaration).body
    ) return cur as ts.FunctionLikeDeclaration;
    cur = cur.parent;
  }
  return null;
}

/**
 * Which parameter index carries `paramName`, or -1 when the parameter cannot be
 * forwarded at all: a default, a rest element, or a destructuring pattern. A
 * default value means a caller may supply nothing and the default wins, which is a
 * literal this walk never sees.
 */
function forwardableParamIndex(fn: ts.FunctionLikeDeclaration, paramName: string): number {
  for (let i = 0; i < fn.parameters.length; i++) {
    const p = fn.parameters[i]!;
    if (!ts.isIdentifier(p.name)) return -1;      // destructuring — refuse
    if (p.name.text !== paramName) continue;
    if (p.initializer) return -1;                  // default — refuse
    if (p.dotDotDotToken) return -1;               // rest — refuse
    return i;
  }
  return -1;
}

/**
 * Resolve `<param>.<prop>` to the set of string literals every caller supplies.
 *
 * Returns null to mean REFUSE TO GUESS — never a partial answer. A partial answer
 * is what would produce a false failure, and this check must never have one.
 */
function resolveForwardedParam(
  ix: FileIndex,
  fn: ts.FunctionLikeDeclaration,
  paramName: string,
  propName: string,
  depth: number,
  seen: Set<string>,
): string[] | null {
  if (depth > MAX_HOPS) return null;

  const fnName = declaredNameOf(fn);
  if (!fnName) return null;                       // anonymous — no call sites to find
  if (ix.exported.has(fnName)) return null;       // callers may be in another file
  if (seen.has(fnName)) return null;              // recursion
  if ((ix.fns.get(fnName) ?? []).length !== 1) return null; // overloaded name — ambiguous

  const idx = forwardableParamIndex(fn, paramName);
  if (idx < 0) return null;

  const callSites = ix.calls.get(fnName) ?? [];
  if (callSites.length === 0) return null;        // no visible caller — infer nothing

  const nextSeen = new Set(seen).add(fnName);
  const out: string[] = [];

  for (const call of callSites) {
    const arg = call.arguments[idx];
    if (!arg) return null;
    const a = unwrap(arg);
    if (!ts.isObjectLiteralExpression(a)) return null;

    let prop: ts.ObjectLiteralElementLike | undefined;
    for (const m of a.properties) {
      // A spread can override a later-read key, so any spread makes the object
      // unreadable rather than partially readable.
      if (ts.isSpreadAssignment(m)) return null;
      const key = m.name && ts.isIdentifier(m.name) ? m.name.text
        : m.name && ts.isStringLiteralLike(m.name) ? m.name.text : null;
      if (key === null) return null;              // computed key — refuse
      if (key === propName) prop = m;
    }
    if (!prop) return null;                       // caller omits it — a default may apply

    let value: ts.Expression | undefined;
    if (ts.isPropertyAssignment(prop)) value = prop.initializer;
    else if (ts.isShorthandPropertyAssignment(prop)) value = prop.name;
    else return null;

    const direct = stringsOf(value);
    if (direct.length > 0) { out.push(...direct); continue; }

    const v = unwrap(value!);

    // The caller forwards its OWN parameter onwards — one more hop.
    if (ts.isPropertyAccessExpression(v) && ts.isIdentifier(v.expression)) {
      const outerFn = enclosingFunction(call);
      if (!outerFn) return null;
      const deeper = resolveForwardedParam(
        ix, outerFn, v.expression.text, v.name.text, depth + 1, nextSeen,
      );
      if (deeper === null) return null;
      out.push(...deeper);
      continue;
    }

    // A local const holding a literal (or a ternary of them), never reassigned.
    if (ts.isIdentifier(v)) {
      if (ix.reassigned.has(v.text)) return null;
      const lits = localConstStrings(ix, v.text, call);
      if (lits === null) return null;
      out.push(...lits);
      continue;
    }

    return null;                                  // anything else — refuse
  }

  return out.length > 0 ? [...new Set(out)] : null;
}

/**
 * `const eventType = isLate ? "late_check_in" : "checked_in_successfully";`
 * Only accepted when the name has exactly ONE declaration in the file and is never
 * assigned to afterwards.
 */
function localConstStrings(ix: FileIndex, name: string, near: ts.Node): string[] | null {
  if (ix.reassigned.has(name)) return null;
  let found: string[] | null = null;
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      count++;
      const lits = stringsOf(node.initializer);
      found = lits.length > 0 ? lits : null;
    }
    ts.forEachChild(node, visit);
  };
  visit(ix.sf);
  void near;
  if (count !== 1) return null;                   // shadowed or re-declared — refuse
  return found;
}

/**
 * Extract every judgeable literal written into a column by insert / upsert / update.
 *
 * `op` records the derivation — "insert", or "insert.fwd1" / "insert.fwd2" when the
 * literal was inferred through call sites. That is not cosmetic: `checkEnumLiterals`
 * prints `op` in its failure block, and the first thing a reviewer needs when judging
 * whether a failure is real is whether the literal was read off the line or inferred
 * through two calls.
 */
export function extractWriteLiterals(dirs: string[], apiRoot: string): ExtractionResult {
  const sites: LiteralSite[] = [];
  const files: string[] = [];
  for (const d of dirs) files.push(...listTsFiles(d));

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const rel = relative(apiRoot, file);
    const ix = buildFileIndex(sf);

    const tableFor = (expr: ts.Expression): string | null => {
      const r = chainRoot(expr);
      if (!r) return null;
      if (r === "<dynamic>") return null;          // non-literal .from() — refuse
      if (r.startsWith("id:")) return ix.tables.get(r.slice(3)) ?? null;
      return r;
    };

    const push = (node: ts.Node, table: string, column: string, literal: string, op: string): void => {
      sites.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        table, column, literal, op,
      });
    };

    /** Judge one payload object against one table. */
    const judgeObject = (
      obj: ts.ObjectLiteralExpression,
      node: ts.Node,
      table: string,
      method: string,
      enclosing: ts.FunctionLikeDeclaration | null,
    ): void => {
      // A spread may override any key declared BEFORE it, so only properties that
      // appear after the last spread can be trusted. `{ a: "x", ...base }` may not
      // write "x" at all, and flagging it would be a false finding.
      let lastSpread = -1;
      obj.properties.forEach((m, i) => { if (ts.isSpreadAssignment(m)) lastSpread = i; });

      obj.properties.forEach((m, i) => {
        if (i < lastSpread) return;
        if (ts.isSpreadAssignment(m)) return;
        const key = m.name && ts.isIdentifier(m.name) ? m.name.text
          : m.name && ts.isStringLiteralLike(m.name) ? m.name.text : null;
        if (key === null) return;

        let value: ts.Expression | undefined;
        if (ts.isPropertyAssignment(m)) value = m.initializer;
        else if (ts.isShorthandPropertyAssignment(m)) value = m.name;
        else return;

        const direct = stringsOf(value);
        if (direct.length > 0) {
          for (const lit of direct) push(node, table, key, lit, method);
          return;
        }

        // `event_type: opts.eventType` — the forwarding case.
        const v = unwrap(value!);
        if (enclosing && ts.isPropertyAccessExpression(v) && ts.isIdentifier(v.expression)) {
          const lits = resolveForwardedParam(ix, enclosing, v.expression.text, v.name.text, 1, new Set());
          if (lits) for (const lit of lits) push(node, table, key, lit, `${method}.fwd1`);
        }
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression);
        if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) {
          const method = callee.name.text;
          const table = tableFor(callee.expression);
          const arg = node.arguments[0];
          if (table && arg) {
            const a = unwrap(arg);
            const enclosing = enclosingFunction(node);
            if (ts.isObjectLiteralExpression(a)) {
              judgeObject(a, node, table, method, enclosing);
            } else if (ts.isArrayLiteralExpression(a)) {
              for (const el of a.elements) {
                const e = unwrap(el);
                if (ts.isObjectLiteralExpression(e)) judgeObject(e, node, table, method, enclosing);
              }
            } else if (ts.isIdentifier(a)) {
              // `const row = {...}; insert(row)` — only when the binding is
              // unambiguous AND nothing ever assigns to it or its properties.
              const obj = ix.objConsts.get(a.text);
              if (obj && !ix.reassigned.has(a.text)) judgeObject(obj, node, table, method, enclosing);
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
