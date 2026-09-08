/**
 * check-unchecked-supabase-reads — a security-critical READ must observe its
 * `.error`.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error. It does not throw. So:
 *
 *     const { data } = await db.from("x").select("...").eq(...).maybeSingle();
 *     if (!data) return null;          // a DB ERROR reads as "no such row"
 *
 * A failed query is indistinguishable from an empty result, and on an
 * authorization path the empty result is usually the PERMISSIVE answer. The
 * session that wrote this guard found the shape on five surfaces — the
 * routes/events.ts trust-score gate (a failed `trust_profiles` read became
 * "no profile", took the default score and admitted the caller; commit
 * 10a91737), routes/tripCrewLocation.ts `getMemberRole`, services/airport
 * LayoverRecommendationService `getRecommendations`, the routes/airport.ts
 * plan-add read, and routes/discovery.ts viewer resolution. A `try/catch`
 * around the read does NOT help — the catch never fires, because nothing was
 * thrown. This tree has 2,000+ reads of that shape; the scope below is the
 * ring where the empty answer is an ACCESS or STATE decision.
 *
 * ── WHAT IS FLAGGED ─────────────────────────────────────────────────────────
 * A PostgREST read chain — rooted at `.from("table")` with no write method in
 * the chain, or `.rpc("fn")` whose `data` is consumed — whose result is used
 * in one of these shapes:
 *
 *   data-only     `const { data } = await …`         — `error` never bound
 *   error-unread  `const { data, error } = await …`  — bound, then never read
 *   member-only   `const r = await …; r.data`        — `r.error` never touched
 *   discarded     `await db.from("t").select(…);`    — result thrown away
 *
 * "Read" means any reference to the bound name after the binding, within its
 * lexical block: a branch, a throw, a log argument, a return, a passthrough.
 * Consumers are resolved structurally, not textually: direct `await`, a chain
 * bound to a variable and awaited later (`const q = …; await q`), elements of
 * `await Promise.all([...])` matched to their array-binding position, and
 * `.then(({ data }) => …)` callbacks. A chain carrying `.throwOnError()` is
 * exempt — that call makes the promise reject, so the error IS observed.
 *
 * ── SCOPE: THREE TIERS, EACH DEFENSIBLE ON ITS OWN ─────────────────────────
 * Judged everywhere under SCOPE_DIRS, a read is IN SCOPE when any holds:
 *
 *   exclusion-table  the table is one where a ROW means DENY (`blocks`, mutes,
 *                    restrictions, trust caps, account bans). Empty means
 *                    ALLOW, so a dropped error is fail-OPEN by construction —
 *                    there is no direction to argue about.
 *   gate-function    the enclosing helper's NAME promises an authorization,
 *                    eligibility, visibility or dedupe answer (require*, can*,
 *                    is*, has*, check*, verify*, ensure*, …Role, …Access,
 *                    …Eligib…, …Viewer, …Admin, …Privacy, …Visib…). A function
 *                    named `isBlocked` or `checkEligibility` that turns a DB
 *                    error into its answer is the defect, whichever way the
 *                    answer falls. Route handlers (`get /path`) are NOT this
 *                    tier — see below.
 *   guard-file       the FILE's name says it is an authorization surface
 *                    (…Guard.ts, …Permissions.ts, …Access.ts, …Privacy….ts,
 *                    …Visibility.ts). `resolveGemCoords` promises nothing by
 *                    name and reveals exact coordinates; its file does.
 *   flag-table       reads of `feature_flags`. Whether "flag unreadable → off"
 *                    is safe depends on the flag's polarity (a kill-switch
 *                    read as "off" is fail-open); check:flag-polarity records
 *                    the polarity, this guard demands the error be seen.
 *
 * DELIBERATELY OUT OF SCOPE, with the number printed on every run so the blind
 * spot is measured rather than implied: inline membership/ownership checks in
 * route handlers, entity loads (`if (!post) 404`), listings, and enrichment.
 * Those are ~1,900 sites; by shape they are fail-closed (no row → 404/403), and
 * a ring that size cannot be classified honestly in one pass. `--all` lists
 * them. Also never judged: write chains (`.insert/.update/.upsert/.delete`,
 * even with a trailing `.select()` — check:silent-supabase-writes territory),
 * `.auth.*`, `.storage.*`, `.channel()`, chains returned/passed/thunked to
 * another function (no cross-function analysis; counted as `delegated`), and
 * anything under src/test/**, src/scripts/**, generated types.
 *
 * ── ALLOWLIST CONTRACT (UNCHECKED_READS_ALLOWLIST.json) ─────────────────────
 * Two sections, both keyed by a STRUCTURAL site key —
 * `<file>::<enclosing fn>::<table>.<terminal>[#n]` — so line churn does not
 * invalidate an entry but moving or renaming the read does (it must be
 * re-judged).
 *
 *   benign         emptiness is genuinely the right answer at this site even
 *                  on error and nothing needs to know (a label lookup, a
 *                  ranking enrichment). Rationale REQUIRED (>= 40 chars).
 *   known_defects  the burn-down ledger, the same device as
 *                  SILENT_SUPABASE_WRITES_BASELINE.json: sites that ignore
 *                  their error today and must be fixed by their owning lane.
 *                  Each note MUST start with `FAIL-OPEN:`, `FAIL-CLOSED:` or
 *                  `UNCLASSIFIED:` so the direction is recorded, not assumed.
 *
 * Any entry whose site no longer exists FAILS the check (the file cannot rot;
 * fixing a site means deleting its line). Any entry with no rationale/label
 * FAILS. A NEW in-scope site FAILS. Nothing here is a permission to leave a
 * defect in place — the ledger exists so the guard can land green and then
 * only ever shrink.
 *
 * ── VACUITY ─────────────────────────────────────────────────────────────────
 * Zero files scanned, zero read sites judged, a source file the parser
 * rejects, or an allowlist that cannot be parsed each exit non-zero. A guard
 * that scans nothing and prints green is the trap this repo has hit
 * repeatedly (see check-guard-coverage.mjs for the last time).
 *
 * Run: node --import tsx/esm src/scripts/checkUncheckedSupabaseReads.ts [--all] [--json]
 *   --all   also print out-of-scope and ledgered sites (triage)
 *   --json  machine-readable output
 * Exit 0 only when every in-scope site is fixed, benign-with-rationale, or
 * ledgered-with-direction AND nothing above is vacuous. Exit 1 otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, relative, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { listSourceFiles } from "./lib/tableAccessExtract.js";

const __dir = dirname(fileURLToPath(import.meta.url));
/**
 * Test hooks. The exit-code proof in src/test/uncheckedSupabaseReads.test.ts
 * points the CLI at a scratch tree (an empty one must FAIL; one holding the
 * reconstructed events.ts defect must FAIL; the fixed form must PASS). Both
 * default to the real tree and the real allowlist; nothing in CI sets them.
 */
