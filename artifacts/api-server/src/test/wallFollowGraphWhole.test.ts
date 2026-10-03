/**
 * census-wall §19 — the Wall reads the WHOLE follow graph, and the Following
 * spine reads every followed author it claims to have read.
 *
 * ── THE DEFECTS ──────────────────────────────────────────────────────────────
 * 1. `loadViewerContext` read `user_follows` with no range. PostgREST cuts any
 *    response at `db-max-rows` (Supabase ships 1,000) and says nothing, so a
 *    viewer who follows 1,234 people was handed 1,000 of them with
 *    `followGraphKnown: true` — a partial graph presented as the whole one.
 * 2. `loadCandidates` then read posts `.in("author_id", followed.slice(0, 500))`
 *    — the first 500 followed authors only — and derived
 *    `followingReachedEnd` from that one capped read. A viewer following 700
 *    people never saw authors 501–700 in Following, and was told
 *    "you're all caught up" about people the server never asked about.
 *
 * ── THE FIX UNDER TEST ───────────────────────────────────────────────────────
 * The graph is keyset-paged on `following_id` until a short page; past a
 * stated bound it is reported NOT known (so caughtUp is withheld) while every
 * follow that was read is still served. The spine reads the followed set in
 * chunks, merges newest-first, and claims the end only when no chunk was cut,
 * the merge cut nothing, and no followed author was left unread.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/wallFollowGraphWhole.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeFailClosedClient, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import {
  loadViewerContext,
  loadCandidates,
  FOLLOW_GRAPH_MAX_ROWS,
  SPINE_AUTHOR_CHUNK,
  SPINE_MAX_AUTHORS,
  type WallViewerContext,
} from "../routes/wall.js";

const VIEWER = "50000000-0000-4000-a000-000000000000";
/** PostgREST's `db-max-rows` as Supabase ships it. */
const DB_MAX_ROWS = 1000;

/** Zero-padded so string order (what `.gt` / `.order` compare) is numeric order. */
const author = (i: number) => `a-${String(i).padStart(6, "0")}`;

/**
 * The fake client with PostgREST's silent row cap put back: every read that
 * returns a list is cut at `cap` rows, whatever `.limit()` asked for, and the
 * response does not say so. Exactly the behaviour the defect hid behind.
 */
function withDbMaxRows(client: any, cap = DB_MAX_ROWS): any {
  const wrap = (builder: any): any => {
    const proxy: any = new Proxy(builder, {
      get(target, prop) {
        if (prop === "then") {
          return (onF: any, onR: any) =>
            target.then((r: any) => {
              const capped = r && Array.isArray(r.data) && r.data.length > cap
                ? { ...r, data: r.data.slice(0, cap) }
                : r;
              return onF ? onF(capped) : capped;
            }, onR);
        }
        const v = target[prop];
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          const out = v.apply(target, args);
          return out === target ? proxy : out;
        };
      },
    });
    return proxy;
  };
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "from") return (table: string) => wrap(target.from(table));
      return target[prop];
    },
  });
}

function follows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ follower_id: VIEWER, following_id: author(i) }));
}

