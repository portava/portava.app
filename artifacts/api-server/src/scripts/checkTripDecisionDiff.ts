#!/usr/bin/env node
/**
 * check:trip-decision-diff — Trips spec §24's decision-diff CI, census-trips
 * TR409 / TR410 / TR433.
 *
 *   pnpm -s check:trip-decision-diff
 *       runs the scenario corpus (src/scenarios/trips/corpus.ts) through the
 *       pure engines and compares every decision with golden.json. Exit 0 when
 *       they agree; exit 1 with the classified report — changed decisions by
 *       path, conservatism increased / decreased per scenario, new conflicts,
 *       large diffs — when they do not; exit 2 when it cannot run (no golden).
 *
 *   pnpm -s check:trip-decision-diff -- --update --note "why the decisions changed"
 *       re-generates golden.json. Refused without a note: a golden that
 *       changed for no stated reason is exactly what §24 calls an unexplained
 *       diff, and this script is the only writer.
 *
 * What a red here means: a planner or coordination engine now decides
 * something differently for a scenario it decided before. That is not a bug
 * report and not an approval — it is the fact that a decision moved, printed
 * for the person who moved it to explain. The tree's own tests say whether the
 * new decision is right; this says that it is new.
 */
import { execFileSync } from "node:child_process";

import { runTripScenarioCorpus } from "../scenarios/trips/run.js";
import { diffDecisions, formatReport } from "../scenarios/trips/diff.js";
import { GOLDEN_PATH, readGolden, writeGolden } from "../scenarios/trips/golden.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function headCommit(): string | null {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || null; } catch { return null; }
}

const update = process.argv.includes("--update");
const actual = runTripScenarioCorpus();

if (update) {
  const note = arg("--note") ?? "";
  const golden = readGolden();
  const report = golden ? diffDecisions(golden.decisions, actual) : null;
  try {
    writeGolden(actual, note, headCommit());
  } catch (e) {
    console.error(`::error::${(e as Error).message}`);
    process.exit(2);
  }
  console.log(report ? formatReport(report) : `trip decision diff: no golden existed; ${actual.length} scenario(s) recorded.`);
  console.log(`golden written: ${GOLDEN_PATH} — note: ${note.trim()}`);
  process.exit(0);
}

const golden = readGolden();
if (!golden) {
  console.error(`::error::no golden at ${GOLDEN_PATH}. This check cannot run without one: pnpm -s check:trip-decision-diff -- --update --note "initial record"`);
  process.exit(2);
}
const report = diffDecisions(golden.decisions, actual);
console.log(formatReport(report));
console.log(`golden note: ${golden.note}${golden.head ? ` (head ${golden.head})` : ""}`);
process.exit(report.ok ? 0 : 1);
