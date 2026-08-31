import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import memoriesRouter from "../routes/memories.js";

/**
 * Backend tests for the Memory System API.
 * Uses the same fake-client + node:http pattern as other test files.
 *
 * Identities:
 *   "owner-tok"   -> user owner-1   (memory owner)
 *   "friend-tok"  -> user friend-1  (mutual follow / friends_only access)
 *   "stranger-tok"-> user stranger-1 (no relation)
 *   "bad-tok"     -> invalid (auth.getUser fails)
 */

const MEM_ID      = "11111111-1111-1111-1111-111111111111";
const TRIP_ID     = "22222222-2222-2222-2222-222222222222";
const ITEM_ID     = "33333333-3333-3333-3333-333333333333";
const USER_ID     = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const FRIEND_ID   = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STRANGER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// ── Fake client ───────────────────────────────────────────────────────────────

interface FakeRow { [k: string]: any }

interface FakeState {
  memories:      FakeRow[];
  memory_items:  FakeRow[];
  memory_tags:   FakeRow[];
  memory_likes:  FakeRow[];
  memory_saves:  FakeRow[];
  user_follows:  FakeRow[];
  trips:         FakeRow[];
  trip_members:  FakeRow[];
  profiles:      FakeRow[];
  blocks:        FakeRow[];
  feature_flags: FakeRow[];
  notifications: FakeRow[];
}

function baseState(): FakeState {
  return {
    memories: [
      {
        id: MEM_ID, owner_id: USER_ID, title: "Tokyo 2024", caption: "Great trip",
        visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
        trip_id: TRIP_ID, event_id: null, place_id: null,
        starts_at: null, ends_at: null, state: "published",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      },
    ],
    memory_items: [
      {
        id: ITEM_ID, memory_id: MEM_ID,
        media_url: "https://example.com/photo.jpg", media_type: "image/jpeg",
        caption: null, position: 0, created_at: new Date().toISOString(),
      },
    ],
    memory_tags:  [],
    memory_likes: [],
    memory_saves: [],
    user_follows: [
      { follower_id: USER_ID,   following_id: FRIEND_ID },
      { follower_id: FRIEND_ID, following_id: USER_ID   },
    ],
    trips: [
      {
        id: TRIP_ID, owner_id: USER_ID, title: "Tokyo adventure",
        destination_city: "Tokyo", destination_country: "Japan",
        start_date: "2024-01-01", end_date: "2024-01-14", status: "completed",
      },
    ],
    trip_members: [
      { trip_id: TRIP_ID, user_id: USER_ID,    role: "owner"  },
      { trip_id: TRIP_ID, user_id: FRIEND_ID,  role: "member" },
    ],
    profiles: [
      { id: USER_ID,    name: "Alice", handle: "alice",   avatar_url: null },
      { id: FRIEND_ID, name: "Bob",   handle: "bob",     avatar_url: null },
    ],
    blocks:        [],
    feature_flags: [{ flag: "memories_enabled", enabled: true }],
    notifications: [],
  };
}

