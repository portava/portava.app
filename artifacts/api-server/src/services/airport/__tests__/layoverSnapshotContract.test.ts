/**
 * census-layover L6 / L269 (census-discovery A13 / A14) — the PUBLISHED
 * cross-lane Layover contract.
 *
 *   L6   "All surfaces consume the same certified LayoverSnapshot /
 *         RecommendationContract; no duplicate time-budget logic."
 *   L269 "Discovery — only show experiences from the certified action universe
 *         in Layover mode."
 *
 * ── WHAT THIS SUITE IS ACTUALLY ABOUT ───────────────────────────────────────
 * The canonical derivation already existed before this file: `certifyFeasibility`
 * is the one deadline computation, `actionUniverseOf` is the §11.1 step-5 action
 * universe, and `bandCandidate` is the envelope verdict. What did NOT exist was a
 * way for a lane that is not Layover to ASK for any of it. Every consumer on the
 * tree — Compass, Safe Return, the offline bundle, the buddy gate, the replanner
 * — is handed an `AirportProfile` and a `LayoverSession` that `routes/airport.ts`
 * assembled with a PRIVATE helper. Discovery holds neither, so the only way it
 * could have gated on the certified window was to build its own loader and its
 * own arithmetic: the second time-budget logic L6 forbids.
 *
 * So the assertions below are about PUBLICATION and REFUSAL, not about the
 * arithmetic (which has its own suites):
 *
 *   1. One snapshot, reproducible: the same session at the same instant is the
 *      same `snapshotId`, and every figure on it is the certified record's own.
 *   2. The envelope on the snapshot is cut from the snapshot's own window, so a
 *      consumer cannot be handed a disc and a deadline that disagree.
 *   3. An unreadable `layover_sessions` is a REFUSAL. "You are not in a layover"
 *      is a claim about a traveller, not a description of a failed query.
 *   4. An unreadable `airport_profiles` is a REFUSAL — with a POSITIVE CONTROL
 *      first, proving the curated row really does move the deadline, so the
 *      refusal is protecting something rather than being decorative.
 *   5. The action universe REFUSES on proof and never CERTIFIES on absence: a
 *      candidate the envelope proved out of reach is BLOCKED, a candidate whose
 *      terms nobody stated is UNMEASURED and is NOT admitted, and no band this
 *      tree can emit implies a fit.
 *   6. A session that may not go landside collapses the landside universe
 *      without inventing a block, and keeps airside actions.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test src/services/airport/__tests__/layoverSnapshotContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LAYOVER_SNAPSHOT_CONTRACT_VERSION,
  LAYOVER_DISCOVERY_MODE_FLAG,
  certifiedLayoverSnapshot,
  certifiedActionUniverse,
} from "../LayoverSnapshot.js";
import { snapshotIdFor } from "../layoverLedger.js";
import { safeEnvelope } from "../LayoverEnvelope.js";
import { safeReturnPosture } from "../LayoverSafeReturnService.js";
import { LAYOVER_ENGINE_VERSION } from "../LayoverSafetyEngine.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";

const NOW = Date.parse("2026-09-15T08:00:00.000Z");
const USER = "user-1";

/** A generous international layover at a CURATED airport. */
function tables(over: { session?: Record<string, any>; airport?: Record<string, any> } = {}) {
  return {
    layover_sessions: [
      sessionRow({
        id: "session-1",
        user_id: USER,
        airport_id: "airport-tpe",
        arrival_time: new Date(NOW - 20 * 60_000).toISOString(),
        departure_time: new Date(NOW + 9 * 3_600_000).toISOString(),
        layover_minutes: 560,
        wants_to_leave: true,
        ...(over.session ?? {}),
      }),
    ],
    airport_profiles: [airportRow({ ...(over.airport ?? {}) })],
  };
}

async function snapshotOr(db: any, opts: Record<string, unknown> = {}) {
  const r = await certifiedLayoverSnapshot(db, USER, { sessionId: "session-1", nowMs: NOW, ...opts });
  assert.equal(r.ok, true, `expected a snapshot, got ${JSON.stringify(r)}`);
  return (r as { ok: true; snapshot: any }).snapshot;
}

