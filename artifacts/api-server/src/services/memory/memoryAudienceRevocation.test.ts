/**
 * §21 / §28.8 — a Memory whose audience narrows must not survive in a cached
 * Compass projection.
 *
 * CENSUS H189 / H190. Section D.4 left both W with one sentence naming what was
 * left: "`compass_feed_cache` is still never invalidated on a memory visibility
 * change". These tests assert the STORE, not a log line: after the PATCH, the
 * cache rows of the readers who lost access are gone.
 *
 * RED BEFORE GREEN. Run against `7d1f2d498` (where `routes/memories.ts`
 * contains no reference to `CompassCacheEngine` at all) every route test in
 * this file fails: the cache row is still there afterwards.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import memoriesRouter from "../../routes/memories.js";
import {
  audienceChanged,
  mergedAudience,
  resolveRevocationTargets,
  revokeMemoryAudienceCaches,
  MAX_REVOCATION_TARGETS,
  REVOCATION_CONCURRENCY,
} from "./memoryAudienceRevocation.js";

const MEM_ID = "11111111-1111-1111-1111-111111111111";
const TRIP_ID = "22222222-2222-2222-2222-222222222222";
const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const LIKER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CREW = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const LISTED = "dddddddd-dddd-dddd-dddd-dddddddddddd";

interface FakeRow { [k: string]: any }
interface FakeState { [table: string]: FakeRow[] }

function baseState(overrides: Partial<FakeRow> = {}): FakeState {
  return {
    memories: [{
      id: MEM_ID, owner_id: OWNER, title: "Tokyo", caption: null,
      visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
      trip_id: TRIP_ID, event_id: null, place_id: null,
      location_city: null, location_country: null, location_lat: null, location_lng: null,
      canonical_location_id: null,
      starts_at: null, ends_at: null, state: "published",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      ...overrides,
    }],
    memory_items: [],
    memory_tags: [],
    memory_likes: [{ memory_id: MEM_ID, user_id: LIKER }],
    memory_saves: [],
    user_follows: [],
    circle_memberships: [],
    trips: [{ id: TRIP_ID, owner_id: OWNER }],
    trip_members: [
      { trip_id: TRIP_ID, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP_ID, user_id: CREW, role: "member", status: "accepted" },
    ],
    profiles: [{ id: OWNER, name: "Alice", handle: "alice", avatar_url: null }],
    blocks: [],
    feature_flags: [],
    notifications: [],
    compass_feed_cache: [
      { user_id: OWNER, cache_key: "feed:owner", payload: {}, expires_at: "2999-01-01T00:00:00Z" },
      { user_id: LIKER, cache_key: "feed:liker", payload: {}, expires_at: "2999-01-01T00:00:00Z" },
      { user_id: CREW, cache_key: "feed:crew", payload: {}, expires_at: "2999-01-01T00:00:00Z" },
      { user_id: LISTED, cache_key: "feed:listed", payload: {}, expires_at: "2999-01-01T00:00:00Z" },
    ],
    compass_cache_invalidations: [],
  };
}

/** Minimal PostgREST double — the same shape src/test/memories.test.ts uses. */
function makeClient(state: FakeState, failTables: Set<string> = new Set()) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingDelete = false;
    let countMode = false;
    let selectedAfterWrite = false;

    const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;

    const builder: any = {
      select(_c?: string, opts?: any) {
        if (opts?.count === "exact" && opts?.head) countMode = true;
        if (pendingInsert || pendingUpdate || pendingDelete) selectedAfterWrite = true;
        return builder;
      },
      insert(row: any) { pendingInsert = row; return builder; },
      update(patch: any) { pendingUpdate = patch; return builder; },
      upsert(row: any) { pendingInsert = row; return builder; },
      delete() { pendingDelete = true; return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return builder; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return builder; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return builder; },
      not(c: string, op: string, v: any) {
        if (op === "cs") {
          const want = String(v).replace(/^\{|\}$/g, "").split(",").filter(Boolean);
          filters.push((r) => !want.some((w) => (r[c] ?? []).includes(w)));
        } else if (op === "in") {
          const list = String(v).replace(/^\(|\)$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
          filters.push((r) => !list.includes(r[c]));
        } else filters.push((r) => r[c] !== v);
        return builder;
      },
      order() { return builder; },
      limit() { return builder; },
      maybeSingle() { return resolveSingle(); },
      single() { return resolveSingle(); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): FakeRow[] {
      return (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }
    async function resolveSingle() {
      if (fail) return { data: null, error: fail, count: null };
      if (pendingInsert) {
        const row = { id: `new-${table}-${Math.random()}`, ...pendingInsert };
        (state[table] ??= []).push(row);
        return { data: row, error: null, count: null };
      }
      if (pendingUpdate) {
        const m = rows();
        if (m.length > 0) Object.assign(m[0], pendingUpdate);
        return { data: m[0] ?? null, error: null, count: null };
      }
      if (pendingDelete) {
        const arr = state[table] ?? [];
        const gone = arr.filter((r) => filters.every((f) => f(r)));
        state[table] = arr.filter((r) => !filters.every((f) => f(r)));
        return { data: selectedAfterWrite ? (gone[0] ?? null) : null, error: null, count: null };
      }
      const m = rows();
      if (countMode) return { data: null, error: null, count: m.length };
      return { data: m[0] ?? null, error: null, count: null };
    }
    async function resolveList() {
      if (fail) return { data: null, error: fail, count: null };
      if (pendingInsert) {
        const ins = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        const made = ins.map((r: any) => ({ id: `new-${table}-${Math.random()}`, ...r }));
        (state[table] ??= []).push(...made);
        return { data: made, error: null, count: made.length };
      }
      if (pendingUpdate) {
        const m = rows();
        m.forEach((r) => Object.assign(r, pendingUpdate));
        return { data: m, error: null, count: m.length };
      }
      if (pendingDelete) {
        const arr = state[table] ?? [];
        const gone = arr.filter((r) => filters.every((f) => f(r)));
        state[table] = arr.filter((r) => !filters.every((f) => f(r)));
        return { data: selectedAfterWrite ? gone : null, error: null, count: gone.length };
      }
      const m = rows();
      if (countMode) return { data: null, error: null, count: m.length };
      return { data: m, error: null, count: m.length };
    }
    return builder;
  }

  return {
    from,
    auth: {
      getUser: async (tok: string) => {
        const map: Record<string, { id: string }> = {
          "owner-tok": { id: OWNER },
          "liker-tok": { id: LIKER },
        };
        const u = map[tok];
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: "invalid" } };
      },
    },
  };
}

