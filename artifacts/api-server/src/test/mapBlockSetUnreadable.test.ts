/**
 * THE BLANK MAP, SECOND INPUT: an unreadable `blocks` table.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * `mapProjection.ts` documents, at length, why an unreadable §24 policy must
 * answer `enabled: false` with a named refusal rather than `enabled: true`
 * with an empty payload:
 *
 *     "The client (useMapEntities.ts) treats an `enabled: true` answer as
 *      OWNING every layer and never re-fetches, while `enabled: false` means
 *      'the gateway is not serving — keep the legacy per-layer path'. This
 *      branch used to answer `enabled: true, objects: []`, which is a
 *      fail-closed answer to the WRONG QUESTION: it told the client 'there is
 *      nothing here' when the truth was 'I cannot tell whether it is safe to
 *      show you anything'."
 *
 * That reasoning was applied to `protected_zones` and to nothing else. The
 * SHARED BLOCK SET — read one line earlier in the same handler, and by
 * `/api/map/search` too — still took the shape the comment condemns:
 *
 *     const blockedSet = await fetchBlockedSet(sc, user.id);
 *     if (blockedSet === null) {
 *       res.json({ enabled: true, objects: [], total: 0, … });   // ← blank map
 *       return;
 *     }
 *
 * `fetchBlockedSet` returns null on a READ FAILURE precisely so the caller can
 * tell it from "this user blocks nobody" — and both callers then threw that
 * distinction away at the last step. An unreadable `blocks` table is not a
 * rarer event than an unapplied migration: it is the ordinary shape of a
 * connection blip, an RLS change or a grant change.
 *
 * The consequence is the same OUTAGE, not a leak: the client is told
 * authoritatively that the map is empty, declines to fall back, and draws
 * nothing. Both routes now answer with a named refusal instead.
 *
 * ── WHY THESE TESTS CANNOT PASS VACUOUSLY ───────────────────────────────────
 *  1. Each refusal case is PAIRED with a readable-world case asserting the
 *     route still serves (`enabled: true` and a non-zero object/result count).
 *     A route that refused unconditionally would fail the pair, so "always
 *     refuse" cannot buy a green.
 *  2. The failure is injected on `blocks` ALONE. Every other table stays
 *     readable, so a green cannot come from the request dying somewhere else.
 *  3. Exact statuses and exact field values — never `notEqual(status, 200)`.
 *     Both refusals are 200-with-`enabled:false`, so a status-shaped assertion
 *     would not even distinguish them.
 *  4. `refusal` is asserted by VALUE, and the serving cases assert the key is
 *     ABSENT — so a route that always emitted a refusal would fail too.
 *  5. CASES_RUN is asserted non-zero: a file that examined nothing FAILS.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/mapBlockSetUnreadable.test.ts
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import mapProjectionRouter, {
  _clearProtectedZoneCache,
  _clearFlowZoneCache,
  _clearCityZoneCache,
} from "../routes/mapProjection.js";
import mapSearchRouter from "../routes/mapSearch.js";
import { startRouterApp, type FakeState, type ProjectionApp } from "./helpers/fakeMapDb.js";

const VIEWER = "13131313-eeee-4eee-8eee-131313131313";
const TOKEN = "block-set-unreadable-token";
const SPOT = { lat: 16.0678, lng: 108.2208 };
const BBOX_STR = "108.0,15.9,108.4,16.2";

/** What PostgREST says when the connection drops mid-statement. */
const READ_FAIL = { message: "server closed the connection unexpectedly" };

let CASES_RUN = 0;

/** A world in which everything is readable and there is exactly one place. */
function world(over: FakeState = {}): FakeState {
  return {
    feature_flags: [
      { flag: "map_projection_enabled", enabled: true },
      { flag: "map_search_enabled", enabled: true },
    ],
    blocks: [],
    geo_zones: [],
    event_roles: [],
    protected_zones: [],
    places: [
      {
        id: "place-1", name: "Han Market", primary_category: "night_market", city: "Da Nang",
        neighborhood: null, country_code: "VN", latitude: SPOT.lat, longitude: SPOT.lng,
        status: "active", merged_into_place_id: null,
      },
    ],
    ...over,
  };
}