describe("certifiedLayoverSnapshot — ONE canonical snapshot, published for other lanes", () => {
  it("carries the certification header and a reproducible snapshot identity", async () => {
    const db = makeLayoverDb(tables()) as any;
    const snap = await snapshotOr(db);

    assert.equal(snap.contractVersion, LAYOVER_SNAPSHOT_CONTRACT_VERSION);
    assert.equal(snap.sessionId, "session-1");
    assert.equal(snap.certification.engineVersion, LAYOVER_ENGINE_VERSION);
    assert.match(snap.certification.inputHash, /^sha256:[0-9a-f]{64}$/);
    // The identity is the ledger's own, not a second spelling.
    assert.equal(snap.snapshotId, snapshotIdFor("session-1", snap.certification.inputHash));

    // Same session, same instant, same snapshot. A certification that moved on
    // every request could not be the thing two surfaces agree on.
    const again = await snapshotOr(makeLayoverDb(tables()) as any);
    assert.equal(again.snapshotId, snap.snapshotId);

    // A different instant is a different computation, and says so.
    const later = await snapshotOr(makeLayoverDb(tables()) as any, { nowMs: NOW + 31 * 60_000 });
    assert.notEqual(later.snapshotId, snap.snapshotId);
  });

  it("never re-derives the deadline, the window or the escalation state", async () => {
    const db = makeLayoverDb(tables()) as any;
    const snap = await snapshotOr(db);
    const record = snap.certifiedRecord;

    assert.equal(snap.hardReturnBy, record.deadline.hardReturnTime.toISOString());
    assert.equal(snap.usableMinutes, record.envelope.usableMinutes);
    assert.equal(snap.returnState, record.envelope.returnState);
    assert.equal(snap.tier, record.envelope.tier);
    assert.equal(snap.verdict, record.verdict);
    assert.equal(snap.confidence, record.confidence);
    // The minutes-to-deadline figure is Safe Return's published derivation,
    // not a fourth copy of `(hardReturn - now) / 60000`.
    assert.equal(snap.minutesToHardReturn, safeReturnPosture(record).minutesToHardReturn);
  });

  it("cuts the envelope from the snapshot's OWN window, so disc and deadline cannot disagree", async () => {
    const db = makeLayoverDb(tables()) as any;
    const snap = await snapshotOr(db);
    assert.notEqual(snap.envelope, null, "a curated airport has coordinates; expected an envelope");
    const expected = safeEnvelope(snap.usableMinutes, snap.envelope.centre, snap.confidence);
    assert.equal(snap.envelope.radiusMetres, expected!.radiusMetres);
    assert.equal(snap.envelope.plannedRadiusMetres, expected!.plannedRadiusMetres);
    assert.equal(snap.envelope.usableMinutes, snap.usableMinutes);
    // The disc proves only the OUTWARD direction; nothing inside it is certified.
    assert.equal(snap.envelope.certifiedInward, false);
  });
});

