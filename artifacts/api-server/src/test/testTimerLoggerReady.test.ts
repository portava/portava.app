/**
 * Guard: every test file that mocks `setTimeout` waits for the logger's pino
 * transport first (helpers/loggerTransportReady.ts).
 *
 * WHY. Outside production the logger writes through a pino-pretty transport
 * (a worker thread behind thread-stream). The worker is kept alive until it
 * reports READY, and thread-stream emits 'ready' after a poll on the GLOBAL
 * setTimeout. A file that has mocked setTimeout when a slow — loaded — worker
 * reports ready turns that poll into a mocked timer nothing ever ticks: the
 * worker is never released and the file's process never exits after every test
 * has passed. That stalled full-suite runs for 12 to 35 minutes
 * (notificationMaintenanceSchedulerTiming, memoryProjectionSchedulerTiming)
 * while each file passed alone in a fraction of a second. Under ten CPU burners
 * the two unfixed files hung 5 and 12 times in 40 rounds; with the wait, 0.
 *
 * WHAT IT CHECKS. A file whose source calls `mock.timers.enable(...)` with
 * `setTimeout` among the mocked APIs — or with no argument, or with an argument
 * this parser cannot read, either of which may mock every timer — must import
 * `awaitLoggerTransportReady` (from any relative path) and await it BEFORE its
 * first such call in the source. Files that mock only `Date` are not at risk
 * (the poll uses the real setTimeout) and are not required to. A static check:
 * it reads source, it does not run the files.
 *
 * THE SOURCE IS PARSED (V-L6c F4; see `enableCalls`). The first version
 * matched `enable\(\s*(\{[^)]*\})?\s*\)`, which stops at the first `)` (wave-6
 * verifier F1); the second read balanced parentheses over a hand-written comment
 * stripper (L6b F2), which regex literals and destructuring still got past.
 * TypeScript's parser now reads the file, and anything it cannot read exactly
 * counts as mocking every timer.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/testTimerLoggerReady.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));

function testFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (e.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

export interface EnableCall { index: number; apis: string[] | "all" }

/**
 * THE SOURCE IS PARSED, NOT SCANNED (V-L6c F4, census-compass §53). The wave-6
 * version blanked comments with a hand-written scanner and matched `apis` with a
 * regular expression; a regex literal containing `/*` blanked the rest of the file,
 * an apostrophe inside one put the rest "in a string" (so a commented-out await
 * counted again), `apis: ["Date"].concat(["setTimeout"])` read as Date-only, a
 * duplicate or nested `apis` key bound to the first one, and `const { timers } =
 * mock` was not seen at all. TypeScript's own parser (already a dependency) gets
 * comments, strings, templates and regex literals right by construction, and the
 * analysis below walks the syntax tree:
 *
 *   - a MOCK is the identifier `mock` (node:test's export or a test context's
 *     destructured one), `<anything>.mock` / `<anything>["mock"]`, an import
 *     `{ mock as m }`, or a variable / destructured binding assigned from one;
 *   - TIMERS is `<mock>.timers` / `<mock>["timers"]`, or a variable /
 *     destructured binding (`{ timers }`, `{ timers: tm }`) assigned from one;
 *   - an ENABLE CALL is `<timers>.enable(...)` (also `?.`, `["enable"]`), or a
 *     call of a function bound from `<timers>.enable` (`const { enable } = …`);
 *   - its API list is read only from an object literal whose ONE `apis` property
 *     is an array literal of string literals. No argument, a non-object, a spread,
 *     a computed key, a shorthand `apis`, no `apis`, two `apis`, or any element
 *     that is not a string literal means EVERY timer;
 *   - any other use of a timers object — handed to a helper, stored, returned,
 *     a method this file does not know — counts as mocking every timer, where it
 *     appears. Only `reset`, `tick`, `runAll` and `setTime` are known not to.
 *
 * OUT OF PREMISE, said rather than implied: replacing `globalThis.setTimeout`
 * by assignment or `mock.method(globalThis, "setTimeout", …)` is not node's
 * MockTimers and is not read here; neither is a timers object reached through a
 * computed name (`mock["tim" + "ers"]`).
 */
const SAFE_TIMER_METHODS = new Set(["reset", "tick", "runAll", "setTime"]);

function unwrap(e: ts.Expression): ts.Expression {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x) || ts.isTypeAssertionExpression(x)) x = x.expression;
  return x;
}

