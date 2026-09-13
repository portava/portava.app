/**
 * §7 Temporal Freedom — the layover is an ADAPTER of the generalised engine.
 *
 * node:test + node:assert. No DB, no network, no clock.
 *
 * census-layover scored L56 ("a generalised engine answering what can this user
 * do before they must be somewhere else") and L178
 * (`calculateCommitmentEnvelope`) NOT-BUILT, and L57/L58/L177 against a
 * hand-rolled `computeWindow`. The engine existed the whole time — in the Trips
 * domain, as `domain/trips/invariants/TripFreedomEngine.ts` — and the layover
 * spec's own §7 says what to do about that: "Layover is its first high-stakes
 * adapter", "keep airport-specific logic in the Layover adapter, not in the
 * generalized engine".
 *
 * Three things have to hold for that to be worth anything, and each is a
 * describe block below.
 *
 *  1. NO NUMBER A TRAVELLER SEES MOVED. `usableMinutes` must equal, to the
 *     minute, what `hardReturn − max(now, arrival + exitDelay)` produced before
 *     the adapter existed, and the window's own end must equal the certified
 *     `hardReturnTime` to the MILLISECOND. Swept, not sampled — if these two
 *     ever drift, the layover surface has two ways to compute the number a
 *     traveller acts on by leaving an airport, which is the defect `9c26efba`
 *     closed for the buffer.
 *
 *  2. THE CONFLICT IS NEW AND IT IS REACHABLE. A layover whose buffer eats the
 *     whole window used to publish `usableMinutes: 0` and nothing else. It now
 *     publishes how many minutes short it is. The arithmetic is checked against
 *     a hand-worked case, not against the engine restated.
 *
 *  3. THE BOUNDARY IS REAL. The adapter may not import anything airport-shaped,
 *     and the generalised engine may not import anything from
 *     `services/airport/` — spec §7's last sentence and developer rule 14. That
 *     is checked by reading both modules' import lines, because a boundary that
 *     is only a comment is the thing this census keeps finding.
 *
 * Run: node --import tsx/esm --test src/test/layoverTemporalFreedom.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  computeWindow,
  computeReturnDeadline,
  estimateExitDelay,
  layoverCutoffMs,
} from "../services/airport/LayoverSafetyEngine.js";
import {
  TemporalFreedomService,
  buildFreedomWindow,
  calculateCommitmentEnvelope,
  earliestLandsideMs,
  layoverCommitments,
  LAYOVER_ARRIVAL_COMMITMENT_ID,
  LAYOVER_DEPARTURE_COMMITMENT_ID,
  type LayoverFreedomContext,
} from "../services/airport/LayoverTemporalFreedom.js";
import type { AirportProfile } from "../services/airport/AirportProfileService.js";
import type { LayoverSession } from "../services/airport/LayoverSessionService.js";

const MIN = 60_000;
const HOUR = 60 * MIN;

function airport(over: Partial<AirportProfile> = {}): AirportProfile {
  return {
    id: "airport-1", iataCode: "TPE", name: "Taoyuan International", city: "Taipei",
    country: "Taiwan", countryCode: "TW", timezone: "Asia/Taipei", lat: 25.0777, lng: 121.2328,
    domesticBufferMin: 60, domesticBufferMax: 90,
    internationalBufferMin: 120, internationalBufferMax: 180,
    immigrationExtraMin: 30, checkedBagsExtraMin: 15, trafficExtraMin: 20,
    verified: true,
    ...over,
  };
}

function session(arrivalMs: number, departureMs: number, over: Partial<LayoverSession> = {}): LayoverSession {
  return {
    id: "session-1", userId: "user-1", airportId: "airport-1", tripId: null,
    arrivalTime: new Date(arrivalMs).toISOString(),
    departureTime: new Date(departureMs).toISOString(),
    boardingTime: null,
    layoverMinutes: Math.round((departureMs - arrivalMs) / MIN),
    flightType: "domestic", immigrationRequired: false,
    checkedBags: false, loungeAccess: false, wantsToLeave: true,
    comfortLevel: "moderate", vibeChips: [], manualAirportName: null,
    manualCity: null, manualCountry: null, manualIata: null, canonicalCityId: null,
    shareCityStatus: false, returnReminderAt: null, status: "active",
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
    ...over,
  };
}

/** A wide grid: every flight type × bags × immigration × a range of gaps. */
function* grid(): Generator<{ a: AirportProfile; s: LayoverSession; nowMs: number }> {
  const base = Date.UTC(2026, 4, 12, 3, 0, 0); // 11:00 Asia/Taipei
  for (const verified of [true, false]) {
    for (const flightType of ["domestic", "international"] as const) {
      for (const immigrationRequired of [false, true]) {
        for (const checkedBags of [false, true]) {
          // 45 min to 14 h in 25-minute steps: short enough to conflict, long
          // enough to cross the overnight and time-of-day bands.
          for (let gapMin = 45; gapMin <= 14 * 60; gapMin += 25) {
            for (const nowOffsetMin of [-30, 0, 40, 300]) {
              const arrivalMs = base;
              const departureMs = arrivalMs + gapMin * MIN;
              yield {
                a: airport({ verified }),
                s: session(arrivalMs, departureMs, { flightType, immigrationRequired, checkedBags }),
                nowMs: arrivalMs + nowOffsetMin * MIN,
              };
            }
          }
        }
      }
    }
  }
}

