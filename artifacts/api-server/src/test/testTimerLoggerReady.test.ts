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
 * THE ARGUMENT IS READ WITH BALANCED PARENTHESES (wave-6 verifier F1). The
 * first version matched `enable\(\s*(\{[^)]*\})?\s*\)`, which stops at the
 * first `)`: `enable({ apis: [...], now: NOW.getTime() })` matched nothing and
 * the file counted as not mocking timers at all — seven files use that form.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *   node --import tsx/esm --test src/test/testTimerLoggerReady.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
 * The source with every comment blanked to spaces (newlines kept, so every index
 * still points at the same character). Strings and template literals are kept.
 * Wave-6 verifier L6b F2: a commented-out `await awaitLoggerTransportReady()`
 * satisfied the order rule, and a commented-out enable call counted.
 */
export function stripComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && src[i + 1] === "*") {
      const close = src.indexOf("*/", i + 2);
      const stop = close < 0 ? src.length : close + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** The text inside the bracket pair that opens at `open` (`(`/`[`), skipping strings; null if it never closes. */
function balanced(src: string, open: number, o: string, cl: string): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === o) depth++;
    else if (c === cl && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}
const balancedArgument = (src: string, open: number) => balanced(src, open, "(", ")");

/**
 * The timer APIs one enable argument mocks — "all" whenever it cannot be read
 * as a plain object whose `apis` is an array of string literals: no argument, a
 * non-object, no `apis` key, an `apis` that is not an array literal, an element
 * that is an identifier, a spread or a template with a substitution, or a spread
 * anywhere in the object (it could carry `apis`). Unknown is never "nothing".
 */
function apisOf(arg: string | null): string[] | "all" {
  if (arg === null) return "all";
  const a = arg.trim();
  if (a === "" || !a.startsWith("{")) return "all";
  if (a.includes("...")) return "all";
  const key = /["'`]?apis["'`]?\s*:\s*/.exec(a);
  if (!key) return "all";
  const at = key.index + key[0].length;
  if (a[at] !== "[") return "all";
  const body = balanced(a, at, "[", "]");
  if (body === null) return "all";
  const names: string[] = [];
  for (const raw of body.split(",")) {
    const el = raw.trim();
    if (el === "") continue;
    const lit = /^(["'])([A-Za-z]+)\1$/.exec(el) ?? /^`([A-Za-z]+)`$/.exec(el);
    if (!lit) return "all";
    names.push(lit[lit.length - 1]!);
  }
  return names;
}

const ENABLE_ON = (receiver: string) =>
  new RegExp(`${receiver}\\s*(?:\\.\\s*enable|\\[\\s*(["'\`])enable\\1\\s*\\])\\s*\\(`, "g");
const TIMERS = String.raw`\bmock\s*\.\s*timers`;

/**
 * Every `mock.timers.enable(...)` call in a source (comments stripped): where
 * it is, and what it mocks. Seen through `mock.timers` and `t.mock.timers` with
 * any whitespace or newline before `.enable`, through bracket access
 * (`timers["enable"](`), and through an alias (`const t = mock.timers;
 * t.enable(...)`). A destructured `enable`, or a file that touches `mock.timers`
 * in a way none of those match, counts as mocking every timer.
 */
export function enableCalls(source: string): EnableCall[] {
  const src = stripComments(source);
  const out: EnableCall[] = [];
  const receivers = [TIMERS];
  for (const m of src.matchAll(new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?mock\s*\.\s*timers\b(?!\s*[.\[])`, "g"))) {
    receivers.push(String.raw`\b${m[1]!.replace(/\$/g, "\\$")}`);
  }
  for (const r of receivers) {
    for (const m of src.matchAll(ENABLE_ON(r))) {
      const open = m.index! + m[0].length - 1;
      out.push({ index: m.index!, apis: apisOf(balancedArgument(src, open)) });
    }
  }
  const destructured = new RegExp(String.raw`\{[^}]*\benable\b[^}]*\}\s*=\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)?mock\s*\.\s*timers\b`).exec(src);
  if (destructured) out.push({ index: destructured.index, apis: "all" });
  if (out.length === 0) {
    const touched = new RegExp(TIMERS).exec(src);
    const onlyReset = touched && !/\benable\b/.test(src);
    if (touched && !onlyReset) out.push({ index: touched.index, apis: "all" });
  }
  return out.sort((x, y) => x.index - y.index);
}

/** The mocked-API lists of every `mock.timers.enable(...)` call in a source. */
export function enabledTimerApis(src: string): Array<string[] | "all"> {
  return enableCalls(src).map((c) => c.apis);
}

const mocksSetTimeout = (src: string) => enabledTimerApis(src).some((a) => a === "all" || a.includes("setTimeout"));
const IMPORT_RE = /import\s*\{[^}]*\bawaitLoggerTransportReady\b[^}]*\}\s*from\s*"(?:\.{1,2}\/)+(?:[\w.-]+\/)*loggerTransportReady\.js"/;

/**
 * Why a file is unsafe, or null. It must import the helper and await it before
 * the FIRST enable call that mocks setTimeout (a top-level `before` placed after
 * the first mocking call in the source is the order this refuses).
 */
export function timerMockViolation(source: string): string | null {
  const first = enableCalls(source).find((c) => c.apis === "all" || c.apis.includes("setTimeout"));
  if (!first) return null;
  const src = stripComments(source); // a commented-out import or await does not count
  if (!IMPORT_RE.test(src)) return "mocks setTimeout without importing awaitLoggerTransportReady";
  const awaitAt = src.search(/await\s+awaitLoggerTransportReady\s*\(\s*\)/);
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