/** The literal member name of `a.b` / `a?.b` / `a["b"]`, or null. */
function memberName(e: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isElementAccessExpression(e) && (ts.isStringLiteral(e.argumentExpression) || ts.isNoSubstitutionTemplateLiteral(e.argumentExpression))) return e.argumentExpression.text;
  return null;
}
const memberObject = (e: ts.Expression): ts.Expression | null =>
  ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e) ? e.expression : null;

/** The timer APIs one enable argument mocks — "all" whenever it cannot be read exactly (see above). */
function apisOfArgument(arg: ts.Expression | undefined): string[] | "all" {
  if (!arg) return "all";
  const obj = unwrap(arg);
  if (!ts.isObjectLiteralExpression(obj)) return "all";
  const apis: ts.Expression[] = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) return "all";
    const name = p.name;
    if (name && ts.isComputedPropertyName(name)) return "all";
    const key = name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) ? name.text : null;
    if (key !== "apis") continue;
    if (!ts.isPropertyAssignment(p)) return "all"; // shorthand, method, accessor
    apis.push(p.initializer);
  }
  if (apis.length !== 1) return "all";
  const list = unwrap(apis[0]!);
  if (!ts.isArrayLiteralExpression(list)) return "all";
  const names: string[] = [];
  for (const el of list.elements) {
    if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) names.push(el.text);
    else return "all";
  }
  return names;
}