// ── 1. No number a traveller sees moved ──────────────────────────────────────

describe("§7 adapter — the window is the engine's and the numbers are unchanged", () => {
  it("usableMinutes equals the pre-adapter formula for every case in the grid", () => {
    let checked = 0;
    for (const { a, s, nowMs } of grid()) {
      const w = computeWindow(a, s, nowMs);
      // The formula `computeWindow` carried before the adapter existed,
      // restated here rather than imported, so this cannot pass by reading the
      // same code twice.
      const { hardReturnTime } = computeReturnDeadline(a, s);
      const legacyEarliestOut = new Date(s.arrivalTime).getTime() + estimateExitDelay(s) * MIN;
      const legacyUsable = Math.max(
        0,
        Math.round((hardReturnTime.getTime() - Math.max(nowMs, legacyEarliestOut)) / MIN),
      );
      assert.equal(
        w.usableMinutes, legacyUsable,
        `usableMinutes moved for ${s.flightType} gap=${s.layoverMinutes}m now=${nowMs}`,
      );
      assert.equal(w.earliestOutTime.getTime(), legacyEarliestOut, "earliestOutTime moved");
      checked += 1;
    }
    assert.ok(checked > 800, `expected a wide sweep, got ${checked}`);
  });

  it("the freedom window's end IS the certified hard return deadline, to the millisecond", () => {
    let withWindow = 0;
    for (const { a, s, nowMs } of grid()) {
      const w = computeWindow(a, s, nowMs);
      if (!w.freedomWindow) continue;
      assert.equal(
        Date.parse(w.freedomWindow.endsAt), w.hardReturnTime.getTime(),
        "the §7 window and the certified deadline disagree — two ways to compute one number",
      );
      assert.equal(Date.parse(w.freedomWindow.beginsAt), w.earliestOutTime.getTime());
      // The window says WHICH airport it is about. Pinned because a mutation
      // that dropped the label failed nothing: `computeWindow` reads no
      // coordinate, so the place is the IATA code or it is nothing at all.
      assert.equal(w.freedomWindow.origin?.placeId, a.iataCode);
      assert.equal(w.freedomWindow.requiredDestination?.placeId, a.iataCode);
      withWindow += 1;
    }
    assert.ok(withWindow > 300, `expected many cases to have a window, got ${withWindow}`);
  });

  it("a window and a conflict are mutually exclusive, and exactly one is present", () => {
    for (const { a, s, nowMs } of grid()) {
      const w = computeWindow(a, s, nowMs);
      assert.equal(
        w.freedomWindow === null, w.temporalConflict !== null,
        "a layover must have either a window or a stated conflict, never both and never neither",
      );
      assert.equal(w.shortfallMinutes === null, w.freedomWindow !== null);
    }
  });

  it("no window this tree can build is CERTIFIED — the buffer terms never reach HIGH", () => {
    for (const { a, s, nowMs } of grid()) {
      const w = computeWindow(a, s, nowMs);
      if (w.freedomWindow) assert.equal(w.freedomWindow.certified, false);
    }
  });

  /**
   * FOUND BY MUTATION. Hard-coding `confidence: "HIGH"` in `computeWindow`'s
   * adapter context failed NOTHING: the window carries a `NO_ORIGIN` constraint
   * (this computation reads no coordinate), which keeps `certified` false on
   * its own, so the confidence value was unobservable. It is the field a
   * consumer would read to decide how much of the buffer to trust, so it is
   * pinned to the rule `bufferEstimates` uses rather than left free.
   */
  it("the window's confidence is the BUFFER's — MEDIUM at a verified airport, LOW elsewhere", () => {
    let verified = 0;
    let generic = 0;
    for (const { a, s, nowMs } of grid()) {
      const w = computeWindow(a, s, nowMs);
      if (!w.freedomWindow) continue;
      assert.equal(w.freedomWindow.confidence, a.verified ? "MEDIUM" : "LOW");
      if (a.verified) verified += 1; else generic += 1;
    }
    assert.ok(verified > 100 && generic > 100, `both rungs must be exercised (${verified}/${generic})`);
  });

  it("the boarding cutoff, not departure, anchors the window's end", () => {
    const arrivalMs = Date.UTC(2026, 4, 12, 3, 0, 0);
    const departureMs = arrivalMs + 9 * HOUR;
    const boardingMs = departureMs - 40 * MIN;
    const s = session(arrivalMs, departureMs, { boardingTime: new Date(boardingMs).toISOString() });
    const w = computeWindow(airport(), s, arrivalMs);
    assert.ok(w.freedomWindow, "a 9h layover must have a window");
    assert.equal(layoverCutoffMs(s), boardingMs);
    assert.equal(
      Date.parse(w.freedomWindow!.endsAt),
      boardingMs - w.breakdown.totalBuffer * MIN,
      "the window ends one buffer before the BOARDING cutoff",
    );
  });
});

