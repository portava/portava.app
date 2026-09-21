/**
 * §18 TripMemoryProjection — trip recap, reached by a caller.
 *
 * CENSUS H166. The §18 preamble states the blanket reason every row in that
 * block is BBW: "No route, lib or service outside `src/test/` and
 * `src/services/memoryCertification/` imports the registry". H.7 then corrected
 * H166's evidence and left the gap named exactly: "`TripMemoryProjection`
 * builds a LIST of a trip's Memories and nothing consumes it."
 *
 * This is the consumer: `GET /trips/:tripId/memories/recap`. It is a NEW route,
 * deliberately — `GET /trips/:tripId/memory` returns a single `{ memory }` that
 * a live client reads, and D.1 (b) records that changing a shipped response
 * shape is not this lane's call to make.
 *
 * RED BEFORE GREEN: at `7d1f2d498` the route does not exist and every request
 * below comes back 404.
 *
 * The assertions are about the PROJECTION's two properties, not about the HTTP
 * plumbing: the field whitelist is what enforces disclosure (nothing outside
 * TRIP_FIELDS may appear), and the audience gate is what decides membership.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import memoriesRouter from "../../routes/memories.js";
import { getProjectionDefinition } from "./projectionRegistry.js";

const TRIP = "22222222-2222-2222-2222-222222222222";
const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CREW = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const PENDING_PERSON = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const BLOCKED_PERSON = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";

interface FakeState { [t: string]: any[] }

function mem(id: string, over: Record<string, any> = {}) {
  return {
    id, owner_id: OWNER, title: "Day one", caption: "SECRET-CAPTION",
    visibility: "trip_crew", allowed_user_ids: [], hidden_user_ids: [],
    trip_id: TRIP, event_id: null, place_id: "p1", canonical_location_id: null,
    location_city: "Kyoto", location_country: "Japan",
    location_lat: 35.01, location_lng: 135.76,
    starts_at: "2024-03-01T10:00:00.000Z", ends_at: null, state: "published",
    created_at: "2024-03-01T10:00:00.000Z", updated_at: "2024-03-01T10:00:00.000Z",
    ...over,
  };
}

function baseState(): FakeState {
  return {
    trips: [{ id: TRIP, owner_id: OWNER }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: CREW, role: "member", status: "accepted" },
    ],
    memories: [
      mem("m2", { starts_at: "2024-03-02T10:00:00.000Z", title: "Day two" }),
      mem("m1"),
      // The owner's own private Memory on the same trip. A crew member may NOT
      // see it; the owner may.
      mem("mp", { visibility: "only_me", title: "Private" }),
      // Deleted — never in a recap.
      mem("md", { state: "deleted" }),
      // Somebody else's Memory on the same trip — the recap is the trip
      // OWNER's, so this must not appear either.
      mem("mx", { owner_id: CREW, title: "Crew's own" }),
    ],
    memory_items: [
      { id: "i1", memory_id: "m1", media_url: "u1", media_type: "image/jpeg", position: 0 },
      { id: "i2", memory_id: "m1", media_url: "u2", media_type: "image/jpeg", position: 1 },
    ],
    memory_tags: [
      { memory_id: "m1", tagged_user_id: CREW, status: "approved" },
      { memory_id: "m1", tagged_user_id: PENDING_PERSON, status: "pending" },
      // APPROVED — the builder's own `approvedTagsFor` would keep this one. Only
      // §10's ladder drops it, and only when the viewer and the participant are
      // blocked. This is the tag that separates "the projection filtered it" from
      // "the person ladder filtered it".
      { memory_id: "m2", tagged_user_id: BLOCKED_PERSON, status: "approved" },
    ],
    memory_likes: [], memory_saves: [], user_follows: [], circle_memberships: [],
    profiles: [
      { id: OWNER, name: "Alice", handle: "alice", avatar_url: null },
      { id: CREW, name: "Bob", handle: "bob", avatar_url: null },
      { id: PENDING_PERSON, name: "Carol", handle: "carol", avatar_url: null },
      { id: BLOCKED_PERSON, name: "Dave", handle: "dave", avatar_url: null },
    ],
    profile_privacy_settings: [],
    blocks: [], feature_flags: [],
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
          "owner-tok": { id: OWNER }, "crew-tok": { id: CREW }, "stranger-tok": { id: STRANGER },
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

const RECAP = `/api/trips/${TRIP}/memories/recap`;

describe("GET /trips/:tripId/memories/recap — §18 TripMemoryProjection, consumed", () => {
  it("requires authentication", async () => {
    const app = await startApp(baseState());
    try { assert.equal((await get(app.baseUrl, RECAP)).status, 401); } finally { await app.close(); }
  });

  it("serves the trip owner's Memories in occurrence order, oldest first", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, RECAP, "owner-tok");
      assert.equal(status, 200);
      assert.equal(body.recap.projectionId, "TripMemoryProjection");
      assert.equal(body.recap.builderVersion, "trip@1");
      assert.equal(body.recap.destination, "trip.recap");
      // occurred_at ascending, ties broken on id: m1 and mp share 03-01T10:00.
      assert.deepEqual(body.recap.rows.map((r: any) => r.memory_id), ["m1", "mp", "m2"]);
      assert.ok(typeof body.recap.sourceVersion === "string" && body.recap.sourceVersion.startsWith("v1:"));
    } finally { await app.close(); }
  });

  it("carries exactly the projection's field whitelist — no caption, no coordinate", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, RECAP, "owner-tok");
      const whitelist = [...getProjectionDefinition("TripMemoryProjection")!.field_whitelist].sort();
      for (const row of body.recap.rows) {
        assert.deepEqual(Object.keys(row).sort(), whitelist);
      }
      const serialized = JSON.stringify(body);
      assert.equal(serialized.includes("SECRET-CAPTION"), false, "a caption is not in TRIP_FIELDS");
      assert.equal(serialized.includes("135.76"), false, "a coordinate is not in TRIP_FIELDS");
    } finally { await app.close(); }
  });

  it("counts media from memory_items rather than guessing", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, RECAP, "owner-tok");
      const m1 = body.recap.rows.find((r: any) => r.memory_id === "m1");
      assert.equal(m1.media_count, 2);
      const m2 = body.recap.rows.find((r: any) => r.memory_id === "m2");
      assert.equal(m2.media_count, 0);
    } finally { await app.close(); }
  });

  it("a crew member gets the crew Memories and NOT the owner's only_me one", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, RECAP, "crew-tok");
      assert.equal(status, 200);
      const ids = body.recap.rows.map((r: any) => r.memory_id);
      assert.deepEqual(ids, ["m1", "m2"]);
      assert.equal(ids.includes("mp"), false, "a crew member must not read the owner's only_me Memory");
    } finally { await app.close(); }
  });

  it("never includes another crew member's own Memory — a recap is the trip OWNER's", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, RECAP, "owner-tok");
      assert.equal(body.recap.rows.some((r: any) => r.memory_id === "mx"), false);
      assert.equal(body.recap.rows.some((r: any) => r.memory_id === "md"), false, "a deleted Memory is not in a recap");
    } finally { await app.close(); }
  });

  it("refuses a viewer who is not accepted crew", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, RECAP, "stranger-tok");
      assert.equal(status, 404);
    } finally { await app.close(); }
  });

  it("refuses a crew member the trip owner has blocked", async () => {
    const state = baseState();
    state.blocks = [{ blocker_id: OWNER, blocked_id: CREW }];
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, RECAP, "crew-tok");
      assert.equal(status, 404);
    } finally { await app.close(); }
  });

  it("discloses only participants the §10 ladder identifies — a pending tag is not one", async () => {
    const app = await startApp(baseState());
    try {
      const { body } = await get(app.baseUrl, RECAP, "owner-tok");
      const m1 = body.recap.rows.find((r: any) => r.memory_id === "m1");
      assert.deepEqual(m1.people, [CREW]);
      assert.equal(m1.people.includes(PENDING_PERSON), false, "a pending tag is not consent to be named");
    } finally { await app.close(); }
  });

  it("drops an APPROVED participant the §10 ladder hides — the projection alone would keep them", async () => {
    const state = baseState();
    state.blocks = [{ blocker_id: OWNER, blocked_id: BLOCKED_PERSON }];
    const app = await startApp(state);
    try {
      const { body } = await get(app.baseUrl, RECAP, "owner-tok");
      const m2 = body.recap.rows.find((r: any) => r.memory_id === "m2");
      assert.deepEqual(m2.people, [], "a blocked participant is HIDDEN (§10 rule 1), approved tag or not");
    } finally { await app.close(); }
  });

  it("refuses rather than reporting an empty recap when memories is unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memories"]));
    try {
      const { status, body } = await get(app.baseUrl, RECAP, "owner-tok");
      assert.equal(status, 503);
      assert.equal(body?.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("refuses rather than reporting a media-free recap when memory_items is unreadable", async () => {
    const app = await startApp(baseState(), new Set(["memory_items"]));
    try {
      const { status } = await get(app.baseUrl, RECAP, "owner-tok");
      assert.equal(status, 503);
    } finally { await app.close(); }
  });
});
