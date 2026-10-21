/**
 * highlightsBlockedListsT220 — census-telegraph T220 (wave 5).
 *
 * Two Highlights list doors read `blocks` through the shared readers now:
 *   GET /users/:userId/highlights     — the pair read (`readPairExclusion`)
 *   GET /highlights/following-feed    — the viewer's block set, scoped to the
 *                                       people they follow (`readBlockExclusions`
 *                                       with `among`)
 * Their FAILURE halves are pinned in highlightsBlockFailClosed.test.ts. Their
 * plain BLOCKED halves were not pinned anywhere: a route that ignored the block
 * survived every suite that reaches it. Each is pinned here, in both
 * directions, against a no-block CONTROL that serves the Highlight — so a case
 * cannot pass because the list is empty for some other reason.
 *
 * node:test over the table-backed highlightRouteHarness (its `.or()` reads the
 * shared pair read's `and(...)` groups through test/helpers/postgrestOrFilter).
 * Run: node --import tsx/esm --test src/test/highlightsBlockedListsT220.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";
import { RESURFACING_TABLE } from "../services/highlights/highlightResurfacing.js";
import { PROJECTION_POLICY_TABLE } from "../services/highlights/highlightProjectionPolicy.js";
import { makeClient } from "./highlightRouteHarness.js";

const OWNER = "11111111-0000-4000-8000-0000000000a1";
const VIEWER = "22222222-0000-4000-8000-0000000000b2";
const HL = "aaaaaaaa-0000-4000-8000-0000000000c3";

function seed(blocks: Array<{ blocker_id: string; blocked_id: string }>): Record<string, any[]> {
  return {
    feature_flags: [],
    profiles: [
      { id: OWNER, handle: "owner", name: "Owner", avatar_url: null, show_name_publicly: true, account_status: "active" },
      { id: VIEWER, handle: "viewer", name: "Viewer", avatar_url: null, show_name_publicly: true, account_status: "active" },
    ],
    blocks,
    highlights: [{
      id: HL, owner_id: OWNER, media_url: `post-media/${OWNER}/highlights/${HL}.jpg`, media_type: "image",
      caption: "hl", visibility: "public", location_name: null, location_city: null, location_country: null,
      created_at: "2026-09-10T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z",
      deleted_at: null, archived_at: null, pinned_at: null,
    }],
    highlight_views: [], highlight_likes: [], circle_memberships: [], trip_members: [],
    user_follows: [{ follower_id: VIEWER, following_id: OWNER }],
    [RESURFACING_TABLE]: [],
    [PROJECTION_POLICY_TABLE]: [],
  };
}

let server: Server;
let base = "";

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((rq: any, _res, next) => {
    rq.log = { error() {}, warn() {}, info() {}, debug() {} };
    next();
  });
  app.use("/api", highlightsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  _setTestClient(null as any, false);
});

async function get(path: string, blocks: Array<{ blocker_id: string; blocked_id: string }>) {
  _setTestClient(makeClient(seed(blocks)) as any, true);
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${VIEWER}` } });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
}

const EITHER_WAY = [
  ["the owner blocked the viewer", { blocker_id: OWNER, blocked_id: VIEWER }],
  ["the viewer blocked the owner", { blocker_id: VIEWER, blocked_id: OWNER }],
] as const;

describe("GET /users/:userId/highlights — a block either way serves nothing (T220)", () => {
  const ids = (body: any): string[] => (body?.highlights ?? []).map((h: any) => h.id);

  it("CONTROL: with no block the owner's Highlight is served", async () => {
    const r = await get(`/api/users/${OWNER}/highlights`, []);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(ids(r.body), [HL]);
  });

  for (const [label, row] of EITHER_WAY) {
    it(`${label} → an empty list`, async () => {
      const r = await get(`/api/users/${OWNER}/highlights`, [row]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(ids(r.body), []);
    });
  }
});

describe("GET /highlights/following-feed — a block either way drops that person (T220)", () => {
  const people = (body: any): string[] => (body?.users ?? []).map((u: any) => u.userId ?? u.id ?? u.user_id);

  it("CONTROL: with no block the followed owner is in the feed", async () => {
    const r = await get(`/api/highlights/following-feed`, []);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(people(r.body).includes(OWNER), JSON.stringify(r.body));
  });

  for (const [label, row] of EITHER_WAY) {
    it(`${label} → the owner is not in the feed`, async () => {
      const r = await get(`/api/highlights/following-feed`, [row]);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(!people(r.body).includes(OWNER), JSON.stringify(r.body));
    });
  }
});