export const SRC_ROOT = process.env.UNCHECKED_READS_SRC_ROOT ? resolve(process.env.UNCHECKED_READS_SRC_ROOT) : resolve(__dir, "..");

/**
 * Roots walked. HTTP handlers and their inline helpers (routes), the domain
 * layer they call (services), shared authorization helpers (lib), plus the
 * engines and middleware that make the same kind of decision one directory
 * over. src/test and src/scripts are never walked (listSourceFiles skips
 * *.test.ts; scripts are not on this list).
 */
export const SCOPE_DIRS = ["routes", "services", "lib", "middlewares", "security", "presence", "compass"];

/** A ROW here means DENY. Empty means allow, so a dropped error is fail-open. */
export const EXCLUSION_TABLES = new Set([
  "blocks",
  "user_blocks",
  "user_mutes",
  "user_restrictions",
  "trust_restrictions",
  "trust_caps",
  "user_account_states",
]);

/** Polarity-dependent gates; the error must be seen whichever way the flag reads. */
export const FLAG_TABLES = new Set(["feature_flags"]);

/**
 * Helper names that promise an authorization / eligibility / visibility /
 * dedupe answer. Prefix OR word match; route handlers (`get /path`) are
 * excluded because the name is a URL, not a promise.
 */
export const GATE_NAME_PREFIX = /^(require|assert|ensure|verify|authori[sz]e|guard|enforce|can|may|is|has|check)(?=[A-Z_])/;
export const GATE_NAME_WORD = /(Role|Eligib|Gate|Permission|Permitted|Allowed|Access|Membership|MemberIds|Viewer|Owner|Admin|Blocked|Privacy|Visib|Moderat|Verdict|Consent)/;
const ROUTE_HANDLER_NAME = /^(get|post|put|patch|delete|all|use) [/*]/;

/**
 * Files whose NAME says they are an authorization surface. A read inside
 * `HiddenGemPrivacyGuard.ts` decides what gets revealed whatever its helper is
 * called (`resolveGemCoords` promises nothing by name, and reveals exact
 * coordinates).
 */
export const GUARD_FILE_NAME = /(Guard|Permission|Access|Privacy|Visibility|Authori[sz]|Membership)[^/]*\.ts$/;

export function isGateFunctionName(fn: string): boolean {
  if (ROUTE_HANDLER_NAME.test(fn)) return false;
  return GATE_NAME_PREFIX.test(fn) || GATE_NAME_WORD.test(fn);
}

export const ALLOWLIST_PATH = process.env.UNCHECKED_READS_ALLOWLIST ? resolve(process.env.UNCHECKED_READS_ALLOWLIST) : resolve(__dir, "UNCHECKED_READS_ALLOWLIST.json");
/** A rationale shorter than this is not a rationale. */
export const MIN_RATIONALE_CHARS = 40;
export const DIRECTION_LABELS = ["FAIL-OPEN:", "FAIL-CLOSED:", "UNCLASSIFIED:"] as const;

const WRITE_METHODS = new Set(["insert", "upsert", "update", "delete"]);
/** Writes that CREATE a durable row. update/delete cannot duplicate one. */
const CREATE_METHODS = new Set(["insert", "upsert"]);
const RESULT_MEMBERS = new Set(["data", "count", "error", "status", "statusText"]);

export type Shape = "data-only" | "error-unread" | "member-only" | "discarded";
export type Terminal = "maybeSingle" | "single" | "select" | "rpc" | "filter";
export type Tier = "exclusion-table" | "gate-function" | "guard-file" | "flag-table" | "write-precondition";

export interface UncheckedRead {
  file: string;
  line: number;
  /** Structural key used by the allowlist. */
  key: string;
  shape: Shape;
  terminal: Terminal;
  table: string;
  fn: string;
  excerpt: string;
  /** Why this read is in scope; null when it is not. */
  tier: Tier | null;
}

export function tierOf(
  read: Pick<UncheckedRead, "table" | "fn" | "file" | "terminal">,
  /** Tables WRITTEN inside the same enclosing function. See the write-precondition tier. */
  writtenInFn?: ReadonlySet<string>,
): Tier | null {
  if (EXCLUSION_TABLES.has(read.table)) return "exclusion-table";
  if (isGateFunctionName(read.fn)) return "gate-function";
  if (GUARD_FILE_NAME.test(read.file)) return "guard-file";
  if (FLAG_TABLES.has(read.table)) return "flag-table";
  // Checked LAST so it is purely additive: nothing already in scope is
  // reclassified, only reads that had no tier at all can gain this one.
  if (writtenInFn?.has(read.table) && (read.terminal === "maybeSingle" || read.terminal === "single")) {
    return "write-precondition";
  }
  return null;
}

// ── AST helpers ─────────────────────────────────────────────────────────────

function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur) ||
    ts.isSatisfiesExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

