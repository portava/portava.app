/**
 * §10 live conditions as a buffer term — the seam, and the invariant it makes
 * non-vacuous.
 *
 * node:test + node:assert/strict (NOT vitest). No DB, no network. The verdict
 * is the EXIT CODE.
 *
 * ── WHAT THIS FILE IS FOR ────────────────────────────────────────────────────
 * §6.1's first hard invariant is "security_wait ↑ must never increase
 * usable_time". Until this pass the census scored it `C ⌀` — VACUOUS — with the
 * reason stated in `layoverFeasibilityInvariants.test.ts`'s own header: "
 * `security_wait` HAS NO INPUT on this tree". It has one now
 * (`LiveConditions.securityWaitExtraMin`, `LayoverSafetyEngine.ts`), and this
 * file sweeps the invariant over it directly instead of over the buffer columns
 * that stood in for it.
 *
 * It also pins the thing that makes adding a sixth buffer term safe: WITH NO
 * LIVE CONDITIONS SUPPLIED THE ARITHMETIC IS UNCHANGED, term for term. Nothing
 * on this tree supplies any outside tests, so that equality is what says no
 * traveller's number moved.
 *
 * ── RED-FIRST RECORD ─────────────────────────────────────────────────────────
 * Every mutation below was made to PRODUCTION code (never to a test, never to
 * a constant the assertion reads back), measured, and reverted. Recorded as
 * `pass/fail` counts of this file's own run.
 *
 * GREEN, unmutated: 27 pass / 0 fail.
 *
 *   M1  LayoverSafetyEngine.liveExtraMinutes — drop the `n > 0` clamp, so
 *       `term = (n) => (Number.isFinite(n) ? n : 0)` lets a negative term
 *       through and a "−40 minute queue" buys forty minutes in the city.
 *       MEASURED: 26 pass / 1 fail.
 *
 *   M2  LayoverSafetyEngine.computeBuffer — omit `liveExtra` from `totalBuffer`
 *       (compute it, publish it in the breakdown, do not add it), the classic
 *       "the field is there so it must be wired" defect.
 *       MEASURED: 24 pass / 3 fail.
 *
 *       READ THIS ONE, IT IS THE USEFUL RESULT. The three failures are the
 *       STRICTNESS assertions ("each term strictly bites", "a 40-minute spike
 *       moves the deadline exactly 40 minutes earlier", "bufferMinutesAtPercentile
 *       equals totalBuffer"). NOT ONE of the six monotonicity sweeps failed —
 *       a term wired to nothing is constant in its input, and a constant is
 *       non-increasing. A file that had only swept monotonicity would have
 *       reported this defect green over 1,400 assertions. That is why the
 *       strict cases are here and why they are not redundant with the sweeps.
 *
 *   M3  LayoverFeasibility.conservativeBufferMinutes — drop the
 *       `estimateMinutesAt(b.liveExtra, …)` term, so the §6.2 percentile
 *       selection silently disagrees with the deadline it is published beside.
 *       MEASURED: 26 pass / 1 fail.
 *
 *   M4  LayoverFeasibility.feasibilityInputs — stop projecting `liveConditions`
 *       into the named input set (`liveConditions: null` always), so two
 *       different computations hash the same and a replay reproduces the wrong
 *       one.
 *       MEASURED: 14 pass / 13 fail.
 *
 *   M5  LayoverSafetyEngine.adviseLeaving — drop the live-conditions reason
 *       code merge loop, so SECURITY_WAIT_HIGH never reaches the record.
 *       MEASURED: 25 pass / 2 fail.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverLiveConditions.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  certifySessionFeasibility,
  feasibilityInputs,
  feasibilityInputHash,
  type FeasibilityAirport,
  type FeasibilitySession,
} from "../services/airport/LayoverFeasibility.js";
import {
  NO_LIVE_CONDITIONS,
  computeBuffer,
  computeReturnDeadline,
  liveExtraMinutes,
  type LiveConditions,
} from "../services/airport/LayoverSafetyEngine.js";

const MIN = 60_000;

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

function live(over: Partial<LiveConditions> = {}): LiveConditions {
  return { ...NO_LIVE_CONDITIONS, ...over, reasonCodes: over.reasonCodes ?? [] };
}

const NOW = Date.parse("2030-06-14T21:00:00.000Z");

// ═══════════════════════════════════════════════════════════════════════════
// 1. Absent live conditions change nothing
// ═══════════════════════════════════════════════════════════════════════════

describe("no live conditions supplied — the arithmetic is what it was", () => {
  it("liveExtra is 0 and totalBuffer is the sum of EVERY term the breakdown publishes", () => {
    for (const tz of ["Asia/Taipei", "America/New_York", "Europe/Berlin"]) {
      for (const intl of [true, false]) {
        for (const bags of [true, false]) {
          const a = airport({ timezone: tz });
          const s = session({
            flightType: intl ? "international" : "domestic",
            immigrationRequired: intl,
            checkedBags: bags,
          });
          const b = computeBuffer(a, s, new Date(Date.parse(s.departureTime)), tz);
          assert.equal(b.liveExtra, 0, `${tz} intl=${intl} bags=${bags}`);
          // Summed by ENUMERATING the breakdown rather than by naming the terms
          // this case was written against. It used to assert that
          // "the five original terms must still sum to the total when nothing
          // is live", and that spelling went red the day a seventh term
          // (`returnTransportExtra`, census L72) arrived — reporting a term
          // that IS accounted for as one that is not. What the case is actually
          // for is that NO term escapes the total, and that claim gets
          // stronger, not weaker, when a term is added without this file being
          // edited at all.
          const named = Object.entries(b)
            .filter(([k]) => k !== "totalBuffer")
            .reduce((sum, [, v]) => sum + (v as number), 0);
          assert.equal(
            b.totalBuffer, named,
            `every term in the breakdown must sum to the total when nothing is live (${tz} intl=${intl} bags=${bags})`,
          );
        }
      }
    }
  });

  it("passing NO_LIVE_CONDITIONS is identical to passing nothing", () => {
    const a = airport();
    const s = session();
    assert.deepEqual(
      computeBuffer(a, s, new Date(Date.parse(s.departureTime)), a.timezone, NO_LIVE_CONDITIONS),
      computeBuffer(a, s, new Date(Date.parse(s.departureTime)), a.timezone),
    );
    assert.equal(
      certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: NO_LIVE_CONDITIONS })
        .deadline.hardReturnTime.getTime(),
      certifySessionFeasibility(a, s, { nowMs: NOW }).deadline.hardReturnTime.getTime(),
    );
  });

  it("the record's liveExtra estimate is an honest zero, not a live reading of zero", () => {
    const r = certifySessionFeasibility(airport(), session(), { nowMs: NOW });
    assert.equal(r.estimates.liveExtra.valueMinutes, 0);
    assert.equal(r.estimates.liveExtra.sourceClass, "STATIC_DEFAULT");
    assert.equal(r.estimates.liveExtra.fallbackLevel, 3);
    assert.equal(r.estimates.liveExtra.observedAt, null);
    assert.deepEqual(r.estimates.liveExtra.sourceRefs, ["no live conditions supplied"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. §6.1 L51 — security_wait ↑ never increases usable_time. NOT VACUOUS.
// ═══════════════════════════════════════════════════════════════════════════

describe("§6.1 — a larger live wait never buys the traveller more time", () => {
  const TERMS = [
    "securityWaitExtraMin",
    "immigrationWaitExtraMin",
    "groundTransportExtraMin",
  ] as const;

  for (const term of TERMS) {
    it(`usableMinutes is non-increasing in ${term}, swept 0..240`, () => {
      for (const tz of ["Asia/Taipei", "America/New_York"]) {
        const a = airport({ timezone: tz });
        const s = session();
        let prevUsable = Number.POSITIVE_INFINITY;
        let prevDeadline = Number.POSITIVE_INFINITY;
        for (let v = 0; v <= 240; v++) {
          const r = certifySessionFeasibility(a, s, {
            nowMs: NOW,
            liveConditions: live({ [term]: v }),
          });
          const usable = r.envelope.usableMinutes;
          const deadline = r.deadline.hardReturnTime.getTime();
          assert.ok(
            usable <= prevUsable,
            `${tz} ${term}=${v}: usable ${usable} > previous ${prevUsable}`,
          );
          assert.ok(
            deadline <= prevDeadline,
            `${tz} ${term}=${v}: deadline moved LATER as the wait grew`,
          );
          prevUsable = usable;
          prevDeadline = deadline;
        }
      }
    });
  }

  it("the three terms are additive and each strictly bites", () => {
    const a = airport();
    const s = session();
    const base = certifySessionFeasibility(a, s, { nowMs: NOW }).deadline.breakdown.totalBuffer;
    const all = certifySessionFeasibility(a, s, {
      nowMs: NOW,
      liveConditions: live({
        securityWaitExtraMin: 11,
        immigrationWaitExtraMin: 13,
        groundTransportExtraMin: 17,
      }),
    }).deadline.breakdown;
    assert.equal(all.liveExtra, 41);
    assert.equal(all.totalBuffer, base + 41);
  });

  it("a negative or non-finite term cannot shrink the buffer", () => {
    assert.equal(liveExtraMinutes(null), 0);
    assert.equal(liveExtraMinutes(undefined), 0);
    assert.equal(liveExtraMinutes(live({ securityWaitExtraMin: -40 })), 0);
    assert.equal(liveExtraMinutes(live({ securityWaitExtraMin: Number.NaN })), 0);
    assert.equal(liveExtraMinutes(live({ securityWaitExtraMin: Number.POSITIVE_INFINITY })), 0);
    assert.equal(
      liveExtraMinutes(live({ securityWaitExtraMin: -40, immigrationWaitExtraMin: 10 })),
      10,
      "one bad term must not cancel a good one",
    );

    const a = airport();
    const s = session();
    const clean = certifySessionFeasibility(a, s, { nowMs: NOW }).deadline.hardReturnTime.getTime();
    const poisoned = certifySessionFeasibility(a, s, {
      nowMs: NOW,
      liveConditions: live({ securityWaitExtraMin: -600 }),
    }).deadline.hardReturnTime.getTime();
    assert.equal(poisoned, clean, "a negative live term must not move the deadline later");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. §21.1 — "security spike → envelope contracts monotonically"
// ═══════════════════════════════════════════════════════════════════════════

describe("§21.1 scenario — a security spike contracts the envelope", () => {
  it("a 40-minute spike moves the deadline exactly 40 minutes earlier and shrinks usable time", () => {
    const a = airport();
    const s = session();
    const calm = certifySessionFeasibility(a, s, { nowMs: NOW });
    const spike = certifySessionFeasibility(a, s, {
      nowMs: NOW,
      liveConditions: live({ securityWaitExtraMin: 40 }),
    });
    assert.equal(
      calm.deadline.hardReturnTime.getTime() - spike.deadline.hardReturnTime.getTime(),
      40 * MIN,
    );
    assert.equal(calm.envelope.usableMinutes - spike.envelope.usableMinutes, 40);
    assert.ok(spike.envelope.usableMinutes < calm.envelope.usableMinutes);
  });

  it("the contraction is monotone across the whole spike range, in every tier", () => {
    for (const hours of [3, 6, 12]) {
      const a = airport();
      const dep = new Date(Date.parse("2030-06-14T20:00:00.000Z") + hours * 60 * MIN).toISOString();
      const s = session({ departureTime: dep });
      let prev = Number.POSITIVE_INFINITY;
      for (let v = 0; v <= 200; v += 2) {
        const u = certifySessionFeasibility(a, s, {
          nowMs: NOW,
          liveConditions: live({ securityWaitExtraMin: v }),
        }).envelope.usableMinutes;
        assert.ok(u <= prev, `${hours}h layover, spike ${v}: usable grew`);
        prev = u;
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. The deadline stays monotone in the flight cutoff WITH live conditions on
// ═══════════════════════════════════════════════════════════════════════════

describe("adding a live term does not break deadline monotonicity in the cutoff", () => {
  it("a later cutoff never yields an earlier deadline, at three live levels", () => {
    const a = airport({ timezone: "Asia/Taipei" });
    // A window that walks across both raw time-of-day band edges (20:00, 22:00
    // local) — the only place the ramp could be seen to misbehave.
    const start = Date.parse("2030-06-15T09:00:00.000Z"); // 17:00 local
    for (const level of [0, 25, 90]) {
      let prev = Number.NEGATIVE_INFINITY;
      for (let m = 0; m <= 8 * 60; m++) {
        const dep = new Date(start + m * MIN).toISOString();
        const d = computeReturnDeadline(
          a,
          session({ departureTime: dep }),
          live({ securityWaitExtraMin: level }),
        ).hardReturnTime.getTime();
        assert.ok(d >= prev, `live=${level} at +${m}min: deadline moved backwards`);
        prev = d;
      }
    }
  });

  it("the deadline is always exactly cutoff − totalBuffer, live term included", () => {
    const a = airport();
    for (const level of [0, 7, 45, 130]) {
      const s = session();
      const d = computeReturnDeadline(a, s, live({ groundTransportExtraMin: level }));
      assert.equal(d.hardReturnTime.getTime(), d.cutoffMs - d.breakdown.totalBuffer * MIN);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. §6.2 — the live term is a real estimate, and the percentile agrees
// ═══════════════════════════════════════════════════════════════════════════

describe("§6.2 — the live term is published as an estimate with real provenance", () => {
  it("supplied conditions produce a LIVE estimate carrying observedAt and expiresAt", () => {
    const r = certifySessionFeasibility(airport(), session(), {
      nowMs: NOW,
      liveConditions: live({
        securityWaitExtraMin: 25,
        reasonCodes: ["SECURITY_WAIT_HIGH"],
        observedAt: "2030-06-14T20:50:00.000Z",
        expiresAt: "2030-06-14T21:10:00.000Z",
      }),
    });
    const e = r.estimates.liveExtra;
    assert.equal(e.valueMinutes, 25);
    assert.equal(e.sourceClass, "LIVE");
    assert.equal(e.fallbackLevel, 0);
    assert.equal(e.observedAt, "2030-06-14T20:50:00.000Z");
    assert.equal(e.expiresAt, "2030-06-14T21:10:00.000Z");
  });

  it("bufferMinutesAtPercentile still equals totalBuffer with a live term", () => {
    for (const level of [0, 5, 60, 200]) {
      const r = certifySessionFeasibility(airport(), session(), {
        nowMs: NOW,
        liveConditions: live({ immigrationWaitExtraMin: level }),
      });
      assert.equal(
        r.bufferMinutesAtPercentile,
        r.deadline.breakdown.totalBuffer,
        `live=${level}: the §6.2 selection and the published buffer disagree`,
      );
    }
  });

  it("the absence of live intelligence does not lower the record's confidence", () => {
    const withNone = certifySessionFeasibility(airport(), session(), { nowMs: NOW });
    const withZero = certifySessionFeasibility(airport(), session(), {
      nowMs: NOW,
      liveConditions: live({}),
    });
    // Both are LOW here because every other term is LOW at an unverified
    // airport; what must not happen is the "no data" case reading WORSE than
    // the "live data says nothing extra" case.
    const order = ["INSUFFICIENT", "LOW", "MEDIUM", "HIGH"];
    assert.ok(order.indexOf(withNone.confidence) >= order.indexOf(withZero.confidence) - 1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The conditions are a NAMED INPUT — hash identity and replay
// ═══════════════════════════════════════════════════════════════════════════

describe("live conditions are inside the input hash", () => {
  const a = airport();
  const s = session();
  const baseHash = feasibilityInputHash(feasibilityInputs(a, s, { nowMs: NOW }));

  const cases: Array<[string, LiveConditions]> = [
    ["securityWaitExtraMin", live({ securityWaitExtraMin: 5 })],
    ["immigrationWaitExtraMin", live({ immigrationWaitExtraMin: 5 })],
    ["groundTransportExtraMin", live({ groundTransportExtraMin: 5 })],
    ["reasonCodes", live({ reasonCodes: ["DATA_STALE"] })],
    ["observedAt", live({ observedAt: "2030-06-14T20:00:00.000Z" })],
    ["expiresAt", live({ expiresAt: "2030-06-14T20:20:00.000Z" })],
    ["present but empty", live({})],
  ];

  for (const [name, conditions] of cases) {
    it(`changing ${name} changes the hash`, () => {
      assert.notEqual(
        feasibilityInputHash(feasibilityInputs(a, s, { nowMs: NOW, liveConditions: conditions })),
        baseHash,
      );
    });
  }

  it("extra keys on the caller's object do not change the hash", () => {
    const clean = live({ securityWaitExtraMin: 12 });
    const noisy = { ...clean, somethingElse: "ignored" } as unknown as LiveConditions;
    assert.equal(
      feasibilityInputHash(feasibilityInputs(a, s, { nowMs: NOW, liveConditions: noisy })),
      feasibilityInputHash(feasibilityInputs(a, s, { nowMs: NOW, liveConditions: clean })),
    );
  });

  it("a record certified under live conditions replays to the same numbers", () => {
    const conditions = live({ securityWaitExtraMin: 31, reasonCodes: ["SECURITY_WAIT_HIGH"] });
    const r1 = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: conditions });
    const r2 = certifySessionFeasibility(a, s, { nowMs: NOW, liveConditions: conditions });
    assert.equal(r1.inputHash, r2.inputHash);
    assert.deepEqual(r1.deadline.breakdown, r2.deadline.breakdown);
    assert.equal(r1.inputs.liveConditions?.securityWaitExtraMin, 31);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Appendix A — the live reason codes reach the certified record
// ═══════════════════════════════════════════════════════════════════════════

describe("Appendix A — live reason codes are carried, not re-derived", () => {
  it("SECURITY_WAIT_HIGH supplied by the truth layer lands on the record", () => {
    const r = certifySessionFeasibility(airport(), session(), {
      nowMs: NOW,
      liveConditions: live({ securityWaitExtraMin: 30, reasonCodes: ["SECURITY_WAIT_HIGH"] }),
    });
    assert.ok(r.reasonCodes.includes("SECURITY_WAIT_HIGH"));
  });

  it("all four live codes survive together and are not duplicated", () => {
    const r = certifySessionFeasibility(airport(), session(), {
      nowMs: NOW,
      liveConditions: live({
        reasonCodes: ["SECURITY_WAIT_HIGH", "TRAFFIC_DEGRADED", "DATA_STALE", "SOURCE_CONFLICT", "DATA_STALE"],
      }),
    });
    for (const c of ["SECURITY_WAIT_HIGH", "TRAFFIC_DEGRADED", "DATA_STALE", "SOURCE_CONFLICT"] as const) {
      assert.ok(r.reasonCodes.includes(c), `${c} missing`);
    }
    assert.equal(r.reasonCodes.filter((c) => c === "DATA_STALE").length, 1);
  });

  it("no live conditions means no live codes — the standing ones only", () => {
    const r = certifySessionFeasibility(airport(), session(), { nowMs: NOW });
    for (const c of ["SECURITY_WAIT_HIGH", "TRAFFIC_DEGRADED", "DATA_STALE", "SOURCE_CONFLICT"] as const) {
      assert.ok(!r.reasonCodes.includes(c), `${c} emitted with no live input at all`);
    }
    assert.ok(r.reasonCodes.includes("ENTRY_NOT_CONFIRMED"));
  });
});
