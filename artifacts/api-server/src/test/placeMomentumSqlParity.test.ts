/**
 * `public.place_momentum_classify()` (migration 2892) and
 * `lib/discoveryTrendState.classifyTrendState()` are TWO HAND-MIRRORED COPIES of
 * one decision. This file is the only thing that makes them agree.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * 2892's own header specifies this test and the lane that wrote the migration
 * could not register it, so it was specified and never written. A specified-but-
 * absent parity test is worse than none: the migration's comments say the two
 * are mirrored, a reader believes it, and nothing checks.
 *
 * The divergence this catches is not hypothetical. `03` §9's states are ordered
 * by SPECIFICITY, not by arithmetic — `rediscovered` is tested BEFORE `trending`
 * because a return after silence is the more specific claim about the same
 * numbers. Reorder either copy and both still "work"; they just answer
 * differently, and the one that feeds the ranker is the SQL while the one every
 * test exercises is the TypeScript.
 *
 * ── WHAT IT DOES, AND THE LIMIT IT ADMITS ───────────────────────────────────
 * No database is available to the curated suite, so this CANNOT execute the SQL.
 * It does the next strongest thing rather than nothing: it PARSES the function
 * body out of 2892 and asserts, structurally, the four properties a silent
 * divergence would have to break — the three constants, the guard order, the
 * state order, and the comparison operators. A behavioural equivalence check
 * against a real Postgres belongs in the live-DB suite and is named below.
 *
 * MUTATION: change any constant in either copy, swap the `rediscovered` and
 * `trending` branches in the SQL, or flip `>` to `>=` in either → red here.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TREND_MIN_RATE, TREND_GROWTH_FACTOR, TREND_DECLINE_FACTOR,
  classifyTrendState, type TrendEvidence,
} from "../lib/discoveryTrendState.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(__dir, "..", "migrations", "2892_place_momentum.sql"), "utf8",
);
/** The function body only — the file's prose comments must not satisfy a match. */
const BODY = (() => {
  const from = SQL.indexOf("AS $fn$");
  const to = SQL.indexOf("$fn$;", from);
  assert.ok(from > 0 && to > from, "2892 no longer defines place_momentum_classify as $fn$…$fn$");
  return SQL.slice(from, to);
})();

describe("2892 place_momentum_classify mirrors classifyTrendState", () => {
  test("the three thresholds are the same numbers on both sides", () => {
    for (const [sqlName, tsValue, tsName] of [
      ["c_min_rate", TREND_MIN_RATE, "TREND_MIN_RATE"],
      ["c_growth_factor", TREND_GROWTH_FACTOR, "TREND_GROWTH_FACTOR"],
      ["c_decline_factor", TREND_DECLINE_FACTOR, "TREND_DECLINE_FACTOR"],
    ] as const) {
      const m = new RegExp(`${sqlName}\\s+CONSTANT\\s+double precision\\s*:=\\s*([0-9.]+)`).exec(BODY);
      assert.ok(m, `2892 no longer declares ${sqlName}`);
      assert.equal(
        Number(m[1]), tsValue,
        `${sqlName} = ${m[1]} in SQL but ${tsName} = ${tsValue} in TypeScript — ` +
          `the ranker and the projection would classify the same place differently`,
      );
    }
  });

  test("both guards come first, so absence of evidence never becomes evidence", () => {
    const weightGuard = BODY.indexOf("p_total_weight IS NULL OR p_total_weight <= 0");
    const rateGuard = BODY.indexOf("p_recent_rate < c_min_rate");
    const firstState = BODY.indexOf("RETURN 'emerging'");
    assert.ok(weightGuard > 0 && rateGuard > 0, "a fail-closed guard is gone from 2892");
    assert.ok(
      weightGuard < firstState && rateGuard < firstState,
      "a guard moved BELOW a state return — a quiet place would read 'cooling' instead of 'unknown'",
    );
  });

  test("rediscovered is decided BEFORE trending, as `03` §9 orders it", () => {
    const rediscovered = BODY.indexOf("RETURN 'rediscovered'");
    const trending = BODY.indexOf("RETURN 'trending'");
    assert.ok(rediscovered > 0 && trending > 0, "a state return is gone from 2892");
    assert.ok(
      rediscovered < trending,
      "SQL now tests trending before rediscovered; a return after silence would be " +
        "reported as ordinary acceleration, and the TypeScript would disagree",
    );
  });

  test("the growth and decline comparisons are strict, in the same direction", () => {
    assert.match(BODY, /p_recent_rate\s*>\s*COALESCE\(p_mid_rate, 0\)\s*\*\s*c_growth_factor/,
      "the growth comparison changed shape or strictness");
    assert.match(BODY, /p_recent_rate\s*<\s*COALESCE\(p_mid_rate, 0\)\s*\*\s*c_decline_factor/,
      "the decline comparison changed shape or strictness");
  });

  test("the TypeScript side still answers what the mirrored rules say it does", () => {
    // Boundary cases, chosen where the two copies could plausibly part company.
    const cases: Array<[TrendEvidence, string]> = [
      [{ recentRate: 0, midRate: 0, priorRate: 0, totalWeight: 0 }, "unknown"],
      [{ recentRate: TREND_MIN_RATE - 0.001, midRate: 0, priorRate: 0, totalWeight: 9 }, "unknown"],
      [{ recentRate: TREND_MIN_RATE, midRate: 0, priorRate: 0, totalWeight: 9 }, "emerging"],
      [{ recentRate: 10, midRate: 0, priorRate: 10, totalWeight: 9 }, "rediscovered"],
      [{ recentRate: 10, midRate: 5, priorRate: 5, totalWeight: 9 }, "trending"],
      [{ recentRate: 10, midRate: 10, priorRate: 10, totalWeight: 9 }, "established"],
      [{ recentRate: 5, midRate: 10, priorRate: 10, totalWeight: 9 }, "cooling"],
      // exactly AT the growth factor is NOT trending — strict `>`
      [{ recentRate: 15, midRate: 10, priorRate: 10, totalWeight: 9 }, "established"],
    ];
    for (const [e, expected] of cases) {
      assert.equal(classifyTrendState(e), expected, `classifyTrendState(${JSON.stringify(e)})`);
    }
  });

  test("this file says out loud what it does NOT prove", () => {
    // A guard against its own reassurance: the structural checks above are not
    // execution. If a live-DB parity suite ever lands, this assertion is what
    // reminds whoever writes it to delete this note.
    assert.ok(
      !SQL.includes("-- LIVE PARITY SUITE REGISTERED"),
      "a live parity suite is claimed in 2892 — replace these structural checks with it",
    );
  });
});