// ── 2. The conflict is new, and it is arithmetic rather than a label ─────────

describe("§7.2 — a layover with no window says by how much", () => {
  /**
   * Hand-worked, so a regression reports a number rather than a restatement of
   * the engine. International + immigration + bags at an unverified airport:
   *   buffer        = 120 (international) + 30 (immigration) + 15 (bags)
   *                 + 20 (traffic) + timeOfDay
   *   exit delay    = 45 (international with immigration) + 20 (bags) = 65
   * With a 2 h gap the window would have to run from arrival+65 to
   * cutoff−buffer, and cutoff−buffer is well before arrival.
   */
  const arrivalMs = Date.UTC(2026, 4, 12, 3, 0, 0); // 11:00 Taipei — no time-of-day extra
  const s = session(arrivalMs, arrivalMs + 2 * HOUR, {
    flightType: "international", immigrationRequired: true, checkedBags: true,
  });
  const a = airport({ verified: false });

  it("publishes no window, a NO_TIME_TO_TRAVEL conflict and the exact shortfall", () => {
    const w = computeWindow(a, s, arrivalMs);
    assert.equal(w.usableMinutes, 0);
    assert.equal(w.freedomWindow, null);
    assert.ok(w.temporalConflict, "a layover with no window must state the conflict");
    assert.equal(w.temporalConflict!.reason, "TRIP_TEMPORAL_CONFLICT");
    assert.equal(w.temporalConflict!.kind, "NO_TIME_TO_TRAVEL");
    assert.deepEqual(
      w.temporalConflict!.commitmentIds,
      [LAYOVER_ARRIVAL_COMMITMENT_ID, LAYOVER_DEPARTURE_COMMITMENT_ID],
    );

    // exitDelay(65) − (120 gap − buffer) = 65 + buffer − 120.
    const expected = estimateExitDelay(s) + w.breakdown.totalBuffer - 120;
    assert.equal(w.shortfallMinutes, expected);
    assert.ok(w.shortfallMinutes! > 0, "a conflict must be a positive shortfall");
  });

  it("the shortfall shrinks minute for minute as the flight moves later", () => {
    // 185 min of buffer + 65 min of exit delay against a 120-minute gap is a
    // 130-minute hole, so the sweep has to run past it for the clear to happen.
    let previous = Infinity;
    for (let extra = 0; extra <= 180; extra += 5) {
      const later = session(arrivalMs, arrivalMs + 2 * HOUR + extra * MIN, {
        flightType: "international", immigrationRequired: true, checkedBags: true,
      });
      const w = computeWindow(a, later, arrivalMs);
      const short = w.shortfallMinutes ?? 0;
      assert.ok(short <= previous, `shortfall grew when the flight moved later (${short} > ${previous})`);
      previous = short;
    }
    assert.equal(previous, 0, "far enough out, the conflict must clear");
  });

  it("a shortfall is never published alongside a window", () => {
    const roomy = session(arrivalMs, arrivalMs + 10 * HOUR);
    const w = computeWindow(airport(), roomy, arrivalMs);
    assert.ok(w.freedomWindow);
    assert.equal(w.shortfallMinutes, null);
    assert.equal(w.temporalConflict, null);
  });
});

