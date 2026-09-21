/**
 * census-layover L46 / L269 — the ride back is not the ride out.
 *
 * §12.1's subtraction ladder names the return leg with a parenthesis that is
 * the whole requirement: *"return (future conditions, not symmetric)"*. The
 * census scores L46 `W` and quotes the divergence verbatim:
 *
 *   "Outbound and return transport are not in the ladder at all — they are
 *    per-candidate and SYMMETRIC (`travelTimeMin * 2`), which is the exact
 *    opposite of 'not symmetric'."
 *
 * ── WHERE THAT DOUBLING IS REACHED FROM, AND WHY IT MATTERS HERE ────────────
 * `certifiedActionUniverse` is the ONLY list `census-layover §25 L269` permits
 * a Discovery surface to show in Layover mode, and its admission arithmetic is
 * `candidateFits` — which charged `travelTimeMin * 2` for every landside
 * candidate. So the symmetry was not an internal detail of the safety engine:
 * it decided which places another architecture was allowed to put in front of
 * a traveller who has a plane to catch.
 *
 * The geometry half of this tree had already stopped assuming it.
 * `bandCandidate` asks the port for the return leg TWICE — once at the
 * departure instant and once at the instant the window says they must start
 * back — and publishes `returnLowerBoundMin`, `returnForecastLowerBoundMin`
 * and `returnDepartsAt`. That is a LOWER BOUND, so it can refuse a journey and
 * can never certify one. The admission arithmetic, which CAN certify one, was
 * the half still doubling.
 *
 * ── WHAT A SYMMETRIC CHARGE BUYS, IN MINUTES ────────────────────────────────
 * A traveller states a 20-minute ride out and a 60-minute visit against a
 * window with room for 100. `20*2 + 60 = 100` fits, so the card is ADMITTED.
 * If the ride back at the hour they would actually start back takes 45 minutes
 * — rush hour, a closed line, a stadium emptying — the true cost is
 * `20 + 60 + 45 = 125`, and the traveller is 25 minutes past their own
 * certified deadline holding a card this contract certified.
 *
 * ── AND WHAT THIS SUITE DOES *NOT* CLAIM ────────────────────────────────────
 * It does not claim the ladder is built. Six of §12.1's eleven terms are still
 * lumped into one `estimateExitDelay` constant and this changes none of them,
 * so L46 stays `W`. It does not claim a traveller will see a different card
 * today either: `LAYOVER_TRAVEL_TIME_PROVIDER` is `noRoutedProvider`, so on
 * this deployment the port answers `NO_ROUTED_PROVIDER` to both legs and the
 * return term is an ABSENCE that falls back to the symmetric charge — exactly
 * the number served before. What is closed is that the contract can now be
 * TOLD the ride back is longer, and refuses when it is.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx --test \
 *      src/services/airport/__tests__/layoverReturnLegAsymmetry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { certifiedLayoverSnapshot, certifiedActionUniverse } from "../LayoverSnapshot.js";
import { candidateFits, candidateIsUnmeasured } from "../LayoverEventReplanner.js";
import { makeLayoverDb, airportRow, sessionRow } from "../../../test/helpers/fakeLayoverDb.js";
import { statedLayoverTimings } from "../../../lib/discoveryLayoverTiming.js";
import { discoveryLayoverGate } from "../../../lib/discoveryLayoverMode.js";
import type {
  TravelTimeProvider,
  TravelTimeQuery,
  TravelTimeResult,
} from "../../../domain/trips/contracts/TravelTimeProvider.js";
const NOW = Date.parse("2026-09-15T08:00:00.000Z");
const USER = "user-1";

/** Right beside the airport, so the straight-line band can never block it. */
const NEAR = { lat: 25.08, lng: 121.235 };

function tables(over: { session?: Record<string, any> } = {}) {
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
    airport_profiles: [airportRow({})],
  };
}