function parseTs(source: string): ts.SourceFile {
  return ts.createSourceFile("guarded.test.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** Every node of a tree, depth first. */
function eachNode(root: ts.Node, fn: (n: ts.Node) => void): void {
  const visit = (n: ts.Node): void => { fn(n); ts.forEachChild(n, visit); };
  visit(root);
}

/**
 * Every `mock.timers.enable(...)` call in a source — where it is (its offset in
 * the source) and what it mocks — plus every use of a timers object this file
 * cannot read, as a call that mocks every timer.
 */
export function enableCalls(source: string): EnableCall[] {
  const sf = parseTs(source);
  const mockNames = new Set<string>(["mock"]);
  const timersNames = new Set<string>();
  const enableNames = new Set<string>();

  const isMock = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return mockNames.has(x.text);
    return memberName(x) === "mock";
  };
  const isTimers = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return timersNames.has(x.text);
    const obj = memberObject(x);
    return memberName(x) === "timers" && obj !== null && isMock(obj);
  };
  const isEnableRef = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return enableNames.has(x.text);
    const obj = memberObject(x);
    return memberName(x) === "enable" && obj !== null && isTimers(obj);
  };
  /** Bind the names a declaration / destructuring introduces from `init`. */
  const bind = (name: ts.BindingName, init: ts.Expression): boolean => {
    let changed = false;
    const add = (set: Set<string>, n: string) => { if (!set.has(n)) { set.add(n); changed = true; } };
    if (ts.isIdentifier(name)) {
      if (isMock(init)) add(mockNames, name.text);
      else if (isTimers(init)) add(timersNames, name.text);
      else if (isEnableRef(init)) add(enableNames, name.text);
    } else if (ts.isObjectBindingPattern(name)) {
      const fromMock = isMock(init); const fromTimers = isTimers(init);
      for (const el of name.elements) {
        const prop = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : (ts.isIdentifier(el.name) ? el.name.text : null);
        if (!ts.isIdentifier(el.name)) continue;
        if (fromMock && prop === "timers") add(timersNames, el.name.text);
        if (fromTimers && prop === "enable") add(enableNames, el.name.text);
        if (prop === "mock") add(mockNames, el.name.text); // `{ mock: m } = t`, `({ mock: m }) =>`
      }
    }
    return changed;
  };

  // Aliases to a fixed point (a chain `const m = t.mock; const tm = m.timers; const { enable } = tm`).
  for (let changed = true, rounds = 0; changed && rounds < 10; rounds++) {
    changed = false;
    eachNode(sf, (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /^(?:node:)?test$/.test(n.moduleSpecifier.text)) {
        const nb = n.importClause?.namedBindings;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) {
          if ((el.propertyName?.text ?? el.name.text) === "mock" && !mockNames.has(el.name.text)) { mockNames.add(el.name.text); changed = true; }
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer && bind(n.name, n.initializer)) changed = true;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && bind(n.left, n.right)) changed = true;
      // A parameter destructured as `({ mock: m })` binds an alias of a test context's mock.
      if (ts.isParameter(n) && ts.isObjectBindingPattern(n.name)) {
        for (const el of n.name.elements) {
          const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : null;
          if (prop === "mock" && ts.isIdentifier(el.name) && !mockNames.has(el.name.text)) { mockNames.add(el.name.text); changed = true; }
        }
      }
    });
  }

  const out: EnableCall[] = [];
  const at = (n: ts.Node) => n.getStart(sf);
  // V-L6d F3: a NESTED pattern under a mock / timers / enable binding
  // (`const { timers: { enable } } = mock`, `({ mock: { timers } }) =>`) is not
  // followed name by name; it may bind enable, so it counts as every timer.
  const nestedUnder = (el: ts.BindingElement): boolean => {
    if (ts.isIdentifier(el.name)) return false;
    const prop = el.propertyName && (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) ? el.propertyName.text : null;
    if (prop === "mock" || prop === "timers" || prop === "enable") return true;
    const pat = el.parent;
    const decl = pat?.parent;
    return !!decl && ts.isVariableDeclaration(decl) && decl.name === pat && !!decl.initializer && (isMock(decl.initializer) || isTimers(decl.initializer));
  };
  eachNode(sf, (n) => {
    if (ts.isBindingElement(n) && nestedUnder(n)) { out.push({ index: at(n), apis: "all" }); return; }
    // An enable call: `<timers>.enable(arg)` or a bound `enable(arg)`.
    if (ts.isCallExpression(n) && isEnableRef(n.expression)) {
      out.push({ index: at(n), apis: apisOfArgument(n.arguments[0]) });
      return;
    }
    // Every other reference to a timers object or a bound enable must be one this file can read.
    const isRef = ts.isExpression(n) && !ts.isCallExpression(n) && (isTimers(n as ts.Expression) || isEnableRef(n as ts.Expression));
    if (!isRef) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      // The binding itself, or the `.timers` / `.enable` NAME inside a member access, is not a use.
      if ((ts.isVariableDeclaration(p) && p.name === n) || ts.isBindingElement(p) || (ts.isPropertyAccessExpression(p) && p.name === n)) return;
      if (ts.isImportSpecifier(p) || ts.isParameter(p)) return;
    }
    const outer = (() => { let x: ts.Node = n; while (x.parent && (ts.isParenthesizedExpression(x.parent) || ts.isNonNullExpression(x.parent) || ts.isAsExpression(x.parent))) x = x.parent; return x; })();
    const p = outer.parent;
    if (!p) return;
    if (isEnableRef(n as ts.Expression)) {
      if (ts.isCallExpression(p) && p.expression === outer) return; // counted above
      if ((ts.isVariableDeclaration(p) && p.initializer === outer) || (ts.isBinaryExpression(p) && p.right === outer && p.operatorToken.kind === ts.SyntaxKind.EqualsToken)) return; // an alias (`=` only: `(0, mock.timers.enable)` is not), read through its calls
      out.push({ index: at(n), apis: "all" }); // an enable handed on (`f(mock.timers.enable)`, `.bind`)
      return;
    }
    // A timers object.
    if ((ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p)) && p.expression === outer) {
      const name = memberName(p);
      if (name !== null && (SAFE_TIMER_METHODS.has(name) || name === "enable")) return;
    }
    if ((ts.isVariableDeclaration(p) && p.initializer === outer) || (ts.isBinaryExpression(p) && p.right === outer && p.operatorToken.kind === ts.SyntaxKind.EqualsToken)) return; // an alias
    out.push({ index: at(n), apis: "all" }); // handed to a helper, stored, returned, an unknown method
  });
  // A source the parser had to recover from (it would not run as written) is not
  // read precisely: every call it found mocks every timer.
  const unparsed = ((sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length > 0;
  return out.map((c) => (unparsed ? { ...c, apis: "all" as const } : c)).sort((x, y) => x.index - y.index);
}

/** The mocked-API lists of every `mock.timers.enable(...)` call in a source. */
export function enabledTimerApis(src: string): Array<string[] | "all"> {
  return enableCalls(src).map((c) => c.apis);
}

const mocksSetTimeout = (src: string) => /\btimers\b/.test(src) && enabledTimerApis(src).some((a) => a === "all" || a.includes("setTimeout"));
const HELPER_MODULE = /^(?:\.{1,2}\/)+(?:[\w.-]+\/)*loggerTransportReady\.js$/;

/**
 * Why a file is unsafe, or null. It must import the helper (from any relative
 * path, under any local name) and await it BEFORE the FIRST enable call that
 * mocks setTimeout (a top-level `before` placed after the first mocking call in
 * the source is the order this refuses). Comments and strings are not code.
 */
export function timerMockViolation(source: string): string | null {
  const first = enableCalls(source).find((c) => c.apis === "all" || c.apis.includes("setTimeout"));
  if (!first) return null;
  const sf = parseTs(source);
  const locals = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !HELPER_MODULE.test(st.moduleSpecifier.text)) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if ((el.propertyName?.text ?? el.name.text) === "awaitLoggerTransportReady") locals.add(el.name.text);
  }
  if (locals.size === 0) return "mocks setTimeout without importing awaitLoggerTransportReady";
  let awaitAt = -1;
  eachNode(sf, (n) => {
    if (awaitAt >= 0 || !ts.isAwaitExpression(n)) return;
    const call = unwrap(n.expression);
    if (ts.isCallExpression(call) && ts.isIdentifier(call.expression) && locals.has(call.expression.text) && call.arguments.length === 0) awaitAt = n.getStart(sf);
  });
  if (awaitAt < 0) return "imports awaitLoggerTransportReady but never awaits it";
  if (awaitAt > first.index) return "awaits awaitLoggerTransportReady only AFTER its first setTimeout-mocking enable";
  return null;
}
const waitsForLogger = (src: string) => timerMockViolation(src) === null;

