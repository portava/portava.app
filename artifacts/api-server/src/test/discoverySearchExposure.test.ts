/**
 * discoverySearchExposure — census-discovery DV-40 on serve points 8 and 9
 * (GET /discovery/search, GET /discovery/suggest), consuming the
 * served-recommendation contract in lib/discoveryRecommendationRecord.ts.
 *
 * `04` §5: "Every served item must have a `recommendation_id`." What is pinned:
 *   X1  every served item carries an id of 2891's shape;
 *   X2  the id in the RESPONSE is the id in the serve-log PAYLOAD, at the same
 *       position, under one session and one instant;
 *   X3  suggest's groups are stamped at their FLATTENED served positions,
 *       which is how the serve log numbers them;
 *   X4  a refused search stays refused: no items minted, no row written;
 *   X5  a partial search still stamps and logs what it really served;
 *   X6  an anonymous caller is refused before anything is served, so no id is
 *       minted and no user-keyed row is written (these two serve points
 *       require a signed-in caller; the anonymous-id half of the contract has
 *       no reachable site here);
 *   X7  two requests are two exposures: the same item gets two ids.
 *
 * Run: node --import tsx/esm --test src/test/discoverySearchExposure.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import discoverySearchRouter, { invalidateBuddyLaunchGateCache } from "../routes/discoverySearch.js";
import { DISCOVERY_SERVE_LOG_FLAG, invalidateServeLogFlagCache } from "../lib/discoveryServeLog.js";
import { _resetRecommendationIdSchemaLatch, RECOMMENDATION_ID_SHAPE } from "../lib/rankEventsProvenance.js";
import { mintServeExposure, servedRecommendationId } from "../lib/discoveryRecommendationRecord.js";
import { stampSuggestGroupsServed } from "../lib/discoverySearchExposure.js";
import { invalidateSearchProtectionFlagCache } from "../lib/discoverySearchProtection.js";
import { invalidateDiscoveryTripProjectionFlagCache } from "../lib/discoveryTripProjectionConsumer.js";
import { VIEWER, installKit, kitGet, settle, startKitServer, type KitCalls, type KitState } from "./discoverySearchTestKit.js";

const ALICE = "b1000000-0000-4000-a000-000000000001";

function world(over: Partial<KitState> = {}): Partial<KitState> {
  const place = (id: string) => ({
    id, name: `zork ${id}`, city: "Lisbon", blurb: null, image_url: null, header_image_source: null,
    image_source_type: null, image_accuracy_status: null, category: "food", primary_category: "food",
    lat: 38.7, lng: -9.1, canonical_location_id: null, created_at: "2026-01-01T00:00:00Z",
    submitted_by: null, status: "active", saved_count: 0,
  });
  return {
    rows: {
      profiles: [
        { id: VIEWER, handle: "viewer", name: "Viewer", account_status: "active", is_private: false },
        { id: ALICE, handle: "zork_alice", username: "zork_alice", name: "Zork Alice", display_name: null,
          avatar_url: null, is_private: false, home_city: null, home_country: null, account_status: "active",
          verified: false, is_official: false, show_profile_picture_publicly: true },
      ],
      blocks: [], user_privacy_settings: [], profile_privacy_settings: [], user_follows: [], friend_requests: [],
      user_friendships: [], event_rsvps: [], events: [], trips: [], trip_plan_items: [], hidden_gems: [], posts: [],
      circles: [], stamp_definitions: [], canonical_locations: [], rank_events: [],
      hashtags: [{ id: "h-zork", slug: "zork", name: "Zork", usage_count: 3, is_blocked: false, created_at: "2026-01-01T00:00:00Z" }],
      discovery_places: [place("p-1"), place("p-2"), place("p-3")],
    },
    flags: { [DISCOVERY_SERVE_LOG_FLAG]: true },
    ...over,
  };
}

const rankRows = (calls: KitCalls) => calls.writes.filter((w) => w.table === "rank_events" && w.op === "insert").flatMap((w) => w.rows);

let base = "";
let server: Server;
before(async () => { ({ base, server } = await startKitServer(discoverySearchRouter)); });
after(() => server.close());
beforeEach(() => {
  invalidateServeLogFlagCache();
  _resetRecommendationIdSchemaLatch();
  invalidateBuddyLaunchGateCache();
  invalidateSearchProtectionFlagCache();
  invalidateDiscoveryTripProjectionFlagCache();
});

describe("DV-40 on GET /discovery/search (serve point 8)", () => {
  for (const type of ["places", "all"]) {
    it(`X1/X2 — type=${type}: every item carries an id, and the log row at its position carries the SAME id`, async () => {
      const { calls } = installKit(world());
      const { status, body } = await kitGet(base, `/discovery/search?q=zork&type=${type}&limit=20`);
      assert.equal(status, 200);
      const results = body.results as any[];
      assert.ok(results.length >= 3, "control: something was served");
      for (const r of results) assert.match(String(r.recommendationId), RECOMMENDATION_ID_SHAPE, `${r.id} has no id of 2891's shape`);
      await settle();
      const rows = rankRows(calls);
      assert.equal(rows.length, results.length, "one impression row per served item");
      rows.forEach((row: any, i: number) => {
        assert.equal(row.item_id, results[i].id, "the log and the response disagree about order");
        assert.equal(row.position, i);
        assert.equal(row.recommendation_id, results[i].recommendationId, `position ${i}: the column id is not the response id`);
        assert.equal(row.features.recommendationId, results[i].recommendationId, `position ${i}: features.recommendationId differs`);
        assert.equal(row.user_id, VIEWER);
      });
      assert.equal(new Set(rows.map((r: any) => r.session_id)).size, 1, "one serve, one session");
      assert.equal(new Set(rows.map((r: any) => r.served_at)).size, 1, "one serve, one instant");
      // And the ids are re-derivable from what the row stored — the join the outcome path relies on.
      const e = { userId: VIEWER, sessionId: rows[0].session_id, servedAt: rows[0].served_at };
      results.forEach((r, i) => assert.equal(servedRecommendationId(e, i, r.id), r.recommendationId));
    });
  }

  it("X4 — a refused search (blocks unreadable) mints no id and writes no row", async () => {
    const { calls } = installKit(world({ errorTables: { blocks: { code: "57014", message: "timeout" } } }));
    const { body } = await kitGet(base, "/discovery/search?q=zork&type=places");
    assert.deepEqual(body.results, []);
    assert.equal(body.refusal?.coverage, "nothing");
    await settle();
    assert.equal(rankRows(calls).length, 0, "a refusal reached the exposure denominator");
  });

  it("X4b — a failed search (a table the type reads is unreadable) stays a refusal with no items", async () => {
    const { calls } = installKit(world({ errorTables: { discovery_places: { code: "57014", message: "timeout" } } }));
    const { body } = await kitGet(base, "/discovery/search?q=zork&type=places");
    assert.deepEqual(body.results, []);
    assert.equal(body.refusal?.code, "search_failed");
    await settle();
    assert.equal(rankRows(calls).length, 0);
  });

  it("X5 — a PARTIAL type=all still stamps and logs what it really served", async () => {
    const { calls } = installKit(world({ errorTables: { hashtags: { code: "57014", message: "timeout" } } }));
    const { body } = await kitGet(base, "/discovery/search?q=zork&type=all&limit=20");
    assert.equal(body.refusal?.coverage, "partial");
    assert.ok(body.results.length > 0);
    for (const r of body.results) assert.match(String(r.recommendationId), RECOMMENDATION_ID_SHAPE);
    await settle();
    assert.deepEqual(rankRows(calls).map((r: any) => r.recommendation_id), body.results.map((r: any) => r.recommendationId));
  });

  it("X6 — an anonymous caller is refused (401) before any serve: no id, no user-keyed row", async () => {
    const { calls } = installKit(world());
    const { status, body } = await kitGet(base, "/discovery/search?q=zork&type=places", null);
    assert.equal(status, 401);
    assert.equal(body.results, undefined);
    await settle();
    assert.equal(rankRows(calls).length, 0);
  });

  it("X7 — two requests are two exposures: the same item gets two different ids", async () => {
    installKit(world());
    const a = await kitGet(base, "/discovery/search?q=zork&type=places");
    const b = await kitGet(base, "/discovery/search?q=zork&type=places");
    assert.equal(a.body.results[0].id, b.body.results[0].id);
    assert.notEqual(a.body.results[0].recommendationId, b.body.results[0].recommendationId);
  });

  it("the serve log flag OFF: ids are still on every item (the response half does not depend on the writer)", async () => {
    const { calls } = installKit(world({ flags: {} }));
    const { body } = await kitGet(base, "/discovery/search?q=zork&type=places");
    for (const r of body.results) assert.match(String(r.recommendationId), RECOMMENDATION_ID_SHAPE);
    await settle();
    assert.equal(rankRows(calls).length, 0, "the writer stays behind its flag");
  });
});

describe("DV-40 on GET /discovery/suggest (serve point 9)", () => {
  it("X3 — every group's items are stamped at their FLATTENED served position, equal to the log's", async () => {
    const { calls } = installKit(world());
    const { status, body } = await kitGet(base, "/discovery/suggest?q=zork");
    assert.equal(status, 200);
    const flat = (body.groups as any[]).flatMap((g) => g.items);
    assert.ok((body.groups as any[]).length >= 2 && flat.length >= 3, "control: more than one group was served");
    await settle();
    const rows = rankRows(calls);
    assert.deepEqual(rows.map((r: any) => r.item_id), flat.map((i: any) => i.id));
    assert.deepEqual(rows.map((r: any) => r.recommendation_id), flat.map((i: any) => i.recommendationId));
    assert.deepEqual(rows.map((r: any) => r.position), flat.map((_: any, i: number) => i));
  });

  it("X4 — a refused suggest (blocks unreadable) mints no id and writes no row", async () => {
    const { calls } = installKit(world({ errorTables: { blocks: { code: "57014", message: "timeout" } } }));
    const { body } = await kitGet(base, "/discovery/suggest?q=zork");
    assert.deepEqual(body.groups, []);
    await settle();
    assert.equal(rankRows(calls).length, 0);
  });

  it("stampSuggestGroupsServed — offsets run across groups; empty groups add nothing; input untouched", () => {
    const e = mintServeExposure(VIEWER, "s-1", new Date("2026-09-27T10:00:00.000Z"));
    const groups = [{ type: "a", items: [{ id: "x" }, { id: "y" }] }, { type: "b", items: [] as Array<{ id: string }> }, { type: "c", items: [{ id: "z" }] }];
    const before = JSON.stringify(groups);
    const out = stampSuggestGroupsServed(groups, e);
    assert.deepEqual(out.flatMap((g) => g.items.map((i) => i.recommendationId)),
      [servedRecommendationId(e, 0, "x"), servedRecommendationId(e, 1, "y"), servedRecommendationId(e, 2, "z")]);
    assert.equal(JSON.stringify(groups), before);
  });
});