async function snapshot() {
  const r = await certifiedLayoverSnapshot(makeLayoverDb(tables()) as any, USER, {
    sessionId: "session-1",
    nowMs: NOW,
  });
  assert.equal(r.ok, true, `expected a snapshot, got ${JSON.stringify(r)}`);
  return (r as { ok: true; snapshot: any }).snapshot;
}

describe("L46 — the certified universe may be told the ride back is longer", () => {
  it("REFUSES a card whose stated return leg overflows the window a doubled outbound fits", async () => {
    const snap = await snapshot();
    const usable = snap.usableMinutes as number;
    assert.ok(usable > 200, `fixture must have a generous window, got ${usable}`);

    const out = 20;
    // Symmetric cost lands 5 minutes INSIDE the window …
    const activity = usable - 2 * out - 5;
    // … and the real ride back is 20 minutes longer than the ride out, which
    // puts the true cost 15 minutes PAST it.
    const back = out + 20;
    assert.ok(out + activity + back > usable, "fixture must actually overflow");
    assert.ok(2 * out + activity <= usable, "fixture must fit under the doubled charge");

    const universe = await certifiedActionUniverse(snap, [
      {
        id: "rush-hour",
        ...NEAR,
        travelTimeMin: out,
        returnTravelTimeMin: back,
        activityTimeMin: activity,
      },
    ]);
    const action = universe.actions.find((a: any) => a.id === "rush-hour")!;
    assert.equal(
      action.admitted,
      false,
      "a card whose stated ride back overflows the certified window was ADMITTED",
    );
    assert.equal(action.state, "BLOCKED");
    assert.deepEqual(universe.admittedIds, []);
  });

  it("POSITIVE CONTROL: the same card with a FASTER ride back is admitted", async () => {
    const snap = await snapshot();
    const usable = snap.usableMinutes as number;
    const out = 20;
    const activity = usable - 2 * out - 5;

    const universe = await certifiedActionUniverse(snap, [
      { id: "clear-road", ...NEAR, travelTimeMin: out, returnTravelTimeMin: out - 10, activityTimeMin: activity },
    ]);
    assert.deepEqual(universe.admittedIds, ["clear-road"]);
  });

  it("an ABSENT return leg falls back to the symmetric charge, byte for byte", async () => {
    const snap = await snapshot();
    const usable = snap.usableMinutes as number;
    const out = 20;
    const activity = usable - 2 * out - 5;

    const withoutTerm = await certifiedActionUniverse(snap, [
      { id: "same", ...NEAR, travelTimeMin: out, activityTimeMin: activity },
    ]);
    const withNullTerm = await certifiedActionUniverse(snap, [
      { id: "same", ...NEAR, travelTimeMin: out, returnTravelTimeMin: null, activityTimeMin: activity },
    ]);
    const symmetric = await certifiedActionUniverse(snap, [
      { id: "same", ...NEAR, travelTimeMin: out, returnTravelTimeMin: out, activityTimeMin: activity },
    ]);
    assert.deepEqual(withoutTerm.admittedIds, ["same"]);
    assert.deepEqual(withNullTerm.admittedIds, ["same"]);
    assert.deepEqual(symmetric.admittedIds, ["same"]);
  });

  it("an ABSENT return leg is charged the OUTBOUND AGAIN, not nothing", async () => {
    // The fallback has to be the doubling, not a zero. A zero ride home makes
    // every place on earth fit, which is the exact shape of the defect
    // `layover_plan_stops.travel_min INTEGER NOT NULL DEFAULT 0` produced.
    const snap = await snapshot();
    const usable = snap.usableMinutes as number;
    const out = 20;
    // Five minutes PAST the window under the symmetric charge, and comfortably
    // inside it if the ride home were free.
    const activity = usable - 2 * out + 5;
    assert.ok(out + activity <= usable, "a free ride home would admit this");

    for (const candidate of [
      { id: "no-term", ...NEAR, travelTimeMin: out, activityTimeMin: activity },
      { id: "no-term", ...NEAR, travelTimeMin: out, returnTravelTimeMin: null, activityTimeMin: activity },
    ]) {
      const universe = await certifiedActionUniverse(snap, [candidate]);
      assert.deepEqual(universe.admittedIds, [], JSON.stringify(candidate));
    }
  });

  it("a NEGATIVE or NON-FINITE return leg is not a statement, and buys nothing", async () => {
    const snap = await snapshot();
    const usable = snap.usableMinutes as number;
    const out = 20;
    const activity = usable - 2 * out + 5;

    for (const back of [-100, Number.NaN, Number.POSITIVE_INFINITY]) {
      const universe = await certifiedActionUniverse(snap, [
        { id: "bad", ...NEAR, travelTimeMin: out, returnTravelTimeMin: back, activityTimeMin: activity },
      ]);
      assert.deepEqual(
        universe.admittedIds,
        [],
        `a return leg of ${String(back)} was read as a measurement`,
      );
    }
  });

  it("an UNSTATED return leg is not a term nobody stated — the outbound still is", () => {
    // The return leg is a REFINEMENT, not a required term: making it required
    // would turn every candidate on this tree UNMEASURED overnight, which is
    // the fabricated-absence mirror of the fabricated-value defect.
    assert.equal(
      candidateIsUnmeasured({ id: "a", travelTimeMin: 20, activityTimeMin: 30, insideAirport: false }),
      false,
    );
    assert.equal(
      candidateIsUnmeasured({ id: "a", travelTimeMin: null, activityTimeMin: 30, insideAirport: false }),
      true,
    );
  });

  it("AIRSIDE is unchanged: there is no landside leg to be asymmetric about", async () => {
    const snap = await snapshot();
    const record = snap.certifiedRecord;
    assert.equal(
      candidateFits(record, {
        id: "airside",
        travelTimeMin: 0,
        returnTravelTimeMin: 9_999,
        activityTimeMin: 45,
        insideAirport: true,
      }),
      true,
      "an airside card must not be charged a landside return",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The producer half: where Discovery's return leg comes from
// ─────────────────────────────────────────────────────────────────────────────

/** One routed answer, in the port's own shape. The doubles below share it. */
const routedAnswer = (minutes: number): TravelTimeResult => ({
  kind: "estimate",
  estimate: {
    minutes,
    p50Minutes: minutes,
    p75Minutes: minutes,
    p90Minutes: minutes,
    confidence: "HIGH",
    sourceClass: "LIVE",
    observedAt: null,
    expiresAt: null,
    fallbackLevel: 0,
    sourceRefs: ["test/routedAnswer"],
  },
  assumption: null,
  expectedMinutes: null,
});

/**
 * A ROUTED, TIME-AWARE provider. Nothing on this tree produces one — that is
 * the whole reason the port is injectable — and it is the only shape under
 * which the asymmetry above is observable end to end.
 *
 * The ride out is `outMin`. The ride back is `backMin`, but ONLY for a query
 * whose `departAt` is later than the one the outbound was asked at: a provider
 * that answered the slow number to every query would prove nothing about
 * WHICH INSTANT the return leg was asked at, and that instant is the
 * requirement.
 */
function rushHourProvider(outMin: number, backMin: number, notBefore: Date): TravelTimeProvider {
  return {
    id: "test-rush-hour",
    routed: true,
    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      if (!q.from || !q.to) return { kind: "unknown", reason: "NO_COORDINATES" };
      return routedAnswer(q.departAt.getTime() > notBefore.getTime() ? backMin : outMin);
    },
  };
}

/** Airport centre and one place beside it, plus a stop the traveller stated. */
const CENTRE = { lat: 25.0777, lng: 121.2328 };
const DEPART_AT = new Date(NOW);

function planStopsDb(rows: Array<Record<string, unknown>>) {
  return makeLayoverDb({ layover_plan_stops: rows }) as any;
}

describe("L46 — the return leg is asked for at the instant they start back", () => {
  it("carries a SEPARATE return figure, asked later than the outbound", async () => {
    const out = await statedLayoverTimings(
      planStopsDb([
        { session_id: "session-1", place_id: "p1", duration_min: 90, travel_min: 0, inside_airport: false },
      ]),
      "session-1",
      [{ id: "p1", ...NEAR }],
      {
        centre: CENTRE,
        departAt: DEPART_AT,
        provider: rushHourProvider(20, 45, DEPART_AT),
      },
    );
    assert.equal(out.ok, true);
    const t = (out as any).byId.get("p1");

    assert.equal(t.travelTimeMin, 20, "the outbound is the leg asked at the departure instant");
    assert.equal(t.travel.source, "routed_port");
    assert.equal(
      t.returnTravelTimeMin,
      45,
      "the ride back must be asked for at the instant they would START BACK, not at departure",
    );
    assert.equal(t.returnTravel.source, "routed_port");
    assert.equal(t.returnTravel.absence, null);
    // The flat field is READ OFF the record, never computed twice.
    assert.equal(t.returnTravelTimeMin, t.returnTravel.value);
  });

  it("with NO routed provider — this deployment — the return is an ABSENCE that names the port", async () => {
    const out = await statedLayoverTimings(
      planStopsDb([
        { session_id: "session-1", place_id: "p1", duration_min: 90, travel_min: 25, inside_airport: false },
      ]),
      "session-1",
      [{ id: "p1", ...NEAR }],
      { centre: CENTRE, departAt: DEPART_AT },
    );
    const t = (out as any).byId.get("p1");
    // The traveller's own self-report still stands for the outbound …
    assert.equal(t.travelTimeMin, 25);
    assert.equal(t.travel.source, "traveller_plan_stop");
    // … and there is no second number, so the charge stays symmetric.
    assert.equal(t.returnTravelTimeMin, null);
    assert.equal(t.returnTravel.source, "unmeasured");
    assert.equal(t.returnTravel.portReason, "NO_ROUTED_PROVIDER");
  });

  it("INSIDE the terminal there is no ride back to measure, and it says so", async () => {
    const out = await statedLayoverTimings(
      planStopsDb([
        { session_id: "session-1", place_id: "p1", duration_min: 45, travel_min: 0, inside_airport: true },
      ]),
      "session-1",
      [{ id: "p1", ...NEAR }],
      { centre: CENTRE, departAt: DEPART_AT, provider: rushHourProvider(20, 45, DEPART_AT) },
    );
    const t = (out as any).byId.get("p1");
    assert.equal(t.insideAirport, true);
    assert.equal(t.returnTravelTimeMin, null);
    assert.equal(t.returnTravel.absence, "no_landside_leg");
    assert.equal(t.returnTravel.portReason, null, "the port was never asked, so it has no word here");
  });

  it("with no stated dwell the START-BACK INSTANT is unknown, and no leg is invented for it", async () => {
    const out = await statedLayoverTimings(
      planStopsDb([]),
      "session-1",
      [{ id: "p1", ...NEAR }],
      { centre: CENTRE, departAt: DEPART_AT, provider: rushHourProvider(20, 45, DEPART_AT) },
    );
    const t = (out as any).byId.get("p1");
    assert.equal(t.travelTimeMin, 20, "the outbound is knowable without a dwell");
    assert.equal(t.activityTimeMin, null);
    assert.equal(t.returnTravelTimeMin, null);
    assert.equal(
      t.returnTravel.absence,
      "return_instant_unknown",
      "an unknown start-back instant is its OWN absence, not 'you have no stop'",
    );
  });

  it("an OSM element has no layover subject, and that outranks every other absence", async () => {
    const out = await statedLayoverTimings(
      planStopsDb([]),
      "session-1",
      [{ id: "node/4242", ...NEAR }],
      { centre: CENTRE, departAt: DEPART_AT, provider: rushHourProvider(20, 45, DEPART_AT) },
    );
    const t = (out as any).byId.get("node/4242");
    assert.equal(t.returnTravel.absence, "no_layover_subject");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End to end: Discovery's own gate, refusing on the ride back
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A ROUTED provider keyed on DIRECTION rather than on the clock.
 *
 * The "asked at the later instant" property is proved by `rushHourProvider`
 * above, against the resolver directly where the instant is an argument. Here
 * the gate owns its own clock, so a time-keyed double would be asserting the
 * test's arithmetic rather than the gate's; direction is the property this
 * block is about.
 */
function directionalProvider(outMin: number, backMin: number): TravelTimeProvider {
  return {
    id: "test-directional",
    routed: true,
    async estimate(q: TravelTimeQuery): Promise<TravelTimeResult> {
      if (!q.from || !q.to) return { kind: "unknown", reason: "NO_COORDINATES" };
      const towardsPlace = q.to.lat === NEAR.lat && q.to.lng === NEAR.lng;
      return routedAnswer(towardsPlace ? outMin : backMin);
    },
  };
}

describe("L269 — Discovery's gate charges the ride back it was told about", () => {
  /**
   * The gate owns its own clock (`Date.now()` inside `certifiedLayoverSnapshot`),
   * so this fixture is anchored to the real instant rather than to `NOW`.
   */
  function liveTables() {
    const now = Date.now();
    return {
      layover_sessions: [
        sessionRow({
          id: "session-1",
          user_id: USER,
          airport_id: "airport-tpe",
          arrival_time: new Date(now - 20 * 60_000).toISOString(),
          departure_time: new Date(now + 9 * 3_600_000).toISOString(),
          layover_minutes: 560,
          wants_to_leave: true,
        }),
      ],
      airport_profiles: [airportRow({})],
      feature_flags: [{ flag: "layover_discovery_mode_enabled", enabled: true }],
      layover_plan_stops: [
        {
          session_id: "session-1",
          place_id: "p1",
          duration_min: 60,
          travel_min: 20,
          inside_airport: false,
        },
      ],
    };
  }

  async function gateWith(provider?: TravelTimeProvider) {
    const db = makeLayoverDb(liveTables()) as any;
    return discoveryLayoverGate(db, USER, [{ id: "p1", ...NEAR }], "GET /discovery", { provider });
  }

  it("WITHHOLDS a place whose routed ride back overflows the certified window", async () => {
    const gate = await gateWith(directionalProvider(20, 100_000));
    assert.equal(gate.ok, true);
    assert.equal((gate as any).active, true);
    assert.deepEqual(
      [...(gate as any).admittedIds],
      [],
      "a place whose measured ride back does not fit was served to a traveller",
    );
    const withheld = (gate as any).summary.excluded[0];
    assert.equal(withheld.id, "p1");
    assert.equal(withheld.state, "BLOCKED");
    assert.equal(
      withheld.terms.returnTravel.value,
      100_000,
      "the withheld card must carry the ride back it was refused for",
    );
    assert.equal(withheld.terms.returnTravel.source, "routed_port");
  });

  it("POSITIVE CONTROL: the same place with a quick ride back IS served", async () => {
    const gate = await gateWith(directionalProvider(20, 20));
    assert.deepEqual([...(gate as any).admittedIds], ["p1"]);
  });

  it("with the deployment's own port the gate is unchanged, and says why", async () => {
    // `LAYOVER_TRAVEL_TIME_PROVIDER` is `noRoutedProvider`: the traveller's own
    // stop is the only figure, the ride back is an ABSENCE, and the charge
    // falls back to the symmetric one this surface has always applied.
    const gate = await gateWith(undefined);
    assert.deepEqual([...(gate as any).admittedIds], ["p1"]);
    const nothingWithheld = (gate as any).summary.excluded;
    assert.deepEqual(nothingWithheld, []);
  });
});