function makeClient(state: FakeState) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    let pendingUpsert: any = null;
    let pendingDelete = false;
    let countMode = false;

    const builder: any = {
      select(_cols?: string, opts?: any) {
        if (opts?.count === "exact" && opts?.head) countMode = true;
        return builder;
      },
      insert(row: any) { pendingInsert = row; return builder; },
      update(patch: any) { pendingUpdate = patch; return builder; },
      upsert(row: any) { pendingUpsert = row; return builder; },
      delete() { pendingDelete = true; return builder; },
      eq(col: string, val: any)  { filters.push((r) => r[col] === val); return builder; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return builder; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return builder; },
      lt(col: string, val: any)  { filters.push((r) => r[col] < val); return builder; },
      order()  { return builder; },
      limit()  { return builder; },
      maybeSingle() { return resolveSingle(true); },
      single()      { return resolveSingle(false); },
      then(onF: any, onR: any) { return resolveList().then(onF, onR); },
    };

    function rows(): FakeRow[] {
      const src: FakeRow[] = (state as any)[table] ?? [];
      return src.filter((r) => filters.every((f) => f(r)));
    }

    async function resolveSingle(maybe: boolean) {
      if (pendingInsert) {
        const arr = (state as any)[table];
        const row = { id: `new-${table}-${Date.now()}`, ...pendingInsert };
        if (arr) arr.push(row);
        return { data: row, error: null, count: null };
      }
      if (pendingUpdate) {
        const matched = rows();
        if (matched.length > 0) Object.assign(matched[0], pendingUpdate);
        const row = matched[0] ?? null;
        return { data: row, error: null, count: null };
      }
      if (pendingUpsert) {
        const arr: FakeRow[] = (state as any)[table] ?? [];
        const row = { id: `new-${table}-${Date.now()}`, ...pendingUpsert };
        arr.push(row);
        return { data: row, error: null, count: null };
      }
      if (pendingDelete) {
        const arr: FakeRow[] = (state as any)[table] ?? [];
        const keep = arr.filter((r) => !filters.every((f) => f(r)));
        (state as any)[table] = keep;
        return { data: null, error: null, count: null };
      }
      const matched = rows();
      if (countMode) return { data: null, error: null, count: matched.length };
      if (maybe) return { data: matched[0] ?? null, error: null, count: null };
      return { data: matched[0] ?? null, error: null, count: null };
    }

    async function resolveList() {
      if (pendingInsert) {
        const arr = (state as any)[table];
        const insRows = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        const inserted = insRows.map((r: any) => ({ id: `new-${table}-${Date.now()}`, ...r }));
        if (arr) inserted.forEach((r: any) => arr.push(r));
        return { data: inserted, error: null, count: inserted.length };
      }
      if (pendingUpdate) {
        const matched = rows();
        matched.forEach((r) => Object.assign(r, pendingUpdate));
        return { data: matched, error: null, count: matched.length };
      }
      if (pendingDelete) {
        const arr: FakeRow[] = (state as any)[table] ?? [];
        const keep = arr.filter((r) => !filters.every((f) => f(r)));
        (state as any)[table] = keep;
        return { data: [], error: null, count: 0 };
      }
      const matched = rows();
      if (countMode) return { data: null, error: null, count: matched.length };
      return { data: matched, error: null, count: matched.length };
    }

    return builder;
  }

  return {
    from,
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, { id: string }> = {
          "owner-tok":   { id: USER_ID    },
          "friend-tok":  { id: FRIEND_ID  },
          "stranger-tok":{ id: STRANGER_ID },
        };
        const u = map[token];
        if (!u) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: u }, error: null };
      },
    },
  };
}

// ── Test app ──────────────────────────────────────────────────────────────────

async function startApp(state: FakeState) {
  const client = makeClient(state);
  _setTestClient(client as any, true);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, info: () => {}, warn: () => {} };
    next();
  });
  app.use("/api", memoriesRouter);

  return new Promise<{ baseUrl: string; state: FakeState; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        state,
        close: () => new Promise<void>((res, rej) => {
          srv.closeAllConnections();
          srv.close((e) => (e ? rej(e) : res()));
        }),
      });
    });
    srv.on("error", reject);
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function auth(tok: string) { return `Bearer ${tok}`; }

