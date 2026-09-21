/**
 * census-layover L117 / L122 / L116 — THE CANDIDATE CONTRACT CARRIES A
 * FEASIBILITY STATE, AND IT IS THE SAME ENVELOPE THE MAP IS DRAWN FROM.
 *
 * §13 L122 asks for a map element *"Candidate pin — carries feasibility state
 * FROM THE RECOMMENDATION CONTRACT"*, and L115 forbids the map from
 * recalculating feasibility for itself. Together those two say the band has to
 * travel ON the card. Before this file, `GET /recommendations` served a card
 * with a `safetyRating` and nothing else: the §8 envelope was computed inside
 * `generateRecommendations`, used once to DROP the candidates it could prove
 * unreachable, and then thrown away. A pin had no state to carry and the client
 * had nothing to render but "hidden or not hidden".
 *
 * There is a second defect this file pins, and it is the one reading alone
 * missed. `routes/airport.ts` publishes the envelope for the MAP with the
 * certified record's confidence:
 *
 *     safeEnvelope(record.envelope.usableMinutes, airportPoint(airport), record.confidence)
 *
 * while `LayoverRecommendationService` banded its CANDIDATES without it:
 *
 *     safeEnvelope(usableMinutes, airportPoint(airport))
 *
 * Confidence is what contracts the planning edge (`ENVELOPE_UNCERTAINTY_BUDGET`
 * holds back 25% of the window at LOW, which is what every production session
 * certifies). So the disc a traveller saw and the disc their candidates were
 * judged against were DIFFERENT DISCS, and the narrower one — the one the map
 * drew — was the one nothing was measured against. Every assertion below about
 * `withinPlannedEdge` is only reachable when the two agree.
 *
 * ── WHY THIS DRIVES THE ROUTE AND NOT THE HELPER ────────────────────────────
 * An earlier round here failed review for testing a helper in isolation. Both
 * cases below boot the real express router, serve a real `GET /overview` to
 * LEARN the geometry, write real `discovery_places` rows at distances derived
 * from THAT geometry, and then serve a real `GET /recommendations`. Nothing is
 * asserted about a number this file computed; the two endpoints are compared
 * against each other.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// NO `process.env.SUPABASE_URL ||= …` HERE, deliberately. The curated `test`
// script pins `SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy`
// for every registered suite, and `check-guard-coverage.mjs` reads a file that
// NAMES either variable as a file that can reach Supabase — it cannot tell a
// stub assignment from a dial. Two redundant lines would have bought this file
// an exemption entry it does not need. Run it the way CI does.

/** Metres north of a point, in degrees of latitude. Longitude is untouched. */
function northOf(centre: { lat: number; lng: number }, metres: number) {
  return { lat: centre.lat + metres / 111_320, lng: centre.lng };
}

let server: any;
let port = 0;
let tables: Record<string, any[]>;