// ── §18 TemporalFreedomService ───────────────────────────────────────────────

describe("§18 TemporalFreedomService", () => {
  const ctx: LayoverFreedomContext = {
    arrivalMs: Date.UTC(2026, 4, 12, 3, 0, 0),
    departureMs: Date.UTC(2026, 4, 12, 3, 0, 0) + 8 * HOUR,
    cutoffMs: Date.UTC(2026, 4, 12, 3, 0, 0) + 8 * HOUR - 30 * MIN,
    exitDelayMin: 45,
    returnBufferMin: 150,
    airportPoint: null,
    airportPlaceId: "TPE",
    confidence: "LOW",
  };

  it("exposes exactly the two members the spec names", () => {
    assert.deepEqual(
      Object.keys(TemporalFreedomService).sort(),
      ["buildFreedomWindow", "calculateCommitmentEnvelope"],
    );
  });

  it("calculateCommitmentEnvelope brackets the outbound flight, and its edge is the window's end", () => {
    const env = calculateCommitmentEnvelope(ctx);
    assert.equal(env.commitmentId, LAYOVER_DEPARTURE_COMMITMENT_ID);
    assert.equal(env.type, "outbound_flight");
    assert.equal(Date.parse(env.requiredArrivalAt), ctx.cutoffMs);
    assert.equal(env.preparationMinutes, 150);
    assert.equal(env.travelMinutes, 0, "two commitments at one airport are a zero-length hop");
    assert.equal(env.reservedMinutes, 150);
    assert.equal(Date.parse(env.mustLeaveBy), ctx.cutoffMs - 150 * MIN);
    assert.equal(env.certified, false);

    const { window } = buildFreedomWindow(ctx);
    assert.ok(window);
    assert.equal(
      window!.endsAt, env.mustLeaveBy,
      "the envelope's edge and the window's end are the same instant or one of them is wrong",
    );
  });

  it("an aircraft has no lateness tolerance, and both commitments are fixed", () => {
    const [arrival, departure] = layoverCommitments(ctx);
    for (const c of [arrival!, departure!]) {
      assert.equal(c.latenessToleranceMinutes, 0);
      assert.equal(c.flexibility, "fixed");
      assert.equal(c.place.placeId, "TPE");
    }
    assert.equal(arrival!.prepMinutes, 0);
    assert.equal(departure!.prepMinutes, 150);
    assert.equal(arrival!.endsAt!.getTime(), ctx.arrivalMs + 45 * MIN);
  });

  it("earliestLandsideMs is the engine's own release instant, not a second formula", () => {
    assert.equal(earliestLandsideMs(ctx), ctx.arrivalMs + ctx.exitDelayMin * MIN);
    const { window } = buildFreedomWindow(ctx);
    assert.equal(Date.parse(window!.beginsAt), earliestLandsideMs(ctx));
  });

  /**
   * FOUND BY MUTATION. Swapping the hop's `travelMinutes: 0` for
   * `null / NO_ROUTED_PROVIDER` failed NOTHING across three suites: the engine
   * computes `endsAt = deadline − prep` in the unknown branch and
   * `deadline − (0 + prep)` in the known one, so every INSTANT is identical and
   * only the window's own honesty moves. The adapter's header claims that 0 is
   * a FACT — two commitments at one airport — and not a missing measurement;
   * these are the assertions that make the claim cost something.
   */
  it("the zero hop is a FACT, not an unknown — reserved, unconstrained, and not downgraded", () => {
    const { window } = buildFreedomWindow(ctx);
    assert.ok(window);
    assert.equal(
      window!.reservedMinutes, ctx.returnBufferMin,
      "the buffer is reserved off the end; `null` here would mean nobody measured the hop",
    );
    assert.ok(
      !window!.hardConstraints.some((h) => h.kind === "TRAVEL_UNKNOWN"),
      "a layover's hop is known to be zero — TRAVEL_UNKNOWN would be a false absence",
    );
    assert.equal(
      window!.confidence, ctx.confidence,
      "the window's confidence is the buffer's, not INSUFFICIENT — the hop adds no doubt",
    );
  });

  it("the window names the outbound flight as the destination it is bounded by", () => {
    const { window } = buildFreedomWindow(ctx);
    assert.equal(window!.requiredDestination?.commitmentId, LAYOVER_DEPARTURE_COMMITMENT_ID);
    assert.ok(
      window!.hardConstraints.some((h) => h.kind === "NEXT_IS_FIXED"),
      "an outbound flight is a fixed commitment and the window must say so",
    );
  });
});