interface ChainInfo {
  root: "from" | "rpc";
  table: string;
  /** Every method name in the chain, root first. */
  methods: string[];
  /** Bare identifier at the bottom of the chain, when the root is not inline. */
  viaIdentifier?: string;
}

const NON_TABLE_RECEIVERS = new Set(["storage", "auth", "realtime", "functions"]);
const BUILTIN_FROM_RECEIVERS = /^(Array|Buffer|Uint8Array|Int8Array|Uint16Array|Int32Array|Float32Array|Float64Array|Set|Map|Object|Promise|Observable|BigInt)$/;

/**
 * Walk DOWN a call chain to its root. Returns the chain when it is a PostgREST
 * read; null for writes, storage, auth, realtime, and non-supabase chains.
 * `viaIdentifier` is set when the chain bottoms out on a plain identifier
 * (`await query`, or `q.eq(...)` where `q = db.from("t").select()`), so the
 * caller can look the binding up.
 */
function describeChain(expr: ts.Expression): ChainInfo | null {
  let cur = unwrap(expr);
  const methods: string[] = [];
  for (;;) {
    if (ts.isCallExpression(cur)) {
      const callee = unwrap(cur.expression);
      if (!ts.isPropertyAccessExpression(callee)) return null; // `fn(...)` — not a chain
      const name = callee.name.text;
      methods.unshift(name);
      if (name === "from" || name === "rpc") {
        const recv = unwrap(callee.expression);
        if (ts.isPropertyAccessExpression(recv) && NON_TABLE_RECEIVERS.has(recv.name.text)) return null;
        if (ts.isCallExpression(recv)) {
          const inner = unwrap(recv.expression);
          if (ts.isPropertyAccessExpression(inner) && NON_TABLE_RECEIVERS.has(inner.name.text)) return null;
        }
        if (ts.isIdentifier(recv) && /storage/i.test(recv.text)) return null;
        if (ts.isIdentifier(recv) && BUILTIN_FROM_RECEIVERS.test(recv.text)) return null; // Array.from
        if (methods.some((m) => WRITE_METHODS.has(m))) return null; // write chain
        const arg = cur.arguments[0];
        const table = arg && ts.isStringLiteralLike(arg) ? arg.text : "<dynamic>";
        return { root: name, table, methods };
      }
      cur = unwrap(callee.expression);
      continue;
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = unwrap(cur.expression);
      continue;
    }
    if (ts.isIdentifier(cur)) {
      if (methods.length === 0) return null;
      if (methods.some((m) => WRITE_METHODS.has(m))) return null;
      return { root: "from", table: "<via-identifier>", methods, viaIdentifier: cur.text };
    }
    return null;
  }
}

function terminalOf(methods: string[], root: "from" | "rpc"): Terminal {
  const last = methods[methods.length - 1];
  if (last === "maybeSingle" || last === "single") return last;
  if (root === "rpc") return "rpc";
  if (last === "select") return "select";
  return "filter";
}

/**
 * Nearest enclosing function-ish name for the structural key. Walks through
 * wrapper calls (`asyncHandler(async (req, res) => …)`) so a route handler is
 * named `get /path`, not `<module>`.
 */
function enclosingFunctionName(node: ts.Node): string {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) {
      if (ts.isFunctionExpression(cur) && cur.name) return cur.name.text;
      const p: ts.Node = cur.parent;
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
      // router.get("/path", …, async (req, res) => …) — possibly through a wrapper call.
      let up: ts.Node | undefined = p;
      while (up && (ts.isCallExpression(up) || ts.isParenthesizedExpression(up))) {
        if (ts.isCallExpression(up)) {
          const callee: ts.Expression = unwrap(up.expression);
          const first: ts.Expression | undefined = up.arguments[0];
          if (ts.isPropertyAccessExpression(callee) && first && ts.isStringLiteralLike(first) && ROUTE_HANDLER_NAME.test(`${callee.name.text} ${first.text}`)) {
            return `${callee.name.text} ${first.text}`;
          }
          // router.use(async (req, res, next) => …) — a path-less middleware.
          if (ts.isPropertyAccessExpression(callee) && callee.name.text === "use" && first === cur) return "use *";
        }
        up = up.parent;
      }
      // An IIFE or a bare callback: keep climbing to the named function that holds it.
    }
    cur = cur.parent;
  }
  return "<module>";
}

