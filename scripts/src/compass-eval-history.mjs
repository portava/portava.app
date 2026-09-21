/**
 * THE RESULT HISTORY for the standing nine-question Compass evaluation.
 *
 * census-compass CPH-EVAL asks for the nine queries run *"against every phase
 * from Phase 1 on"*, measuring eight dimensions each time. The measuring half
 * exists (`./compass-eval-criteria.mjs`: four dimensions measured from the
 * per-turn record, four adjudicated). This file is the other half — the store
 * that lets run N be compared with run N-1 — and it is deliberately built so
 * that it CANNOT pretend the missing part is there.
 *
 * ── WHAT CANNOT BE MANUFACTURED, STATED FIRST ────────────────────────────────
 *
 * The eval has run against a real model ONCE, on 2026-07-21, on prompt
 * `compass-v1.1`, and 7 of the 9 came back with no text. Phases 1 through 15 are
 * in the past and nobody ran the nine against them. There is therefore no
 * per-phase history, and this file does not invent one:
 *
 *   - THE STORE SHIPS EMPTY. It is not in the repository at all until a real
 *     run appends to it. No seed, no fixture, no backfill, no "estimated"
 *     Phase 1..15 rows. The only writer is `appendRun`, and the only caller of
 *     `appendRun` is the runner, after a real run of the nine.
 *   - FEWER THAN TWO RUNS IS SAID OUT LOUD. `compareHistory` returns
 *     `no_history` for zero and `single_run` for one, with EMPTY movements, and
 *     `formatHistoryComparison` prints that sentence rather than a table of
 *     zeroes. A "0% change" line computed from an empty store is indis-
 *     tinguishable from a measured no-op, which is the exact failure this
 *     module is shaped against.
 *   - A DIMENSION NOBODY JUDGED IS `not_comparable`, never "unchanged". An
 *     unjudged measure has no pass rate; subtracting two absent numbers and
 *     getting zero would report stability that was never observed.
 *
 * So what this file makes true is forward-looking, and only that: from the next
 * run on, each run is filed under the phase it measured, the moment it ran and
 * the commit it ran at, and the run after it can be compared against it. The
 * gap for Phases 1..15 stays a gap, visibly.
 *
 * ── WHY JSON LINES, AND WHY APPEND IS LITERAL ────────────────────────────────
 *
 * One JSON object per line, opened `a`. Appending a run does not read, parse or
 * rewrite the runs before it, so a bug in this module — or a crash mid-write —
 * can add a bad line but cannot silently shorten the history. A single JSON
 * array would have to be read, mutated and written back, and the first
 * `writeFileSync` of a mis-parsed array is the whole record gone.
 *
 * `readHistoryFile` THROWS on a malformed line, naming the line number, rather
 * than skipping it. A store with one corrupt line must not read as a shorter
 * honest store: that is the same defect as a backfill, arrived at by accident.
 *
 * This module is pure apart from the two filesystem functions and
 * `currentCommit`, so the comparison is unit-testable with no store on disk —
 * every case in `compass-eval-criteria.test.mjs` builds its entries in memory.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROADMAP_MEASURES, RUN_LEVEL_MEASURES, MEASURED_MEASURES } from "./compass-eval-criteria.mjs";

/**
 * Bumped when the ENTRY SHAPE changes in a way a reader of old entries must
 * know about. It is recorded per entry, not per file, because the file is
 * append-only: entries written under an older shape stay exactly as they were
 * written, and rewriting them to match a newer shape would be editing a record
 * of something that happened.
 */
export const HISTORY_SCHEMA = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root: this file is at <root>/scripts/src/. */
export const REPO_ROOT = resolve(HERE, "..", "..");

/**
 * Where a run lands. In the repository, beside the runbook that explains it,
 * because the point of the history is that it accumulates ACROSS branches and
 * phases — a path under a build or temp directory is a history that lasts until
 * the next clean.
 *
 * Overridable per invocation (`--history <file>`) for a dry run that must not
 * touch the real record.
 */
export const DEFAULT_HISTORY_PATH = join(REPO_ROOT, "docs", "compass", "eval-history.jsonl");

