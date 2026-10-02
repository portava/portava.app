/**
 * Testing-mode lane WP-06 (PLAT-F33) — `GET /me/stories`, the owner's own
 * active stories.
 *
 * "Save your own story into a highlight" (`POST /stories/:id/save-to-highlight`,
 * owner only) had no way to be reached: `GET /stories/feed` never includes the
 * viewer's own stories (its candidate owners are the people the viewer follows,
 * travels with or circles with), and `GET /stories/archive` lists only expired
 * and saved ones. So an owner could not open the story they had just posted.
 *
 * This route lists exactly the caller's own stories that are live: state
 * `active` and not yet expired. It is the OWNER'S read, so it applies no
 * audience filter — and it takes no user id, so it can never be anyone else's.
 * An unreadable `stories` table is a 503, never "you have no stories".
 *
 * RED at 18518e982: `/me/stories` is not a route (404).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import storiesRouter from "../routes/stories.js";

const ME = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

type Row = Record<string, any>;
interface FakeState { [t: string]: Row[] }

function story(id: string, over: Row = {}): Row {
  return {
    id, owner_id: ME, media_url: `https://x/${id}.jpg`, media_type: "image/jpeg", caption: null,
    visibility: "public", close_friends_only: false, trip_id: null, event_id: null, place_id: null,
    expires_at: FUTURE, saved_to_highlight_id: null, state: "active", hide_viewer_list: false,
    created_at: `2026-09-2${id.slice(-1)}T10:00:00.000Z`, allowed_user_ids: [], hidden_user_ids: [],
    ...over,
  };
}

function baseState(): FakeState {
  return {
    feature_flags: [{ flag: "stories_enabled", enabled: true }],
    stories: [
      story("s-2"),
      story("s-1"),
      story("s-3", { expires_at: PAST }),
      story("s-4", { state: "deleted" }),
      story("s-5", { state: "saved" }),
      story("s-6", { owner_id: OTHER }),
    ],
    profiles: [{ id: ME, handle: "me", name: "Me", avatar_url: null, verified: false }],
  };
}

function makeClient(state: FakeState, failTables = new Set<string>()) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    let asc: { col: string; ascending: boolean } | null = null;
    let limitN: number | null = null;
    const fail = failTables.has(table) ? { message: `${table} unreadable` } : null;
    const result = () => {
      if (fail) return { data: null, error: fail };
      let rows = (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (asc) {
        const { col, ascending } = asc;
        rows = [...rows].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (ascending ? 1 : -1));
      }
      return { data: limitN == null ? rows : rows.slice(0, limitN), error: null };
    };
    const b: any = {
      select() { return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      gt(c: string, v: any) { filters.push((r) => String(r[c]) > String(v)); return b; },
      order(col: string, opts?: { ascending?: boolean }) { asc = { col, ascending: opts?.ascending !== false }; return b; },
      limit(n: number) { limitN = n; return b; },
      maybeSingle: async () => { const r = result(); return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }; },
      then(onF: any, onR: any) { return Promise.resolve(result()).then(onF, onR); },
    };
    return b;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: { message: "no rpc" } }),
    auth: {
      getUser: async (tok: string) => (tok === "me-tok"
        ? { data: { user: { id: ME } }, error: null }
        : { data: { user: null }, error: { message: "invalid" } }),
    },
  };
}

async function startApp(state: FakeState, failTables = new Set<string>()) {
  _setTestClient(makeClient(state, failTables) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, next: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", storiesRouter);
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
  const res = await fetch(`${base}${path}`, { headers: { connection: "close", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) } });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

describe("PLAT-F33 — GET /me/stories lists the owner's own live stories", () => {
  it("requires authentication", async () => {
    const app = await startApp(baseState());
    try { assert.equal((await get(app.baseUrl, "/api/me/stories")).status, 401); } finally { await app.close(); }
  });

  it("only the caller's own active, unexpired stories, oldest first", async () => {
    const app = await startApp(baseState());
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/stories", "me-tok");
      assert.equal(status, 200);
      assert.deepEqual(body.stories.map((s: any) => s.id), ["s-1", "s-2"]);
      assert.deepEqual(body.author, { userId: ME, handle: "me", name: "Me", avatarUrl: null, verified: false });
    } finally { await app.close(); }
  });

  it("no live stories is an empty list", async () => {
    const state = baseState();
    state.stories = state.stories.filter((s) => s.owner_id !== ME || s.state !== "active");
    const app = await startApp(state);
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/stories", "me-tok");
      assert.equal(status, 200);
      assert.deepEqual(body.stories, []);
    } finally { await app.close(); }
  });

  it("an unreadable stories table is a 503, not an empty list", async () => {
    const app = await startApp(baseState(), new Set(["stories"]));
    try {
      const { status, body } = await get(app.baseUrl, "/api/me/stories", "me-tok");
      assert.equal(status, 503);
      assert.equal(body.error, "degraded_unavailable");
    } finally { await app.close(); }
  });

  it("stories switched off answers feature_disabled, like the feed", async () => {
    const state = baseState();
    state.feature_flags = [{ flag: "stories_enabled", enabled: false }];
    const app = await startApp(state);
    try {
      const { body } = await get(app.baseUrl, "/api/me/stories", "me-tok");
      assert.equal(body.error, "feature_disabled");
    } finally { await app.close(); }
  });
});