/** The lexical scope a `const` lives in: nearest Block / function body / SourceFile. */
function scopeOf(node: ts.Node): ts.Node {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isBlock(cur) || ts.isSourceFile(cur) || ts.isModuleBlock(cur) || ts.isCaseClause(cur) || ts.isDefaultClause(cur)) return cur;
    if ((ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) && !ts.isBlock(cur.body)) return cur; // expression-bodied
    cur = cur.parent;
  }
  return node.getSourceFile();
}

function bindsName(pattern: ts.BindingPattern, name: string): boolean {
  for (const el of pattern.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isIdentifier(el.name)) { if (el.name.text === name) return true; }
    else if (bindsName(el.name, name)) return true;
  }
  return false;
}

/** True when `scope` (a nested block / function / catch) declares `name` itself, shadowing the outer binding. */
function declaresName(scope: ts.Node, name: string): boolean {
  if (ts.isCatchClause(scope)) {
    const v = scope.variableDeclaration;
    if (v && ts.isIdentifier(v.name) && v.name.text === name) return true;
  }
  if (ts.isFunctionLike(scope)) {
    for (const p of scope.parameters) {
      if (ts.isIdentifier(p.name) && p.name.text === name) return true;
      if ((ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) && bindsName(p.name, name)) return true;
    }
  }
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name) && n.name.text === name) { found = true; return; }
      if ((ts.isObjectBindingPattern(n.name) || ts.isArrayBindingPattern(n.name)) && bindsName(n.name, name)) { found = true; return; }
    }
    // Only this scope's own declarations; nested blocks are their own scopes.
    if (n !== scope && (ts.isBlock(n) || ts.isFunctionLike(n))) return;
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return found;
}

/** Is this identifier node a genuine reference (not a property name / key / declaration)? */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if (ts.isPropertyAssignment(p) && p.name === id) return false;
  if (ts.isBindingElement(p) && (p.propertyName === id || p.name === id)) return false;
  if (ts.isVariableDeclaration(p) && p.name === id) return false;
  if (ts.isParameter(p) && p.name === id) return false;
  if (ts.isPropertySignature(p) || ts.isMethodSignature(p)) return false;
  if (ts.isTypeReferenceNode(p) || ts.isQualifiedName(p)) return false;
  if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p)) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

/** Every reference to `name` inside `scope` positioned after `afterPos`, skipping nested scopes that redeclare it. */
function referencesAfter(scope: ts.Node, name: string, afterPos: number): ts.Identifier[] {
  const refs: ts.Identifier[] = [];
  const visit = (n: ts.Node): void => {
    if (n !== scope && (ts.isBlock(n) || ts.isFunctionLike(n) || ts.isCatchClause(n)) && declaresName(n, name)) return;
    if (ts.isIdentifier(n) && n.text === name && n.getStart() >= afterPos && isReference(n)) refs.push(n);
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return refs;
}

/**
 * Judge how a whole result value is consumed given its binding name.
 *   - `.error` accessed anywhere → observed (null)
 *   - passed whole to a call / returned / spread / assigned onward → observed (the callee may check)
 *   - only `.data` / `.count` / … accessed → member-only
 *   - never referenced → discarded
 */
function judgeIdentifierBinding(scope: ts.Node, name: string, afterPos: number): Shape | null {
  const refs = referencesAfter(scope, name, afterPos);
  if (refs.length === 0) return "discarded";
  let sawResultMember = false;
  for (const r of refs) {
    let p: ts.Node = r.parent;
    while (ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p) || ts.isAsExpression(p)) p = p.parent;
    if (ts.isPropertyAccessExpression(p)) {
      const m = p.name.text;
      if (m === "error") return null;
      if (RESULT_MEMBERS.has(m)) { sawResultMember = true; continue; }
      return null; // some other member — not a PostgREST result shape we understand; assume observed
    }
    if (ts.isElementAccessExpression(p)) {
      const arg = p.argumentExpression;
      if (ts.isStringLiteralLike(arg) && arg.text === "error") return null;
      if (ts.isStringLiteralLike(arg) && RESULT_MEMBERS.has(arg.text)) { sawResultMember = true; continue; }
      return null;
    }
    // `const { data } = r` — a re-destructure.
    if (ts.isVariableDeclaration(p) && p.initializer === r && ts.isObjectBindingPattern(p.name)) {
      const s = judgeObjectPattern(p.name, scopeOf(p), p.getEnd());
      if (s === null) return null;
      sawResultMember = true;
      continue;
    }
    // Passed whole, returned whole, spread, or assigned onward — the consumer
    // is out of sight; assume it looks. False negatives are the cheaper
    // direction for a guard that must not be deleted.
    return null;
  }
  return sawResultMember ? "member-only" : null;
}

/** Judge a `{ data, error }`-style pattern. Returns the shape, or null when error is observed. */
function judgeObjectPattern(pattern: ts.ObjectBindingPattern, scope: ts.Node, afterPos: number): Shape | null {
  let errorEl: ts.BindingElement | null = null;
  let restEl: ts.BindingElement | null = null;
  for (const el of pattern.elements) {
    if (el.dotDotDotToken) { restEl = el; continue; }
    const prop = el.propertyName ?? el.name;
    const propName = ts.isIdentifier(prop) ? prop.text : ts.isStringLiteralLike(prop) ? prop.text : null;
    if (propName === "error") errorEl = el;
  }
  if (errorEl) {
    if (!ts.isIdentifier(errorEl.name)) return null; // nested pattern on error — exotic; assume observed
    const refs = referencesAfter(scope, errorEl.name.text, afterPos);
    return refs.length > 0 ? null : "error-unread";
  }
  if (restEl && ts.isIdentifier(restEl.name)) return judgeIdentifierBinding(scope, restEl.name.text, afterPos);
  return "data-only";
}