/** The twelve recorded per run: the roadmap's eight, plus the v2 four. */
export const HISTORY_DIMENSIONS = [...ROADMAP_MEASURES, ...RUN_LEVEL_MEASURES];

const resolvePath = (p) => (p ? (isAbsolute(p) ? p : resolve(REPO_ROOT, p)) : DEFAULT_HISTORY_PATH);

/**
 * The commit the run ran at, read from git. `null` when git cannot answer —
 * and `buildRunEntry` then REFUSES the entry rather than filing a score with no
 * code behind it. A dimension that "got worse" between two runs is only a
 * finding if you can say which change made it worse.
 */
export function currentCommit(cwd = REPO_ROOT) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Collapse the flat Tier B array (the 76 verdicts, with Tier C's measurements
 * already substituted in) into one summary per dimension.
 *
 * `judged` and `total` are kept apart on purpose. A run that judged three of
 * nine safety slots and passed all three is not a 100% safety run, and the
 * comparison below uses `judged` as the denominator while reporting the drop in
 * coverage separately.
 *
 * `source` records whether the dimension was MEASURED from the record or read
 * by a human, so a later reader of the history can tell a measurement from an
 * opinion without going back to the module that produced it.
 */
export function summarizeDimensions(tierB) {
  const out = {};
  for (const measure of HISTORY_DIMENSIONS) {
    const rows = (tierB ?? []).filter((e) => e.measure === measure);
    const count = (state) => rows.filter((e) => e.state === state).length;
    const pass = count("pass");
    const fail = count("fail");
    const unjudged = count("unjudged");
    const measured = rows.filter((e) => e.measured === true).length;
    out[measure] = {
      pass,
      fail,
      unjudged,
      judged: pass + fail,
      total: rows.length,
      source: rows.length === 0
        ? "absent"
        : measured === rows.length ? "measured" : measured === 0 ? "adjudicated" : "mixed",
    };
  }
  return out;
}

/**
 * One run, ready to append.
 *
 * THE KEY IS (phase, ranAt, commit) AND ALL THREE ARE REQUIRED. Phase, because
 * the row is about movement between phases. `ranAt`, because two runs of the
 * same phase are two results and the later one does not replace the earlier.
 * Commit, because a regression with no commit behind it names nothing to look
 * at. A missing phase or commit THROWS: filing a run under a guessed phase is
 * how an honest store starts telling a story that did not happen.
 */
export function buildRunEntry({ phase, ranAt, commit, verdict, tierA, tierB, promptVersion = null, apiBaseUrl = null, note = "" }) {
  const p = phase === 0 || phase ? String(phase).trim() : "";
  if (!p) {
    throw new Error(
      "buildRunEntry: a phase is required. The history exists to show movement BETWEEN phases; " +
      "pass --phase <n> naming the phase this run measured. It is not guessed from the branch.",
    );
  }
  const sha = String(commit ?? "").trim();
  if (!sha) {
    throw new Error(
      "buildRunEntry: a commit is required. `git rev-parse HEAD` answered nothing, so this run " +
      "cannot be tied to the code it measured, and a regression against it would name nothing.",
    );
  }
  const at = ranAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(at))) throw new Error(`buildRunEntry: ranAt is not a timestamp: ${at}`);

  const failed = (tierA ?? []).filter((c) => !c.pass).map((c) => c.id);
  return {
    schema: HISTORY_SCHEMA,
    phase: p,
    ranAt: at,
    commit: sha,
    verdict: verdict ?? null,
    promptVersion,
    apiBaseUrl,
    tierA: { total: (tierA ?? []).length, failed },
    dimensions: summarizeDimensions(tierB),
    measuredDimensions: [...MEASURED_MEASURES],
    note: String(note ?? ""),
  };
}

/**
 * Append one run. The ONLY writer in this module, and it opens the file `a`:
 * nothing already recorded is read, parsed or rewritten, so this can add a bad
 * line but cannot shorten the history.
 */
export function appendRun(entry, path) {
  const file = resolvePath(path);
  appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  return file;
}