async function get(base: string, path: string, tok?: string) {
  const hdrs: Record<string, string> = { connection: "close" };
  if (tok) hdrs["Authorization"] = tok;
  const res = await fetch(`${base}${path}`, { headers: hdrs });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function post(base: string, path: string, tok?: string, body?: unknown) {
  const hdrs: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (tok) hdrs["Authorization"] = tok;
  const res = await fetch(`${base}${path}`, { method: "POST", headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function patch(base: string, path: string, tok?: string, body?: unknown) {
  const hdrs: Record<string, string> = { "Content-Type": "application/json", connection: "close" };
  if (tok) hdrs["Authorization"] = tok;
  const res = await fetch(`${base}${path}`, { method: "PATCH", headers: hdrs, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function del(base: string, path: string, tok?: string) {
  const hdrs: Record<string, string> = { connection: "close" };
  if (tok) hdrs["Authorization"] = tok;
  const res = await fetch(`${base}${path}`, { method: "DELETE", headers: hdrs });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/memories/:id", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, `/api/memories/${MEM_ID}`);
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns 200 with memory for public memory + valid user", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/memories/${MEM_ID}`, auth("owner-tok"));
      assert.equal(status, 200);
      assert.ok(body?.memory?.id === MEM_ID);
    } finally { await app.close(); }
  });

  it("returns 200 for public memory by stranger", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, `/api/memories/${MEM_ID}`, auth("stranger-tok"));
      assert.equal(status, 200);
    } finally { await app.close(); }
  });

  it("returns 404 for only_me memory viewed by stranger", async () => {
    const state = baseState();
    state.memories[0].visibility = "only_me";
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/memories/${MEM_ID}`, auth("stranger-tok"));
      assert.equal(status, 404);
    } finally { await app.close(); }
  });

  it("returns 200 for only_me memory viewed by owner", async () => {
    const state = baseState();
    state.memories[0].visibility = "only_me";
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/memories/${MEM_ID}`, auth("owner-tok"));
      assert.equal(status, 200);
    } finally { await app.close(); }
  });

  it("returns 400 for invalid uuid", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, `/api/memories/not-a-uuid`, auth("owner-tok"));
      assert.equal(status, 400);
    } finally { await app.close(); }
  });

  it("denies a hidden viewer even for a friends_only memory (audit MEM·M1)", async () => {
    const state = baseState();
    state.memories[0].visibility = "friends_only";
    state.memories[0].hidden_user_ids = [FRIEND_ID]; // owner hid this mutual follower
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/memories/${MEM_ID}`, auth("friend-tok"));
      assert.equal(status, 404, "a hidden friend must not read a friends_only memory");
    } finally { await app.close(); }
  });

  it("still allows a non-hidden friend to read a friends_only memory (positive control)", async () => {
    const state = baseState();
    state.memories[0].visibility = "friends_only";
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/memories/${MEM_ID}`, auth("friend-tok"));
      assert.equal(status, 200);
    } finally { await app.close(); }
  });
});

describe("POST /api/memories", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await post(app.baseUrl, "/api/memories");
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("creates a memory", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await post(app.baseUrl, "/api/memories", auth("owner-tok"), {
        title: "New memory", caption: "A caption", visibility: "public",
      });
      assert.equal(status, 201);
      assert.ok(body?.memory?.title === "New memory");
    } finally { await app.close(); }
  });

  it("rejects invalid visibility", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await post(app.baseUrl, "/api/memories", auth("owner-tok"), {
        visibility: "everyone",
      });
      assert.equal(status, 400);
    } finally { await app.close(); }
  });
});

describe("PATCH /api/memories/:id", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await patch(app.baseUrl, `/api/memories/${MEM_ID}`, undefined, { title: "X" });
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns 403 for non-owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await patch(app.baseUrl, `/api/memories/${MEM_ID}`, auth("stranger-tok"), { title: "X" });
      assert.equal(status, 403);
    } finally { await app.close(); }
  });

  it("updates title for owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await patch(app.baseUrl, `/api/memories/${MEM_ID}`, auth("owner-tok"), { title: "Updated title" });
      assert.equal(status, 200);
      assert.ok(body?.memory?.title === "Updated title");
    } finally { await app.close(); }
  });

  it("returns 400 for empty patch", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await patch(app.baseUrl, `/api/memories/${MEM_ID}`, auth("owner-tok"), {});
      assert.equal(status, 400);
    } finally { await app.close(); }
  });
});

describe("DELETE /api/memories/:id", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await del(app.baseUrl, `/api/memories/${MEM_ID}`);
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns 403 for non-owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await del(app.baseUrl, `/api/memories/${MEM_ID}`, auth("stranger-tok"));
      assert.equal(status, 403);
    } finally { await app.close(); }
  });

  it("soft-deletes for owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await del(app.baseUrl, `/api/memories/${MEM_ID}`, auth("owner-tok"));
      assert.equal(status, 204);
      assert.equal(app.state.memories[0].state, "deleted");
    } finally { await app.close(); }
  });
});

describe("POST /api/memories/:id/like", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await post(app.baseUrl, `/api/memories/${MEM_ID}/like`);
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("likes a public memory", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await post(app.baseUrl, `/api/memories/${MEM_ID}/like`, auth("friend-tok"));
      assert.equal(status, 200);
      assert.equal(body?.likedByMe, true);
    } finally { await app.close(); }
  });

  it("returns 404 for only_me memory liked by stranger", async () => {
    const state = baseState();
    state.memories[0].visibility = "only_me";
    const app = await startApp(state);
    try {
      const { status } = await post(app.baseUrl, `/api/memories/${MEM_ID}/like`, auth("stranger-tok"));
      assert.equal(status, 404);
    } finally { await app.close(); }
  });
});