type Consumption =
  | { kind: "judged"; shape: Shape | null }
  | { kind: "delegated" }
  | { kind: "unresolved" };

/** Given the node that holds the RESULT value (the await, or a Promise.all element), classify its consumer. */
function consumptionOf(valueNode: ts.Node, root: "from" | "rpc"): Consumption {
  let cur: ts.Node = valueNode;
  let parent: ts.Node = cur.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isNonNullExpression(parent) || ts.isTypeAssertionExpression(parent) || ts.isSatisfiesExpression(parent)) {
    cur = parent; parent = cur.parent;
  }

  // const { data } = <value>   |   const r = <value>
  if (ts.isVariableDeclaration(parent) && parent.initializer === cur) {
    const scope = scopeOf(parent);
    if (ts.isObjectBindingPattern(parent.name)) return { kind: "judged", shape: judgeObjectPattern(parent.name, scope, parent.getEnd()) };
    if (ts.isIdentifier(parent.name)) return { kind: "judged", shape: judgeIdentifierBinding(scope, parent.name.text, parent.getEnd()) };
    return { kind: "unresolved" };
  }
  // r = <value>   |   ({ data, error } = <value>)
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === cur) {
    if (ts.isIdentifier(parent.left)) {
      return { kind: "judged", shape: judgeIdentifierBinding(scopeOf(parent.parent), parent.left.text, parent.getEnd()) };
    }
    if (ts.isObjectLiteralExpression(parent.left)) {
      const names = parent.left.properties.map((p) => (ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) ? p.name.text : ""));
      return { kind: "judged", shape: names.includes("error") ? null : "data-only" };
    }
    return { kind: "unresolved" };
  }
  // (<value>).data  /  (<value>)?.data
  if (ts.isPropertyAccessExpression(parent) && parent.expression === cur) {
    const m = parent.name.text;
    if (m === "error") return { kind: "judged", shape: null };
    if (RESULT_MEMBERS.has(m)) return { kind: "judged", shape: "member-only" };
    return { kind: "unresolved" };
  }
  // await db.from("t").select();   — the whole result thrown away
  if (ts.isExpressionStatement(parent)) {
    if (root === "rpc") return { kind: "delegated" }; // an rpc whose result is discarded is a write-style call
    return { kind: "judged", shape: "discarded" };
  }
  // return <value>  /  fn(<value>)  /  [<value>]  /  { k: <value> }  /  yield <value>
  if (ts.isReturnStatement(parent) || ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isArrowFunction(parent) || ts.isArrayLiteralExpression(parent) || ts.isPropertyAssignment(parent) || ts.isSpreadElement(parent) || ts.isYieldExpression(parent)) {
    return { kind: "delegated" };
  }
  return { kind: "unresolved" };
}

// ── Per-file scan ───────────────────────────────────────────────────────────

export interface FileScan {
  /** Every unchecked read found, in and out of scope (see `tier`). */
  reads: UncheckedRead[];
  sitesJudged: number;
  delegated: number;
  unresolved: number;
  throwOnError: number;
  /** `file:line <parent kind>` for each unresolved consumer, so the blind spot can be read. */
  unresolvedSamples: string[];
}

/**
 * Tables WRITTEN inside each enclosing function: `fn -> {table, …}`.
 *
 * This is the evidence behind the `write-precondition` tier. `describeChain`
 * deliberately returns null for a write chain, so writes are invisible to the
 * read scan; this walks for them separately and does not judge them.
 */
