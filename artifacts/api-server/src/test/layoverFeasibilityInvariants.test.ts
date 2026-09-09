/**
 * Spec §6.1 hard invariants, asserted as property sweeps over the certified record.
 *
 * node:test + node:assert/strict (NOT vitest). No DB, no network. The verdict
 * is the EXIT CODE.
 *
 * The three invariants §6.1 states as arithmetic:
 *
 *   security_wait      ↑ must never increase usable_time
 *   return_travel_time ↑ must never expand safe_envelope
 *   departure_time earlier must never expand safe_envelope
 *
 * WHY PROPERTY SWEEPS AND NOT EXAMPLES. Each of these is a statement about a
 * FUNCTION, not about a point. The defect the third one describes (census L53)
 * was a step function: an example test at 20:00 would have passed against a
 * differently-broken step, and did not exist at all. What holds a monotonicity
 * claim down is sweeping the input minute by minute across the boundaries and
 * comparing every adjacent pair.
 *
 * WHAT IS HONESTLY VACUOUS AND WHAT IS NOT.
 *   - `security_wait` HAS NO INPUT on this tree. The census scores that row
 *     "C ⌀" — correct but vacuous — and inventing a security-wait input to
 *     make it non-vacuous would be fabricating an estimate the spec §2.1
 *     forbids. What IS real is the five `airport_profiles` buffer columns the
 *     wait would land in, plus the time-of-day term. The sweep below states
 *     the invariant over every buffer term that exists: raising ANY of them
 *     never increases usable time and never moves the deadline later. That is
 *     the strongest true form of L51 on this tree, and it is not vacuous.
 *   - `return_travel_time` is a real per-candidate input, so L52 is swept
 *     directly.
 *   - `departure_time` is swept through `certifySessionFeasibility` — the path
 *     the four route handlers now take — rather than through the engine
 *     helpers directly, so the invariant is asserted where the traveller's
 *     number actually comes from. (`layoverDeadlineMonotonicity.test.ts`
 *     covers the engine itself; this is the record.)
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverFeasibilityInvariants.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  certifySessionFeasibility,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LandsideProbe,
} from "../services/airport/LayoverFeasibility.js";
import { assess } from "../services/airport/LayoverSafetyEngine.js";
import { localHour, wallTimeToUtc } from "../services/airport/AirportTime.js";

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-tpe", iataCode: "TPE", timezone: "Asia/Taipei", verified: false,
    domesticBufferMin: 60, internationalBufferMin: 120,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    ...over,
  };
}

function session(over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-1",
    arrivalTime: "2030-06-14T20:00:00.000Z",
    departureTime: "2030-06-15T12:00:00.000Z",
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

const PROBE: LandsideProbe = {
  title: "probe", travelTimeMin: 20, activityTimeMin: 30, travelTimeSource: "category_default",
};

// ═══════════════════════════════════════════════════════════════════════════
// L51 — a larger required wait can never buy the traveller more time
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The five buffer columns are where a measured security/immigration/transfer
 * wait would land when one exists. Raising each in turn is the testable form
 * of "security_wait ↑ must never increase usable_time".
 *
 * Each column is swept twice: once with a session that ACTIVATES it (where the
 * output must move, or the sweep proves nothing) and once with a session that
 * does not (where the output must not move at all — a domestic flight must not
 * pick up the international buffer, and a traveller with no checked bags must
 * not pay the bag term). The second arm was added because the first arm's
 * non-vacuity assertion caught this test asking for the wrong pairing.
 */
const BUFFER_COLUMNS: Array<{
  column: keyof FeasibilityAirport;
  active: Partial<FeasibilitySession>;
  inactive: Partial<FeasibilitySession>;
}> = [
  { column: "domesticBufferMin",
    active:   { flightType: "domestic" },
    inactive: { flightType: "international" } },
  { column: "internationalBufferMin",
    active:   { flightType: "international" },
    inactive: { flightType: "domestic" } },
  { column: "immigrationExtraMin",
    active:   { immigrationRequired: true },
    inactive: { immigrationRequired: false } },
  { column: "checkedBagsExtraMin",
    active:   { checkedBags: true },
    inactive: { checkedBags: false } },
  // No session shape switches the traffic term off; it is always in the ladder.
  { column: "trafficExtraMin", active: {}, inactive: {} },
];

