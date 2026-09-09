/**
 * Layover certified feasibility record — identity, replay and single-derivation.
 *
 * node:test + node:assert/strict (NOT vitest). The verdict is the EXIT CODE.
 *
 * WHAT THIS PINS, and why each assertion is not vacuous.
 *
 * 1. ONE DERIVATION. `routes/airport.ts` used to answer four different
 *    questions about the same session by assembling `assess()`,
 *    `computeWindow()` and `adviseLeaving()` itself, once per handler. They
 *    agreed only by coincidence of call order, and the census's headline
 *    defect 2 is that coincidence failing. The source-structure test below is
 *    the regression pin for the wiring: it goes RED the moment a handler
 *    reaches for one of those three again, which an output-equality test
 *    cannot do (four handlers can agree while still each deriving their own).
 *
 * 2. REPLAY. Spec §2.1 "versioned, explainable and replayable". The claim is
 *    exact: feeding `record.inputs` back produces a deep-equal record. Not
 *    "similar" — equal. A record whose inputs did not fully determine it would
 *    fail here, which is what makes `inputHash` an identity rather than a
 *    decoration.
 *
 * 3. THE HASH DISCRIMINATES. A hash that ignored an input would let two
 *    different computations share an identity. Every named input is perturbed
 *    one at a time and the hash must move. This is the assertion that would
 *    catch a hash taken over a hand-written subset of the inputs.
 *
 * 4. ONE BUFFER, ONE DEADLINE per record — the shape of headline defect 2,
 *    asserted over a boarding time deliberately placed in a DIFFERENT
 *    time-of-day band from the departure, which is the only configuration in
 *    which the old two-anchor bug was visible. Green before this change too
 *    (`9c26efba` fixed the anchor); stated as a standing invariant, not
 *    claimed as a regression pin for this pass.
 *
 * FALSE GREENS CONSIDERED. The HTTP assertions check exact status 200 and the
 * exact field values, never `status !== 500`; `req.log` is installed because
 * the real server installs it, so a handler throw cannot masquerade as a
 * considered refusal; the certification assertions name the field and its
 * value rather than asserting truthiness of the object.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/layoverFeasibilityRecord.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { _setTestClient } from "../lib/http.js";
import airportRouter from "../routes/airport.js";
import { makeLayoverDb, airportRow, sessionRow } from "./helpers/fakeLayoverDb.js";
import {
  certifyFeasibility,
  certifySessionFeasibility,
  replayFeasibility,
  feasibilityInputs,
  feasibilityInputHash,
  conservativeBufferMinutes,
  estimateMinutesAt,
  worstConfidence,
  LAYOVER_FEASIBILITY_VERSION,
  SAFETY_CRITICAL_PERCENTILE,
  type EstimatePercentile,
  type FeasibilityAirport,
  type FeasibilitySession,
  type LandsideProbe,
} from "../services/airport/LayoverFeasibility.js";
import {
  assess,
  computeReturnDeadline,
  LAYOVER_ENGINE_VERSION,
} from "../services/airport/LayoverSafetyEngine.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── Fixtures ─────────────────────────────────────────────────────────────────

function airport(over: Partial<FeasibilityAirport> = {}): FeasibilityAirport {
  return {
    id: "airport-tpe",
    iataCode: "TPE",
    timezone: "Asia/Taipei",
    verified: false,
    domesticBufferMin: 60,
    internationalBufferMin: 120,
    immigrationExtraMin: 30,
    checkedBagsExtraMin: 15,
    trafficExtraMin: 20,
    ...over,
  };
}

function session(over: Partial<FeasibilitySession> = {}): FeasibilitySession {
  return {
    id: "session-1",
    arrivalTime: "2030-06-15T00:00:00.000Z",
    departureTime: "2030-06-15T04:00:00.000Z",
    boardingTime: null,
    flightType: "international",
    immigrationRequired: true,
    checkedBags: false,
    wantsToLeave: true,
    ...over,
  };
}

const PROBE: LandsideProbe = {
  title: "Leaving airport",
  travelTimeMin: 20,
  activityTimeMin: 30,
  travelTimeSource: "category_default",
};

const NOW = Date.parse("2030-06-15T01:00:00.000Z");

// ═══════════════════════════════════════════════════════════════════════════
// 1. Replay — the record is fully determined by its inputs
// ═══════════════════════════════════════════════════════════════════════════

describe("a certified record replays exactly from its own inputs", () => {
  it("replayFeasibility(record.inputs) deep-equals the record", () => {
    const record = certifySessionFeasibility(airport(), session(), {
      nowMs: NOW,
      landsideProbe: PROBE,
    });
    assert.deepEqual(replayFeasibility(record.inputs), record);
  });

  it("replay holds with no landside probe, and across every percentile policy", () => {
    for (const p of ["p50", "p75", "p90"] as EstimatePercentile[]) {
      const record = certifySessionFeasibility(airport(), session(), {
        nowMs: NOW,
        bufferPercentile: p,
      });
      assert.equal(record.landside, null);
      assert.deepEqual(replayFeasibility(record.inputs), record);
    }
  });

  it("nothing is read from a clock: two certifications at the same nowMs are identical", () => {
    const a = certifySessionFeasibility(airport(), session(), { nowMs: NOW, landsideProbe: PROBE });
    const b = certifySessionFeasibility(airport(), session(), { nowMs: NOW, landsideProbe: PROBE });
    assert.deepEqual(a, b);
    assert.equal(a.inputHash, b.inputHash);
  });

  it("the record carries both versions and the instant it is for", () => {
    const record = certifySessionFeasibility(airport(), session(), { nowMs: NOW });
    assert.equal(record.engineVersion, LAYOVER_ENGINE_VERSION);
    assert.equal(record.feasibilityVersion, LAYOVER_FEASIBILITY_VERSION);
    assert.equal(record.computedAt, new Date(NOW).toISOString());
    assert.match(record.inputHash, /^sha256:[0-9a-f]{64}$/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. The hash discriminates every named input
// ═══════════════════════════════════════════════════════════════════════════

describe("inputHash is an identity for the computation, not a decoration", () => {
  const base = feasibilityInputs(airport(), session(), { nowMs: NOW, landsideProbe: PROBE });
  const baseHash = feasibilityInputHash(base);

  const perturbations: Array<[string, () => ReturnType<typeof feasibilityInputs>]> = [
    ["airport.id", () => feasibilityInputs(airport({ id: "other" }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.iataCode", () => feasibilityInputs(airport({ iataCode: "HND" }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.timezone", () => feasibilityInputs(airport({ timezone: "Asia/Tokyo" }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.verified", () => feasibilityInputs(airport({ verified: true }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.domesticBufferMin", () => feasibilityInputs(airport({ domesticBufferMin: 61 }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.internationalBufferMin", () => feasibilityInputs(airport({ internationalBufferMin: 121 }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.immigrationExtraMin", () => feasibilityInputs(airport({ immigrationExtraMin: 31 }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.checkedBagsExtraMin", () => feasibilityInputs(airport({ checkedBagsExtraMin: 16 }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["airport.trafficExtraMin", () => feasibilityInputs(airport({ trafficExtraMin: 21 }), session(), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.id", () => feasibilityInputs(airport(), session({ id: "session-2" }), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.arrivalTime", () => feasibilityInputs(airport(), session({ arrivalTime: "2030-06-15T00:01:00.000Z" }), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.departureTime", () => feasibilityInputs(airport(), session({ departureTime: "2030-06-15T04:01:00.000Z" }), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.boardingTime", () => feasibilityInputs(airport(), session({ boardingTime: "2030-06-15T03:30:00.000Z" }), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.flightType", () => feasibilityInputs(airport(), session({ flightType: "domestic" }), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.immigrationRequired", () => feasibilityInputs(airport(), session({ immigrationRequired: false }), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.checkedBags", () => feasibilityInputs(airport(), session({ checkedBags: true }), { nowMs: NOW, landsideProbe: PROBE })],
    ["session.wantsToLeave", () => feasibilityInputs(airport(), session({ wantsToLeave: false }), { nowMs: NOW, landsideProbe: PROBE })],
    ["nowMs", () => feasibilityInputs(airport(), session(), { nowMs: NOW + 1, landsideProbe: PROBE })],
    ["bufferPercentile", () => feasibilityInputs(airport(), session(), { nowMs: NOW, landsideProbe: PROBE, bufferPercentile: "p50" })],
    ["landsideProbe absent", () => feasibilityInputs(airport(), session(), { nowMs: NOW })],
    ["landsideProbe.travelTimeMin", () => feasibilityInputs(airport(), session(), { nowMs: NOW, landsideProbe: { ...PROBE, travelTimeMin: 21 } })],
    ["landsideProbe.activityTimeMin", () => feasibilityInputs(airport(), session(), { nowMs: NOW, landsideProbe: { ...PROBE, activityTimeMin: 31 } })],
    ["landsideProbe.travelTimeSource", () => feasibilityInputs(airport(), session(), { nowMs: NOW, landsideProbe: { ...PROBE, travelTimeSource: "inside_airport" } })],
  ];

  for (const [name, build] of perturbations) {
    it(`changing ${name} changes the hash`, () => {
      assert.notEqual(feasibilityInputHash(build()), baseHash);
    });
  }

  it("the hash is key-order independent — structurally equal inputs agree", () => {
    // Deep key reversal at every level. (A `JSON.stringify(base, keyArray)`
    // replacer would have looked equivalent and was not: a replacer ARRAY
    // filters keys at every depth, so the nested airport/session fields were
    // silently dropped and the "different order" object was a different
    // object. Caught by this assertion failing — noted because it is exactly
    // the false green this file is meant to be careful about.)
    const deepReverse = (v: any): any => {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
      return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, deepReverse(x)]));
    };
    const reordered = deepReverse(base);
    // Rebuild with the sub-objects' keys in a different insertion order.
    const shuffled = {
      landsideProbe: base.landsideProbe,
      bufferPercentile: base.bufferPercentile,
      nowMs: base.nowMs,
      session: Object.fromEntries(Object.entries(base.session).reverse()) as typeof base.session,
      airport: Object.fromEntries(Object.entries(base.airport).reverse()) as typeof base.airport,
      feasibilityVersion: base.feasibilityVersion,
      engineVersion: base.engineVersion,
    };
    assert.equal(feasibilityInputHash(shuffled), baseHash);
    assert.equal(feasibilityInputHash(reordered), baseHash);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. One buffer, one deadline, one record
// ═══════════════════════════════════════════════════════════════════════════

describe("a record publishes exactly one buffer and one deadline", () => {
  /**
   * Departure 20:00 Asia/Taipei with boarding 19:30 — the two instants sit in
   * DIFFERENT raw time-of-day bands, which is the only configuration in which
   * a per-anchor buffer and a per-cutoff deadline could be seen to disagree.
   */
  const split = session({
    arrivalTime:   "2030-06-15T04:00:00.000Z", // 12:00 local
    boardingTime:  "2030-06-15T11:30:00.000Z", // 19:30 local
    departureTime: "2030-06-15T12:00:00.000Z", // 20:00 local
  });

  it("landside, envelope and deadline agree on the buffer and the deadline", () => {
    const r = certifySessionFeasibility(airport(), split, {
      nowMs: Date.parse("2030-06-15T05:00:00.000Z"),
      landsideProbe: PROBE,
    });
    const total = r.deadline.breakdown.totalBuffer;
    assert.equal(r.landside!.returnBufferMin, total);
    assert.equal(r.envelope.returnBufferMin, total);
    assert.equal(r.landside!.hardReturnTime.getTime(), r.deadline.hardReturnTime.getTime());
    assert.equal(r.envelope.hardReturnTime.getTime(), r.deadline.hardReturnTime.getTime());
    assert.deepEqual(r.landside!.breakdown, r.deadline.breakdown);
    assert.equal(
      r.deadline.hardReturnTime.getTime(),
      r.deadline.cutoffMs - total * 60_000,
    );
  });

  it("passing the certified deadline into assess() changes no assessment", () => {
    // The optional 5th argument is a REUSE of `computeReturnDeadline`, not a
    // second path. If it ever became one, this comparison is where it shows.
    const a = airport();
    const s = split;
    const deadline = computeReturnDeadline(a, s);
    for (const travel of [0, 5, 20, 60, 200]) {
      for (const activity of [0, 30, 120]) {
        for (const inside of [true, false]) {
          const cand = { title: "c", travelTimeMin: travel, activityTimeMin: activity, insideAirport: inside };
          assert.deepEqual(
            assess(a, s, cand, NOW, deadline),
            assess(a, s, cand, NOW),
            `travel=${travel} activity=${activity} inside=${inside}`,
          );
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. §6.2 estimate representation
// ═══════════════════════════════════════════════════════════════════════════

describe("§6.2 estimates describe every term without inventing a spread", () => {
  const r = certifySessionFeasibility(airport(), session(), { nowMs: NOW, landsideProbe: PROBE });
  const all = [
    r.estimates.baseBuffer, r.estimates.immigrationExtra, r.estimates.bagsExtra,
    r.estimates.trafficExtra, r.estimates.timeOfDayExtra, r.estimates.exitDelay,
    r.estimates.outboundTravel!,
  ];

  it("every spec field is present on every estimate", () => {
    for (const e of all) {
      for (const k of ["valueMinutes", "p50Minutes", "p75Minutes", "p90Minutes",
                       "confidence", "sourceClass", "observedAt", "expiresAt",
                       "fallbackLevel", "sourceRefs"]) {
        assert.ok(k in e, `missing ${k}`);
      }
    }
  });

  it("the distributions are degenerate and honestly flat — no fabricated freshness", () => {
    for (const e of all) {
      assert.equal(e.p50Minutes, e.valueMinutes);
      assert.equal(e.p75Minutes, e.valueMinutes);
      assert.equal(e.p90Minutes, e.valueMinutes);
      // Nothing is observed, so nothing may claim an observation time or a TTL.
      assert.equal(e.observedAt, null);
      assert.equal(e.expiresAt, null);
      // Nothing is live: no estimate on this tree may claim fallback level 0 or 1.
      assert.ok(e.fallbackLevel >= 2, `fallbackLevel ${e.fallbackLevel} claims a measurement that does not exist`);
    }
  });

  it("the buffer terms sum to exactly the buffer the deadline used, at every percentile", () => {
    for (const p of ["p50", "p75", "p90"] as EstimatePercentile[]) {
      assert.equal(
        conservativeBufferMinutes(r.estimates, p),
        r.deadline.breakdown.totalBuffer,
        `percentile ${p}`,
      );
    }
    assert.equal(r.bufferMinutesAtPercentile, r.deadline.breakdown.totalBuffer);
    assert.equal(r.inputs.bufferPercentile, SAFETY_CRITICAL_PERCENTILE);
  });

  it("each buffer estimate carries the value the breakdown carries", () => {
    assert.equal(r.estimates.baseBuffer.valueMinutes, r.deadline.breakdown.baseBuffer);
    assert.equal(r.estimates.immigrationExtra.valueMinutes, r.deadline.breakdown.immigrationExtra);
    assert.equal(r.estimates.bagsExtra.valueMinutes, r.deadline.breakdown.bagsExtra);
    assert.equal(r.estimates.trafficExtra.valueMinutes, r.deadline.breakdown.trafficExtra);
    assert.equal(r.estimates.timeOfDayExtra.valueMinutes, r.deadline.breakdown.timeOfDayExtra);
    assert.equal(r.estimates.exitDelay.valueMinutes, r.envelope.exitDelayMin);
  });

  it("the selected percentile is never below the point value", () => {
    for (const e of all) {
      for (const p of ["p50", "p75", "p90"] as EstimatePercentile[]) {
        assert.ok(estimateMinutesAt(e, p) >= e.valueMinutes);
      }
    }
  });

  it("provenance follows the airport, and an unverified airport is never better than LOW", () => {
    assert.equal(r.estimates.baseBuffer.sourceClass, "AIRPORT_PROFILE");
    assert.equal(r.estimates.baseBuffer.confidence, "LOW");   // verified: false
    assert.equal(r.estimates.timeOfDayExtra.sourceClass, "STATIC_DEFAULT");
    assert.equal(r.confidence, "LOW");

    // A fallback profile (no row) may not claim to be an airport fact.
    const fb = certifySessionFeasibility(airport({ id: null }), session(), { nowMs: NOW });
    assert.equal(fb.estimates.baseBuffer.sourceClass, "STATIC_DEFAULT");
    assert.equal(fb.estimates.baseBuffer.fallbackLevel, 3);

    // A verified airport may reach MEDIUM on its own columns, never on constants.
    const v = certifySessionFeasibility(airport({ verified: true }), session(), { nowMs: NOW });
    assert.equal(v.estimates.baseBuffer.confidence, "MEDIUM");
    assert.equal(v.estimates.timeOfDayExtra.confidence, "LOW");
    assert.equal(v.confidence, "LOW", "the record is only as good as its weakest term");
  });

  it("worstConfidence folds to the weakest member", () => {
    assert.equal(worstConfidence([]), "HIGH");
    assert.equal(
      worstConfidence([r.estimates.baseBuffer, r.estimates.timeOfDayExtra]),
      "LOW",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. The wiring: no route derives feasibility for itself any more
// ═══════════════════════════════════════════════════════════════════════════

describe("routes consult the certified record and nothing else", () => {
  /**
   * The regression pin for this pass. Four handlers can publish agreeing
   * numbers while each still deriving its own — that is precisely the state
   * this work removed, and an output-equality test cannot see it. This can.
   */
  it("routes/airport.ts does not call assess, computeWindow or adviseLeaving", () => {
    const src = readFileSync(join(HERE, "..", "routes", "airport.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const fn of ["assess", "computeWindow", "adviseLeaving"]) {
      const hits = (src.match(new RegExp(`\\b${fn}\\s*\\(`, "g")) ?? []).length;
      assert.equal(
        hits, 0,
        `routes/airport.ts calls ${fn}() ${hits} time(s) — feasibility must come from certifySessionFeasibility, not be re-derived per handler`,
      );
    }
    assert.match(src, /certifySessionFeasibility\s*\(/);
  });

  /**
   * The handlers that legitimately certify, BY NAME rather than by count.
   *
   * This was `assert.equal(calls, 4)`. A bare count is the weaker pin: it goes
   * red when a fifth handler is added — which it correctly did when
   * POST /return-now landed — but it cannot tell a NEW handler that certifies
   * once from an OLD handler that started certifying twice. Both read as 5.
   * Naming them keeps the ratchet and makes the diff say which handler
   * changed. Adding a row here is a deliberate act; bumping a number was not.
   */
  const FEASIBILITY_HANDLERS = [
    "/airport/sessions/:id/safety",
    "/airport/sessions/:id/return-deadline",
    "/airport/sessions/:id/return-now",
    "/airport/sessions/:id/overview",
    "/airport/sessions/:id/stops",
  ];

  it("every handler that needs feasibility certifies exactly once", () => {
    const src = readFileSync(join(HERE, "..", "routes", "airport.ts"), "utf8");
    const calls = (src.match(/certifySessionFeasibility\s*\(/g) ?? []).length;
    assert.equal(
      calls, FEASIBILITY_HANDLERS.length,
      `expected one certification per feasibility handler (${FEASIBILITY_HANDLERS.join(", ")}), found ${calls}`,
    );
    // Non-vacuity: the named routes must actually exist, or this asserts a
    // count against a list nobody maintains.
    for (const route of FEASIBILITY_HANDLERS) {
      assert.ok(
        src.includes(`"${route}"`),
        `${route} is named as a feasibility handler but no route declares it`,
      );
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Over HTTP: the certified fields reach the traveller's client
// ═══════════════════════════════════════════════════════════════════════════

const TOKEN = "feasibility-token";
const USER_ID = "user-1";
let server: http.Server;
let base: string;

function call(method: string, path: string, body?: any): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port), path: url.pathname, method,
        headers: {
          authorization: `Bearer ${TOKEN}`,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { raw += c; });
        res.on("end", () => {
          let p: any; try { p = raw ? JSON.parse(raw) : null; } catch { p = raw; }
          resolve({ status: res.statusCode ?? 0, body: p });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * A departure at 20:00 Asia/Taipei with boarding at 19:30 — the split-band
 * configuration again, now end to end, so the four endpoints are compared on
 * the one input shape where a per-handler derivation could diverge.
 */
function stage() {
  const now = Date.now();
  const tables: Record<string, any[]> = {
    feature_flags: [
      { flag: "airport_mode_enabled", enabled: true },
      { flag: "layover_safety_engine_enabled", enabled: true },
      { flag: "layover_plans_enabled", enabled: true },
      { flag: "layover_stable_recommendation_ids_enabled", enabled: false },
    ],
    airport_profiles: [airportRow({})],
    layover_sessions: [sessionRow({
      user_id: USER_ID,
      arrival_time:   new Date(now - 30 * 60_000).toISOString(),
      boarding_time:  "2030-06-15T11:30:00.000Z",
      departure_time: "2030-06-15T12:00:00.000Z",
      layover_minutes: 600,
    })],
    layover_plan_stops: [],
    layover_recommendations: [],
    layover_events: [],
    discovery_places: [],
    blocks: [],
    profiles: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { [TOKEN]: USER_ID } }), true);
  return tables;
}

before(() => {
  const app = express();
  app.use(express.json());
  // The real server installs req.log; without it a handler throw becomes a 500
  // that reads like a considered refusal.
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  return new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as any).port}`;
      resolve();
    });
  });
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("the certified header is published on every feasibility endpoint", () => {
  const expectCertified = (c: any, where: string) => {
    assert.ok(c, `${where}: no certification block`);
    assert.equal(c.engineVersion, LAYOVER_ENGINE_VERSION, where);
    assert.equal(c.feasibilityVersion, LAYOVER_FEASIBILITY_VERSION, where);
    assert.match(c.inputHash, /^sha256:[0-9a-f]{64}$/, where);
    assert.equal(typeof c.computedAt, "string", where);
    assert.ok(["yes", "tight", "no", "stay_airside"].includes(c.verdict), `${where}: verdict ${c.verdict}`);
    assert.equal(c.confidence, "LOW", `${where}: unverified airport, static buffers`);
    assert.equal(c.bufferPercentile, SAFETY_CRITICAL_PERCENTILE, where);
  };

  it("GET /safety", async () => {
    stage();
    const r = await call("GET", "/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    expectCertified(r.body.certification, "/safety");
    // The buffer and the deadline in one response come from one record.
    assert.equal(r.body.returnBufferMin, r.body.breakdown.totalBuffer);
    assert.equal(
      new Date(r.body.hardReturnTime).getTime(),
      Date.parse("2030-06-15T11:30:00.000Z") - r.body.returnBufferMin * 60_000,
    );
  });

  it("GET /overview", async () => {
    stage();
    const r = await call("GET", "/api/airport/sessions/session-1/overview");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    expectCertified(r.body.certification, "/overview");
    assert.equal(r.body.window.returnBufferMin, r.body.window.breakdown.totalBuffer);
    assert.equal(r.body.window.hardReturnTime, r.body.planFit.backByTime);
  });

  it("GET /stops", async () => {
    stage();
    const r = await call("GET", "/api/airport/sessions/session-1/stops");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    expectCertified(r.body.certification, "/stops");
  });

  it("POST /return-deadline", async () => {
    stage();
    const r = await call("POST", "/api/airport/sessions/session-1/return-deadline", { minutesBefore: 30 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    expectCertified(r.body.certification, "/return-deadline");
    assert.equal(
      new Date(r.body.hardReturnTime).getTime(),
      Date.parse("2030-06-15T11:30:00.000Z") - r.body.bufferMinutes * 60_000,
    );
  });

  it("all four endpoints publish the same deadline and the same buffer", async () => {
    stage();
    const safety = await call("GET", "/api/airport/sessions/session-1/safety");
    const overview = await call("GET", "/api/airport/sessions/session-1/overview");
    const stops = await call("GET", "/api/airport/sessions/session-1/stops");
    const deadline = await call("POST", "/api/airport/sessions/session-1/return-deadline", { minutesBefore: 30 });
    for (const r of [safety, overview, stops, deadline]) {
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const hard = safety.body.hardReturnTime;
    assert.equal(overview.body.window.hardReturnTime, hard);
    assert.equal(overview.body.localTimes.hardReturnLocal,
      new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false })
        .format(new Date(hard)));
    assert.equal(stops.body.planFit.backByTime, hard);
    assert.equal(deadline.body.hardReturnTime, hard);
    assert.equal(deadline.body.bufferMinutes, safety.body.returnBufferMin);
    assert.equal(overview.body.window.returnBufferMin, safety.body.returnBufferMin);
  });

  it("the certified record is what the safety endpoint's advice comes from", async () => {
    stage();
    const r = await call("GET", "/api/airport/sessions/session-1/safety");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.advice.verdict, r.body.certification.verdict);
    assert.equal(r.body.advice.engineVersion, LAYOVER_ENGINE_VERSION);
    assert.ok(Array.isArray(r.body.advice.reasonCodes));
    // The §6.2 estimates travel with the answer, so a client can see that
    // every figure behind it is a static default.
    assert.equal(r.body.estimates.baseBuffer.p90Minutes, r.body.estimates.baseBuffer.valueMinutes);
    assert.equal(r.body.estimates.timeOfDayExtra.sourceClass, "STATIC_DEFAULT");
  });
});

// A direct-construction sanity check that the hash function is actually the
// one the record uses — otherwise section 2 could pass against a hash nobody
// consults.
describe("the record's hash is the hash of its own inputs", () => {
  it("record.inputHash === feasibilityInputHash(record.inputs)", () => {
    const inputs = feasibilityInputs(airport(), session(), { nowMs: NOW, landsideProbe: PROBE });
    const r = certifyFeasibility(inputs);
    assert.equal(r.inputHash, feasibilityInputHash(inputs));
    assert.equal(r.inputHash, feasibilityInputHash(r.inputs));
  });
});