function collectWritesByFunction(sf: ts.SourceFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && CREATE_METHODS.has(callee.name.text)) {
        // Walk the receiver down to its `.from("table")`.
        let cur: ts.Node = unwrap(callee.expression);
        for (let hops = 0; hops < 64; hops += 1) {
          if (ts.isCallExpression(cur)) {
            const c2 = unwrap(cur.expression);
            if (ts.isPropertyAccessExpression(c2)) {
              if (c2.name.text === "from") {
                const arg = cur.arguments[0];
                if (arg && ts.isStringLiteralLike(arg)) {
                  const fn = enclosingFunctionName(n);
                  if (!out.has(fn)) out.set(fn, new Set());
                  out.get(fn)!.add(arg.text);
                }
                break;
              }
              cur = unwrap(c2.expression);
              continue;
            }
            break;
          }
          if (ts.isPropertyAccessExpression(cur)) { cur = unwrap(cur.expression); continue; }
          break;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function scanSource(src: string, file: string): FileScan {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: FileScan = { reads: [], sitesJudged: 0, delegated: 0, unresolved: 0, throwOnError: 0, unresolvedSamples: [] };
  const writesByFn = collectWritesByFunction(sf);
  const noteUnresolved = (node: ts.Node): void => {
    out.unresolved++;
    out.unresolvedSamples.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${ts.SyntaxKind[node.parent.kind]}`);
  };

  // identifier -> chain, for `const q = db.from("t").select(...)` bound and awaited later.
  const bound = new Map<string, ChainInfo | null>();
  const noteBinding = (name: string, info: ChainInfo): void => {
    if (!bound.has(name)) { bound.set(name, info); return; }
    const prev = bound.get(name);
    if (prev && prev.table !== info.table) bound.set(name, null); // ambiguous — refuse to guess
  };
  function resolveChain(expr: ts.Expression): ChainInfo | null {
    const info = describeChain(expr);
    if (!info) return null;
    if (info.viaIdentifier) {
      const base = bound.get(info.viaIdentifier);
      if (!base) return null; // not a supabase chain (or ambiguous)
      return { root: base.root, table: base.table, methods: [...base.methods, ...info.methods] };
    }
    return info;
  }
  const bindVisit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) && !ts.isAwaitExpression(unwrap(n.initializer))) {
      const info = resolveChain(n.initializer);
      if (info) noteBinding(n.name.text, info);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && !ts.isAwaitExpression(unwrap(n.right))) {
      const info = resolveChain(n.right);
      if (info) noteBinding(n.left.text, info);
    }
    ts.forEachChild(n, bindVisit);
  };
  bindVisit(sf);

  const keyCounts = new Map<string, number>();
  const record = (chainNode: ts.Node, info: ChainInfo, shape: Shape): void => {
    const line = sf.getLineAndCharacterOfPosition(chainNode.getStart(sf)).line + 1;
    const fn = enclosingFunctionName(chainNode);
    const terminal = terminalOf(info.methods, info.root);
    const base = `${file}::${fn}::${info.table}.${terminal}`;
    const n = (keyCounts.get(base) ?? 0) + 1;
    keyCounts.set(base, n);
    const key = n === 1 ? base : `${base}#${n}`;
    const excerpt = chainNode.getText(sf).replace(/\s+/g, " ").slice(0, 100);
    const read: UncheckedRead = { file, line, key, shape, terminal, table: info.table, fn, excerpt, tier: null };
    read.tier = tierOf(read, writesByFn.get(fn));
    out.reads.push(read);
  };

  const judge = (valueNode: ts.Node, chainNode: ts.Node, info: ChainInfo): void => {
    if (info.methods.includes("throwOnError")) { out.throwOnError++; return; }
    const c = consumptionOf(valueNode, info.root);
    if (c.kind === "delegated") { out.delegated++; return; }
    if (c.kind === "unresolved") { noteUnresolved(valueNode); return; }
    out.sitesJudged++;
    if (c.shape) record(chainNode, info, c.shape);
  };

  function judgePromiseAll(awaitNode: ts.AwaitExpression, arr: ts.ArrayLiteralExpression, settled: boolean): void {
    let cur: ts.Node = awaitNode;
    let parent: ts.Node = cur.parent;
    while (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)) { cur = parent; parent = cur.parent; }
    const elements = arr.elements;
    const chainAt = (i: number): { node: ts.Expression; info: ChainInfo } | null => {
      const el = elements[i];
      if (!el || ts.isSpreadElement(el)) return null;
      const inner = unwrap(el);
      const info = ts.isIdentifier(inner) ? (bound.get(inner.text) ?? null) : resolveChain(inner);
      return info ? { node: inner, info } : null;
    };
    if (ts.isVariableDeclaration(parent) && parent.initializer === cur && ts.isArrayBindingPattern(parent.name)) {
      const scope = scopeOf(parent);
      parent.name.elements.forEach((el, i) => {
        const c = chainAt(i);
        if (!c) return;
        if (c.info.methods.includes("throwOnError")) { out.throwOnError++; return; }
        if (settled) { noteUnresolved(c.node); return; } // allSettled wraps in {status,value}; out of scope
        if (ts.isOmittedExpression(el)) { out.sitesJudged++; record(c.node, c.info, "discarded"); return; }
        if (ts.isObjectBindingPattern(el.name)) { out.sitesJudged++; const s = judgeObjectPattern(el.name, scope, parent.getEnd()); if (s) record(c.node, c.info, s); return; }
        if (ts.isIdentifier(el.name)) { out.sitesJudged++; const s = judgeIdentifierBinding(scope, el.name.text, parent.getEnd()); if (s) record(c.node, c.info, s); return; }
        noteUnresolved(c.node);
      });
      return;
    }
    for (let i = 0; i < elements.length; i++) { const c = chainAt(i); if (c) noteUnresolved(c.node); }
  }

  const visit = (n: ts.Node): void => {
    if (ts.isAwaitExpression(n)) {
      const inner = unwrap(n.expression);
      let info: ChainInfo | null = null;
      if (ts.isIdentifier(inner)) info = bound.get(inner.text) ?? null;
      else if (ts.isCallExpression(inner) || ts.isPropertyAccessExpression(inner)) info = resolveChain(inner);
      if (info) judge(n, inner, info);
      else if (ts.isCallExpression(inner)) {
        // await Promise.all([ chainA, chainB ])
        const callee = unwrap(inner.expression);
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Promise" && /^(all|allSettled)$/.test(callee.name.text)) {
          const arr = inner.arguments[0] ? unwrap(inner.arguments[0]) : undefined;
          if (arr && ts.isArrayLiteralExpression(arr)) judgePromiseAll(n, arr, callee.name.text === "allSettled");
        }
      }
    }
    // <chain>.then(({ data }) => …)
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "then") {
        const info = resolveChain(callee.expression);
        if (info) {
          if (info.methods.includes("throwOnError")) out.throwOnError++;
          else {
            const cb = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
            if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
              const p = cb.parameters[0];
              if (!p) { out.sitesJudged++; record(callee.expression, info, "discarded"); }
              else if (ts.isObjectBindingPattern(p.name)) { out.sitesJudged++; const s = judgeObjectPattern(p.name, cb.body, cb.body.getStart()); if (s) record(callee.expression, info, s); }
              else if (ts.isIdentifier(p.name)) { out.sitesJudged++; const s = judgeIdentifierBinding(cb.body, p.name.text, cb.body.getStart()); if (s) record(callee.expression, info, s); }
              else noteUnresolved(callee.expression);
            } else out.delegated++; // .then(namedHandler)
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };

  visit(sf);
  return out;
}

// ── Tree scan ───────────────────────────────────────────────────────────────

export interface TreeScan {
  /** In-scope unchecked reads only. */
  reads: UncheckedRead[];
  /** Out-of-scope unchecked reads (the measured blind spot). */
  outOfScope: UncheckedRead[];
  filesScanned: number;
  sitesJudged: number;
  delegated: number;
  unresolved: number;
  throwOnError: number;
  unresolvedSamples: string[];
  parseFailures: string[];
}

export function scanTree(root: string = SRC_ROOT, dirs: string[] = SCOPE_DIRS): TreeScan {
  const result: TreeScan = { reads: [], outOfScope: [], filesScanned: 0, sitesJudged: 0, delegated: 0, unresolved: 0, throwOnError: 0, unresolvedSamples: [], parseFailures: [] };
  for (const d of dirs) {
    const dir = join(root, d);
    if (!existsSync(dir)) continue;
    for (const file of listSourceFiles(dir)) {
      const rel = relative(root, file);
      let text: string;
      try { text = readFileSync(file, "utf8"); } catch { result.parseFailures.push(rel); continue; }
      result.filesScanned++;
      const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
      if ((sf as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) { result.parseFailures.push(rel); continue; }
      const one = scanSource(text, rel);
      for (const r of one.reads) (r.tier ? result.reads : result.outOfScope).push(r);
      result.sitesJudged += one.sitesJudged;
      result.delegated += one.delegated;
      result.unresolved += one.unresolved;
      result.throwOnError += one.throwOnError;
      result.unresolvedSamples.push(...one.unresolvedSamples);
    }
  }
  return result;
}

// ── Allowlist ───────────────────────────────────────────────────────────────

export interface Allowlist {
  benign: Record<string, unknown>;
  known_defects: Record<string, unknown>;
}

export interface AllowlistVerdict {
  /** In-scope reads with no valid entry — the check fails on these. */
  violations: UncheckedRead[];
  /** Benign with a valid rationale. */
  benign: UncheckedRead[];
  /** Ledgered known defects with a valid direction label. */
  ledgered: UncheckedRead[];
  /** Entries (either section) whose key matches no in-scope site — fixed, moved, or mistyped. */
  stale: string[];
  /** Entries with no usable rationale / direction label. */
  unjustified: string[];
  /** A key present in both sections — it cannot be both. */
  duplicated: string[];
}

function validBenign(v: unknown): boolean {
  return typeof v === "string" && v.trim().length >= MIN_RATIONALE_CHARS;
}
function validDefectNote(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  return DIRECTION_LABELS.some((l) => s.startsWith(l)) && s.length >= MIN_RATIONALE_CHARS;
}

export function applyAllowlist(reads: UncheckedRead[], allowlist: Allowlist): AllowlistVerdict {
  const v: AllowlistVerdict = { violations: [], benign: [], ledgered: [], stale: [], unjustified: [], duplicated: [] };
  const keys = new Set(reads.map((r) => r.key));
  for (const [key, rationale] of Object.entries(allowlist.benign)) {
    if (!validBenign(rationale)) v.unjustified.push(key);
    if (!keys.has(key)) v.stale.push(key);
    if (key in allowlist.known_defects) v.duplicated.push(key);
  }
  for (const [key, note] of Object.entries(allowlist.known_defects)) {
    if (!validDefectNote(note)) v.unjustified.push(key);
    if (!keys.has(key)) v.stale.push(key);
  }
  for (const r of reads) {
    if (validBenign(allowlist.benign[r.key]) && !(r.key in allowlist.known_defects)) v.benign.push(r);
    else if (validDefectNote(allowlist.known_defects[r.key]) && !(r.key in allowlist.benign)) v.ledgered.push(r);
    else v.violations.push(r);
  }
  return v;
}

/** Strip `//`-prefixed prose keys; the file is JSON, so comments live in keys. */
function section(obj: Record<string, unknown>, name: string): Record<string, unknown> {
  const raw = obj[name];
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`allowlist section "${name}" must be an object of key -> text`);
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) if (!k.startsWith("//")) out[k] = val;
  return out;
}

