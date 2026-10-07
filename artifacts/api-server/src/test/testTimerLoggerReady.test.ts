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

/**
 * The text between `(` at `open` and its matching `)`, skipping string and
 * template-literal contents; null when the parentheses never balance.
 */
function balancedArgument(src: string, open: number): string | null {
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
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}

export interface EnableCall { index: number; apis: string[] | "all" }

/** Every `mock.timers.enable(...)` call in a source: where it is, and what it mocks. */
export function enableCalls(src: string): EnableCall[] {
  const out: EnableCall[] = [];
  for (const m of src.matchAll(/mock\.timers\.enable\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const arg = balancedArgument(src, open);
    // Unparseable (unbalanced), empty, not an object literal, or an object
    // without `apis`: all of them may mock every timer — counted as "all".
    if (arg === null || arg.trim() === "" || !arg.trim().startsWith("{")) { out.push({ index: m.index!, apis: "all" }); continue; }
    const apis = /apis\s*:\s*\[([^\]]*)\]/.exec(arg);
    if (!apis) { out.push({ index: m.index!, apis: "all" }); continue; }
    out.push({ index: m.index!, apis: [...apis[1]!.matchAll(/["']([A-Za-z]+)["']/g)].map((x) => x[1]!) });
  }
  return out;
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
export function timerMockViolation(src: string): string | null {
  const first = enableCalls(src).find((c) => c.apis === "all" || c.apis.includes("setTimeout"));
  if (!first) return null;
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