/**
 * Parse the store. A malformed line THROWS, naming the line, because a store
 * that silently drops what it cannot read is a store that reports a shorter,
 * tidier history than the one that happened.
 */
export function parseHistory(text) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`compass eval history: line ${i + 1} is not valid JSON (${e.message}). ` +
        "Nothing was dropped — fix or remove the line by hand; this store is append-only and is not rewritten for you.");
    }
  });
  return out;
}

/**
 * Read the store, oldest first. A file that has never been written reads as an
 * EMPTY history rather than an error: no run having happened is the true state
 * of this row today, and it is not a malfunction.
 */
export function readHistoryFile(path) {
  const file = resolvePath(path);
  if (!existsSync(file)) return [];
  return parseHistory(readFileSync(file, "utf8"));
}

/** Latest run for a phase, or null. Entries are appended in run order. */
function latestForPhase(history, phase) {
  const want = String(phase);
  let found = null;
  for (const e of history) if (String(e.phase) === want) found = e;
  return found;
}

/** Pass RATE over the JUDGED slots, or null when nothing was judged. */
function rateOf(dim) {
  if (!dim || !dim.judged) return null;
  return dim.pass / dim.judged;
}

const keyOf = (e) => (e ? `phase ${e.phase} @ ${e.commit.slice(0, 8)} (${e.ranAt})` : "none");

/**
 * Per-dimension movement between two runs.
 *
 * Returns `{ status, comparable, from, to, movements, regressions, coverageLosses, message }`.
 *
 *   status "no_history"          nothing has ever been recorded
 *          "single_run"          one run; there is nothing to compare it with
 *          "phase_not_recorded"  a named phase has no run in the store
 *          "compared"            two runs, and `movements` is real
 *
 * The first three all carry `comparable: false` and EMPTY movements. That is
 * the honest half of this module: the caller cannot accidentally read a trend
 * out of a store that has none, because there is no array of zeroes to read.
 */
export function compareHistory(history, { fromPhase = null, toPhase = null } = {}) {
  const empty = { movements: [], regressions: [], coverageLosses: [], from: null, to: null, comparable: false };
  const h = Array.isArray(history) ? history : [];

  if (fromPhase !== null || toPhase !== null) {
    // Half a pair is not a comparison. Filling the other half with "whatever
    // ran last" would answer a question nobody asked, and label the answer with
    // the phase they DID name.
    if (fromPhase === null || toPhase === null) {
      return {
        ...empty,
        status: "phase_not_recorded",
        message: `a comparison needs two phases; only phase ${fromPhase ?? toPhase} was named. ` +
          "Pass both --from-phase and --to-phase, or neither to compare the last two runs.",
      };
    }
    const a = latestForPhase(h, fromPhase);
    const b = latestForPhase(h, toPhase);
    const missing = [];
    if (!a) missing.push(String(fromPhase));
    if (!b) missing.push(String(toPhase));
    if (missing.length) {
      return {
        ...empty,
        status: "phase_not_recorded",
        message: `no recorded run for phase ${missing.join(" or phase ")}. ` +
          `The store holds ${h.length} run(s): ${h.map((e) => `phase ${e.phase}`).join(", ") || "none"}. ` +
          "The nine queries were never run against that phase, and nothing here will stand in for it.",
      };
    }
    return diff(a, b);
  }

  if (h.length === 0) {
    return {
      ...empty,
      status: "no_history",
      message: "No run has ever been recorded. The nine queries have not been run against any phase " +
        "through this store, so there is no trend, no baseline and no movement — and none is invented here.",
    };
  }
  if (h.length === 1) {
    return {
      ...empty,
      status: "single_run",
      to: h[0],
      message: `Exactly one run is recorded (${keyOf(h[0])}). A comparison needs two. ` +
        "Nothing is reported as improved, regressed or stable, because nothing has been measured twice.",
    };
  }
  return diff(h[h.length - 2], h[h.length - 1]);
}