describe("every test file that mocks setTimeout waits for the logger's transport first", () => {
  it("the parser reads each enable call's API list (so the rule below is not vacuous)", () => {
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ apis: ["setTimeout", "setInterval"] });`), [["setTimeout", "setInterval"]]);
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ apis: ["Date"], now: 5 });`), [["Date"]]);
    assert.deepEqual(enabledTimerApis(`mock.timers.enable();`), ["all"]);
    assert.equal(mocksSetTimeout(`mock.timers.enable({ apis: ["Date"] })`), false);
    assert.equal(waitsForLogger(`import { awaitLoggerTransportReady } from "./helpers/loggerTransportReady.js";\nbefore(async () => { await awaitLoggerTransportReady(); });`), true);
  });

  it("probe fixtures (wave-6 verifier F1): an argument with nested parentheses is still read, and an unreadable one counts as all", () => {
    const IMPORT = `import { awaitLoggerTransportReady } from "./helpers/loggerTransportReady.js";\n`;
    const WAIT = `before(async () => { await awaitLoggerTransportReady(); });\n`;
    // Nested parens in `now:` — the case the first regex could not see.
    const nested = `mock.timers.enable({ apis: ["Date", "setTimeout"], now: NOW.getTime() });`;
    assert.deepEqual(enabledTimerApis(nested), [["Date", "setTimeout"]]);
    assert.ok(timerMockViolation(nested), "setTimeout mocked behind now: NOW.getTime() with no await must be refused");
    assert.equal(timerMockViolation(IMPORT + WAIT + nested), null);
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });`), [["Date"]]);
    assert.equal(timerMockViolation(`mock.timers.enable({ apis: ["Date"], now: new Date("x").getTime() });`), null, "Date only stays exempt");
    // A ")" inside a string in the argument does not end it.
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ now: Date.parse(")"), apis: ["setTimeout"] });`), [["setTimeout"]]);
    // Unreadable arguments may mock everything.
    assert.deepEqual(enabledTimerApis(`mock.timers.enable(OPTS);`), ["all"]);
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ now: 5 });`), ["all"]);
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ apis: ["setTimeout"]`), ["all"], "unbalanced");
    // Order, not presence: the await must come before the first mocking call.
    assert.ok(timerMockViolation(IMPORT + nested + "\n" + WAIT), "an await placed after the first mocking enable is refused");
    // Any relative import path: a file under src/test/db/ imports from ../helpers/.
    assert.equal(timerMockViolation(`import { awaitLoggerTransportReady } from "../helpers/loggerTransportReady.js";\n` + WAIT + nested), null);
    assert.ok(timerMockViolation(WAIT + nested), "an await with no import is refused");
  });

  it("probe fixtures (wave-6 verifier L6b F2): the spellings that got past the balanced-paren parser are all caught", () => {
    const IMPORT = `import { awaitLoggerTransportReady } from "./helpers/loggerTransportReady.js";\n`;
    const WAIT = `before(async () => { await awaitLoggerTransportReady(); });\n`;
    const probes: Record<string, string> = {
      "D spread in apis": `const APIS = ["setTimeout"];\nmock.timers.enable({ apis: [...APIS] });`,
      "D identifier in apis": `const TIMER = "setTimeout";\nmock.timers.enable({ apis: [TIMER] });`,
      "D apis not an array literal": `mock.timers.enable({ apis: TIMERS });`,
      "E template literal": "mock.timers.enable({ apis: [`setTimeout`] });",
      "G object spread after the list": `mock.timers.enable({ apis: ["Date"], ...EXTRA });`,
      "A newline before .enable": `mock.timers\n  .enable({ apis: ["setTimeout"] });`,
      "B aliased receiver": `const t = mock.timers;\nt.enable({ apis: ["setTimeout"] });`,
      "B aliased t.mock.timers": `it("x", (tc) => { const tm = tc.mock.timers; tm.enable({ apis: ["setTimeout"] }); });`,
      "H bracket access": `mock.timers["enable"]({ apis: ["setTimeout"] });`,
      "destructured enable": `const { enable } = mock.timers;\nenable({ apis: ["setTimeout"] });`,
      "destructured enable beside a Date-only enable": `mock.timers.enable({ apis: ["Date"] });\nconst { enable } = mock.timers;\nenable({ apis: ["setTimeout"] });`,
    };
    for (const [name, body] of Object.entries(probes)) {
      assert.ok(timerMockViolation(body), `${name}: a setTimeout mock with no await got past the guard`);
      assert.equal(timerMockViolation(IMPORT + WAIT + body), null, `${name}: the same file WITH the await must pass`);
    }
    // Each spelling is READ, not merely refused: the same spelling mocking only Date stays exempt.
    for (const dateOnly of [
      `mock.timers\n  .enable({ apis: ["Date"] });`,
      `const t = mock.timers;\nt.enable({ apis: ["Date"] });`,
      `mock.timers["enable"]({ apis: ["Date"] });`,
    ]) assert.deepEqual([enabledTimerApis(dateOnly), timerMockViolation(dateOnly)], [[["Date"]], null], dateOnly);
    // The template literal is read, not just refused: Date-only stays exempt.
    assert.deepEqual(enabledTimerApis("mock.timers.enable({ apis: [`Date`] });"), [["Date"]]);
    // C — comments do not count, in either direction.
    const enable = `mock.timers.enable({ apis: ["setTimeout"] });\n`;
    assert.ok(timerMockViolation(IMPORT + `// await awaitLoggerTransportReady();\n` + enable), "a commented-out await satisfied the rule");
    assert.ok(timerMockViolation(IMPORT + `/* before(async () => { await awaitLoggerTransportReady(); }); */\n` + enable), "a block-commented await satisfied the rule");
    assert.equal(timerMockViolation(`// mock.timers.enable({ apis: ["setTimeout"] });\nconst x = 1;`), null, "a commented-out enable is not a mock");
    // A file that only resets (no enable anywhere) is not a mock.
    assert.equal(timerMockViolation(`afterEach(() => mock.timers.reset());`), null);
  });

  it("probe fixtures (V-L6c F4): the spellings that got past the comment stripper are all read", () => {
    const IMPORT = `import { awaitLoggerTransportReady } from "./helpers/loggerTransportReady.js";\n`;
    const WAIT = `before(async () => { await awaitLoggerTransportReady(); });\n`;
    const probes: Record<string, string> = {
      "P1 a regex literal containing /*": "const re = /\\/*x/;\nmock.timers.enable({ apis: [\"setTimeout\"] });",
      "P6 a regex ending in an escaped slash": "const re = /\\/\\//; mock.timers.enable({ apis: [\"setTimeout\"] });",
      "P2 apis built by .concat": `mock.timers.enable({ apis: ["Date"].concat(["setTimeout"]) });`,
      "P3 destructured timers": `const { timers } = mock;\ntimers.enable({ apis: ["setTimeout"] });`,
      "P4 destructured and renamed timers": `const { timers: tm } = mock;\ntm.enable({ apis: ["setTimeout"] });`,
      "P5 duplicate apis key": `mock.timers.enable({ apis: ["Date"], apis: ["setTimeout"] });`,
      "P8 capis before apis": `mock.timers.enable({ capis: ["Date"], apis: ["setTimeout"] });`,
      "P9 nested apis before the real one": `mock.timers.enable({ now: { apis: ["Date"] }, apis: ["setTimeout"] });`,
      "optional call": `mock.timers.enable?.({ apis: ["setTimeout"] });`,
      "optional member": `mock.timers?.enable({ apis: ["setTimeout"] });`,
      "a helper receiving mock.timers": `useFakeTimers(mock.timers);`,
      "an enable handed on": `const go = run(mock.timers.enable);`,
      "mock imported under another name": `import { mock as m } from "node:test";\nm.timers.enable({ apis: ["setTimeout"] });`,
      "a test context's mock aliased": `it("x", (t) => { const m = t.mock; m.timers.enable({ apis: ["setTimeout"] }); });`,
      "a context destructured as { mock: mk }": `it("x", ({ mock: mk }) => { mk.timers.enable({ apis: ["setTimeout"] }); });`,
      "a shorthand apis": `const apis = ["Date"];\nmock.timers.enable({ apis });`,
      "a computed key": `mock.timers.enable({ ["apis"]: ["Date"] });`,
      // V-L6d F3: read as NOTHING by the first AST version.
      "nested destructuring of enable": `const { timers: { enable } } = mock;\nenable({ apis: ["setTimeout"] });`,
      "nested destructuring in a context parameter": `it("x", ({ mock: { timers } }) => { timers.enable({ apis: ["setTimeout"] }); });`,
      "a comma-operator callee": `(0, mock.timers.enable)({ apis: ["setTimeout"] });`,
    };
    for (const [name, body] of Object.entries(probes)) {
      assert.ok(timerMockViolation(body), `${name}: a setTimeout mock with no await got past the guard`);
      assert.equal(timerMockViolation(IMPORT + WAIT + body), null, `${name}: the same file WITH the await must pass`);
    }
    // P7: an apostrophe in a regex literal no longer revives a commented-out await.
    assert.ok(timerMockViolation(IMPORT + "const re = /it's/;\n// await awaitLoggerTransportReady();\nmock.timers.enable({ apis: [\"setTimeout\"] });"));
    // Read precisely, not merely refused: each of these mocks only Date.
    for (const dateOnly of [
      `mock.timers.enable({ capis: ["setTimeout"], apis: ["Date"] });`,
      `mock.timers.enable({ now: { apis: ["setTimeout"] }, apis: ["Date"] });`,
      `const { timers } = mock;\ntimers.enable({ apis: ["Date"] });`,
      "const re = /\\/*x/;\nmock.timers.enable({ apis: [\"Date\"] });",
    ]) assert.deepEqual([enabledTimerApis(dateOnly), timerMockViolation(dateOnly)], [[["Date"]], null], dateOnly);
    // Strings and templates are not code; a renamed helper import still counts.
    assert.equal(timerMockViolation(`const s = "mock.timers.enable({ apis: ['setTimeout'] })"; const t = \`mock.timers.enable()\`;`), null);
    assert.equal(timerMockViolation(`import { awaitLoggerTransportReady as ready } from "../helpers/loggerTransportReady.js";\nbefore(async () => { await ready(); });\nmock.timers.enable();`), null);
    // Known-safe methods are not a mock.
    assert.equal(timerMockViolation(`mock.timers.tick(10); mock.timers.runAll(); mock.timers.setTime(5); mock.timers.reset();`), null);
  });

  it("no file mocks setTimeout without awaiting awaitLoggerTransportReady", () => {
    // This file is the guard: its source strings are fixtures, not timer mocks.
    const files = testFiles(TEST_ROOT).filter((f) => f !== fileURLToPath(import.meta.url));
    const mocking = files.filter((f) => mocksSetTimeout(readFileSync(f, "utf8")));
    assert.ok(mocking.length >= 8, `premise: the scan found the files that mock setTimeout (found ${mocking.length})`);
    const missing = mocking
      .map((f) => [relative(TEST_ROOT, f), timerMockViolation(readFileSync(f, "utf8"))] as const)
      .filter(([, why]) => why !== null)
      .map(([f, why]) => `${f}: ${why}`);
    assert.deepEqual(missing, [], "these files mock setTimeout without first awaiting the logger's transport — add a top-level before(async () => { await awaitLoggerTransportReady(); })");
  });
});