describe("DELETE /api/memories/:id/like", () => {
  it("returns 200 even if not liked", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await del(app.baseUrl, `/api/memories/${MEM_ID}/like`, auth("owner-tok"));
      assert.equal(status, 200);
    } finally { await app.close(); }
  });
});

describe("POST /api/memories/:id/save", () => {
  it("saves a public memory", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await post(app.baseUrl, `/api/memories/${MEM_ID}/save`, auth("friend-tok"));
      assert.equal(status, 200);
      assert.equal(body?.savedByMe, true);
    } finally { await app.close(); }
  });
});

describe("DELETE /api/memories/:id/save", () => {
  it("unsaves a memory", async () => {
    const state = baseState();
    state.memory_saves.push({ memory_id: MEM_ID, user_id: FRIEND_ID, created_at: new Date().toISOString() });
    const app = await startApp(state);
    try {
      const { status, body } = await del(app.baseUrl, `/api/memories/${MEM_ID}/save`, auth("friend-tok"));
      assert.equal(status, 200);
      assert.equal(body?.savedByMe, false);
    } finally { await app.close(); }
  });
});

describe("POST /api/memories/:id/items", () => {
  it("returns 403 for non-owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await post(app.baseUrl, `/api/memories/${MEM_ID}/items`, auth("stranger-tok"), {
        mediaUrl: "https://example.com/x.jpg",
      });
      assert.equal(status, 403);
    } finally { await app.close(); }
  });

  it("adds item for owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await post(app.baseUrl, `/api/memories/${MEM_ID}/items`, auth("owner-tok"), {
        mediaUrl: "https://example.com/new.jpg", mediaType: "image/jpeg", position: 1,
      });
      assert.equal(status, 201);
      assert.ok(body?.item?.mediaUrl === "https://example.com/new.jpg");
    } finally { await app.close(); }
  });

  it("rejects invalid mediaUrl", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await post(app.baseUrl, `/api/memories/${MEM_ID}/items`, auth("owner-tok"), {
        mediaUrl: "not-a-url",
      });
      assert.equal(status, 400);
    } finally { await app.close(); }
  });
});

describe("DELETE /api/memories/:id/items/:itemId", () => {
  it("returns 403 for non-owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await del(app.baseUrl, `/api/memories/${MEM_ID}/items/${ITEM_ID}`, auth("stranger-tok"));
      assert.equal(status, 403);
    } finally { await app.close(); }
  });

  it("removes item for owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await del(app.baseUrl, `/api/memories/${MEM_ID}/items/${ITEM_ID}`, auth("owner-tok"));
      assert.equal(status, 204);
    } finally { await app.close(); }
  });
});

describe("PATCH /api/memories/:id/tags/:userId — self-tag update", () => {
  it("returns 403 if trying to modify another user's tag", async () => {
    const state = baseState();
    state.memory_tags.push({ memory_id: MEM_ID, tagged_user_id: FRIEND_ID, status: "pending" });
    const app = await startApp(state);
    try {
      const { status } = await patch(app.baseUrl, `/api/memories/${MEM_ID}/tags/${FRIEND_ID}`, auth("owner-tok"), { action: "approve" });
      assert.equal(status, 403);
    } finally { await app.close(); }
  });

  it("allows user to approve their own tag", async () => {
    const state = baseState();
    state.memory_tags.push({ memory_id: MEM_ID, tagged_user_id: FRIEND_ID, status: "pending" });
    const app = await startApp(state);
    try {
      const { status, body } = await patch(app.baseUrl, `/api/memories/${MEM_ID}/tags/${FRIEND_ID}`, auth("friend-tok"), { action: "approve" });
      assert.equal(status, 200);
      assert.equal(body?.status, "approved");
    } finally { await app.close(); }
  });

  it("allows user to remove their own tag", async () => {
    const state = baseState();
    state.memory_tags.push({ memory_id: MEM_ID, tagged_user_id: FRIEND_ID, status: "pending" });
    const app = await startApp(state);
    try {
      const { status, body } = await patch(app.baseUrl, `/api/memories/${MEM_ID}/tags/${FRIEND_ID}`, auth("friend-tok"), { action: "remove" });
      assert.equal(status, 200);
      assert.equal(body?.status, "removed");
    } finally { await app.close(); }
  });
});

