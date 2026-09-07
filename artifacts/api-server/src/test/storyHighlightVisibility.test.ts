/**
 * Story → Highlight promotion must never widen the audience.
 *
 * THE DEFECT
 * ==========
 * POST /stories/:id/save-to-highlight hard-coded `visibility: "public"` on the
 * Highlight it created. A close-friends Story became a PUBLIC Highlight.
 *
 * THE GUARD
 * =========
 * lib/storyHighlightVisibility translates a Story's audience into a Highlight
 * visibility ONLY where the two enforcement paths admit the same viewers
 * (public → public, circle_only → circle_only) and REFUSES every other rung:
 * friends_only, close_friends, custom, trip_crew (trip_only is any-shared-trip,
 * a wider set than one trip's crew), plus the legacy close_friends_only
 * boolean and a non-empty hide list. A refused promotion writes nothing —
 * no highlight row, no saved_to_highlight_id, no state change — and returns
 * 409 with a stable `state: "not_promotable"` / `reason` the UI can render.
 *
 * Run: node --import tsx/esm --test src/test/storyHighlightVisibility.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import storiesRouter from "../routes/stories.js";
import {
  resolveHighlightVisibilityForStory,
  STORY_TO_HIGHLIGHT_VISIBILITY,
  STORY_VISIBILITIES,
  PROMOTABLE_STORY_VISIBILITIES,
} from "../lib/storyHighlightVisibility.js";

const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const STORY = "cccccccc-cccc-cccc-cccc-cccccccccccc";

// ── The pure mapping ─────────────────────────────────────────────────────────

describe("resolveHighlightVisibilityForStory — only faithful mappings, everything else refused", () => {
  it("considers every story visibility exactly once, and only two of them map", () => {
    assert.deepEqual(Object.keys(STORY_TO_HIGHLIGHT_VISIBILITY).sort(), [...STORY_VISIBILITIES].sort());
    assert.deepEqual([...PROMOTABLE_STORY_VISIBILITIES].sort(), ["circle_only", "public"]);
  });

  it("public → public and circle_only → circle_only", () => {
    assert.deepEqual(resolveHighlightVisibilityForStory({ visibility: "public", hidden_user_ids: [] }),
      { ok: true, visibility: "public", storyVisibility: "public" });
    assert.deepEqual(resolveHighlightVisibilityForStory({ visibility: "circle_only", hidden_user_ids: [] }),
      { ok: true, visibility: "circle_only", storyVisibility: "circle_only" });
  });

  it("NEVER maps a restricted story to public: close_friends, friends_only, custom, trip_crew are refused", () => {
    const cases: Array<[string, string]> = [
      ["close_friends", "close_friends_audience"],
      ["friends_only", "mutual_follow_audience"],
      ["custom", "custom_audience"],
      ["trip_crew", "trip_crew_audience"],
    ];
    for (const [vis, reason] of cases) {
      const d = resolveHighlightVisibilityForStory({ visibility: vis, trip_id: "t-1", allowed_user_ids: [OTHER] });
      assert.equal(d.ok, false, vis);
      if (d.ok) continue;
      assert.equal(d.state, "not_promotable");
      assert.equal(d.reason, reason);
      assert.equal(d.storyVisibility, vis);
      assert.ok(d.message.length > 0);
      assert.ok(!d.message.includes(OTHER), "the message names no other user");
    }
  });

  it("the legacy close_friends_only boolean refuses whatever the visibility string says", () => {
    const d = resolveHighlightVisibilityForStory({ visibility: "public", close_friends_only: true });
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.reason, "close_friends_audience");
  });

  it("a non-empty hide list refuses — a Highlight cannot honour it", () => {
    const d = resolveHighlightVisibilityForStory({ visibility: "public", hidden_user_ids: [OTHER] });
    assert.equal(d.ok, false);
    if (!d.ok) assert.equal(d.reason, "hidden_list_unsupported");
    // An empty or absent list is fine.
    assert.equal(resolveHighlightVisibilityForStory({ visibility: "public", hidden_user_ids: [] }).ok, true);
    assert.equal(resolveHighlightVisibilityForStory({ visibility: "public" }).ok, true);
  });

  it("fails closed on a null, missing, or unknown visibility — never defaults to public", () => {
    for (const bad of [null, undefined, "", "PUBLIC", "everyone", 7]) {
      const d = resolveHighlightVisibilityForStory({ visibility: bad });
      assert.equal(d.ok, false, String(bad));
      if (!d.ok) assert.equal(d.reason, "unknown_visibility");
    }
    assert.equal(resolveHighlightVisibilityForStory(null).ok, false);
    assert.equal(resolveHighlightVisibilityForStory(undefined).ok, false);
  });
});

// ── The route ────────────────────────────────────────────────────────────────

interface State {
  stories: any[];
  highlights: any[];
  feature_flags: any[];
  /** Every write the route attempted, per table. */
  writes: Array<{ table: string; kind: "insert" | "update"; payload: any }>;
}

function makeClient(state: State) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingInsert: any = null;
    let pendingUpdate: any = null;
    const b: any = {
      select() { return b; },
      insert(p: any) { pendingInsert = p; state.writes.push({ table, kind: "insert", payload: p }); return b; },
      update(p: any) { pendingUpdate = p; state.writes.push({ table, kind: "update", payload: p }); return b; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return b; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(f: any, r: any) { return resolve(false).then(f, r); },
    };
    async function resolve(single: boolean) {
      if (pendingInsert) {
        const row = { id: `new-${table}`, ...pendingInsert };
        (state as any)[table].push(row);
        return { data: single ? row : [row], error: null };
      }
      const rows = ((state as any)[table] ?? []).filter((r: any) => filters.every((f) => f(r)));
      if (pendingUpdate) rows.forEach((r: any) => Object.assign(r, pendingUpdate));
      return { data: single ? (rows[0] ?? null) : rows, error: null };
    }
    return b;
  }
  return {
    from,
    auth: {
      getUser: async (t: string) => {
        const map: Record<string, string> = { "owner-tok": OWNER, "other-tok": OTHER };
        const id = map[t];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "no" } };
      },
    },
  };
}

