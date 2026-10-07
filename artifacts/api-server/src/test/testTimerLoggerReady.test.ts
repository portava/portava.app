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
 * `setTimeout` among the mocked APIs — or with no argument, which mocks every
 * timer — must import and call `awaitLoggerTransportReady`. Files that mock only
 * `Date` are not at risk (the poll uses the real setTimeout) and are not
 * required to. A static check: it reads source, it does not run the files.
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

/** The mocked-API lists of every `mock.timers.enable(...)` call in a source. */
export function enabledTimerApis(src: string): Array<string[] | "all"> {
  const out: Array<string[] | "all"> = [];
  const re = /mock\.timers\.enable\(\s*(\{[^)]*\})?\s*\)/g;
  for (const m of src.matchAll(re)) {
    const arg = m[1];
    if (!arg) { out.push("all"); continue; }
    const apis = /apis\s*:\s*\[([^\]]*)\]/.exec(arg);
    if (!apis) { out.push("all"); continue; }
    out.push([...apis[1]!.matchAll(/["']([A-Za-z]+)["']/g)].map((x) => x[1]!));
  }
  return out;
}

const mocksSetTimeout = (src: string) => enabledTimerApis(src).some((a) => a === "all" || a.includes("setTimeout"));
const waitsForLogger = (src: string) => /import \{[^}]*\bawaitLoggerTransportReady\b[^}]*\} from "\.\/(?:\.\.\/)*helpers\/loggerTransportReady\.js"/.test(src) && /await awaitLoggerTransportReady\(\)/.test(src);

describe("every test file that mocks setTimeout waits for the logger's transport first", () => {
  it("the parser reads each enable call's API list (so the rule below is not vacuous)", () => {
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ apis: ["setTimeout", "setInterval"] });`), [["setTimeout", "setInterval"]]);
    assert.deepEqual(enabledTimerApis(`mock.timers.enable({ apis: ["Date"], now: 5 });`), [["Date"]]);
    assert.deepEqual(enabledTimerApis(`mock.timers.enable();`), ["all"]);
    assert.equal(mocksSetTimeout(`mock.timers.enable({ apis: ["Date"] })`), false);
    assert.equal(waitsForLogger(`import { awaitLoggerTransportReady } from "./helpers/loggerTransportReady.js";\nbefore(async () => { await awaitLoggerTransportReady(); });`), true);
  });

  it("no file mocks setTimeout without awaiting awaitLoggerTransportReady", () => {
    const files = testFiles(TEST_ROOT);
    const mocking = files.filter((f) => mocksSetTimeout(readFileSync(f, "utf8")));
    assert.ok(mocking.length >= 8, `premise: the scan found the files that mock setTimeout (found ${mocking.length})`);
    const missing = mocking.filter((f) => !waitsForLogger(readFileSync(f, "utf8"))).map((f) => relative(TEST_ROOT, f));
    assert.deepEqual(missing, [], "these files mock setTimeout without first awaiting the logger's transport — add a top-level before(async () => { await awaitLoggerTransportReady(); })");
  });
});