describe("POST /api/trips/:tripId/memory", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await post(app.baseUrl, `/api/trips/${TRIP_ID}/memory`);
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns 403 for non-owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await post(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("friend-tok"));
      assert.equal(status, 403);
    } finally { await app.close(); }
  });

  it("creates memory from trip for owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await post(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("owner-tok"));
      assert.equal(status, 201);
      assert.ok(body?.memory?.tripId === TRIP_ID);
      assert.ok(body?.memory?.state === "draft");
      assert.ok(typeof body?.taggedCount === "number");
    } finally { await app.close(); }
  });

  it("returns 403 for non-completed trip", async () => {
    const state = baseState();
    state.trips[0].status = "planning";
    const app = await startApp(state);
    try {
      const { status } = await post(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("owner-tok"));
      assert.equal(status, 403);
    } finally { await app.close(); }
  });
});

describe("GET /api/users/:userId/memories", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, `/api/users/${USER_ID}/memories`);
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns own memories for owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${USER_ID}/memories`, auth("owner-tok"));
      assert.equal(status, 200);
      assert.ok(Array.isArray(body?.memories));
    } finally { await app.close(); }
  });

  it("returns public memories for stranger", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/users/${USER_ID}/memories`, auth("stranger-tok"));
      assert.equal(status, 200);
      assert.ok(Array.isArray(body?.memories));
    } finally { await app.close(); }
  });
});

describe("GET /api/memories (discovery)", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, "/api/memories");
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns only public memories", async () => {
    const state = baseState();
    state.memories.push({
      id: "44444444-4444-4444-4444-444444444444",
      owner_id: USER_ID, title: "Private mem", caption: null,
      visibility: "only_me", allowed_user_ids: [], hidden_user_ids: [],
      trip_id: null, event_id: null, place_id: null,
      starts_at: null, ends_at: null, state: "published",
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/memories", auth("stranger-tok"));
      assert.equal(status, 200);
      const ids = (body?.memories ?? []).map((m: any) => m.id);
      assert.ok(ids.includes(MEM_ID), "public memory should appear");
      assert.ok(!ids.includes("44444444-4444-4444-4444-444444444444"), "private memory should NOT appear");
    } finally { await app.close(); }
  });
});

// ── GET /api/trips/:tripId/memory ─────────────────────────────────────────────

describe("GET /api/trips/:tripId/memory", () => {
  it("returns 401 without auth", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, `/api/trips/${TRIP_ID}/memory`);
      assert.equal(status, 401);
    } finally { await app.close(); }
  });

  it("returns 400 for an invalid trip UUID", async () => {
    const app = await startApp(baseState());
    try {
      const { status } = await get(app.baseUrl, "/api/trips/not-a-uuid/memory", auth("owner-tok"));
      assert.equal(status, 400);
    } finally { await app.close(); }
  });

  it("returns 200 with memory for the trip owner", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("owner-tok"));
      assert.equal(status, 200);
      assert.equal(body?.memory?.id, MEM_ID);
      assert.equal(body?.memory?.tripId, TRIP_ID);
    } finally { await app.close(); }
  });

  it("returns 200 for a non-owner when memory is public", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("stranger-tok"));
      assert.equal(status, 200);
      assert.equal(body?.memory?.id, MEM_ID);
    } finally { await app.close(); }
  });

  it("returns 404 for a blocked user", async () => {
    const state = baseState();
    // owner (USER_ID) has blocked the stranger — isBlocked returns true
    state.blocks.push({ blocker_id: USER_ID, blocked_id: STRANGER_ID });
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("stranger-tok"));
      assert.equal(status, 404);
    } finally { await app.close(); }
  });

  it("returns 404 when memory visibility is only_me and viewer is not the owner", async () => {
    const state = baseState();
    state.memories[0].visibility = "only_me";
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("stranger-tok"));
      assert.equal(status, 404);
    } finally { await app.close(); }
  });

  it("returns 404 when the trip has no linked memory", async () => {
    const state = baseState();
    state.memories = [];
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("owner-tok"));
      assert.equal(status, 404);
    } finally { await app.close(); }
  });

  it("returns 404 when the trip does not exist", async () => {
    const state = baseState();
    state.trips = [];
    const app = await startApp(state);
    try {
      const { status } = await get(app.baseUrl, `/api/trips/${TRIP_ID}/memory`, auth("owner-tok"));
      assert.equal(status, 404);
    } finally { await app.close(); }
  });
});
