#!/usr/bin/env node
/**
 * check:layover-decision-diff — Layover spec §21.2's decision-diff CI,
 * census-layover L241.
 *
 *   pnpm -s check:layover-decision-diff
 *       runs the synthetic scenario corpus
 *       (src/services/layover/replay/layoverScenarioCorpus.ts) through the pure
 *       feasibility engine, projects each answer onto the §20 decision record,
 *       and compares it with layoverDecisionGolden.json through
 *       `layoverReplay.decisionDiffCorpus`. Exit 0 when they agree; exit 1 with
 *       the classified report — deadlines that moved LATER (the direction that
 *       strands people) first, then earlier, verdict flips, changed fields and
 *       rules — when they do not; exit 2 when it cannot run (no golden).
 *
 *   pnpm -s check:layover-decision-diff -- --update --note "why the decisions changed"
 *       re-generates the golden. Refused without a note.
 *
 * What a red here means: the engine now decides a corpus scenario differently.
 * Not a bug report and not an approval — the fact that a decision moved,
 * printed for the person who moved it to explain in the note.
 */
import { execFileSync } from "node:child_process";

import { runLayoverScenarioCorpus } from "../services/layover/replay/layoverScenarioCorpus.js";
import {
  LAYOVER_GOLDEN_PATH,
  compareToGolden,
  formatLayoverDiffReport,
  readLayoverGolden,
  writeLayoverGolden,
} from "../services/layover/replay/layoverDecisionGolden.js";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function headCommit(): string | null {
  try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || null; } catch { return null; }
}

const actual = runLayoverScenarioCorpus();

if (process.argv.includes("--update")) {
  const note = arg("--note") ?? "";
  const golden = readLayoverGolden();
  try {
    writeLayoverGolden(actual, note, headCommit());
  } catch (e) {
    console.error(`::error::${(e as Error).message}`);
    process.exit(2);
  }
  console.log(golden ? formatLayoverDiffReport(compareToGolden(golden.decisions, actual)) : `layover decision diff: no golden existed; ${actual.length} scenario(s) recorded.`);
  console.log(`golden written: ${LAYOVER_GOLDEN_PATH} — note: ${note.trim()}`);
  process.exit(0);
}

const golden = readLayoverGolden();
if (!golden) {
  console.error(`::error::no golden at ${LAYOVER_GOLDEN_PATH}. This check cannot run without one: pnpm -s check:layover-decision-diff -- --update --note "initial record"`);
  process.exit(2);
}
const report = compareToGolden(golden.decisions, actual);
console.log(formatLayoverDiffReport(report));
console.log(`golden note: ${golden.note}${golden.head ? ` (head ${golden.head})` : ""}`);
process.exit(report.ok ? 0 : 1);