describe("§6.1 L51 — raising any buffer term never increases usable time", () => {
  const NOW = Date.parse("2030-06-15T00:00:00.000Z");

  const sweep = (column: keyof FeasibilityAirport, over: Partial<FeasibilitySession>) => {
    const out: Array<{ usable: number; hard: number; probeUsable: number }> = [];
    for (let v = 0; v <= 240; v++) {
      const r = certifySessionFeasibility(
        airport({ [column]: v } as Partial<FeasibilityAirport>),
        session(over),
        { nowMs: NOW, landsideProbe: PROBE },
      );
      out.push({
        usable: r.envelope.usableMinutes,
        hard: r.deadline.hardReturnTime.getTime(),
        probeUsable: r.landside!.usableMinutes,
      });
    }
    return out;
  };

  const assertMonotone = (column: string, points: ReturnType<typeof sweep>) => {
    for (let i = 1; i < points.length; i++) {
      assert.ok(points[i].usable <= points[i - 1].usable,
        `${column}=${i}: usableMinutes rose from ${points[i - 1].usable} to ${points[i].usable}`);
      assert.ok(points[i].hard <= points[i - 1].hard,
        `${column}=${i}: hardReturnTime moved later`);
      assert.ok(points[i].probeUsable <= points[i - 1].probeUsable,
        `${column}=${i}: the probe's usableMinutes rose`);
    }
  };

  for (const { column, active, inactive } of BUFFER_COLUMNS) {
    it(`${column} ↑ never increases usableMinutes or moves the deadline later`, () => {
      const points = sweep(column, active);
      assertMonotone(column, points);
      // Non-vacuity: a term the arithmetic ignored would sail through the
      // monotonicity assertion above.
      assert.notEqual(points[0].usable, points[points.length - 1].usable,
        `${column} never changed usableMinutes across 0..240 — the sweep proves nothing`);
      assert.notEqual(points[0].hard, points[points.length - 1].hard,
        `${column} never moved the deadline across 0..240`);
    });

    if (Object.keys(inactive).length > 0) {
      it(`${column} is inert when the session does not activate it`, () => {
        const points = sweep(column, inactive);
        assertMonotone(column, points);
        for (const p of points) {
          assert.equal(p.usable, points[0].usable,
            `${column} moved usableMinutes for a session it does not apply to`);
          assert.equal(p.hard, points[0].hard,
            `${column} moved the deadline for a session it does not apply to`);
        }
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// L52 — a longer return leg can never make a candidate safer
// ═══════════════════════════════════════════════════════════════════════════

/** Safety order, worst last. `airport_only` is a PREFERENCE, not a safety judgement. */
const SAFETY_ORDER = { safe: 0, possible_but_risky: 1, not_recommended: 2, airport_only: 0 } as const;

describe("§6.1 L52 — a longer travel leg never expands the safe envelope", () => {
  const NOW = Date.parse("2030-06-15T00:00:00.000Z");
  const a = airport();

  for (const activityTimeMin of [0, 30, 120]) {
    for (const verified of [true, false]) {
      it(`travelTimeMin ↑ (activity ${activityTimeMin}, verified ${verified}) never improves the rating`, () => {
        const s = session({ wantsToLeave: true });
        let prevRating = -1;
        let prevRequired = -1;
        let sawWorse = false;
        for (let travel = 0; travel <= 300; travel++) {
          const r = assess(a, s, {
            title: "c", travelTimeMin: travel, activityTimeMin, insideAirport: false, verified,
          }, NOW);
          const rank = SAFETY_ORDER[r.rating];
          assert.ok(rank >= prevRating, `travel=${travel}: rating improved from rank ${prevRating} to ${rank} (${r.rating})`);
          assert.ok(r.requiredMinutes >= prevRequired, `travel=${travel}: requiredMinutes fell`);
          if (rank > prevRating && prevRating >= 0) sawWorse = true;
          prevRating = rank;
          prevRequired = r.requiredMinutes;
        }
        assert.ok(sawWorse, "the rating never degraded across 0..300 min of travel — the sweep proves nothing");
      });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// L53 — an earlier departure can never expand the safe envelope, THROUGH the record
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The two windows the census names, swept minute by minute in airport-local
 * time: 05:00–08:00 (the 06:00 and 08:00 band edges) and 19:00–23:00 (the
 * 20:00 and 22:00 edges). Everything is asserted on ADJACENT pairs, so the
 * claim being tested is monotonicity and not merely "the numbers look sane".
 */
const SWEEPS: Array<{ tz: string; day: string; fromHour: number; toHour: number }> = [
  { tz: "Asia/Taipei",      day: "2030-06-15", fromHour: 5,  toHour: 8 },
  { tz: "Asia/Taipei",      day: "2030-06-15", fromHour: 19, toHour: 23 },
  { tz: "America/New_York", day: "2030-06-15", fromHour: 5,  toHour: 8 },
  { tz: "America/New_York", day: "2030-06-15", fromHour: 19, toHour: 23 },
];

describe("§6.1 L53 — an earlier departure never expands the certified envelope", () => {
  for (const { tz, day, fromHour, toHour } of SWEEPS) {
    for (const withBoarding of [false, true]) {
      it(`${tz} ${String(fromHour).padStart(2, "0")}:00→${toHour}:00 local${withBoarding ? ", boarding pinned 30 min earlier" : ""}`, () => {
        const a = airport({ timezone: tz });
        const startMs = wallTimeToUtc(tz, `${day}T${String(fromHour).padStart(2, "0")}:00`)!.getTime();
        const minutes = (toHour - fromHour) * 60;
        // `now` and arrival are fixed: only the departure moves, so nothing
        // else can explain a change in the envelope.
        const arrivalMs = startMs - 10 * 3_600_000;
        const nowMs = arrivalMs + 30 * 60_000;

        let prev: { usable: number; hard: number; available: number } | null = null;
        let sawChange = false;
        for (let m = 0; m <= minutes; m++) {
          const departureMs = startMs + m * 60_000;
          const boardingMs = withBoarding ? departureMs - 30 * 60_000 : null;
          const r = certifySessionFeasibility(
            a,
            session({
              arrivalTime: new Date(arrivalMs).toISOString(),
              departureTime: new Date(departureMs).toISOString(),
              boardingTime: boardingMs === null ? null : new Date(boardingMs).toISOString(),
            }),
            { nowMs, landsideProbe: PROBE },
          );
          const cur = {
            usable: r.envelope.usableMinutes,
            hard: r.deadline.hardReturnTime.getTime(),
            available: r.landside!.availableMinutes,
          };
          if (prev) {
            const at = `${tz} ${new Date(departureMs).toISOString()} (local hour ${localHour(tz, new Date(departureMs))})`;
            // Moving the departure ONE MINUTE LATER may never shrink any of
            // these; equivalently, an earlier departure never expands them.
            assert.ok(cur.hard >= prev.hard,
              `${at}: hardReturnTime moved EARLIER as the flight moved later — an earlier departure would have bought ${(prev.hard - cur.hard) / 60000} extra minutes`);
            assert.ok(cur.usable >= prev.usable,
              `${at}: usableMinutes fell from ${prev.usable} to ${cur.usable} as the flight moved later`);
            assert.ok(cur.available >= prev.available,
              `${at}: probe availableMinutes fell from ${prev.available} to ${cur.available}`);
            if (cur.hard !== prev.hard) sawChange = true;
          }
          prev = cur;
        }
        assert.ok(sawChange, "the deadline never moved across the sweep — the sweep proves nothing");
      });
    }
  }

  it("the record's deadline is always exactly cutoff minus the buffer it publishes", () => {
    const a = airport();
    const startMs = wallTimeToUtc("Asia/Taipei", "2030-06-15T19:00")!.getTime();
    for (let m = 0; m <= 240; m++) {
      const departureMs = startMs + m * 60_000;
      const r = certifySessionFeasibility(a, session({
        arrivalTime: new Date(departureMs - 10 * 3_600_000).toISOString(),
        departureTime: new Date(departureMs).toISOString(),
      }), { nowMs: departureMs - 9 * 3_600_000, landsideProbe: PROBE });
      assert.equal(
        r.deadline.hardReturnTime.getTime(),
        r.deadline.cutoffMs - r.deadline.breakdown.totalBuffer * 60_000,
      );
      // …and the buffer it publishes is the one the §6.2 estimates describe.
      assert.equal(r.bufferMinutesAtPercentile, r.deadline.breakdown.totalBuffer);
    }
  });
});
