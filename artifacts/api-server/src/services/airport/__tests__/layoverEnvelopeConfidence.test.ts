/**
 * census L63 — "Envelope edges contract as confidence drops **or** return risk
 * rises."
 *
 * §18 closed the second half and stated the first exactly:
 *
 *     "The envelope's edge contracts as return risk rises — a later exit, a
 *      larger buffer, a live queue all shrink `usableMinutes` and the radius
 *      with it, swept over seven windows. It does NOT contract on confidence:
 *      `confidence` is carried on the window and no edge reads it. Half the
 *      requirement."
 *
 * It also gives census L37 (`ConfidenceBand`) its missing half: the band was
 * computed and published and *"nothing consumes the value and no decision turns
 * on it"*. An edge that moves when the band moves is a consumer.
 *
 * ── WHY A SECOND EDGE AND NOT A SMALLER FIRST ONE ───────────────────────────
 * `radiusMetres` is a PROOF: outside it, `2 × lowerBound(distance) >
 * usableMinutes` and no route at any speed fits. Shrinking that on a confidence
 * band would mean declaring points infeasible that are not provably
 * infeasible — `certifiedOutward` would quietly become false, and the module's
 * whole discipline is "no proof, no block". So the proved edge does not move,
 * and the CONTRACTED edge is published beside it as a planning bound. The test
 * below pins both halves of that: the planned edge contracts monotonically as
 * confidence falls, and the proved edge does not move at all.
 *
 * Run: node --import tsx/esm --test src/services/airport/__tests__/layoverEnvelopeConfidence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  safeEnvelope,
  bandCandidate,
  ENVELOPE_UNCERTAINTY_BUDGET,
} from "../LayoverEnvelope.js";
import { ESTIMATE_CONFIDENCES } from "../LayoverFeasibility.js";

/** Taoyuan. Any fixed point works; the arithmetic is great-circle. */
const TPE = { lat: 25.0797, lng: 121.2342 };
const ORDERED = ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"] as const;

describe("L63 — the planning edge contracts as confidence drops", () => {
  it("every confidence band has a budget, and the vocabulary is the record's own", () => {
    assert.deepEqual(
      Object.keys(ENVELOPE_UNCERTAINTY_BUDGET).sort(),
      [...ESTIMATE_CONFIDENCES].sort(),
    );
  });

  it("the planned radius is monotonically non-increasing down the band", () => {
    let last = Number.POSITIVE_INFINITY;
    for (const band of ORDERED) {
      const env = safeEnvelope(300, TPE, band)!;
      assert.ok(
        env.plannedRadiusMetres <= last,
        `${band}: planned radius ${env.plannedRadiusMetres} is WIDER than the band above it (${last})`,
      );
      last = env.plannedRadiusMetres;
    }
  });

  it("and it actually moves — LOW is strictly tighter than HIGH, not merely not-wider", () => {
    const high = safeEnvelope(300, TPE, "HIGH")!;
    const low  = safeEnvelope(300, TPE, "LOW")!;
    assert.ok(
      low.plannedRadiusMetres < high.plannedRadiusMetres,
      "a contraction that never contracts is not a contraction",
    );
  });

  it("INSUFFICIENT plans nothing outside the airport", () => {
    const env = safeEnvelope(300, TPE, "INSUFFICIENT")!;
    assert.equal(env.plannedRadiusMetres, 0);
    assert.equal(env.plannedMaxOneWayMinutes, 0);
  });

  it("HIGH spends no budget — the planned edge and the proved edge coincide", () => {
    const env = safeEnvelope(300, TPE, "HIGH")!;
    assert.equal(env.uncertaintyBudgetMinutes, 0);
    assert.equal(env.plannedRadiusMetres, env.radiusMetres);
  });
});

describe("the PROVED edge does not move — a haircut is not a proof", () => {
  it("radiusMetres is identical across every band", () => {
    const radii = new Set(ORDERED.map((b) => safeEnvelope(300, TPE, b)!.radiusMetres));
    assert.equal(radii.size, 1, `the proved outer bound moved with confidence: ${[...radii]}`);
  });

  it("certifiedOutward stays true, and certifiedInward stays false", () => {
    for (const b of ORDERED) {
      const env = safeEnvelope(300, TPE, b)!;
      assert.equal(env.certifiedOutward, true);
      assert.equal(env.certifiedInward, false);
    }
  });

  it("omitting the band reproduces the pre-L63 envelope exactly", () => {
    const bare = safeEnvelope(300, TPE)!;
    assert.equal(bare.uncertaintyBudgetMinutes, 0);
    assert.equal(bare.plannedRadiusMetres, bare.radiusMetres);
    assert.equal(bare.confidence, null);
  });
});