describe("an unreadable block set must not be served as an empty map", () => {
  let app: ProjectionApp | null = null;

  beforeEach(() => { _clearProtectedZoneCache(); _clearFlowZoneCache(); _clearCityZoneCache(); });
  afterEach(async () => { if (app) await app.close(); app = null; });

  async function gateway(state: FakeState, query: string) {
    app = await startRouterApp(mapProjectionRouter, state, { token: TOKEN, userId: VIEWER });
    return app.projection(query);
  }
  async function search(state: FakeState, query: string): Promise<{ status: number; body: any }> {
    app = await startRouterApp(mapSearchRouter, state, { token: TOKEN, userId: VIEWER });
    const r = await fetch(`${app.baseUrl}/api/map/search?${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    return { status: r.status, body: (await r.json()) as any };
  }

  // ── The gateway ───────────────────────────────────────────────────────────

  it("gateway: an unreadable `blocks` answers enabled:false with a named refusal, not a blank enabled:true", async () => {
    const r = await gateway(world({ blocks: { error: READ_FAIL } }), `bbox=${BBOX_STR}&zoom=14&kinds=place`);

    assert.equal(r.status, 200);
    assert.equal(
      r.body.enabled, false,
      "enabled:true tells the client it owns every layer; it then declines to fall back and draws nothing",
    );
    assert.equal(r.body.refusal, "block_set_unreadable", "the operator must be able to see WHY the flip did not take");
    assert.deepEqual(r.body.objects, [], "nothing may be served while the block set is unknown");
    assert.equal(r.body.total, 0);
    CASES_RUN++;
  });

  it("gateway: a READABLE (empty) block set still serves — this is not an off switch", async () => {
    const r = await gateway(world(), `bbox=${BBOX_STR}&zoom=14&kinds=place`);

    assert.equal(r.body.enabled, true);
    assert.equal("refusal" in r.body, false, "a healthy world must carry no refusal at all");
    assert.equal(r.body.objects.length, 1, "the place is still served — the fix is not 'always refuse'");
    assert.equal(r.body.objects[0].id, "place:place-1");
    CASES_RUN++;
  });

  it("gateway: a block set with rows in it still serves — a non-empty block list is a normal answer", async () => {
    const r = await gateway(
      world({ blocks: [{ blocker_id: VIEWER, blocked_id: "99999999-ffff-4fff-8fff-999999999999" }] }),
      `bbox=${BBOX_STR}&zoom=14&kinds=place`,
    );

    assert.equal(r.body.enabled, true);
    assert.equal("refusal" in r.body, false);
    assert.equal(r.body.objects.length, 1);
    CASES_RUN++;
  });

  // ── Map search ────────────────────────────────────────────────────────────

  it("search: an unreadable `blocks` answers enabled:false with a named refusal", async () => {
    const r = await search(world({ blocks: { error: READ_FAIL } }), `lat=${SPOT.lat}&lng=${SPOT.lng}&radiusKm=10`);

    assert.equal(r.status, 200);
    assert.equal(
      r.body.enabled, false,
      "'nothing matched your search' is a claim; an unreadable block set cannot support it",
    );
    assert.equal(r.body.refusal, "block_set_unreadable");
    assert.deepEqual(r.body.results, []);
    assert.equal(r.body.total, 0);
    CASES_RUN++;
  });

  it("search: a readable world answers enabled:true and carries no refusal", async () => {
    const r = await search(world(), `lat=${SPOT.lat}&lng=${SPOT.lng}&radiusKm=10`);

    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, true);
    assert.equal("refusal" in r.body, false);
    assert.ok(Array.isArray(r.body.results), "a served answer still carries a results array");
    CASES_RUN++;
  });

  it("search: the flag-off envelope is unchanged and carries no refusal", async () => {
    const r = await search(
      world({ feature_flags: [{ flag: "map_search_enabled", enabled: false }] }),
      `lat=${SPOT.lat}&lng=${SPOT.lng}&radiusKm=10`,
    );

    assert.equal(r.body.enabled, false);
    assert.equal("refusal" in r.body, false, "a deliberate flag-off is not a refusal — conflating them hides real ones");
    CASES_RUN++;
  });
});

describe("this suite examined something", () => {
  it("drove a router in a non-zero number of cases", () => {
    assert.ok(CASES_RUN >= 6, `expected >= 6 cases to have driven a router, saw ${CASES_RUN}`);
  });
});