function viewerClient(n: number, failOn?: (ctx: FakeReadContext) => any) {
  return withDbMaxRows(
    makeFailClosedClient({
      rows: {
        user_follows: follows(n),
        profiles: [{ id: VIEWER, current_city: null, home_city: null, interests: [] }],
        trip_members: [],
        trips: [],
      },
      failOn,
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The follow graph
// ─────────────────────────────────────────────────────────────────────────────

describe("census-wall §19 — loadViewerContext reads the WHOLE follow graph", () => {
  it("CONTROL: the fake really does cut a range-less read at 1,000 rows", async () => {
    const sc = viewerClient(1234);
    const { data } = await sc.from("user_follows").select("following_id").eq("follower_id", VIEWER);
    assert.equal(data.length, DB_MAX_ROWS, "vacuity guard: without the cap this file proves nothing");
  });

  it("a viewer following 1,234 people gets all 1,234, and the graph is KNOWN", async () => {
    const ctx = await loadViewerContext(viewerClient(1234), VIEWER);
    assert.equal(ctx.followedCreatorIds.size, 1234, "every follow past the 1,000-row cut must be read");
    assert.ok(ctx.followedCreatorIds.has(author(1233)), "the last follow is in the set");
    assert.equal(ctx.followGraphKnown, true);
  });

  it("exactly 1,000 follows (a FULL first page) is still read to the end and KNOWN", async () => {
    const ctx = await loadViewerContext(viewerClient(1000), VIEWER);
    assert.equal(ctx.followedCreatorIds.size, 1000);
    assert.equal(ctx.followGraphKnown, true, "a full page is not evidence of more — the next page answers that");
  });

  it("a graph LARGER than the bounded read is served as far as it was read, and NOT claimed known", async () => {
    const n = FOLLOW_GRAPH_MAX_ROWS + 1;
    const ctx = await loadViewerContext(viewerClient(n), VIEWER);
    assert.equal(ctx.followedCreatorIds.size, FOLLOW_GRAPH_MAX_ROWS, "what was read is still used");
    assert.equal(ctx.followGraphKnown, false, "…but Following must not claim caughtUp over the unread rest");
  });

  it("a graph of exactly the bound is KNOWN (the bound is inclusive)", async () => {
    const ctx = await loadViewerContext(viewerClient(FOLLOW_GRAPH_MAX_ROWS), VIEWER);
    assert.equal(ctx.followedCreatorIds.size, FOLLOW_GRAPH_MAX_ROWS);
    assert.equal(ctx.followGraphKnown, true);
  });

  it("a LATER page that fails keeps what was read and marks the graph UNKNOWN", async () => {
    // Fail only the second page: the one filtered `following_id > <last of page 1>`.
    const failSecondPage = (ctx: FakeReadContext) =>
      ctx.table === "user_follows" && ctx.filters.some((f) => f.col === "following_id" && f.op === "gt")
        ? { message: "connection terminated unexpectedly", code: "57P01" }
        : null;
    const ctx = await loadViewerContext(viewerClient(1234, failSecondPage), VIEWER);
    assert.equal(ctx.followGraphKnown, false, "a graph with an unread tail is not known");
    assert.equal(ctx.followedCreatorIds.size, DB_MAX_ROWS, "the first page's follows are still served");
  });

  it("a FIRST page that fails is still UNKNOWN and empty (the existing contract)", async () => {
    const failAll = (ctx: FakeReadContext) =>
      ctx.table === "user_follows" ? { message: "user_follows unavailable", code: "57P01" } : null;
    const ctx = await loadViewerContext(viewerClient(10, failAll), VIEWER);
    assert.equal(ctx.followGraphKnown, false);
    assert.equal(ctx.followedCreatorIds.size, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The Following spine
// ─────────────────────────────────────────────────────────────────────────────

const BASE_MS = Date.parse("2026-09-01T12:00:00.000Z");

function post(i: number, authorIdx: number, minutesAgo: number) {
  const at = new Date(BASE_MS - minutesAgo * 60_000).toISOString();
  return {
    id: `p-${String(i).padStart(6, "0")}`,
    author_id: author(authorIdx),
    trip_id: null,
    content: `post ${i}`,
    visibility: "public",
    status: "active",
    post_status: "published",
    created_at: at,
    published_at: at,
    canonical_place_id: null,
    has_video: false,
    media_count: 0,
    category: null,
    location_city: null,
    location_country: null,
    like_count: 0,
    comment_count: 0,
    save_count: 0,
  };
}

function viewerOf(nFollowed: number): WallViewerContext {
  return {
    followedCreatorIds: new Set(Array.from({ length: nFollowed }, (_, i) => author(i))),
    followGraphKnown: true,
    viewerTripIds: new Set(),
    currentCity: null,
    currentCountry: null,
    mutualFollowedAuthorIds: new Set(),
    upcomingTripCities: new Set(),
    preferredCities: new Set(),
    interests: new Set(),
  };
}

function spineClient(posts: Record<string, any>[]) {
  return withDbMaxRows(makeFailClosedClient({ rows: { posts, profiles: [], places: [], hidden_gems: [] } }));
}

const ids = (loaded: { candidates: { canonicalObjectId: string }[] }) =>
  new Set(loaded.candidates.map((c) => c.canonicalObjectId));

describe("census-wall §19 — the Following spine reads every followed author", () => {
  it("CONTROL: a small graph behaves exactly as before — one read, true end", async () => {
    const posts = [post(1, 0, 1), post(2, 1, 2)];
    const loaded = await loadCandidates(spineClient(posts), "following", viewerOf(3), { discoveryEnabled: false });
    assert.deepEqual([...ids(loaded)].sort(), ["p-000001", "p-000002"]);
    assert.equal(loaded.followingReachedEnd, true);
  });

  it("a post by followed author #650 reaches Following (it sat past the old 500-author slice)", async () => {
    const posts = [post(1, 650, 1), post(2, 3, 2)];
    const loaded = await loadCandidates(spineClient(posts), "following", viewerOf(700), { discoveryEnabled: false });
    assert.ok(ids(loaded).has("p-000001"), "author #650's post must be read");
    assert.equal(loaded.followingReachedEnd, true, "every author was read and nothing was cut");
  });

  it("two chunks that are each short but together over the window: newest kept, end NOT claimed", async () => {
    // 100 posts from an author in chunk 1, 100 from an author in chunk 2,
    // interleaved in time. Each chunk returns < CANDIDATE_FETCH (150), but the
    // merge holds 200 and must cut to the newest 150.
    const posts: any[] = [];
    for (let i = 0; i < 200; i++) posts.push(post(i, i % 2 === 0 ? 10 : 600, i));
    const loaded = await loadCandidates(spineClient(posts), "following", viewerOf(700), { discoveryEnabled: false });
    const got = ids(loaded);
    assert.equal(got.size, 150, "the merged window is still CANDIDATE_FETCH");
    for (let i = 0; i < 150; i++) assert.ok(got.has(post(i, 0, 0).id), `the newest 150 are kept (missing #${i})`);
    assert.equal(loaded.followingReachedEnd, false, "the merge cut 50 older posts — that is not the end");
  });

  it("a followed set larger than the spine's bound never claims the end", async () => {
    const posts = [post(1, 0, 1)];
    const loaded = await loadCandidates(
      spineClient(posts),
      "following",
      viewerOf(SPINE_MAX_AUTHORS + 1),
      { discoveryEnabled: false },
    );
    assert.ok(ids(loaded).has("p-000001"));
    assert.equal(loaded.followingReachedEnd, false, "an author the spine did not ask about may have posted");
  });

  it("one failed chunk fails the spine — it does not quietly drop that chunk's authors", async () => {
    const posts = [post(1, 0, 1), post(2, 650, 2)];
    const failSecondChunk = (ctx: FakeReadContext) => {
      if (ctx.table !== "posts") return null;
      const inF = ctx.filters.find((f) => f.col === "author_id" && f.op === "in");
      return inF && (inF.val as string[]).includes(author(SPINE_AUTHOR_CHUNK))
        ? { message: "statement timeout", code: "57014" }
        : null;
    };
    const sc = withDbMaxRows(
      makeFailClosedClient({ rows: { posts, profiles: [], places: [], hidden_gems: [] }, failOn: failSecondChunk }),
    );
    const loaded = await loadCandidates(sc, "following", viewerOf(700), { discoveryEnabled: false });
    assert.equal(loaded.spineFailed, true, "a partial spine is a failed spine");
    assert.equal(loaded.followingReachedEnd, false);
  });

  it("every chunk's author list stays within the chunk size", async () => {
    const seen: number[] = [];
    const record = (ctx: FakeReadContext) => {
      if (ctx.table === "posts") {
        const inF = ctx.filters.find((f) => f.col === "author_id" && f.op === "in");
        if (inF) seen.push((inF.val as unknown[]).length);
      }
      return null;
    };
    const sc = withDbMaxRows(makeFailClosedClient({ rows: { posts: [], profiles: [], places: [] }, failOn: record }));
    await loadCandidates(sc, "following", viewerOf(1200), { discoveryEnabled: false });
    assert.deepEqual(seen.sort((a, b) => b - a), [SPINE_AUTHOR_CHUNK, SPINE_AUTHOR_CHUNK, 1200 - 2 * SPINE_AUTHOR_CHUNK]);
  });
});