describe("the contracted edge reaches a candidate verdict", () => {
  /**
   * ~24 km east of TPE. On a 120-minute window the straight-line bound puts it
   * 49 minutes out one-way: inside the proved edge (60) and inside the HIGH
   * planning edge (60), outside the LOW one (45). Chosen to sit BETWEEN the two
   * edges — a point on either side of both would prove nothing.
   */
  const FAR = { lat: 25.0797, lng: 121.46 };
  const AT = new Date("2026-09-20T02:00:00.000Z");

  it("a point inside the proved disc but outside the LOW planning edge is flagged, not blocked", async () => {
    const env = safeEnvelope(120, TPE, "LOW")!;
    const v = await bandCandidate(env, FAR, AT);
    assert.equal(v.band, "UNCERTIFIED", "a confidence haircut may never produce a BLOCK");
    assert.equal(v.withinPlannedEdge, false);
    assert.match(String(v.plannedEdgeReason), /confidence/i);
  });

  it("the same point under HIGH confidence is inside the planning edge", async () => {
    const env = safeEnvelope(120, TPE, "HIGH")!;
    const v = await bandCandidate(env, FAR, AT);
    assert.equal(v.withinPlannedEdge, true);
    assert.equal(v.plannedEdgeReason, null);
  });

  it("a point outside the PROVED disc is still BLOCKED, with its arithmetic reason", async () => {
    const VERY_FAR = { lat: 25.0797, lng: 124.0 };
    const env = safeEnvelope(60, TPE, "HIGH")!;
    const v = await bandCandidate(env, VERY_FAR, AT);
    assert.equal(v.band, "BLOCKED");
    assert.match(String(v.reason), /usable time/);
  });
});

// ── Reachability: the certified confidence must reach the envelope on the wire

describe("GET /airport/sessions/:id/overview publishes the contracted edge", () => {
  it("safeEnvelope carries the record's confidence and a strictly tighter planning edge", async () => {
    const http = await import("node:http");
    const express = (await import("express")).default;
    const { _setTestClient } = await import("../../../lib/http.js");
    const airportRouter = (await import("../../../routes/airport.js")).default;
    const { makeLayoverDb, airportRow, sessionRow } = await import("../../../test/helpers/fakeLayoverDb.js");

    const app = express();
    app.use(express.json());
    app.use((r: any, _res: any, next: any) => { r.log = { error() {}, info() {}, warn() {}, debug() {} }; next(); });
    app.use("/api", airportRouter);
    const server = await new Promise<any>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const port = (server.address() as any).port;

    _setTestClient(makeLayoverDb({
      feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
      airport_profiles: [airportRow()],
      layover_sessions: [sessionRow({ user_id: "user-1" })],
      layover_events: [], layover_plan_stops: [], trip_plan_items: [],
    }, { users: { "env-token": "user-1" } }), true);

    const body = await new Promise<any>((resolve, reject) => {
      const r = http.request(
        { hostname: "127.0.0.1", port, path: "/api/airport/sessions/session-1/overview", method: "GET",
          headers: { authorization: "Bearer env-token" } },
        (res) => {
          let raw = ""; res.on("data", (c) => (raw += c));
          res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
        });
      r.on("error", reject); r.end();
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const env = body?.safeEnvelope;
    assert.ok(env, `no safeEnvelope on the overview: ${JSON.stringify(body).slice(0, 200)}`);
    // Every production session on this tree certifies LOW — there is no
    // verified airport and `timeOfDayExtra` is a STATIC_DEFAULT everywhere.
    assert.ok(["LOW", "MEDIUM", "HIGH", "INSUFFICIENT"].includes(env.confidence), String(env.confidence));
    assert.ok(env.uncertaintyBudgetMinutes > 0, "a LOW-confidence window must hold minutes back");
    assert.ok(
      env.plannedRadiusMetres < env.radiusMetres,
      `the wired edge did not contract: planned ${env.plannedRadiusMetres} vs proved ${env.radiusMetres}`,
    );
  });
});
