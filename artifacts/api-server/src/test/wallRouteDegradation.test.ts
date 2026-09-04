/**
 * Wall route — graceful degradation (spec §34 / TABLE 5 / non-negotiable test
 * §40: "If all intelligence services fail, does a safe, functional social feed
 * remain? It must.").
 *
 * Drives the real /wall router over HTTP with a fake service client whose LIVE
 * intelligence reads THROW. The response must still be a well-formed social feed
 * (200, items present) with an empty — never fabricated — live strip. Also
 * checks the master flag gate and the Following mode path end-to-end.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _clearPromotedScopeCache } from "../lib/liveClaimRead.js";
import wallRouter from "../routes/wall.js";

// ── Fake data ────────────────────────────────────────────────────────────────
const TOKEN = "tok";
const VIEWER = "viewer-1";
const FLAGS: Record<string, boolean> = {
  wall_enabled: true,
  wall_live_for_you_enabled: true,
  wall_input_intelligence_enabled: false,
  wall_discovery_insertions_enabled: false,
  wall_compass_handoff_enabled: false,
  wall_rab_integration_enabled: false,
  // Intel gate flags ON so the live path RUNS and then FAILS at the throwing read.
  intel_live_label_crowd: true,
  intel_claim_projection_crowd: true,
  intel_capture_quick_signal: true,
  intel_limited_live: true,
  disable_intel_live_labels: false,
};

const PROFILES: Record<string, any> = {
  [VIEWER]: { id: VIEWER, account_status: "active", current_city: "Da Nang", current_country: "VN" },
  "author-1": { id: "author-1", display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" },
};
const POSTS = [
  {
    id: "post-1",
    author_id: "author-1",
    trip_id: null,
    content: "Sunset at An Thuong",
    visibility: "public",
    status: "active",
    created_at: "2026-09-01T10:00:00Z",
    published_at: "2026-09-01T10:00:00Z",
    canonical_place_id: "place-1",
    has_video: false,
    media_count: 1,
    category: "food",
    location_city: "Da Nang",
    location_country: "VN",
  },
];
const PLACES = [{ id: "place-1", name: "An Thuong", city: "Da Nang", country_code: "VN" }];

/** A table-routed fake supabase client. Live-intel reads THROW to simulate a
 *  subsystem outage; everything else is fail-safe canned data. */
function fakeClient(flags: Record<string, boolean> = FLAGS) {
  function builder(table: string) {
    const f: Record<string, any> = {};
    const b: any = {
      select() {
        return b;
      },
      eq(col: string, val: any) {
        f[col] = val;
        return b;
      },
      in() {
        return b;
      },
      or() {
        return b;
      },
      gt() {
        return b;
      },
      lte() {
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      insert() {
        return Promise.resolve({ error: null });
      },
      upsert() {
        return Promise.resolve({ error: null });
      },
      delete() {
        return { eq: () => Promise.resolve({ error: null }) };
      },
      maybeSingle() {
        if (table === "feature_flags") {
          return Promise.resolve({ data: { enabled: !!flags[String(f["flag"])] }, error: null });
        }
        if (table === "profiles") {
          return Promise.resolve({ data: PROFILES[String(f["id"])] ?? null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        // Live-intel reads throw — the "subsystem stubbed to fail" condition.
        if (table === "intel_live_promoted_scopes" || table === "intel_state_snapshots") {
          return Promise.reject(new Error("intel down")).then(onF, onR);
        }
        let data: any[] = [];
        if (table === "posts") data = POSTS;
        else if (table === "profiles") data = Object.values(PROFILES);
        else if (table === "places") data = PLACES;
        else if (table === "user_follows") data = [{ following_id: "author-1" }];
        else if (table === "trip_members") data = [];
        else if (table === "blocks") data = [];
        else data = []; // feature_flags list (loadRankingFlags), ranking_config, etc.
        return Promise.resolve({ data, error: null }).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === TOKEN
          ? { data: { user: { id: VIEWER } }, error: null }
          : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

// ── Test HTTP harness ────────────────────────────────────────────────────────
let server: http.Server;
let baseUrl = "";

function request(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = opts.body != null ? JSON.stringify(opts.body) : null;
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = raw;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("Wall route graceful degradation", () => {
  before(async () => {
    _setTestClient(fakeClient(), true);
    const app = express();
    app.use(express.json());
    app.use("/api", wallRouter);
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

  it("returns a safe social feed when the live subsystem fails (For You)", async () => {
    _clearPromotedScopeCache();
    const res = await request("GET", "/api/wall?mode=for_you", { token: TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, "for_you");
    assert.ok(Array.isArray(res.json.items));
    assert.ok(res.json.items.length >= 1, "the social feed still has content");
    assert.equal(res.json.items[0].canonicalObjectId, "post-1");
    // The live strip degraded to empty rather than fabricating a live state.
    assert.deepEqual(res.json.liveForYou, []);
    assert.ok(typeof res.json.generatedAt === "string");
  });

  it("Following mode returns eligible content chronologically", async () => {
    _clearPromotedScopeCache();
    const res = await request("GET", "/api/wall?mode=following", { token: TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.json.mode, "following");
    assert.equal(res.json.items[0].canonicalObjectId, "post-1");
    assert.equal(res.json.caughtUp, true);
    assert.deepEqual(res.json.liveForYou, []);
  });

  it("GET /wall/live degrades to an empty strip when intel throws", async () => {
    _clearPromotedScopeCache();
    const res = await request("GET", "/api/wall/live?limit=4", { token: TOKEN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.liveForYou, []);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request("GET", "/api/wall", {});
    assert.equal(res.status, 401);
  });

  it("records an impression without failing the feed", async () => {
    const res = await request("POST", "/api/wall/impression", {
      token: TOKEN,
      body: { objectId: "post-1", objectType: "social_post" },
    });
    assert.equal(res.status, 202);
    assert.equal(res.json.ok, true);
  });

  it("gates every route behind wall_enabled", async () => {
    _setTestClient(fakeClient({ ...FLAGS, wall_enabled: false }), true);
    const res = await request("GET", "/api/wall", { token: TOKEN });
    assert.equal(res.status, 404); // feature_disabled maps to 404 (lib/http STATUS)
    assert.equal(res.json.error, "feature_disabled");
    _setTestClient(fakeClient(), true); // restore for any later assertions
  });
});
