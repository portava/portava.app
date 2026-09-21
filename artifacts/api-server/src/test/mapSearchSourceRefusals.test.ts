/**
 * MAP SEARCH — "nothing is near you" must not be assembled from a read that
 * did not answer.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `loadNearbyEvents` goes out of its way to preserve the distinction the whole
 * suite exists to protect. Its own comment:
 *
 *     "A read FAILURE is not an empty neighbourhood: return null so a caller
 *      that needs the distinction can tell them apart."
 *
 * And the route then threw it away on the very next line:
 *
 *     const events = (await loadNearbyEvents(…).catch(() => null)) ?? [];
 *
 * `?? []` collapses "the events table could not be read" into "there are no
 * events near you" — a confident claim about the world, made out of a query
 * that did not answer. The response carried no way for a client or an operator
 * to tell the two apart: same 200, same `enabled: true`, same empty list.
 *
 * ── THE SHAPE OF THE FIX, AND WHY THIS ONE ──────────────────────────────────
 * Refusing the WHOLE request when one source fails would be worse than the
 * defect: a single broken table would blank a search that three healthy
 * sources could still answer. The gateway next door already solved this — see
 * `producers` and `crowdFlow.refusal` in routes/mapProjection.ts, which report
 * per-layer refusals precisely so "empty" and "broken" stay distinguishable
 * without taking the whole surface down. Map search now carries the same
 * report: `sources.<name> = { refusal, collected }`, and `null` for a source
 * the caller did not ask for.
 *
 * ── WHY THESE TESTS CANNOT PASS VACUOUSLY ───────────────────────────────────
 *  1. Every refusal case is PAIRED with a healthy-world case over the same
 *     source, asserting `refusal: null`. A route that always reported a
 *     refusal would fail the pair, so "always refuse" buys no green.
 *  2. Failure is injected on ONE table; the request still succeeds and the
 *     other sources still report cleanly, so a green cannot come from the
 *     request dying early.
 *  3. Exact values — `refusal` is asserted by name, never by truthiness.
 *  4. CASES_RUN is asserted non-zero: a file that examined nothing FAILS.
 *
 * KNOWN GAP, reported rather than papered over: `listMapTravelers` and
 * `findNearbyGems` both return a bare array and have NO failure channel at
 * all — a failed read inside them is already indistinguishable from an empty
 * one before the route ever sees it. Their entries here can therefore only
 * report a THROW, which is not how supabase-js signals a database error. That
 * is a gap in those functions' signatures, not something this route can close,
 * and it is not asserted as though it were covered.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mapSearchSourceRefusals.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapSearchRouter from "../routes/mapSearch.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "14141414-aaaa-4aaa-8aaa-141414141414";
const TOKEN = "map-search-source-token";
const SPOT = { lat: 16.0678, lng: 108.2208 };

const READ_FAIL = { message: "server closed the connection unexpectedly" };

let CASES_RUN = 0;

function world(over: FakeState = {}): FakeState {
  return {
    feature_flags: [{ flag: "map_search_enabled", enabled: true }],
    blocks: [],
    events: [],
    ...over,
  };
}

describe("map search reports WHICH source refused, instead of calling it empty", () => {
  let app: ProjectionApp | null = null;
  afterEach(async () => { if (app) await app.close(); app = null; });

  async function search(state: FakeState, query: string): Promise<{ status: number; body: any }> {
    app = await startRouterApp(mapSearchRouter, state, { token: TOKEN, userId: VIEWER });
    const r = await fetch(`${app.baseUrl}/api/map/search?${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return { status: r.status, body: (await r.json()) as any };
  }

  const Q = `lat=${SPOT.lat}&lng=${SPOT.lng}&radiusKm=10`;

  it("an unreadable `events` table is reported as a refusal, not as an empty neighbourhood", async () => {
    const r = await search(world({ events: { error: READ_FAIL } }), `${Q}&types=event`);

    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true, "one broken source must not blank a search other sources could answer");
    assert.equal(
      r.body.sources.event.refusal, "events_unreadable",
      "'no events near you' is a claim about the world; an unreadable table cannot support it",
    );
    assert.equal(r.body.sources.event.collected, 0);
    assert.deepEqual(r.body.results, []);
    CASES_RUN++;
  });

  it("a READABLE but empty `events` table reports NO refusal — empty is a real answer", async () => {
    const r = await search(world(), `${Q}&types=event`);

    assert.equal(r.status, 200);
    assert.equal(
      r.body.sources.event.refusal, null,
      "a genuinely empty neighbourhood must be distinguishable from a broken one",
    );
    assert.equal(r.body.sources.event.collected, 0);
    CASES_RUN++;
  });

  it("a source the caller did not ask for is null, not a silent zero", async () => {
    const r = await search(world(), `${Q}&types=event`);

    assert.equal(r.body.sources.traveler, null, "not requested is not the same as collected nothing");
    assert.equal(r.body.sources.gem, null);
    assert.notEqual(r.body.sources.event, null, "the requested source IS reported");
    CASES_RUN++;
  });

  it("every source is reported when no types filter is given", async () => {
    const r = await search(world(), Q);

    for (const k of ["traveler", "gem", "event"]) {
      assert.notEqual(r.body.sources[k], null, `${k} must be reported when it was asked for`);
      assert.equal(typeof r.body.sources[k].collected, "number");
    }
    assert.equal(r.body.sources.event.refusal, null, "a healthy world carries no refusals at all");
    CASES_RUN++;
  });

  it("a broken `events` does not stop the other sources being reported cleanly", async () => {
    const r = await search(world({ events: { error: READ_FAIL } }), Q);

    assert.equal(r.body.sources.event.refusal, "events_unreadable");
    assert.equal(r.body.sources.traveler.refusal, null, "the failure is scoped to the table it was injected on");
    assert.equal(r.body.sources.gem.refusal, null);
    CASES_RUN++;
  });

  it("the flag-off envelope carries no sources report at all", async () => {
    const r = await search(
      world({ feature_flags: [{ flag: "map_search_enabled", enabled: false }] }),
      Q,
    );

    assert.equal(r.body.enabled, false);
    assert.equal(r.body.sources, null, "a deliberate flag-off has no sources to report on");
    CASES_RUN++;
  });
});

describe("this suite examined something", () => {
  it("drove the router in a non-zero number of cases", () => {
    assert.ok(CASES_RUN >= 6, `expected >= 6 cases to have driven the router, saw ${CASES_RUN}`);
  });
});
