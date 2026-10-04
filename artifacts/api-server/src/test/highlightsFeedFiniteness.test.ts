/**
 * §12 — "Highlights should remain finite and contextual. Do not turn the
 * surface into an endless feed."
 *
 * GET /highlights/following-feed had no `.limit()` and no cursor: it returned
 * every active highlight of every user the viewer follows in a single response.
 * Its only bound was the 24-hour expiry, which is a bound on AGE, not on SIZE.
 * Every sibling read is bounded — /highlights/active caps at 100, the memories
 * discovery feed caps at 100 — so this was an omission rather than a design.
 *
 * WHY THE FIX IS BEHIND A FLAG, AND WHY THAT IS TESTED IN BOTH POSITIONS
 * ---------------------------------------------------------------------
 * Capping a feed that is uncapped today can only REMOVE highlights from
 * somebody's screen, and §12 says "finite" without saying how many. So the cap
 * ships behind `highlights_feed_bounded_enabled` (migration 2339), seeded
 * FALSE. The OFF assertions below are the ones that matter operationally: they
 * are what says the flag genuinely leaves production alone.
 *
 * Run: node --import tsx/esm --test src/test/highlightsFeedFiniteness.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";

const VIEWER = "11111111-1111-1111-1111-111111111111";
const OWNER  = "22222222-2222-2222-2222-222222222222";

const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

/** 150 active public highlights from one followed user. */
function highlights(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    owner_id: OWNER,
    media_url: `https://example.com/${i}.jpg`,
    media_type: "image/jpeg",
    video_duration_seconds: null,
    caption: null,
    location_name: null, location_city: null, location_country: null,
    visibility: "public",
    expires_at: FUTURE,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    deleted_at: null,
  }));
}

function makeFakeClient(rows: any[], flagOn: boolean) {
  function chain(table: string) {
    let limitN: number | null = null;
    let head = false;
    // The page cursor. Honoured (rather than ignored like the other filters)
    // because the cursor walk below is only evidence if `?cursor=` really moves
    // the window: `created_at > cursor`, applied BEFORE the limit, as PostgREST
    // applies it. Rows are built in ascending created_at order, the route's
    // order, and toISOString() makes string order equal time order.
    let createdAfter: string | null = null;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return obj; },
      insert() { return obj; }, update() { return obj; }, upsert() { return obj; }, delete() { return obj; },
      eq() { return obj; }, neq() { return obj; }, in() { return obj; },
      lt() { return obj; },
      gt(col: string, v: string) { if (col === "created_at") createdAfter = v; return obj; },
      is() { return obj; }, not() { return obj; },
      // `.or()` is how the feed asks for "not expired OR permanent" since
      // migration 2975 made `expires_at` nullable. A fake without it makes the
      // handler throw, which arrives as a 500 and reads exactly like a broken
      // feed — this method is a no-op for the same reason `eq` is: this suite
      // is about page SIZE, and every row the fake holds is unexpired.
      or() { return obj; },
      order() { return obj; },
      limit(n: number) { limitN = n; return obj; },
      maybeSingle() { return resolve(true); },
      single() { return resolve(true); },
      then(f: any, r: any) { return resolve(false).then(f, r); },
    };
    async function resolve(single: boolean): Promise<any> {
      if (table === "highlights") {
        const windowed = createdAfter != null ? rows.filter((r) => r.created_at > createdAfter!) : rows;
        const out = limitN != null ? windowed.slice(0, limitN) : windowed;
        return { data: single ? (out[0] ?? null) : out, error: null, count: out.length };
      }
      if (table === "blocks") return { data: single ? null : [], error: null, count: 0 };
      if (table === "user_follows") {
        return { data: single ? { following_id: OWNER } : [{ following_id: OWNER }], error: null, count: 1 };
      }
      if (table === "profiles") {
        return {
          data: single
            ? { id: OWNER, account_status: "active", name: "Owner", handle: "owner", avatar_url: null }
            : [{ id: OWNER, name: "Owner", handle: "owner", avatar_url: null }],
          error: null, count: 1,
        };
      }
      if (table === "feature_flags") {
        return {
          data: single ? (flagOn ? { enabled: true } : { enabled: false }) : [],
          error: null, count: null,
        };
      }
      return { data: single ? null : [], error: null, count: head ? 0 : 0 };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    auth: { getUser: async () => ({ data: { user: { id: VIEWER } }, error: null }) },
  };
}