// ── 3. The boundary spec §7 asks for, read rather than asserted ──────────────

describe("§7 / developer rule 14 — the generalised engine stays airport-free", () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
  const importLines = (src: string) =>
    src.split("\n").filter((l) => /^\s*import\b/.test(l) || /^\s*}\s*from\s+"/.test(l) || /\bfrom\s+"/.test(l));

  it("the generalised engine imports nothing from services/airport", () => {
    const lines = importLines(read("../domain/trips/invariants/TripFreedomEngine.ts"));
    for (const l of lines) {
      assert.ok(
        !/services\/airport/.test(l),
        `the generalised Temporal Freedom Engine reached into the layover adapter: ${l.trim()}`,
      );
    }
  });

  it("the layover adapter imports no airport DOMAIN type and no safety arithmetic", () => {
    const lines = importLines(read("../services/airport/LayoverTemporalFreedom.ts"));
    for (const forbidden of ["AirportProfileService", "LayoverSessionService", "LayoverSafetyEngine", "LayoverFeasibility"]) {
      assert.ok(
        !lines.some((l) => l.includes(forbidden)),
        `the adapter imported ${forbidden}; its context must be plain numbers (spec §7)`,
      );
    }
  });

  it("the adapter is what the safety engine asks — computeWindow does not re-derive the window", () => {
    const src = read("../services/airport/LayoverSafetyEngine.ts");
    assert.ok(
      src.includes("TemporalFreedomService.buildFreedomWindow(freedomCtx)"),
      "computeWindow must obtain its window through the §18 TemporalFreedomService",
    );
    assert.ok(
      !/const\s+earliestOutMs\s*=\s*arrivalMs\s*\+/.test(src),
      "the hand-rolled `arrival + exitDelay` window start is back beside the engine's",
    );
  });
});