function storyRow(overrides: Record<string, any>) {
  return {
    id: STORY, owner_id: OWNER,
    media_url: "post-media/owner/story.jpg", media_type: "image/jpeg", caption: "hi",
    visibility: "public", close_friends_only: false,
    allowed_user_ids: [], hidden_user_ids: [], trip_id: null,
    state: "active", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    saved_to_highlight_id: null,
    ...overrides,
  };
}

async function startApp(story: Record<string, any>) {
  const state: State = {
    stories: [storyRow(story)],
    highlights: [],
    feature_flags: [{ flag: "stories_enabled", enabled: true }],
    writes: [],
  };
  _setTestClient(makeClient(state) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", storiesRouter);
  return new Promise<{ baseUrl: string; state: State; close: () => Promise<void> }>((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`, state,
        close: () => new Promise<void>((res, rej) => { srv.closeAllConnections(); srv.close((e) => (e ? rej(e) : res())); }),
      });
    });
    srv.on("error", reject);
  });
}

async function save(base: string, tok: string) {
  const res = await fetch(`${base}/api/stories/${STORY}/save-to-highlight`, {
    method: "POST",
    headers: { connection: "close", Authorization: `Bearer ${tok}`, "content-type": "application/json" },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("POST /stories/:id/save-to-highlight — the Highlight is never wider than the Story", () => {
  it("a public Story becomes a public Highlight and the Story is linked", async () => {
    const app = await startApp({ visibility: "public" });
    try {
      const r = await save(app.baseUrl, "owner-tok");
      assert.equal(r.status, 201);
      assert.equal(r.body.highlightId, "new-highlights");
      const hl = app.state.highlights[0];
      assert.equal(hl.visibility, "public");
      assert.equal(hl.owner_id, OWNER);
      assert.equal(app.state.stories[0].saved_to_highlight_id, "new-highlights");
      assert.equal(app.state.stories[0].state, "saved");
    } finally { await app.close(); }
  });

  it("a circle_only Story becomes a circle_only Highlight — not a public one", async () => {
    const app = await startApp({ visibility: "circle_only" });
    try {
      const r = await save(app.baseUrl, "owner-tok");
      assert.equal(r.status, 201);
      assert.equal(app.state.highlights[0].visibility, "circle_only");
    } finally { await app.close(); }
  });

  for (const vis of ["close_friends", "friends_only", "custom", "trip_crew"]) {
    it(`a ${vis} Story is REFUSED: 409 not_promotable, no highlight row, Story untouched`, async () => {
      const app = await startApp({ visibility: vis, trip_id: "11111111-1111-1111-1111-111111111111", allowed_user_ids: [OTHER] });
      try {
        const before = JSON.stringify(app.state.stories[0]);
        const r = await save(app.baseUrl, "owner-tok");
        assert.equal(r.status, 409);
        assert.equal(r.body.error, "conflict");
        assert.equal(r.body.state, "not_promotable");
        assert.equal(r.body.storyVisibility, vis);
        assert.equal(r.body.highlightVisibility, null);
        assert.equal(typeof r.body.reason, "string");
        assert.equal(typeof r.body.message, "string");
        assert.deepEqual([...r.body.promotableStoryVisibilities].sort(), ["circle_only", "public"]);
        assert.equal(app.state.highlights.length, 0, "no Highlight may exist for a refused Story");
        assert.equal(app.state.writes.length, 0, "no write of any kind");
        assert.equal(JSON.stringify(app.state.stories[0]), before, "the Story is preserved byte for byte");
      } finally { await app.close(); }
    });
  }

  it("the legacy close_friends_only=true refuses even when visibility says public", async () => {
    const app = await startApp({ visibility: "public", close_friends_only: true });
    try {
      const r = await save(app.baseUrl, "owner-tok");
      assert.equal(r.status, 409);
      assert.equal(r.body.reason, "close_friends_audience");
      assert.equal(app.state.highlights.length, 0);
    } finally { await app.close(); }
  });

  it("a public Story with a hide list refuses", async () => {
    const app = await startApp({ visibility: "public", hidden_user_ids: [OTHER] });
    try {
      const r = await save(app.baseUrl, "owner-tok");
      assert.equal(r.status, 409);
      assert.equal(r.body.reason, "hidden_list_unsupported");
      assert.equal(app.state.highlights.length, 0);
    } finally { await app.close(); }
  });

  it("a non-owner is still 403 before any audience reasoning", async () => {
    const app = await startApp({ visibility: "close_friends" });
    try {
      const r = await save(app.baseUrl, "other-tok");
      assert.equal(r.status, 403);
      assert.equal(app.state.writes.length, 0);
    } finally { await app.close(); }
  });

  it("an already-saved Story short-circuits to its existing highlight id, whatever its visibility", async () => {
    const app = await startApp({ visibility: "close_friends", saved_to_highlight_id: "hl-existing" });
    try {
      const r = await save(app.baseUrl, "owner-tok");
      assert.equal(r.status, 200);
      assert.equal(r.body.highlightId, "hl-existing");
      assert.equal(app.state.writes.length, 0);
    } finally { await app.close(); }
  });
});
