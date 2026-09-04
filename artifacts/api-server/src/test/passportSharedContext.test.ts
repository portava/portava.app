/**
 * Passport Shared Context (§17/§18, TABLE 17/TABLE 18).
 *
 * Verifies:
 *   • overlap facts are computed for the viewer relationship (both-in-city,
 *     both-free-tonight, mutual follows, shared cities, intent overlap, shared
 *     trips, both-going-to);
 *   • the summary is a QUALITATIVE label, never a numeric match/compatibility
 *     score (§18);
 *   • stale availability never counts as "free tonight" (§31);
 *   • permission gates (canSeeAvailability / canSeeMutuals / canSeeTrips) drop
 *     the corresponding facts;
 *   • the §18 Compass handoff seed carries only permitted, coarse facts.
 *
 * Run: node --import tsx/esm --test src/test/passportSharedContext.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { buildSharedContext } from "../services/passport/SharedContextService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import passportRouter from "../routes/passport.js";

const OWNER = "owner-1";
const VIEWER = "viewer-1";
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();

const ALL = { canSeeAvailability: true, canSeeMutuals: true, canSeeTrips: true, canMakePlan: true };

function factKeys(p: { facts: Array<{ key: string }> }): string[] {
  return p.facts.map((f) => f.key).sort();
}

describe("buildSharedContext", () => {
  it("returns an empty, non-scored overlap when viewer === owner", async () => {
    const db = makePassportDb({});
    const r = await buildSharedContext(db, OWNER, OWNER, ALL);
    assert.deepEqual(r.facts, []);
    assert.equal(r.summaryLabel, "No overlap yet");
    assert.equal(r.compassHandoff.eligible, false);
    // §18: no numeric compatibility field anywhere on the projection.
    assert.equal((r as any).score, undefined);
    assert.equal((r as any).matchScore, undefined);
  });

  it("computes rich overlap facts and a qualitative summary label", async () => {
    const db = makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Da Nang", home_city: "Da Nang", interests: ["Nightlife", "Food"], availability_tags: [] },
        { id: VIEWER, current_city: "Da Nang", home_city: "Hanoi", interests: ["Food", "Explore"], availability_tags: [] },
      ],
      quick_availability_status: [
        { user_id: OWNER, status: "free_tonight", expires_at: FUTURE },
        { user_id: VIEWER, status: "open_to_plans", expires_at: FUTURE },
      ],
      user_follows: [
        { follower_id: OWNER, following_id: "u-common" },
        { follower_id: VIEWER, following_id: "u-common" },
      ],
      user_stamps: [
        { user_id: OWNER, city: "Bangkok", is_revoked: false },
        { user_id: VIEWER, city: "Bangkok", is_revoked: false },
      ],
    });
    const r = await buildSharedContext(db, OWNER, VIEWER, ALL);
    const keys = factKeys(r);
    assert.ok(keys.includes("both_in_city"), "both_in_city");
    assert.ok(keys.includes("both_free_tonight"), "both_free_tonight");
    assert.ok(keys.includes("mutual_follows"), "mutual_follows");
    assert.ok(keys.includes("shared_cities"), "shared_cities");
    assert.ok(keys.includes("intent_overlap"), "intent_overlap");
    assert.equal(r.summaryLabel, "Strong travel overlap");

    // Explainability: mutual follows carries a magnitude; intent carries a detail.
    const mutual = r.facts.find((f) => f.key === "mutual_follows")!;
    assert.equal(mutual.magnitude, 1);
    const intent = r.facts.find((f) => f.key === "intent_overlap")!;
    assert.ok((intent.detail ?? "").toLowerCase().includes("food"));

    // §18 handoff seed: eligible, coarse city, shared intents, no coordinates.
    assert.equal(r.compassHandoff.eligible, true);
    assert.equal(r.compassHandoff.city, "Da Nang");
    assert.ok(r.compassHandoff.sharedIntents.map((s) => s.toLowerCase()).includes("food"));
    assert.ok(r.compassHandoff.overlapWindow);
  });

  it("never counts STALE availability as free tonight (§31)", async () => {
    const db = makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Tokyo", home_city: "Tokyo" },
        { id: VIEWER, current_city: "Tokyo", home_city: "Osaka" },
      ],
      quick_availability_status: [
        { user_id: OWNER, status: "free_tonight", expires_at: PAST }, // expired
        { user_id: VIEWER, status: "free_tonight", expires_at: FUTURE },
      ],
    });
    const r = await buildSharedContext(db, OWNER, VIEWER, ALL);
    assert.ok(!factKeys(r).includes("both_free_tonight"), "stale status must not count");
    assert.equal(r.compassHandoff.overlapWindow, null);
  });

  it("permission gates drop availability / mutuals / trips facts", async () => {
    const db = makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Bali", home_city: "Bali", interests: ["Surf"] },
        { id: VIEWER, current_city: "Ubud", home_city: "Ubud", interests: ["Surf"] },
      ],
      quick_availability_status: [
        { user_id: OWNER, status: "free_tonight", expires_at: FUTURE },
        { user_id: VIEWER, status: "free_tonight", expires_at: FUTURE },
      ],
      user_follows: [
        { follower_id: OWNER, following_id: "x" },
        { follower_id: VIEWER, following_id: "x" },
      ],
    });
    const r = await buildSharedContext(db, OWNER, VIEWER, {
      canSeeAvailability: false,
      canSeeMutuals: false,
      canSeeTrips: false,
      canMakePlan: false,
    });
    const keys = factKeys(r);
    assert.ok(!keys.includes("both_free_tonight"), "availability gated off");
    assert.ok(!keys.includes("mutual_follows"), "mutuals gated off");
    // Intent overlap still surfaces (not availability-gated).
    assert.ok(keys.includes("intent_overlap"));
    // Handoff not eligible when plans are not permitted.
    assert.equal(r.compassHandoff.eligible, false);
    assert.ok(r.compassHandoff.reasons.includes("plan_not_permitted"));
  });
});

// The Shared Moments capability chain — all four flags must read true for
// areSharedMomentsEnabled() to permit the fact.
const SHARED_MOMENTS_FLAGS = [
  { flag: "external_places_enabled", enabled: true },
  { flag: "live_places_enabled", enabled: true },
  { flag: "place_days_enabled", enabled: true },
  { flag: "shared_moments_enabled", enabled: true },
];

describe("buildSharedContext — shared_moments fact (§15/§17, TABLE 17)", () => {
  it("emits a shared_moments fact when BOTH are accepted members of active Moments", async () => {
    const db = makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Da Nang", home_city: "Da Nang" },
        { id: VIEWER, current_city: "Hanoi", home_city: "Hanoi" },
      ],
      feature_flags: SHARED_MOMENTS_FLAGS,
      shared_moments: [
        { id: "m-1", status: "active" },
        { id: "m-2", status: "active" },
        { id: "m-archived", status: "archived" }, // both members, but archived → excluded
      ],
      shared_moment_memberships: [
        { moment_id: "m-1", user_id: OWNER, status: "accepted" },
        { moment_id: "m-1", user_id: VIEWER, status: "accepted" },
        { moment_id: "m-2", user_id: OWNER, status: "accepted" },
        { moment_id: "m-2", user_id: VIEWER, status: "accepted" },
        { moment_id: "m-archived", user_id: OWNER, status: "accepted" },
        { moment_id: "m-archived", user_id: VIEWER, status: "accepted" },
      ],
    });
    const r = await buildSharedContext(db, OWNER, VIEWER, ALL);
    const fact = r.facts.find((f) => f.key === "shared_moments");
    assert.ok(fact, "shared_moments fact emitted");
    assert.equal(fact!.magnitude, 2, "only the two ACTIVE shared Moments count");
    assert.equal(fact!.label, "2 Shared Moments");
    assert.equal(fact!.detail, null, "no title/place/date leaks in the detail");
  });

  it("stays absent when only ONE party is a member (no shared Moment)", async () => {
    const db = makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Da Nang", home_city: "Da Nang" },
        { id: VIEWER, current_city: "Hanoi", home_city: "Hanoi" },
      ],
      feature_flags: SHARED_MOMENTS_FLAGS,
      shared_moments: [{ id: "m-1", status: "active" }],
      shared_moment_memberships: [
        { moment_id: "m-1", user_id: OWNER, status: "accepted" },
        // VIEWER is NOT a member of m-1.
      ],
    });
    const r = await buildSharedContext(db, OWNER, VIEWER, ALL);
    assert.ok(!factKeys(r).includes("shared_moments"), "no shared Moment ⇒ no fact");
  });

  it("stays absent (fail-closed) when the Shared Moments capability is off", async () => {
    const db = makePassportDb({
      profiles: [
        { id: OWNER, current_city: "Da Nang", home_city: "Da Nang" },
        { id: VIEWER, current_city: "Hanoi", home_city: "Hanoi" },
      ],
      // feature_flags not staged ⇒ areSharedMomentsEnabled() is false.
      shared_moments: [{ id: "m-1", status: "active" }],
      shared_moment_memberships: [
        { moment_id: "m-1", user_id: OWNER, status: "accepted" },
        { moment_id: "m-1", user_id: VIEWER, status: "accepted" },
      ],
    });
    const r = await buildSharedContext(db, OWNER, VIEWER, ALL);
    assert.ok(!factKeys(r).includes("shared_moments"), "capability off ⇒ no fact");
  });
});

// ── D2 regression — GET /passport/:userId/shared-context block/unavailable guard.
//    The route must short-circuit to a restricted payload for a blocked (or
//    unavailable) relationship, exactly like the sibling /journeys and
//    /contributions endpoints. Before the fix it called buildSharedContext even
//    for a blocked viewer, leaking both-in-city / shared-cities / intent-overlap /
//    compass-city facts.
const OWNER_UUID = "11111111-1111-4111-8111-111111111111";
const VIEWER_UUID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "viewer-token";

function routeClient(tables: Record<string, any[]>) {
  const base: any = makePassportDb(tables);
  base.auth = {
    getUser: async (token: string) =>
      token === TOKEN
        ? { data: { user: { id: VIEWER_UUID } }, error: null }
        : { data: { user: null }, error: { message: "invalid" } },
  };
  return base;
}

function httpGet(baseUrl: string, path: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("GET /passport/:userId/shared-context — blocked/unavailable guard (D2)", () => {
  let server: http.Server;
  let baseUrl = "";

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use("/", passportRouter);
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        server.unref();
        resolve();
      });
    });
  });

  after(async () => {
    _clearTestClient();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  });

  it("returns the restricted payload (no facts) when the owner has blocked the viewer", async () => {
    _setTestClient(
      routeClient({
        profiles: [
          { id: OWNER_UUID, current_city: "Da Nang", home_city: "Da Nang", interests: ["Food"] },
          { id: VIEWER_UUID, current_city: "Da Nang", home_city: "Hanoi", interests: ["Food"] },
        ],
        // Owner blocks the viewer ⇒ resolveInteractionPermissions → isBlocked.
        blocks: [{ blocker_id: OWNER_UUID, blocked_id: VIEWER_UUID }],
      }),
      true,
    );
    const res = await httpGet(baseUrl, `/passport/${OWNER_UUID}/shared-context`, TOKEN);
    assert.equal(res.status, 200);
    assert.equal(res.json.restricted, true, "blocked viewer gets the restricted shape");
    assert.equal(res.json.sharedContext, null, "no overlap facts are computed or returned");
    assert.equal(res.json.viewerContext, undefined, "the non-restricted branch (which leaks facts) did not run");
  });

  it("does NOT short-circuit for a normal (non-blocked) viewer — facts are computed", async () => {
    _setTestClient(
      routeClient({
        profiles: [
          { id: OWNER_UUID, current_city: "Da Nang", home_city: "Da Nang", interests: ["Food"] },
          { id: VIEWER_UUID, current_city: "Da Nang", home_city: "Hanoi", interests: ["Food"] },
        ],
        // no blocks staged
      }),
      true,
    );
    const res = await httpGet(baseUrl, `/passport/${OWNER_UUID}/shared-context`, TOKEN);
    assert.equal(res.status, 200);
    assert.notEqual(res.json.restricted, true, "a normal viewer is not restricted");
    assert.ok("viewerContext" in res.json, "the normal branch ran and returned a shared context");
    assert.ok(res.json.sharedContext, "shared context facts are present for a permitted viewer");
  });
});