export function parseAllowlist(text: string): Allowlist {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("allowlist must be a JSON object with `benign` and `known_defects` sections");
  const obj = parsed as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!k.startsWith("//") && k !== "benign" && k !== "known_defects") throw new Error(`allowlist has an unknown top-level section "${k}"`);
  }
  return { benign: section(obj, "benign"), known_defects: section(obj, "known_defects") };
}

export function loadAllowlist(path: string = ALLOWLIST_PATH): Allowlist {
  if (!existsSync(path)) return { benign: {}, known_defects: {} };
  return parseAllowlist(readFileSync(path, "utf8"));
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const scan = scanTree();
  let allowlist: Allowlist;
  try { allowlist = loadAllowlist(); } catch (e) {
    console.error(`✘ check-unchecked-supabase-reads: cannot read allowlist: ${(e as Error).message}`);
    process.exit(1);
  }
  const verdict = applyAllowlist(scan.reads, allowlist);
  const problems: string[] = [];
  if (scan.filesScanned === 0) problems.push("scanned ZERO files — the scope roots are wrong or the tree moved");
  if (scan.sitesJudged === 0) problems.push("judged ZERO read sites — the chain matcher is broken (vacuity)");
  if (scan.parseFailures.length > 0) problems.push(`${scan.parseFailures.length} file(s) failed to parse: ${scan.parseFailures.join(", ")}`);
  if (verdict.unjustified.length > 0) problems.push(`${verdict.unjustified.length} allowlist entr(ies) with no rationale (benign: >= ${MIN_RATIONALE_CHARS} chars; known_defects: must start with ${DIRECTION_LABELS.join(" | ")}): ${verdict.unjustified.join(", ")}`);
  if (verdict.stale.length > 0) problems.push(`${verdict.stale.length} stale allowlist entr(ies) — site fixed, moved or renamed; delete the line: ${verdict.stale.join(", ")}`);
  if (verdict.duplicated.length > 0) problems.push(`${verdict.duplicated.length} key(s) in BOTH sections: ${verdict.duplicated.join(", ")}`);

  const dirCounts = { open: 0, closed: 0, unclassified: 0 };
  for (const r of verdict.ledgered) {
    const note = String(allowlist.known_defects[r.key]).trim();
    if (note.startsWith("FAIL-OPEN:")) dirCounts.open++;
    else if (note.startsWith("FAIL-CLOSED:")) dirCounts.closed++;
    else dirCounts.unclassified++;
  }
  const stats = {
    filesScanned: scan.filesScanned, sitesJudged: scan.sitesJudged, delegated: scan.delegated, unresolved: scan.unresolved, throwOnError: scan.throwOnError,
    inScope: scan.reads.length, outOfScope: scan.outOfScope.length, benign: verdict.benign.length, ledgered: verdict.ledgered.length, ledgerDirection: dirCounts,
  };

  if (args.has("--json")) {
    console.log(JSON.stringify({ stats, violations: verdict.violations, benign: verdict.benign, ledgered: verdict.ledgered, outOfScope: args.has("--all") ? scan.outOfScope : undefined, unresolvedSamples: args.has("--all") ? scan.unresolvedSamples : undefined, stale: verdict.stale, unjustified: verdict.unjustified, duplicated: verdict.duplicated, problems }, null, 2));
  } else {
    const summary =
      `scanned ${stats.filesScanned} file(s); judged ${stats.sitesJudged} read site(s): ${stats.inScope} in scope ` +
      `(${stats.benign} benign, ${stats.ledgered} ledgered known defects: ${dirCounts.open} FAIL-OPEN / ${dirCounts.closed} FAIL-CLOSED / ${dirCounts.unclassified} UNCLASSIFIED), ` +
      `${stats.outOfScope} out of scope; ${stats.delegated} delegated to a caller, ${stats.unresolved} unresolved, ${stats.throwOnError} throwOnError`;
    const show = (r: UncheckedRead, tag: string): void => {
      console.log(`  ${r.file}:${r.line}  [${tag}]  ${r.key}\n      ${r.excerpt}`);
    };
    for (const r of verdict.violations) show(r, `${r.shape} / ${r.tier}`);
    if (args.has("--all")) {
      for (const r of verdict.ledgered) show(r, `ledgered: ${String(allowlist.known_defects[r.key]).split(":")[0]}`);
      for (const r of verdict.benign) show(r, "benign");
      for (const r of scan.outOfScope) show(r, `out-of-scope ${r.shape}`);
    }
    if (verdict.violations.length === 0 && problems.length === 0) {
      console.log(`✅ check-unchecked-supabase-reads: no NEW in-scope read ignores its .error. ${summary}.`);
    } else {
      if (verdict.violations.length > 0) {
        console.error(
          `\n✘ check-unchecked-supabase-reads: ${verdict.violations.length} in-scope read(s) ignore .error.\n` +
            "supabase-js RESOLVES on a DB error, so `const { data } = await …` turns a failed\n" +
            "query into an empty result — on an authorization path, the permissive answer.\n" +
            "Fix: bind { data, error } and act on error (fail closed on a gate, log on a\n" +
            "best-effort read). A try/catch around the read does NOT catch it. If emptiness is\n" +
            `genuinely safe here, add the key to ${relative(process.cwd(), ALLOWLIST_PATH)} under\n` +
            "\"benign\" with a rationale; a real defect you cannot fix now goes under\n" +
            "\"known_defects\" with a FAIL-OPEN: / FAIL-CLOSED: / UNCLASSIFIED: note.\n",
        );
      }
      for (const p of problems) console.error(`✘ ${p}`);
      console.error(`   ${summary}.`);
    }
  }
  process.exit(verdict.violations.length > 0 || problems.length > 0 ? 1 : 0);
}