async function get(path: string): Promise<any> {
  return await new Promise<any>((resolve, reject) => {
    const r = http.request(
      {
        hostname: "127.0.0.1", port, path, method: "GET",
        headers: { authorization: "Bearer env-token" },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

before(async () => {
  const express = (await import("express")).default;
  const { _setTestClient } = await import("../lib/http.js");
  const airportRouter = (await import("../routes/airport.js")).default;
  const { makeLayoverDb, airportRow, sessionRow } = await import("./helpers/fakeLayoverDb.js");

  const app = express();
  app.use(express.json());
  app.use((r: any, _res: any, next: any) => {
    r.log = { error() {}, info() {}, warn() {}, debug() {} };
    next();
  });
  app.use("/api", airportRouter);
  server = await new Promise<any>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  port = (server.address() as any).port;

  tables = {
    feature_flags: [{ flag: "airport_mode_enabled", enabled: true }],
    airport_profiles: [airportRow()],
    layover_sessions: [sessionRow({ user_id: "user-1" })],
    layover_events: [], layover_plan_stops: [], trip_plan_items: [],
    layover_recommendations: [], discovery_places: [],
  };
  _setTestClient(makeLayoverDb(tables, { users: { "env-token": "user-1" } }), true);
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("§13 — a candidate pin carries the certified feasibility state", () => {
  test("the envelope the map is drawn from is the envelope the candidates are banded against", async () => {
    // 1. Learn the geometry from the surface the MAP reads. Nothing below
    //    computes a radius; both numbers are the server's own.
    const overview = await get("/api/airport/sessions/session-1/overview");
    const env = overview?.safeEnvelope;
    assert.ok(env, `no safeEnvelope on /overview: ${JSON.stringify(overview).slice(0, 300)}`);
    assert.ok(
      env.plannedRadiusMetres < env.radiusMetres,
      `this fixture must certify below HIGH confidence or there is no annulus to test: ` +
        `planned ${env.plannedRadiusMetres} vs proved ${env.radiusMetres}`,
    );

    // 2. Three real rows, placed by THAT geometry.
    //    - `near`    well inside the contracted planning edge
    //    - `annulus` between the planning edge and the proved edge: servable,
    //                but beyond what this confidence band would plan on
    //    - `far`     outside the proved edge: certainly unreachable at any speed
    const centre = env.centre as { lat: number; lng: number };
    const annulusMetres = Math.round((env.plannedRadiusMetres + env.radiusMetres) / 2);
    tables.discovery_places.push(
      {
        id: "dp-near", name: "Near Teahouse", place_type: "cafe", category: "food",
        neighborhood: "Near", blurb: null, verified: true, canonical_location_id: null,
        city: "Taoyuan", status: "active",
        ...northOf(centre, Math.round(env.plannedRadiusMetres * 0.3)),
      },
      {
        id: "dp-annulus", name: "Annulus Night Market", place_type: "market", category: "food",
        neighborhood: "Annulus", blurb: null, verified: true, canonical_location_id: null,
        city: "Taoyuan", status: "active",
        ...northOf(centre, annulusMetres),
      },
      {
        id: "dp-far", name: "Far Mountain Temple", place_type: "attraction", category: "culture",
        neighborhood: "Far", blurb: null, verified: true, canonical_location_id: null,
        city: "Taoyuan", status: "active",
        ...northOf(centre, Math.round(env.radiusMetres * 2 + 50_000)),
      },
    );

    // 3. The real recommendations route.
    const body = await get("/api/airport/sessions/session-1/recommendations");
    assert.equal(body?.featureEnabled, true, JSON.stringify(body).slice(0, 300));
    const recs: any[] = body.recommendations ?? [];
    assert.ok(recs.length > 0, "the fixture produced no cards at all");

    // EVERY card carries the state — a pin with no band is a pin the map has to
    // guess about, which is the L115 recalculation this contract exists to stop.
    for (const r of recs) {
      assert.ok(r.feasibility, `card "${r.title}" carries no feasibility state`);
      assert.equal(
        r.feasibility.impliesFit, false,
        `card "${r.title}" claims its band certifies a fit; nothing on this tree can`,
      );
    }

    const byTitle = new Map(recs.map((r) => [r.title, r]));

    // The certainly-unreachable one is not served at all (L117's "hidden" arm).
    assert.equal(
      byTitle.has("Far Mountain Temple"), false,
      "a place outside the proved edge was served as an option",
    );

    const near = byTitle.get("Near Teahouse");
    assert.ok(near, `the near candidate was dropped: ${recs.map((r) => r.title).join(" | ")}`);
    assert.equal(near.feasibility.certified, true);
    assert.equal(near.feasibility.withinPlannedEdge, true);
    assert.equal(near.feasibility.plannedEdgeReason, null);
    assert.ok(
      typeof near.feasibility.lowerBoundOneWayMin === "number",
      "a banded candidate must publish the bound its band was decided on",
    );

    // THE CONSISTENCY ASSERTION. This card sits between the two radii the MAP
    // publishes. It is servable — a planning haircut is a flag, never a refusal
    // — and it must be FLAGGED. It can only be flagged if the recommendation
    // path cut its envelope under the same confidence the overview did.
    const annulus = byTitle.get("Annulus Night Market");
    assert.ok(annulus, `the annulus candidate was dropped: ${recs.map((r) => r.title).join(" | ")}`);
    assert.equal(annulus.feasibility.certified, true);
    assert.equal(
      annulus.feasibility.withinPlannedEdge, false,
      "a candidate between the planning edge and the proved edge was not flagged — " +
        "the candidate envelope was cut without the record's confidence",
    );
    assert.match(
      String(annulus.feasibility.plannedEdgeReason),
      /held back/,
      "the flag must say what was held back and why, or a pin can only show a colour",
    );

    // An AIRSIDE card was never handed to the envelope — it has no position and
    // no landside leg — so it must carry the explicit unbanded state with the
    // reason, not a measured-looking band it never earned. Asserted HERE, in
    // the generate-path case, and not in a second request: the route serves
    // stored cards on a second GET (`layover_safety_engine_enabled` is off in
    // this fixture), so a second request would exercise `getRecommendations`
    // and could not see a defect in `generateRecommendations` at all. That is
    // exactly what the first draft of this file did, and the mutation that
    // should have caught it stayed GREEN.
    const airside = recs.filter((r) => r.insideAirport === true);
    assert.ok(airside.length > 0, "the fixture produced no airside cards");
    for (const r of airside) {
      assert.equal(r.feasibility.certified, false, `airside card "${r.title}" claims a certified band`);
      assert.equal(r.feasibility.lowerBoundOneWayMin, null);
      assert.equal(r.feasibility.withinPlannedEdge, null);
      assert.match(String(r.feasibility.reason), /inside the terminal/);
    }
  });

  test("a card served from storage says it was not re-measured, rather than repeating an old band", async () => {
    // The SECOND GET on this session. `layover_recommendations` now has rows
    // and `layover_safety_engine_enabled` is off, so the route takes the stored
    // path — which cuts no envelope, because it has no airport, no session and
    // no certified window. A band carried over from the first request would be
    // a claim about a window that has since moved.
    const body = await get("/api/airport/sessions/session-1/recommendations");
    const recs: any[] = body.recommendations ?? [];
    assert.ok(recs.length > 0, "the stored path served nothing");
    for (const r of recs) {
      assert.equal(r.feasibility.certified, false, `stored card "${r.title}" claims a fresh certification`);
      assert.equal(r.feasibility.band, "UNCERTIFIED");
      assert.equal(r.feasibility.impliesFit, false);
      assert.match(
        String(r.feasibility.reason),
        r.insideAirport ? /inside the terminal/ : /did not re-measure/,
        `stored card "${r.title}" does not say why it has no band`,
      );
    }
  });
});
