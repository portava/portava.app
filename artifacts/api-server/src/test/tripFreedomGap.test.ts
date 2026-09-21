/**
 * census-compass CT-03 — "consume Temporal Freedom windows rather than
 * independently calculating free time".
 *
 * The engine (domain/trips/invariants/TripFreedomEngine) existed and
 * `get_freedom_windows` consumed it; `CompassSenseEngine.free_time_block`
 * still derived "no plan item starts within the next 3 hours" on its own.
 * Now the gap is the engine's answer (`freeGapFromPlan`) and Sense consumes
 * it. The other site the row named, `check_trip_conflicts`, computes
 * cross-trip calendar overlap — not free time — and is not touched.
 *
 * Mutation log (each applied alone, suite run, source restored):
 *   M1 freeGapFromPlan ignores items already started (gap from the past)  → red
 *   M2 Sense derives the gap itself again (engine call removed)           → red
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/tripFreedomGap.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { freeGapFromPlan } from "../domain/trips/invariants/TripFreedomEngine.js";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const NOW = Date.parse("2026-09-20T10:00:00.000Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

describe("freeGapFromPlan — the engine's gap over a day's plan", () => {
  it("a day with no timed item claims no gap (timedCount 0)", () => {
    assert.deepEqual(freeGapFromPlan([{ id: "a", startsAt: null }], NOW), { gapMinutes: null, nextPlanId: null, nextStartsAt: null, timedCount: 0 });
    assert.deepEqual(freeGapFromPlan([], NOW).timedCount, 0);
  });

  it("the gap is to the NEXT timed item, not the first in the list, and items already started do not count", () => {
    const g = freeGapFromPlan([
      { id: "later", startsAt: at(240) },
      { id: "past", startsAt: at(-30) },
      { id: "next", startsAt: at(90) },
    ], NOW);
    assert.equal(g.gapMinutes, 90);
    assert.equal(g.nextPlanId, "next");
    assert.equal(g.nextStartsAt, at(90));
    assert.equal(g.timedCount, 3);
  });

  it("with timed items all in the past the rest of the day is free: gap null, next null, timedCount kept", () => {
    const g = freeGapFromPlan([{ id: "p", startsAt: at(-60) }], NOW);
    assert.equal(g.gapMinutes, null);
    assert.equal(g.nextPlanId, null);
    assert.equal(g.timedCount, 1);
  });

  it("an unparseable start is not a timed item", () => {
    assert.equal(freeGapFromPlan([{ id: "x", startsAt: "not a date" }], NOW).timedCount, 0);
  });
});

describe("Sense consumes the engine", () => {
  it("CompassSenseEngine imports freeGapFromPlan and no longer sorts start times itself", () => {
    const src = strip(readFileSync(join(SRC, "compass", "CompassSenseEngine.ts"), "utf8"));
    assert.match(src, /import \{ freeGapFromPlan \} from "\.\.\/domain\/trips\/invariants\/TripFreedomEngine\.js"/);
    assert.match(src, /freeGapFromPlan\(items\.map/);
    assert.doesNotMatch(src, /upcoming\[0\] \?\? null/, "the engine's own derivation survives in Sense");
  });
});
