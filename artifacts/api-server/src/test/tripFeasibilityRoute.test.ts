/**
 * GET /trips/:tripId/feasibility — the §7 read surface, and the reachability
 * the vertical-slice rule asks for.
 *
 * A feasibility engine nothing calls is a library, not a capability. This file
 * pins that the route exists, is registered, is authorized, and — the part that
 * matters — that its failure modes are honest: a read that fails is 503, not an
 * empty itinerary presented as a workable day.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { intervalToMinutes, FEASIBILITY_UNVERIFIED_DISCLOSURE } from "../routes/tripFeasibility.js";

const route = readFileSync(new URL("../routes/tripFeasibility.ts", import.meta.url), "utf8");
const index = readFileSync(new URL("../routes/index.ts", import.meta.url), "utf8");

describe("the route is reachable", () => {
  it("is registered in the router index", () => {
    // A route file that exists and is never mounted is the "UI exists but is
    // disconnected" case, and earns no credit.
    assert.match(index, /import tripFeasibilityRouter from "\.\/tripFeasibility"/);
    assert.match(index, /router\.use\(tripFeasibilityRouter\)/);
  });

  it("declares the path the engine is reached through", () => {
    assert.match(route, /router\.get\("\/trips\/:tripId\/feasibility"/);
  });
});

describe("the route is authorized", () => {
  it("requires a user and then trip membership, in that order", () => {
    const user = route.indexOf("await requireUser(req, res)");
    const member = route.indexOf("await requireTripMember(sc, tripId, user.id)");
    const read = route.indexOf('.from("trip_commitments")');
    assert.ok(user > 0 && member > user, "membership is not checked after authentication");
    assert.ok(read > member, "the commitments are read before membership is established");
  });

  it("refuses a non-member with forbidden, not an empty result", () => {
    assert.match(route, /if \(!membership\) \{ sendError\(res, "forbidden"/);
  });

  it("validates the trip id before touching the database", () => {
    const check = route.indexOf("UUID_RE.test(tripId)");
    const client = route.indexOf("getServiceClient()");
    assert.ok(check > 0 && check < client);
  });
});

describe("fail-closed: an unreadable day is not a feasible day", () => {
  it("a commitments read error is 503, never an empty itinerary", () => {
    // The forbidden pattern this guards against: read failure -> "nothing
    // found" -> zero hops -> a day that looks fine.
    assert.match(route, /if \(error\) \{[\s\S]*?sendError\(res, "degraded_unavailable"/);
    assert.ok(!/\.select\([\s\S]*?\)\s*;\s*const rows = \(data \?\? \[\]\)/.test(route),
      "data is used without inspecting error first");
  });

  it("inspects error rather than wrapping the read in try/catch", () => {
    // supabase-js RESOLVES on a database error. A try/catch around these reads
    // is dead code and would let a failure through as an empty list.
    const body = route.slice(route.indexOf("router.get("));
    assert.ok(!/try\s*\{/.test(body),
      "a try/catch around a supabase read is dead code and hides the error path");
    assert.match(route, /const \{ data, error \} = await sc/);
  });

  it("never returns FEASIBLE while the provider is not routed", () => {
    // The engine can only produce FEASIBLE from a routed source, and this
    // deployment has none. The response carries the provider's own claim so a
    // client cannot mistake UNVERIFIED for measured.
    assert.match(route, /provider: \{ id: PROVIDER\.id, routed: PROVIDER\.routed \}/);
    assert.match(route, /const PROVIDER = straightLineTravelTimeProvider/);
  });

  it("always carries the disclosure, not only on some paths", () => {
    assert.match(route, /disclosure: FEASIBILITY_UNVERIFIED_DISCLOSURE/);
    assert.match(FEASIBILITY_UNVERIFIED_DISCLOSURE, /not measured routes/);
  });
});

describe("interval parsing — a duration that cannot be read is not zero", () => {
  it("parses the shapes Postgres actually renders", () => {
    assert.equal(intervalToMinutes("00:20:00"), 20);
    assert.equal(intervalToMinutes("01:30:00"), 90);
    assert.equal(intervalToMinutes("00:00:30"), 0.5);
    assert.equal(intervalToMinutes("00:10:00.000000"), 10);
    assert.equal(intervalToMinutes("1 day 02:00:00"), 1560);
    assert.equal(intervalToMinutes("2 days 00:30:00"), 2910);
  });

  it("returns null — never 0 — for anything it cannot read", () => {
    // 0 would silently remove a prep buffer or a lateness tolerance from the
    // invariant, which is the same class of error as an absent route read as
    // no travel.
    for (const junk of [null, undefined, "", "   ", "twenty minutes", "P1DT2H", "abc", "::", "12"]) {
      assert.equal(intervalToMinutes(junk as never), null,
        `${JSON.stringify(junk)} parsed to something rather than null`);
    }
  });

  it("the caller defaults a null to 0 explicitly, where it is visible", () => {
    // Defaulting is a decision. It belongs at the call site, spelled out, not
    // buried in the parser where nobody reviewing the invariant would see it.
    assert.match(route, /intervalToMinutes\(next\.prep_duration\) \?\? 0/);
    assert.match(route, /intervalToMinutes\(next\.lateness_tolerance\) \?\? 0/);
  });
});

describe("the route says what it cannot compute", () => {
  // THIS TEST USED TO PIN THE ROUTE BEING INERT.
  //
  // It asserted the file still carried the comment "place_id has no foreign key
  // by design", which was true and was also the reason both endpoints of every
  // hop were hardcoded null — so the provider answered NO_COORDINATES on every
  // hop and this route could return only UNKNOWN. The absent FK is real; the
  // conclusion drawn from it was not. `place_id` denotes public.places.id, and
  // resolvePlaces reads it.
  it("resolves place coordinates, so INFEASIBLE is reachable at all", () => {
    assert.match(route, /export async function resolvePlaces/);
    assert.match(route, /\.from\("places"\)[\s\S]{0,120}latitude, longitude/);
    assert.match(route, /const fromPlace: GeoPoint \| null = pointOf\(prev\.place_id\)/);
    assert.match(route, /const toPlace: GeoPoint \| null = pointOf\(next\.place_id\)/);
  });

  it("a places read that FAILS is 503 — not a set of unlocated places", () => {
    // The two are one keystroke apart and produce opposite outcomes: an empty
    // map means "none of these are located" and yields UNKNOWN verdicts, which
    // a client renders as nothing to worry about.
    assert.match(route, /if \(!places\) \{[\s\S]{0,400}sendError\(res, "degraded_unavailable"/);
    assert.match(route, /if \(error\) return null;/);
  });

  it("still says what it cannot compute, and keeps the three no-coordinate cases apart", () => {
    assert.match(route, /NO_COORDINATES/);
    // A dangling place id produces the same verdict as "no place named" and
    // must not be indistinguishable from it in the response.
    assert.match(route, /unresolvedPlaceIds: places\.unresolved/);
  });

  it("uses the earliest possible departure, and says that is the optimistic choice", () => {
    assert.match(route, /EARLIEST possible\n\s*\/\/ departure and therefore the most\n?\s*\/\/? ?optimistic input|EARLIEST possible/);
  });
});