describe("certifiedLayoverSnapshot — fail closed", () => {
  it("refuses on an unreadable layover_sessions instead of answering 'no layover'", async () => {
    const db = makeLayoverDb(tables(), {
      failures: { "layover_sessions:select": { message: "connection reset" } },
    }) as any;
    const r = await certifiedLayoverSnapshot(db, USER, { sessionId: "session-1", nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "layover_sessions_unreadable");
    assert.equal((r as any).snapshot, undefined);
  });

  it("refuses on an unreadable layover_sessions for the ACTIVE-session lookup too", async () => {
    const db = makeLayoverDb(tables(), {
      failures: { "layover_sessions:select": { message: "connection reset" } },
    }) as any;
    const r = await certifiedLayoverSnapshot(db, USER, { nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "layover_sessions_unreadable");
  });

  it("a genuinely absent session is NOT the same refusal", async () => {
    const db = makeLayoverDb({ layover_sessions: [], airport_profiles: [airportRow()] }) as any;
    const r = await certifiedLayoverSnapshot(db, USER, { sessionId: "session-1", nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "session_not_found");

    const active = await certifiedLayoverSnapshot(db, USER, { nowMs: NOW });
    assert.equal(active.ok, false);
    assert.equal((active as any).reason, "no_live_layover_session");
  });

  it("POSITIVE CONTROL: the curated airport row really does move the deadline", async () => {
    // A curated row with a distinctive international buffer.
    const curated = await snapshotOr(
      makeLayoverDb(tables({ airport: { international_buffer_min: 200, verified: true } })) as any,
    );
    // The same session with no row at all falls back to the GENERIC buffers.
    const fallback = await snapshotOr(
      makeLayoverDb({
        layover_sessions: tables({
          session: { airport_id: null, manual_iata: "TPE", manual_city: "Taoyuan", manual_country: "Taiwan" },
        }).layover_sessions,
        airport_profiles: [],
      }) as any,
    );
    assert.notEqual(
      curated.hardReturnBy,
      fallback.hardReturnBy,
      "if the curated buffers did not reach the deadline, refusing on an unreadable read would protect nothing",
    );
  });

  it("refuses on an unreadable airport_profiles instead of quietly using generic buffers", async () => {
    const db = makeLayoverDb(tables(), {
      failures: { "airport_profiles:select": { message: "connection reset" } },
    }) as any;
    const r = await certifiedLayoverSnapshot(db, USER, { sessionId: "session-1", nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal((r as any).reason, "airport_profiles_unreadable");
  });
});

describe("certifiedActionUniverse — refuses on proof, never certifies on absence", () => {
  it("BLOCKS a candidate the envelope proved out of reach and ADMITS nothing unmeasured", async () => {
    const snap = await snapshotOr(makeLayoverDb(tables()) as any);
    const universe = await certifiedActionUniverse(snap, [
      // ~1,000 km away: no road is shorter than the straight line.
      { id: "far", lat: 34.0, lng: 121.2342 },
      // Next to the airport, but nobody stated how long either leg takes.
      { id: "near-unmeasured", lat: 25.08, lng: 121.235 },
      // Next to the airport WITH both terms stated, comfortably inside the window.
      { id: "near-measured", lat: 25.08, lng: 121.235, travelTimeMin: 20, activityTimeMin: 60 },
      // Inside the terminal: no landside journey exists to measure.
      { id: "airside", lat: null, lng: null, insideAirport: true, travelTimeMin: 0, activityTimeMin: 45 },
    ]);

    const by = new Map(universe.actions.map((a: any) => [a.id, a]));
    assert.equal(by.get("far").state, "BLOCKED");
    assert.equal(by.get("far").admitted, false);
    assert.ok(by.get("far").reason, "a block is a refusal and must explain itself");

    assert.equal(by.get("near-unmeasured").state, "UNMEASURED");
    assert.equal(by.get("near-unmeasured").admitted, false);

    assert.equal(by.get("near-measured").state, "ADMITTED");
    assert.equal(by.get("near-measured").admitted, true);
    assert.equal(by.get("airside").state, "ADMITTED");

    assert.deepEqual(universe.admittedIds, ["airside", "near-measured"]);
    assert.deepEqual(universe.refusedIds, ["far"]);
    assert.deepEqual(universe.unmeasuredIds, ["near-unmeasured"]);

    // The universe travels with the certification that produced it.
    assert.equal(universe.snapshotId, snap.snapshotId);
    assert.equal(universe.certification.inputHash, snap.certification.inputHash);
  });

  it("no band this tree can emit implies a fit", async () => {
    const snap = await snapshotOr(makeLayoverDb(tables()) as any);
    const universe = await certifiedActionUniverse(snap, [
      { id: "far", lat: 34.0, lng: 121.2342 },
      { id: "near", lat: 25.08, lng: 121.235, travelTimeMin: 20, activityTimeMin: 60 },
    ]);
    for (const a of universe.actions as any[]) {
      assert.equal(a.feasibility.impliesFit, false, `${a.id} claimed a certified fit`);
    }
  });

  it("carries the §11.1 action universe rather than a second copy of its ids", async () => {
    const snap = await snapshotOr(makeLayoverDb(tables()) as any);
    const universe = await certifiedActionUniverse(snap, [
      { id: "near-measured", lat: 25.08, lng: 121.235, travelTimeMin: 20, activityTimeMin: 60 },
      { id: "near-unmeasured", lat: 25.08, lng: 121.235 },
    ]);
    assert.deepEqual(universe.universe.feasibleCandidateIds, ["near-measured"]);
    assert.deepEqual(universe.universe.unmeasuredCandidateIds, ["near-unmeasured"]);
    assert.equal(universe.universe.usableMinutes, snap.usableMinutes);
  });

  it("a session that may not go landside CLOSES landside without inventing a block", async () => {
    const snap = await snapshotOr(
      makeLayoverDb(tables({ session: { wants_to_leave: false } })) as any,
    );
    assert.equal(snap.landsideOpen, false);
    assert.ok(snap.landsideClosedReason, "a closed universe must name why");

    const universe = await certifiedActionUniverse(snap, [
      { id: "near-measured", lat: 25.08, lng: 121.235, travelTimeMin: 20, activityTimeMin: 60 },
      { id: "airside", lat: null, lng: null, insideAirport: true, travelTimeMin: 0, activityTimeMin: 45 },
    ]);
    const by = new Map(universe.actions.map((a: any) => [a.id, a]));
    assert.equal(by.get("near-measured").state, "CLOSED");
    assert.equal(by.get("near-measured").admitted, false);
    // CLOSED is not BLOCKED: nothing measured this place and the contract does
    // not pretend otherwise.
    assert.equal(by.get("near-measured").band, "UNCERTIFIED");
    // Behind security is still reachable.
    assert.equal(by.get("airside").state, "ADMITTED");
    assert.deepEqual(universe.admittedIds, ["airside"]);
  });
});

describe("the Discovery lane's flag", () => {
  it("names a flag that is OFF until a feature_flags row says otherwise", async () => {
    assert.equal(LAYOVER_DISCOVERY_MODE_FLAG, "layover_discovery_mode_enabled");
    const { isFlagEnabled } = await import("../../../lib/featureFlags.js");
    const db = makeLayoverDb({ feature_flags: [] }) as any;
    assert.equal(await isFlagEnabled(db, LAYOVER_DISCOVERY_MODE_FLAG), false);
  });
});
