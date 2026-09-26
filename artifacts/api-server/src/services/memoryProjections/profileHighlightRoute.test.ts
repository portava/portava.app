/**
 * §18 ProfileHighlightProjection — an audience-specific profile, reached by a
 * caller.
 *
 * CENSUS H165. §E.5 filed this row BRANCH, risk-blocked, with a reason no
 * later section improved on: *"each changes a live response shape … nothing in
 * this repository can tell you which clients read those shapes"*. §H.7 then
 * MEASURED the one readable client and named the two paths it calls —
 * /api/users/:id/memories and /api/users/:id/highlights — so the objection is
 * answerable rather than permanent, and it is answered the way §J answered it
 * for H166: a NEW path, with no shipped shape touched.
 *
 * WHY THIS ROUTE IS IN routes/memories.ts AND NOT routes/highlights.ts, which
 * is the thing a reader will check first. `ProfileHighlightProjection` declares
 * `source_tables: ["memories", "memory_items"]` and a destination of
 * "profile.highlights". It is §12's thesis expressed as a projection — a
 * Highlight is a disposable view over Memories — and the `highlights` table is
 * the 24-hour Stories product §1 names as a non-goal. Serving this projection
 * out of routes/highlights.ts would have projected the wrong table.
 *
 * RED BEFORE GREEN: at 5bca80c91 the route does not exist and every request
 * below comes back 404.
 *
 * THE PROJECTION IS NOT THE PERMISSION. The builder has its own audience
 * filter, and it is real: published-only, public or explicitly allow-listed,
 * never a hidden viewer. What it does NOT have is any notion of a block, and
 * `hidden_user_ids` is not the same thing as a block. So §23's ladder runs per
 * row before the builder, and the block check runs before either.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import memoriesRouter from "../../routes/memories.js";
import { getProjectionDefinition } from "./projectionRegistry.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FRIEND = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const BLOCKED = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const HIDDEN = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

interface FakeState { [t: string]: any[] }

function mem(id: string, over: Record<string, any> = {}) {
  return {
    id, owner_id: OWNER, title: "A day", caption: "SECRET-CAPTION",
    visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
    location_city: "Kyoto", location_country: "Japan",
    location_lat: 35.0123, location_lng: 135.7654,
    starts_at: "2024-03-01T10:00:00.000Z", ends_at: null, state: "published",
    created_at: "2024-03-01T10:00:00.000Z", updated_at: "2024-03-01T10:00:00.000Z",
    ...over,
  };
}

function baseState(): FakeState {
  return {
    memories: [
      mem("pub", { title: "Public day" }),
      mem("priv", { visibility: "only_me", title: "Private" }),
      mem("cust", { visibility: "custom", allowed_user_ids: [FRIEND], title: "For Bob" }),
      mem("hid", { visibility: "public", hidden_user_ids: [HIDDEN], title: "Not for Eve" }),
      mem("draft", { state: "draft", title: "Draft" }),
      mem("del", { state: "deleted", title: "Deleted" }),
      mem("circle", { visibility: "circle_only", title: "Circle" }),
      mem("other", { owner_id: STRANGER, title: "Someone else's" }),
    ],
    memory_items: [
      { id: "i1", memory_id: "pub", media_url: "u1", media_type: "image/jpeg", position: 0 },
      { id: "i2", memory_id: "pub", media_url: "u2", media_type: "image/jpeg", position: 1 },
    ],
    memory_tags: [],
    memory_likes: [], memory_saves: [], user_follows: [], circle_memberships: [],
    profiles: [
      { id: OWNER, name: "Alice", handle: "alice", avatar_url: null },
      { id: FRIEND, name: "Bob", handle: "bob", avatar_url: null },
    ],
    profile_privacy_settings: [],
    blocks: [{ blocker_id: BLOCKED, blocked_id: OWNER }],
    feature_flags: [],
    compass_feed_cache: [], compass_cache_invalidations: [],
  };
}

function makeClient(state: FakeState, failTables = new Set<string>()) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let limitN: number | null = null;
    let countMode = false;
    const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;
    const builder: any = {
      select(_c?: string, opts?: any) { if (opts?.count === "exact" && opts?.head) countMode = true; return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return builder; },
      not(c: string, _o: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      order() { return builder; },
      limit(n: number) { limitN = n; return builder; },
      maybeSingle: async () => (fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null, count: null }),
      single: async () => (fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null, count: null }),
      then(onF: any, onR: any) {
        const p = fail
          ? Promise.resolve({ data: null, error: fail, count: null })
          : Promise.resolve(countMode
            ? { data: null, error: null, count: rows().length }
            : { data: limitN == null ? rows() : rows().slice(0, limitN), error: null, count: rows().length });
        return p.then(onF, onR);
      },
    };
    function rows() { return (state[table] ?? []).filter((r) => filters.every((f) => f(r))); }
    return builder;
  }
  return {
    from,
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, { id: string }> = {
          "owner-tok": { id: OWNER }, "friend-tok": { id: FRIEND },
          "stranger-tok": { id: STRANGER }, "blocked-tok": { id: BLOCKED },
          "hidden-tok": { id: HIDDEN },
        };
        const u = map[tok];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

async function startApp(state: FakeState, failTables = new Set<string>()) {
  _setTestClient(makeClient(state, failTables) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", memoriesRouter);
  return new Promise<{ baseUrl: string; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function get(base: string, path: string, tok?: string) {
  const h: Record<string, string> = { connection: "close" };
  if (tok) h.Authorization = `Bearer ${tok}`;
  const res = await fetch(`${base}${path}`, { headers: h });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

const PROFILE = `/api/users/${OWNER}/memories/highlights`;
const ids = (b: any) => (b.profileHighlights.rows as any[]).map((r) => r.memory_id).sort();

describe("GET /users/:userId/memories/highlights — §18 ProfileHighlightProjection, consumed (H165)", () => {
  it("requires authentication", async () => {
    const app = await startApp(baseState());
    try { assert.equal((await get(app.baseUrl, PROFILE)).status, 401); } finally { await app.close(); }
  });

  it("the owner sees every published Memory of their own, including the private one", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, PROFILE, "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.profileHighlights.projectionId, "ProfileHighlightProjection");
      assert.equal(body.profileHighlights.builderVersion, "profile-highlight@2");
      assert.equal(body.profileHighlights.destination, "profile.highlights");
      assert.deepEqual(ids(body), ["circle", "cust", "hid", "priv", "pub"]);
      assert.ok(body.profileHighlights.rows.every((r: any) => r.audience === "OWNER"));
      // Never the draft, never the deleted, never another owner's.
      assert.ok(!ids(body).includes("draft") && !ids(body).includes("del") && !ids(body).includes("other"));
    } finally { await app.close(); }
  });

  it("a stranger sees the public ones and nothing else", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, PROFILE, "stranger-tok");
      assert.deepEqual(ids(body), ["hid", "pub"]);
      assert.ok(body.profileHighlights.rows.every((r: any) => r.audience === "VIEWER"));
    } finally { await app.close(); }
  });

  it("an allow-listed viewer sees the restricted Memory; a stranger does not", async () => {
    const app = await startApp(baseState());
    try {
      assert.ok(ids((await get(app.baseUrl, PROFILE, "friend-tok")).body).includes("cust"));
      assert.ok(!ids((await get(app.baseUrl, PROFILE, "stranger-tok")).body).includes("cust"));
    } finally { await app.close(); }
  });

  it("a hidden viewer is denied the Memory they were hidden from, public or not", async () => {
    const app = await startApp(baseState());
    try {
      const got = ids((await get(app.baseUrl, PROFILE, "hidden-tok")).body);
      assert.ok(!got.includes("hid"), "hidden_user_ids is a per-Memory denial");
      assert.ok(got.includes("pub"));
    } finally { await app.close(); }
  });

  it("a blocked viewer gets no profile at all — the block is checked before the builder", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, PROFILE, "blocked-tok");
      assert.equal(status, 404);
      assert.equal(body.error, "not_found");
    } finally { await app.close(); }
  });

  it("fails closed when the block table is unreadable", async () => {
    const app = await startApp(baseState(), new Set(["blocks"]));
    try {
      assert.equal((await get(app.baseUrl, PROFILE, "stranger-tok")).status, 404);
    } finally { await app.close(); }
  });

  it("carries exactly the projection's field whitelist — no caption, no coordinate", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, PROFILE, "stranger-tok");
      const whitelist = [...getProjectionDefinition("ProfileHighlightProjection")!.field_whitelist].sort();
      for (const row of body.profileHighlights.rows) assert.deepEqual(Object.keys(row).sort(), whitelist);
      const s = JSON.stringify(body);
      assert.ok(!s.includes("SECRET-CAPTION"), "a caption is not in PROFILE_HIGHLIGHT_FIELDS");
      assert.ok(!s.includes("135.7654"), "the exact coordinate must never reach a profile reader");
    } finally { await app.close(); }
  });

  it("counts media per Memory rather than reporting a photograph-free profile", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, PROFILE, "stranger-tok");
      const pub = (body.profileHighlights.rows as any[]).find((r) => r.memory_id === "pub");
      assert.equal(pub.media_count, 2);
    } finally { await app.close(); }
  });

  it("refuses rather than serving an empty profile when memories are unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memories"]));
    try {
      const { status, body } = await get(app.baseUrl, PROFILE, "stranger-tok");
      assert.equal(status, 503);
      assert.equal(body.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("refuses rather than reporting a photograph-free profile when items are unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memory_items"]));
    try {
      assert.equal((await get(app.baseUrl, PROFILE, "stranger-tok")).status, 503);
    } finally { await app.close(); }
  });

  it("rejects a userId that is not a uuid", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, "/api/users/not-a-uuid/memories/highlights", "owner-tok");
      assert.equal(status, 400);
      assert.equal(body.error, "invalid_payload");
    } finally { await app.close(); }
  });

  it("§10's precision ceiling empties the place for a non-owner, and never for the owner", async () => {
    // §H found three profile reads that published more than their siblings. A
    // fourth that skipped `protectMemoryRow` would be the same defect in a new
    // place, and PROFILE_HIGHLIGHT_FIELDS carries city and country. With the
    // precision gate on, a row that names no rung clamps to `hidden` — the
    // read-side normalization that keeps an unreadable policy from being served
    // as `exact`.
    const state = baseState();
    state.feature_flags = [{ flag: "memory_location_precision_enabled", enabled: true }];
    const app = await startApp(state);
    try {
      const stranger = (await get(app.baseUrl, PROFILE, "stranger-tok")).body.profileHighlights.rows as any[];
      assert.ok(stranger.length > 0);
      for (const r of stranger) {
        assert.equal(r.location_city, null, "a clamped rung discloses no city");
        assert.equal(r.location_country, null);
      }
      const owner = (await get(app.baseUrl, PROFILE, "owner-tok")).body.profileHighlights.rows as any[];
      assert.ok(owner.some((r) => r.location_city === "Kyoto"), "the owner still sees their own place");
    } finally { await app.close(); }
  });

  it("says on the response that it is built and not registered", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, PROFILE, "owner-tok");
      assert.equal(body.profileHighlights.registered, false);
      assert.ok(String(body.profileHighlights.sourceVersion).startsWith("v1:"));
    } finally { await app.close(); }
  });
});