async function startApp(rows: any[], flagOn: boolean) {
  _setTestClient(makeFakeClient(rows, flagOn) as any, true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; n(); });
  app.use("/api", highlightsRouter);
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

/**
 * The following-feed response. `nextCursor` is OPTIONAL in the type for the
 * same reason it is optional in the route: an unbounded response does not carry
 * the key at all, and one of the assertions below is precisely that it does not.
 */
interface FeedUser { userId: string; highlights: unknown[] }
interface FeedBody { users?: FeedUser[]; nextCursor?: string | null }

async function feed(base: string, qs = ""): Promise<{ status: number; body: FeedBody | null }> {
  const res = await fetch(`${base}/api/highlights/following-feed${qs}`, {
    headers: { connection: "close", Authorization: "Bearer tok" },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as FeedBody | null };
}

const total = (b: FeedBody | null) =>
  (b?.users ?? []).reduce((n: number, u: FeedUser) => n + u.highlights.length, 0);

describe("GET /highlights/following-feed — §12 finiteness", () => {
  it("is unbounded with the flag OFF, exactly as before migration 2339", async () => {
    const app = await startApp(highlights(150), false);
    try {
      const { status, body } = await feed(app.baseUrl);
      assert.equal(status, 200);
      assert.equal(total(body), 150, "the flag being off must change nothing about the response");
      assert.ok(!Object.prototype.hasOwnProperty.call(body ?? {}, "nextCursor"),
        "an unbounded response keeps its pre-2339 shape");
    } finally { await app.close(); }
  });

  it("caps the page at the default with the flag ON", async () => {
    const app = await startApp(highlights(150), true);
    try {
      const { status, body } = await feed(app.baseUrl);
      assert.equal(status, 200);
      assert.equal(total(body), 60, "the default page is finite");
      assert.ok(body?.nextCursor, "a full page must offer a cursor so nothing is unreachable");
    } finally { await app.close(); }
  });

  it("honours an explicit smaller limit", async () => {
    const app = await startApp(highlights(150), true);
    try {
      const { body } = await feed(app.baseUrl, "?limit=5");
      assert.equal(total(body), 5);
      assert.ok(body?.nextCursor);
    } finally { await app.close(); }
  });

  it("clamps an oversized limit rather than honouring it", async () => {
    const app = await startApp(highlights(150), true);
    try {
      const { body } = await feed(app.baseUrl, "?limit=100000");
      assert.equal(total(body), 150, "150 is all there is; the point is the request did not become unbounded");
    } finally { await app.close(); }
  });

  it("omits nextCursor on a partial page — there is nothing further to fetch", async () => {
    const app = await startApp(highlights(3), true);
    try {
      const { body } = await feed(app.baseUrl);
      assert.equal(total(body), 3);
      assert.equal(body?.nextCursor, null);
    } finally { await app.close(); }
  });

  it("rejects nothing and truncates nothing when a garbage limit is sent", async () => {
    const app = await startApp(highlights(150), true);
    try {
      const { status, body } = await feed(app.baseUrl, "?limit=abc");
      assert.equal(status, 200);
      assert.equal(total(body), 60, "an unparseable limit falls back to the default, not to 0 or to unbounded");
    } finally { await app.close(); }
  });
});

/**
 * A page the viewer's FILTERS shrank is not the end of the feed.
 *
 * With the cap on, the route reads `limit * 5` raw rows, then removes what this
 * viewer may not see (circle_only / trip_only without the relationship, §11
 * resurfacing controls, §10 consent) and cuts the page. It used to emit
 * `nextCursor` only when the CUT page was full, so a raw window that filtering
 * shrank below `limit` ended the feed with `nextCursor: null` — and a window
 * filtering emptied returned `{ users: [] }` with no cursor at all. Either way
 * every visible highlight after that window was unreachable, and a client that
 * follows the cursor (the only honest way to read a capped feed) was told the
 * feed was complete. The window is the unit the server examined, so the cursor
 * continues from the last row it examined whenever that window was full.
 *
 * The fake withholds every circle_only row (no circle_memberships), which is the
 * filter these tests use to shrink a window.
 */
describe("GET /highlights/following-feed — the cursor walk reaches every visible highlight", () => {
  /** Rows in ascending created_at with the given visibilities, in order. */
  function rowsWith(visibilities: string[]) {
    return visibilities.map((v, i) => ({ ...highlights(visibilities.length)[i], visibility: v }));
  }

  /** Follow `nextCursor` until the server says there is nothing further. */
  async function walk(base: string, limit: number): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = `?limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const { status, body } = await feed(base, qs);
      assert.equal(status, 200);
      for (const u of body?.users ?? []) for (const h of u.highlights as Array<{ id: string }>) ids.push(h.id);
      const next: string | null = body?.nextCursor ?? null;
      assert.notEqual(next, cursor, "a cursor that does not advance would loop forever");
      cursor = next;
      pages += 1;
      assert.ok(pages <= 50, "the walk must terminate");
    } while (cursor);
    return { ids, pages };
  }

  it("continues past a raw window that filtering EMPTIED", async () => {
    // limit 5 → raw window 25: all 25 circle_only (withheld), then 10 public.
    const rows = rowsWith([...Array(25).fill("circle_only"), ...Array(10).fill("public")]);
    const app = await startApp(rows, true);
    try {
      const first = await feed(app.baseUrl, "?limit=5");
      assert.equal(first.status, 200);
      assert.equal(total(first.body), 0, "nothing in the first window is visible to this viewer");
      assert.equal(first.body?.nextCursor, rows[24].created_at,
        "the window was full, so the feed continues after the last row the server examined");

      const { ids } = await walk(app.baseUrl, 5);
      assert.deepEqual(ids, rows.slice(25).map((r) => r.id), "every public highlight, each exactly once, in order");
    } finally { await app.close(); }
  });

  it("continues past a raw window that filtering SHRANK below the page size", async () => {
    // 2 public, 23 circle_only (window of 25 full, 2 visible), then 10 public.
    const rows = rowsWith(["public", "public", ...Array(23).fill("circle_only"), ...Array(10).fill("public")]);
    const app = await startApp(rows, true);
    try {
      const first = await feed(app.baseUrl, "?limit=5");
      assert.equal(total(first.body), 2);
      assert.equal(first.body?.nextCursor, rows[24].created_at,
        "a short page cut from a FULL window is not the end of the feed");

      const { ids } = await walk(app.baseUrl, 5);
      const visible = rows.filter((r) => r.visibility === "public").map((r) => r.id);
      assert.equal(ids.length, 12);
      assert.deepEqual(ids, visible, "every public highlight, each exactly once, in order");
    } finally { await app.close(); }
  });

  it("still ends the feed when the raw window was NOT full", async () => {
    // 3 circle_only + 2 public: the window (25) is not full, so nothing lies beyond it.
    const rows = rowsWith(["circle_only", "circle_only", "circle_only", "public", "public"]);
    const app = await startApp(rows, true);
    try {
      const { body } = await feed(app.baseUrl, "?limit=5");
      assert.equal(total(body), 2);
      assert.equal(body?.nextCursor, null, "a window that was not full is everything there is");
    } finally { await app.close(); }
  });

  it("ends the feed on an emptied window that was NOT full", async () => {
    const rows = rowsWith(["circle_only", "circle_only"]);
    const app = await startApp(rows, true);
    try {
      const { status, body } = await feed(app.baseUrl, "?limit=5");
      assert.equal(status, 200);
      assert.equal(total(body), 0);
      assert.equal(body?.nextCursor ?? null, null, "nothing lies beyond a window that was not full");
    } finally { await app.close(); }
  });

  it("leaves the unbounded (flag OFF) response shape alone when everything is filtered", async () => {
    const rows = rowsWith(["circle_only", "circle_only"]);
    const app = await startApp(rows, false);
    try {
      const { body } = await feed(app.baseUrl);
      assert.equal(total(body), 0);
      assert.ok(!Object.prototype.hasOwnProperty.call(body ?? {}, "nextCursor"),
        "an unbounded response keeps its pre-2339 shape");
    } finally { await app.close(); }
  });

  it("walks a feed with nothing filtered in full pages, each highlight once", async () => {
    const rows = highlights(23);
    const app = await startApp(rows, true);
    try {
      const { ids, pages } = await walk(app.baseUrl, 5);
      assert.deepEqual(ids, rows.map((r) => r.id));
      assert.ok(pages >= 5, "23 rows at 5 per page take at least five pages");
    } finally { await app.close(); }
  });
});
