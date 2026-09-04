/**
 * Passport projection §31 cache tiering.
 *
 * Verifies:
 *   • buildProjectionCachePolicy tiers the aggregate: static sections (identity,
 *     stamps, stats, credentials, travel identity, journeys/memories/plans) get
 *     a long TTL, dynamic sections (availability, state, intent, trust, shared
 *     context, capabilities) a short one; the overall maxAge is the shortest
 *     present-section TTL;
 *   • GET /passport/:userId/projection sets a Cache-Control max-age matching that
 *     policy plus a weak ETag, returns the per-section `cache` map in the body,
 *     and answers 304 to a matching If-None-Match — never rendering stale
 *     availability/state as current beyond the dynamic horizon.
 *
 * Run: node --import tsx/esm --test src/test/passportProjectionCache.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import {
  buildPassportProjection,
  buildProjectionCachePolicy,
  PASSPORT_STATIC_MAX_AGE,
  PASSPORT_DYNAMIC_MAX_AGE,
  type ViewerResolution,
  type ViewerPermissions,
} from "../services/passport/PassportProjectionService.js";
import { makePassportDb } from "./helpers/fakePassportDb.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import passportRouter from "../routes/passport.js";

const OWNER = "owner-c1";

function permsFull(): ViewerPermissions {
  return {
    relationshipLabel: "self", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: true, canSeeAvailability: true,
    canSeeTrips: true, canSeeMutuals: true, canSeeLocationContext: true,
    canSeeFriendOnlyPosts: true, canMessage: false, canSendMessageRequest: false,
    canFollow: false, canInviteToTripCrew: false,
  };
}
function permsPublic(): ViewerPermissions {
  return {
    relationshipLabel: "stranger", isBlocked: false, isUnavailable: false,
    canViewProfile: true, canViewFullProfile: false, canSeeAvailability: false,
    canSeeTrips: false, canSeeMutuals: false, canSeeLocationContext: false,
    canSeeFriendOnlyPosts: false, canMessage: false, canSendMessageRequest: false,
    canFollow: true, canInviteToTripCrew: false,
  };
}
const resolver = (res: ViewerResolution) => async () => res;

function baseProfile(id: string) {
  return {
    id, handle: "cacher", display_name: "C", name: "C",
    home_city: "Hanoi", home_country: "Vietnam", current_city: "Hanoi",
    is_official: false, is_private: false, passport_visibility: "public",
    show_profile_picture_publicly: true, created_at: "2023-01-01",
  };
}

describe("buildProjectionCachePolicy (§31 tiering)", () => {
  it("tiers static vs dynamic sections; overall maxAge is the shortest present TTL", async () => {
    const db = makePassportDb({ profiles: [baseProfile(OWNER)] });
    const selfRes: ViewerResolution = { context: "self", permissions: permsFull(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(db, OWNER, OWNER, { resolveViewerContext: resolver(selfRes) }))!;
    const policy = buildProjectionCachePolicy(p);

    // Static sections carry the long TTL.
    assert.equal(policy.sections.identity, PASSPORT_STATIC_MAX_AGE);
    assert.equal(policy.sections.stamps, PASSPORT_STATIC_MAX_AGE);
    assert.equal(policy.sections.stats, PASSPORT_STATIC_MAX_AGE);
    // Dynamic sections carry the short TTL.
    assert.equal(policy.sections.trust, PASSPORT_DYNAMIC_MAX_AGE);
    assert.equal(policy.sections.capabilities, PASSPORT_DYNAMIC_MAX_AGE);
    assert.equal(policy.sections.travelerState, PASSPORT_DYNAMIC_MAX_AGE);
    // Overall = shortest present section.
    assert.equal(policy.maxAge, PASSPORT_DYNAMIC_MAX_AGE);
    assert.ok(PASSPORT_DYNAMIC_MAX_AGE < PASSPORT_STATIC_MAX_AGE, "dynamic must be shorter than static");
  });

  it("a public view without availability is still bounded by its dynamic sections", async () => {
    const db = makePassportDb({ profiles: [baseProfile(OWNER)] });
    const pubRes: ViewerResolution = { context: "public", permissions: permsPublic(), sharedTrip: false, sharedEvent: false, ownerIsTripHost: false, buddyRole: null };
    const p = (await buildPassportProjection(db, OWNER, null, { resolveViewerContext: resolver(pubRes) }))!;
    assert.equal(p.availability, undefined, "availability withheld from public");
    const policy = buildProjectionCachePolicy(p);
    assert.equal(policy.sections.availability, undefined, "no availability section to cache");
    // trust + traveler state + capabilities keep it on the dynamic horizon.
    assert.equal(policy.maxAge, PASSPORT_DYNAMIC_MAX_AGE);
  });
});

// ── Route-level headers ────────────────────────────────────────────────────────
const OWNER_UUID = "33333333-3333-4333-8333-333333333333";

describe("GET /passport/:userId/projection — §31 cache headers", () => {
  let server: http.Server;
  let baseUrl = "";

  before(async () => {
    _setTestClient(makePassportDb({
      profiles: [baseProfile(OWNER_UUID)],
      trust_profiles: [{ user_id: OWNER_UUID, overall_score: 40, public_level: "new_traveler" }],
    }), true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _res: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
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
    await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  });

  function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(baseUrl + path);
      const req = http.request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c as Buffer));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json: any = null;
            try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  it("sets a public Cache-Control max-age, a weak ETag, and returns the per-section cache map", async () => {
    const res = await get(`/passport/${OWNER_UUID}/projection`);
    assert.equal(res.status, 200);
    // Anonymous view is shared-cacheable and bounded by the dynamic horizon.
    assert.equal(res.headers["cache-control"], `public, max-age=${PASSPORT_DYNAMIC_MAX_AGE}`);
    assert.match(String(res.headers["etag"]), /^W\/"[0-9a-f]{40}"$/, "weak sha1 ETag");
    // Per-section tiering rides in the body so the client can tier its own cache.
    assert.equal(res.json.cache.maxAge, PASSPORT_DYNAMIC_MAX_AGE);
    assert.equal(res.json.cache.sections.identity, PASSPORT_STATIC_MAX_AGE);
    assert.equal(res.json.cache.sections.trust, PASSPORT_DYNAMIC_MAX_AGE);
    assert.ok(res.json.projection, "projection body present");
  });

  it("answers 304 to a matching If-None-Match (revalidation)", async () => {
    const first = await get(`/passport/${OWNER_UUID}/projection`);
    const etag = String(first.headers["etag"]);
    const second = await get(`/passport/${OWNER_UUID}/projection`, { "if-none-match": etag });
    assert.equal(second.status, 304, "matching validator ⇒ 304 Not Modified");
    assert.equal(second.json, null, "304 carries no body");
  });

  it("a fresh (non-matching) If-None-Match still returns 200 with a body", async () => {
    const res = await get(`/passport/${OWNER_UUID}/projection`, { "if-none-match": 'W/"deadbeef"' });
    assert.equal(res.status, 200);
    assert.ok(res.json.projection);
  });
});