async function startApp(state: FakeState) {
  _setTestClient(makeClient(state) as any, true);
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

async function patch(base: string, path: string, tok: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok}`, connection: "close" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function del(base: string, path: string, tok: string) {
  const res = await fetch(`${base}${path}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${tok}`, connection: "close" },
  });
  return { status: res.status };
}

const cachedUsers = (s: FakeState) => new Set((s.compass_feed_cache ?? []).map((r) => r.user_id as string));

// ── The pure predicate ────────────────────────────────────────────────────────

describe("§21 audienceChanged", () => {
  it("is true for every audience-bearing field, and false for a caption edit", () => {
    const base = { visibility: "public", allowed_user_ids: [], hidden_user_ids: [], trip_id: TRIP_ID, state: "published" };
    assert.equal(audienceChanged(base, { ...base }), false);
    assert.equal(audienceChanged(base, { ...base, visibility: "only_me" }), true);
    assert.equal(audienceChanged(base, { ...base, state: "archived" }), true);
    assert.equal(audienceChanged(base, { ...base, trip_id: null }), true);
    assert.equal(audienceChanged(base, { ...base, allowed_user_ids: [LISTED] }), true);
    assert.equal(audienceChanged(base, { ...base, hidden_user_ids: [LIKER] }), true);
    // Order is not a change — a re-sorted allow-list must not evict every cache.
    assert.equal(
      audienceChanged({ ...base, allowed_user_ids: [LIKER, LISTED] }, { ...base, allowed_user_ids: [LISTED, LIKER] }),
      false,
    );
  });

  it("mergedAudience takes the patch's value only when the patch names the key", () => {
    const existing = { visibility: "public", allowed_user_ids: [LIKER], hidden_user_ids: [], trip_id: TRIP_ID, state: "published" };
    const merged = mergedAudience(existing, { visibility: "custom" });
    assert.equal(merged.visibility, "custom");
    assert.deepEqual(merged.allowed_user_ids, [LIKER]);
    assert.equal(mergedAudience(existing, { allowed_user_ids: [] }).allowed_user_ids?.length, 0);
  });
});

// ── Target resolution ─────────────────────────────────────────────────────────

describe("§21 resolveRevocationTargets", () => {
  it("names the crew of BOTH the old and the new trip, and the owner", async () => {
    const state = baseState();
    const sc = makeClient(state);
    const r = await resolveRevocationTargets(sc, {
      memoryId: MEM_ID,
      ownerId: OWNER,
      previous: { visibility: "trip_crew", trip_id: TRIP_ID },
      next: { visibility: "only_me", trip_id: TRIP_ID },
    });
    assert.ok(r.targets.includes(OWNER), "owner");
    assert.ok(r.targets.includes(CREW), "crew member who lost the memory");
    assert.equal(r.unbounded_audience, null);
    assert.deepEqual(r.degraded, []);
  });

  it("reports `public` as an unbounded audience and falls back to likes/saves/tags", async () => {
    const state = baseState();
    const sc = makeClient(state);
    const r = await resolveRevocationTargets(sc, {
      memoryId: MEM_ID,
      ownerId: OWNER,
      previous: { visibility: "public" },
      next: { visibility: "only_me" },
    });
    assert.equal(r.unbounded_audience, "public");
    assert.ok(r.targets.includes(LIKER), "the bounded proxy must include the liker");
  });

  it("records an unreadable membership table instead of silently revoking nobody", async () => {
    const state = baseState();
    const sc = makeClient(state, new Set(["trip_members"]));
    const r = await resolveRevocationTargets(sc, {
      memoryId: MEM_ID,
      ownerId: OWNER,
      previous: { visibility: "trip_crew", trip_id: TRIP_ID },
      next: { visibility: "only_me", trip_id: TRIP_ID },
    });
    assert.equal(r.degraded.length, 1);
    assert.equal(r.degraded[0].table, "trip_members");
    assert.ok(!r.targets.includes(CREW), "an unreadable crew cannot be claimed as revoked");
  });

  it("caps the target set and says so rather than reporting a complete revocation", async () => {
    const many = Array.from({ length: MAX_REVOCATION_TARGETS + 25 }, (_, i) => `follower-${String(i).padStart(5, "0")}`);
    const state = baseState();
    state.user_follows = many.map((id) => ({ follower_id: id, following_id: OWNER }));
    const sc = makeClient(state);
    const r = await resolveRevocationTargets(sc, {
      memoryId: MEM_ID,
      ownerId: OWNER,
      previous: { visibility: "friends_only" },
      next: { visibility: "only_me" },
    });
    assert.equal(r.truncated, true);
    assert.equal(r.targets.length, MAX_REVOCATION_TARGETS);
    assert.equal(r.targets[0], OWNER, "the owner survives the cap");
  });

  it("evicts with a BOUNDED pool — a Memory edit must not open one connection per follower", async () => {
    const many = Array.from({ length: 120 }, (_, i) => `follower-${String(i).padStart(5, "0")}`);
    const state = baseState();
    state.user_follows = many.map((id) => ({ follower_id: id, following_id: OWNER }));
    const sc = makeClient(state);
    let inFlight = 0;
    let peak = 0;
    const report = await revokeMemoryAudienceCaches(sc, {
      memoryId: MEM_ID,
      ownerId: OWNER,
      previous: { visibility: "friends_only" },
      next: { visibility: "only_me" },
      reason: "memory_visibility_changed",
      invalidate: async () => {
        inFlight++;
        if (inFlight > peak) peak = inFlight;
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    });
    assert.equal(report.invalidated, 121, "owner + 120 followers");
    assert.ok(peak > 1, "a fixed-width pool is not a sequential loop");
    assert.ok(
      peak <= REVOCATION_CONCURRENCY,
      `pool width must not exceed ${REVOCATION_CONCURRENCY}, observed ${peak}`,
    );
    assert.equal(report.peak_in_flight, peak, "the report must state the width it actually used");
  });

  it("revokeMemoryAudienceCaches reports a failing invalidator rather than throwing", async () => {
    const state = baseState();
    const sc = makeClient(state);
    const report = await revokeMemoryAudienceCaches(sc, {
      memoryId: MEM_ID,
      ownerId: OWNER,
      previous: { visibility: "public" },
      next: { visibility: "only_me" },
      reason: "memory_visibility_changed",
      invalidate: async (_db, userId) => { if (userId === LIKER) throw new Error("boom"); },
    });
    assert.deepEqual(report.failed, [LIKER]);
    assert.ok(report.invalidated >= 1);
  });
});

// ── The wiring: the route must reach it ───────────────────────────────────────

describe("PATCH /api/memories/:id revokes cached Compass projections", () => {
  it("evicts the cache of a reader who lost access when a public Memory goes private", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      assert.ok(cachedUsers(state).has(LIKER), "precondition: the liker has a cached feed");
      const { status } = await patch(app.baseUrl, `/api/memories/${MEM_ID}`, "owner-tok", { visibility: "only_me" });
      assert.equal(status, 200);
      assert.equal(cachedUsers(state).has(LIKER), false, "the liker's cached Compass feed must be gone");
      assert.equal(cachedUsers(state).has(OWNER), false, "the owner's own cached feed must be gone");
    } finally { await app.close(); }
  });

  it("evicts the crew's cache when a trip_crew Memory is narrowed", async () => {
    const state = baseState({ visibility: "trip_crew" });
    const app = await startApp(state);
    try {
      const { status } = await patch(app.baseUrl, `/api/memories/${MEM_ID}`, "owner-tok", { visibility: "only_me" });
      assert.equal(status, 200);
      assert.equal(cachedUsers(state).has(CREW), false, "the crew member's cached Compass feed must be gone");
    } finally { await app.close(); }
  });

  it("leaves every cache alone when nothing about the audience changed", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await patch(app.baseUrl, `/api/memories/${MEM_ID}`, "owner-tok", { caption: "a new caption" });
      assert.equal(status, 200);
      assert.deepEqual(
        [...cachedUsers(state)].sort(),
        [OWNER, LIKER, CREW, LISTED].sort(),
        "a caption edit must not evict anybody's Compass cache",
      );
    } finally { await app.close(); }
  });

  it("DELETE evicts the caches of the readers who held the Memory", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      const { status } = await del(app.baseUrl, `/api/memories/${MEM_ID}`, "owner-tok");
      assert.equal(status, 204);
      assert.equal(cachedUsers(state).has(LIKER), false, "a deleted Memory must not survive in a reader's cached feed");
      assert.equal(cachedUsers(state).has(OWNER), false);
    } finally { await app.close(); }
  });

  it("records the revocation in compass_cache_invalidations with a Memory-specific reason", async () => {
    const state = baseState();
    const app = await startApp(state);
    try {
      await patch(app.baseUrl, `/api/memories/${MEM_ID}`, "owner-tok", { visibility: "only_me" });
      const reasons = new Set((state.compass_cache_invalidations ?? []).map((r) => r.reason as string));
      assert.ok(
        reasons.has("memory_visibility_changed"),
        `expected a memory_visibility_changed audit row, saw ${[...reasons].join(", ") || "none"}`,
      );
    } finally { await app.close(); }
  });
});