function diff(a, b) {
  const movements = [];
  const regressions = [];
  const coverageLosses = [];

  for (const measure of HISTORY_DIMENSIONS) {
    const from = a.dimensions?.[measure] ?? null;
    const to = b.dimensions?.[measure] ?? null;
    const rFrom = rateOf(from);
    const rTo = rateOf(to);

    // EITHER SIDE UNJUDGED ⇒ NOT COMPARABLE. Not "unchanged": a dimension
    // nobody judged has no rate, and calling the difference of two absences
    // zero would report a stability that was never observed.
    if (rFrom === null || rTo === null) {
      movements.push({
        measure, from, to, delta: null, direction: "not_comparable",
        why: rFrom === null && rTo === null
          ? "unjudged in both runs"
          : rFrom === null ? `unjudged in ${keyOf(a)}` : `unjudged in ${keyOf(b)}`,
      });
      continue;
    }

    const delta = rTo - rFrom;
    const direction = delta < 0 ? "regressed" : delta > 0 ? "improved" : "unchanged";
    const m = { measure, from, to, delta, direction, why: "" };
    movements.push(m);
    if (direction === "regressed") regressions.push(m);
    // Same rate over fewer judged slots is NOT a regression in quality, and it
    // is not nothing either: the run knows less than the one before it.
    if (to.judged < from.judged) coverageLosses.push(m);
  }

  return {
    status: "compared",
    comparable: true,
    from: a,
    to: b,
    movements,
    regressions,
    coverageLosses,
    message: regressions.length
      ? `${regressions.length} dimension(s) regressed between ${keyOf(a)} and ${keyOf(b)}.`
      : `No dimension regressed between ${keyOf(a)} and ${keyOf(b)}.`,
  };
}

const pct = (r) => `${Math.round(r * 100)}%`;
const cell = (d) => `${d.pass}/${d.judged}${d.unjudged ? ` (+${d.unjudged} unjudged)` : ""}`;

/**
 * The comparison, printed.
 *
 * The three incomparable states print their sentence AND NOTHING ELSE — no
 * table, no arrows, no percentages. A reader skimming the output of a run
 * against an empty store must not be able to mistake it for a measured result,
 * and a formatter that prints a grid of dashes is exactly how that mistake gets
 * made.
 */
export function formatHistoryComparison(c) {
  const L = [];
  L.push("");
  L.push("===== RESULT HISTORY =====");
  L.push("");
  if (!c.comparable) {
    L.push(c.message);
    L.push("");
    if (c.status === "no_history" || c.status === "single_run") {
      L.push("The nine queries have not been run against Phases 1..15; those runs are in the past and");
      L.push("cannot be reconstructed. This store starts empty by design and fills from the next run on.");
      L.push("See docs/compass/nine-query-eval-runbook.md §8.");
    }
    return L.join("\n");
  }
  L.push(`FROM ${keyOf(c.from)}   verdict ${c.from.verdict}`);
  L.push(`TO   ${keyOf(c.to)}   verdict ${c.to.verdict}`);
  L.push("");
  for (const m of c.movements) {
    if (m.direction === "not_comparable") {
      L.push(`  ·  ${m.measure.padEnd(26)} not comparable — ${m.why}`);
      continue;
    }
    const mark = m.direction === "regressed" ? "✖" : m.direction === "improved" ? "▲" : "=";
    const label = m.direction === "regressed" ? " REGRESSED" : "";
    L.push(`  ${mark}  ${m.measure.padEnd(26)} ${cell(m.from)} ${pct(rateOf(m.from))} → ${cell(m.to)} ${pct(rateOf(m.to))}${label}`);
  }
  L.push("");
  if (c.regressions.length) {
    L.push(`  REGRESSIONS: ${c.regressions.map((m) => m.measure).join(", ")}`);
  } else {
    L.push("  No dimension regressed.");
  }
  if (c.coverageLosses.length) {
    L.push(`  FEWER SLOTS JUDGED than last time (not a quality regression, but the run knows less): ` +
      c.coverageLosses.map((m) => `${m.measure} ${m.from.judged}→${m.to.judged}`).join(", "));
  }
  L.push("");
  L.push(`  Runs in the store are compared pairwise only. A dimension is compared over the slots`);
  L.push(`  a human or a measurement actually judged; an unjudged dimension is "not comparable".`);
  return L.join("\n");
}
