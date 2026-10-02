/**
 * census-discovery §82 (lane W10-O) — the values this lane RULED without
 * changing, pinned to their register entries so a value cannot drift from its
 * ruling silently (docs/architecture/discovery-decision-register.md).
 *
 *   R1  D-W10-O-4 (DC-32, §47.8): the eight "silent production defaults",
 *       each ruled PROVISIONAL at its current value.
 *   R2  D-W10-O-12 (DC-22, E-1): the DiscoveryCandidate confidence priors.
 *   R3  D-W10-O-8 (DV-41, §55.10 Q2–Q3): the 10 s interaction window, and only
 *       active dwell is interest.
 *   R4  the register carries every entry this file pins.
 *
 * Several of these values live in files other lanes own (routes/discovery.ts,
 * lib/discoveryPde.ts, lib/portavaRank.ts, lib/discoveryTrendState.ts,
 * lib/discoveryLiveRank.ts). This file only READS them: an exported constant by
 * import, an unexported one by its declaration's text.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/discoveryRulingsPinned.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_B_TTL_MS } from "../lib/discoveryCacheEligibility.js";
import { TREND_MIN_RATE, TREND_GROWTH_FACTOR, TREND_DECLINE_FACTOR } from "../lib/discoveryTrendState.js";
import { TRAVEL_HORIZON_MINUTES, DEFAULT_QUEUE_TOLERANCE_MINUTES, LIVE_RANK_MAX_POSITIONS } from "../lib/discoveryLiveRank.js";
import { CONFIDENCE_PRIOR } from "../lib/discoveryCandidate.js";
import { dwellCountsAsInterest, DWELL_KINDS } from "../lib/discoveryDwellVocabulary.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(SRC, "../../..");
const read = (p: string) => readFileSync(resolve(REPO, p), "utf8");

/** The value a declaration's text assigns, e.g. `const X = 2 * 60 * 1_000;` → 120000. Arithmetic of literals only. */
function declared(src: string, pattern: RegExp): number {
  const m = pattern.exec(src);
  assert.ok(m, `declaration ${pattern} not found`);
  const expr = m![1]!.replace(/_/g, "");
  assert.match(expr, /^[\d\s*.+-]+$/, `not a literal arithmetic expression: ${expr}`);
  return expr.split("*").map((t) => Number(t.trim())).reduce((a, b) => a * b, 1);
}

describe("§82 — ruled values stay pinned to their register entries", () => {
  it("R1. D-W10-O-4: §47.8's defaults, each ruled PROVISIONAL at this value", () => {
    const route = read("artifacts/api-server/src/routes/discovery.ts");
    const pde = read("artifacts/api-server/src/lib/discoveryPde.ts");
    const rank = read("artifacts/api-server/src/lib/portavaRank.ts");
    assert.equal(CACHE_B_TTL_MS, 10 * 60_000);
    assert.equal(declared(route, /const CACHE_TTL_MS\s*=\s*([^;]+);/), 2 * 60 * 60_000);
    assert.equal(declared(pde, /const SEEN_WINDOW_MS = ([^;]+);/), 24 * 60 * 60_000);
    assert.match(rank, /^\s*seenPenalty: -0\.6,$/m);
    assert.equal(declared(pde, /const MIN_TOTAL_CATEGORY_OBSERVATIONS = ([^;]+);/), 3);
    assert.deepEqual([TREND_MIN_RATE, TREND_GROWTH_FACTOR, TREND_DECLINE_FACTOR], [3, 1.5, 0.6]);
    assert.deepEqual([TRAVEL_HORIZON_MINUTES, DEFAULT_QUEUE_TOLERANCE_MINUTES, LIVE_RANK_MAX_POSITIONS], [45, 30, 15]);
    assert.match(rank, /author: opts\.authorPenalty \?\? 0\.35,/);
    assert.match(rank, /kind:\s+opts\.kindPenalty \?\? 0\.15,/);
  });

  it("R2. D-W10-O-12: the confidence priors are the ratified class priors", () => {
    assert.deepEqual({ ...CONFIDENCE_PRIOR }, { corroborated: 0.8, observed: 0.6, stale: 0.4, unknown: 0.2 });
  });

  it("R3. D-W10-O-8: the interaction window is 10 s, and only active dwell is interest", () => {
    const client = read("travel-buddy-standalone/src/services/discoveryDwell.ts");
    assert.equal(declared(client, /export const DWELL_INTERACTION_WINDOW_MS = ([^;]+);/), 10_000);
    assert.deepEqual(DWELL_KINDS.filter((k) => dwellCountsAsInterest(k)), ["active"]);
  });

  it("R4. the register carries every entry pinned here, with its values", () => {
    const reg = read("docs/architecture/discovery-decision-register.md");
    for (const id of ["D-W10-O-4", "D-W10-O-8", "D-W10-O-12"]) assert.match(reg, new RegExp(`### ${id} `));
    for (const needle of ["`CACHE_B_TTL_MS` | 10 min", "`CACHE_TTL_MS` (routes/discovery.ts) | 2 h", "24 h; −0.6", "| 3 |", "3; ×1.5; ×0.6", "45; 30; 15", "0.35; 0.15",
      "corroborated 0.8, observed 0.6, stale 0.4, unknown 0.2", "**10 seconds**", "PROVISIONAL, review by 2027-03-31"]) {
      assert.ok(reg.includes(needle), `the register does not record "${needle}"`);
    }
  });
});
