/**
 * Video playback (owner-reported 2026-10-24) — lib/media/storageBackedPostMedia.ts
 * and its wiring into routes/posts.ts.
 *
 * Production, read 2026-10-24: every post with uploaded media since 2026-08-16
 * (4 of 4) carries its upload's bare key in `posts.media_urls` and has NO
 * `post_media` row, so the read side served `media: []` and the client never
 * mounted a video player for `e4bbf335`'s `.mov`.
 *
 *   U1–U6  the module: refs, kind, synthesis, the fallback's guards, the create plan, the row insert
 *   R1     GET /posts/:id on e4bbf335's exact production shape ⇒ a video item, with its poster
 *   R2     an unreadable post_media read stays `media: null` (census-media §47)
 *   R3     ISOLATION: a viewer who cannot see the post gets 404 and no media; a post's items name only its own refs
 *   R4     a post with ANY post_media row (even rejected) is never synthesized for
 *   R5     the feeds, pending and a mutation response carry the synthesized items
 *   R6     POST /posts writes the upload as a post_media row, keeps media_urls external-only, and answers with media
 *   R7     POST /posts refuses another user's key, a moderated key and an unreadable ledger, writing nothing
 *   R8     POST /posts: a failed row write removes the post and answers an error (never a 201)
 *   R9     PATCH /posts/:id refuses an upload key (after the D-82 hold), writing nothing
 *   R10    withPostMedia (pending, mutations): an unreadable read is null, not the old fail-open []
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import postsRouter from "../routes/posts.js";
import { _resetStampOverlayColCache } from "../lib/postMediaOverlay.js";
import {
  storageBackedRefs, mediaKindForPath, synthesizeMediaItems, mediaUrlsFallback, projectedMedia,
  planPostMediaUploads, insertUploadRows, presentPosters, MAX_POSTER_LOOKUPS,
} from "../lib/media/storageBackedPostMedia.js";

type Row = Record<string, any>;

const AUTHOR = "d47c09d6-0000-4000-8000-00000000a001";
const VIEWER = "d47c09d6-0000-4000-8000-00000000b002";
const POST = "e4bbf335-0000-4000-8000-000000000001"; // e4bbf335's shape, below
const NEW_POST = "e4bbf335-0000-4000-8000-0000000000ff";
const MOV_KEY = `${AUTHOR}/1792727980484.mov`;
const MOV_REF = `post-media/${MOV_KEY}`;
const POSTER_KEY = `${MOV_KEY}.poster.jpg`;

/** e4bbf335 as production holds it (2026-10-24): one .mov in media_urls, no post_media row, no summary columns. */
function e4bbf335(over: Row = {}): Row {
  return {
    id: POST, author_id: AUTHOR, trip_id: null, content: "camera video", media_urls: [MOV_REF],
    media_type: "video/quicktime", primary_media_type: null, has_video: false, media_count: 0, media_thumbnail_url: null,
    visibility: "public", status: "active", post_status: "published", location_privacy_mode: "delayed_until_exit",
    published_at: "2026-10-23T04:00:00Z", created_at: "2026-10-23T03:59:50Z", updated_at: "2026-10-23T03:59:50Z",
    category: "activity", ...over,
  };
}

interface World {
  posts: Row[];
  post_media: Row[];
  ledger?: Row[];
  trips?: Row[];
  user_follows?: Row[];
  objects?: Set<string>;
  failRead?: Set<string>;
  failInsert?: Set<string>;
  failDelete?: Set<string>;
  storageFails?: boolean;
  inserted: Array<{ table: string; row: any }>;
  updated: Array<{ table: string; patch: any }>;
  deleted: Array<{ table: string; eqs: Row }>;
}

function world(over: Partial<World> = {}): World {
  return { posts: [], post_media: [], ledger: [], objects: new Set(), inserted: [], updated: [], deleted: [], ...over };
}

function fake(w: World): any {
  const users: Record<string, string> = { "tok-author": AUTHOR, "tok-viewer": VIEWER };
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const eqs: Row = {};
    let mode: "read" | "insert" | "update" | "delete" | "upsert" = "read";
    let payload: any = null;
    let single = false;
    const b: any = {
      select() { return b; },
      insert(p: any) { mode = "insert"; payload = p; return b; },
      upsert(p: any) { mode = "upsert"; payload = p; return b; },
      update(p: any) { mode = "update"; payload = p; return b; },
      delete() { mode = "delete"; return b; },
      eq(c: string, v: any) { eqs[c] = v; filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return b; },
      gte() { return b; }, lt() { return b; }, lte() { return b; }, not() { return b; }, or() { return b; },
      ilike() { return b; }, overlaps() { return b; }, contains() { return b; }, filter() { return b; }, match() { return b; },
      order() { return b; }, limit() { return b; }, range() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(f: any, r: any) { return run().then(f, r); },
    };
    function source(): Row[] {
      if (table === "posts") return w.posts;
      if (table === "post_media") return w.post_media;
      if (table === "post_media_moderation_ledger") return w.ledger ?? [];
      if (table === "trips") return w.trips ?? [];
      if (table === "user_follows") return w.user_follows ?? [];
      return [];
    }
    async function run(): Promise<any> {
      if (mode === "insert" || mode === "upsert") {
        if (w.failInsert?.has(table)) return { data: null, error: { code: "57P01", message: "terminating connection" } };
        const rows = Array.isArray(payload) ? payload : [payload];
        const made = rows.map((r: Row) => ({ ...(table === "posts" ? { id: NEW_POST } : { id: `${table}-${w.inserted.length}` }), ...r }));
        for (const r of made) { w.inserted.push({ table, row: r }); if (table === "posts") w.posts.push(r); if (table === "post_media") w.post_media.push(r); }
        return { data: single ? made[0] : made, error: null };
      }
      if (mode === "update") {
        w.updated.push({ table, patch: payload });
        const hit = source().filter((r) => filters.every((f) => f(r)));
        for (const r of hit) Object.assign(r, payload);
        return { data: single ? hit[0] ?? null : hit, error: null };
      }
      if (mode === "delete") {
        if (w.failDelete?.has(table)) return { data: null, error: { code: "57P01", message: "terminating connection" } };
        w.deleted.push({ table, eqs: { ...eqs } });
        const src = source();
        for (let i = src.length - 1; i >= 0; i--) if (filters.every((f) => f(src[i]!))) src.splice(i, 1);
        return { data: null, error: null };
      }
      if (w.failRead?.has(table)) return { data: null, error: { code: "57014", message: "statement timeout" } };
      const hit = source().filter((r) => filters.every((f) => f(r)));
      return single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null, count: hit.length };
    }
    return b;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: { getUser: async (t: string) => (users[t] ? { data: { user: { id: users[t] } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) },
    storage: {
      from: () => ({
        list: async (folder: string, opts?: { search?: string }) => {
          if (w.storageFails) return { data: null, error: { message: "storage down" } };
          const names = [...(w.objects ?? [])].filter((k) => k.startsWith(`${folder}/`)).map((k) => k.slice(folder.length + 1)).filter((n) => !n.includes("/"));
          return { data: names.filter((n) => !opts?.search || n.includes(opts.search)).map((name) => ({ name })), error: null };
        },
        upload: async () => ({ error: null }),
      }),
    },
  };
}

async function serve(w: World): Promise<{ base: string; close: () => Promise<void> }> {
  _resetStampOverlayColCache();
  _setTestClient(fake(w), true);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error: () => {}, info: () => {}, warn: () => {} }; next(); });
  app.use("/api", postsRouter);
  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) });
    });
  });
}

async function call(base: string, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const presence = (keys: Set<string>, fail = false) => async (p: string) => (fail ? "error" as const : keys.has(p) ? "present" as const : "absent" as const);

describe("U — the module", () => {
  it("U1 storage-backed refs: every app-storage spelling of a post-media object, in order, deduplicated; external and other buckets are not", () => {
    const refs = storageBackedRefs([
      "https://images.example.com/x.jpg", MOV_REF, `/api/media/file/post-media/${AUTHOR}/b.jpg`, MOV_REF,
      `profile-media/${AUTHOR}/avatar.jpg`, 7 as any,
    ]);
    assert.deepEqual(refs.map((r) => [r.bareKey, r.ord]), [[MOV_REF, 1], [`post-media/${AUTHOR}/b.jpg`, 2]]);
  });

  it("U2 kind: extension first (the client's videoPosterRef set plus 3gp), then the post's declared type", () => {
    assert.equal(mediaKindForPath("a/b.MOV"), "video");
    assert.equal(mediaKindForPath("a/b.m4v"), "video");
    assert.equal(mediaKindForPath("a/b.jpg", "video/quicktime"), "image", "a known image extension wins over the post's type");
    assert.equal(mediaKindForPath("a/b.bin", "video/quicktime"), "video");
    assert.equal(mediaKindForPath("a/b.bin", null, "video"), "video");
    assert.equal(mediaKindForPath("a/b.bin"), "image");
  });

  it("U3 synthesis: a video item names its poster only when the poster exists", async () => {
    const posters = await presentPosters(presence(new Set([POSTER_KEY])), [MOV_KEY]);
    const [item] = synthesizeMediaItems(e4bbf335(), posters);
    assert.deepEqual(item, {
      id: null, source: "media_urls", media_type: "video", url: MOV_REF, feed_url: null,
      thumbnail_url: `post-media/${POSTER_KEY}`, duration_seconds: null, width: null, height: null,
      sort_order: 0, processing_status: "ready", stamp_overlay: null,
    });
    assert.equal(synthesizeMediaItems(e4bbf335(), await presentPosters(presence(new Set()), [MOV_KEY]))[0]!.thumbnail_url, null, "absent poster ⇒ null");
    assert.equal(synthesizeMediaItems(e4bbf335(), await presentPosters(presence(new Set([POSTER_KEY]), true), [MOV_KEY]))[0]!.thumbnail_url, null, "unknown poster ⇒ null, never invented");
    const many = Array.from({ length: MAX_POSTER_LOOKUPS + 3 }, (_, i) => `${AUTHOR}/${i}.mov`);
    const answered = await presentPosters(presence(new Set(many.map((m) => `${m}.poster.jpg`))), many);
    assert.equal(answered.size, MAX_POSTER_LOOKUPS, "the listing is capped; the rest are null");
  });

  it("U4 the fallback's guards: unread ⇒ nothing; external-only ⇒ nothing; a post with ANY row ⇒ nothing; existence unreadable ⇒ null", async () => {
    const posts = [e4bbf335(), { id: "ext", media_urls: ["https://images.example.com/x.jpg"] }];
    const w = world({ objects: new Set([POSTER_KEY]) });
    assert.equal((await mediaUrlsFallback(fake(w), posts, {}, true)).size, 0, "the route's own read failed: it answers null itself");
    const ok = await mediaUrlsFallback(fake(w), posts, {}, false, { presence: presence(new Set([POSTER_KEY])) });
    assert.deepEqual([...ok.keys()], [POST], "only the post with a storage-backed ref");
    assert.equal((ok.get(POST) as any[])[0].media_type, "video");
    const withRejected = world({ post_media: [{ post_id: POST, moderation_status: "rejected", processing_status: "ready" }] });
    assert.equal((await mediaUrlsFallback(fake(withRejected), posts, {}, false)).has(POST), false, "a row moderated away never comes back through media_urls");
    const unreadable = world({ failRead: new Set(["post_media"]) });
    const u = await mediaUrlsFallback(fake(unreadable), posts, {}, false);
    assert.equal(u.get(POST), null, "an unreadable existence read is unknown (null), not []");
    assert.deepEqual(projectedMedia(POST, u, []), null);
    assert.deepEqual(projectedMedia(POST, new Map(), null), null, "the route's null stays null");
    assert.equal(projectedMedia(POST, ok, null), null, "an unreadable route read stays null even when a fallback exists for the post");
    assert.deepEqual(projectedMedia("other", ok, [{ id: "m" }]), [{ id: "m" }], "rows win where there is no fallback entry");
  });

  it("U5 the create plan: external stays, the author's upload becomes a row; another user's key, a client-writable prefix, an unclean ref and another bucket are refused", () => {
    const plan = planPostMediaUploads(["https://images.example.com/x.jpg", MOV_REF, MOV_REF], AUTHOR, "video/quicktime");
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.deepEqual(plan.external, ["https://images.example.com/x.jpg"]);
    assert.deepEqual(plan.uploads.map((u) => [u.path, u.kind, u.mime]), [[MOV_KEY, "video", "video/quicktime"]]);
    assert.deepEqual(planPostMediaUploads([`post-media/${VIEWER}/x.mov`], AUTHOR), { ok: false, code: "forbidden", message: "You can only attach media you uploaded." });
    assert.equal((planPostMediaUploads([`post-media/memories/${AUTHOR}/x.jpg`], AUTHOR) as any).code, "forbidden");
    assert.equal((planPostMediaUploads(["post-media/a/../b.jpg"], AUTHOR) as any).code, "invalid_payload");
    assert.equal((planPostMediaUploads([`profile-media/${AUTHOR}/a.jpg`], AUTHOR) as any).code, "invalid_payload");
  });

  it("U6 the row insert: ready, pending (2098), the author's, the poster only when it exists; a failed write is reported", async () => {
    const w = world();
    const plan = planPostMediaUploads([MOV_REF], AUTHOR);
    assert.ok(plan.ok);
    if (!plan.ok) return;
    assert.deepEqual(await insertUploadRows(fake(w), NEW_POST, AUTHOR, plan.uploads, { presence: presence(new Set([POSTER_KEY])), durationSeconds: 12.5 }), { ok: true, count: 1 });
    const row = w.post_media[0]!;
    assert.equal(row.post_id, NEW_POST); assert.equal(row.user_id, AUTHOR); assert.equal(row.storage_path, MOV_KEY);
    assert.equal(row.public_url, MOV_REF); assert.equal(row.media_type, "video"); assert.equal(row.mime_type, "video/quicktime");
    assert.equal(row.processing_status, "ready"); assert.equal(row.moderation_status, "pending");
    assert.equal(row.thumbnail_storage_path, POSTER_KEY); assert.equal(row.thumbnail_url, `post-media/${POSTER_KEY}`); assert.equal(row.duration_seconds, 12.5);
    const f = world({ failInsert: new Set(["post_media"]) });
    assert.equal((await insertUploadRows(fake(f), NEW_POST, AUTHOR, plan.uploads, { presence: presence(new Set()) })).ok, false);
  });
});

describe("R — the routes", () => {
  it("R1 GET /posts/:id on e4bbf335's production shape ⇒ media[0] is a video with its poster, marked as from media_urls", async () => {
    const w = world({ posts: [e4bbf335()], objects: new Set([MOV_KEY, POSTER_KEY]) });
    const s = await serve(w);
    try {
      const r = await call(s.base, "GET", `/api/posts/${POST}`, "tok-viewer");
      assert.equal(r.status, 200);
      assert.equal(r.body.media.length, 1);
      assert.deepEqual(
        { type: r.body.media[0].media_type, url: r.body.media[0].url, thumb: r.body.media[0].thumbnail_url, id: r.body.media[0].id, source: r.body.media[0].source },
        { type: "video", url: MOV_REF, thumb: `post-media/${POSTER_KEY}`, id: null, source: "media_urls" },
      );
      assert.equal(r.body.media_type, "video/quicktime", "the post's own declared type now travels with it (the client's fallback)");
      assert.deepEqual(r.body.media_urls, [MOV_REF], "nothing beyond what media_urls already exposed");
    } finally { await s.close(); }
  });

  it("R2 an unreadable post_media read is media: null on the detail, never []", async () => {
    const w = world({ posts: [e4bbf335()], failRead: new Set(["post_media"]) });
    const s = await serve(w);
    try {
      const r = await call(s.base, "GET", `/api/posts/${POST}`, "tok-viewer");
      assert.equal(r.status, 200);
      assert.equal(r.body.media, null);
    } finally { await s.close(); }
  });

  it("R3 ISOLATION: a private post is 404 with no media for another user, and a page's items name only each post's own refs", async () => {
    const w = world({ posts: [e4bbf335({ visibility: "private" })], objects: new Set([POSTER_KEY]) });
    const s = await serve(w);
    try {
      const r = await call(s.base, "GET", `/api/posts/${POST}`, "tok-viewer");
      assert.equal(r.status, 404);
      assert.equal(JSON.stringify(r.body).includes(MOV_KEY), false, "no key of the hidden post reaches the refused viewer");
      const own = await call(s.base, "GET", `/api/posts/${POST}`, "tok-author");
      assert.equal(own.status, 200, "control: the author still reads it");
      assert.equal(own.body.media[0].media_type, "video");
    } finally { await s.close(); }
    const other = { id: "f0000000-0000-4000-8000-000000000002", media_urls: [`post-media/${VIEWER}/z.jpg`] };
    const fb = await mediaUrlsFallback(fake(world()), [e4bbf335(), other], {}, false, { presence: presence(new Set()) });
    assert.deepEqual((fb.get(POST) as any[]).map((m) => m.url), [MOV_REF]);
    assert.deepEqual((fb.get(other.id) as any[]).map((m) => m.url), [`post-media/${VIEWER}/z.jpg`]);
  });

  it("R4 a post with a rejected post_media row is never synthesized for on the detail", async () => {
    const w = world({ posts: [e4bbf335()], post_media: [{ id: "pm1", post_id: POST, media_type: "video", public_url: MOV_REF, processing_status: "ready", moderation_status: "rejected", sort_order: 0 }] });
    const s = await serve(w);
    try {
      const r = await call(s.base, "GET", `/api/posts/${POST}`, "tok-viewer");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.media, [], "moderated away stays away");
    } finally { await s.close(); }
  });

  it("R5 the global feed, the trip feed, pending and a mutation response all carry the synthesized video", async () => {
    const s = await serve(world({ posts: [e4bbf335()], objects: new Set([POSTER_KEY]) }));
    try {
      const feed = await call(s.base, "GET", "/api/posts", "tok-viewer");
      assert.equal(feed.status, 200);
      const p = (feed.body.posts as any[]).find((x) => x.id === POST);
      assert.ok(p, "the post is in the global feed");
      assert.equal(p.media[0].media_type, "video");
    } finally { await s.close(); }
    const TRIP = "70000000-0000-4000-8000-000000000007";
    const s2 = await serve(world({ posts: [e4bbf335({ trip_id: TRIP })], trips: [{ id: TRIP }], objects: new Set([POSTER_KEY]) }));
    try {
      const trip = await call(s2.base, "GET", `/api/trips/${TRIP}/posts`, "tok-viewer");
      assert.equal(trip.status, 200, JSON.stringify(trip.body));
      const p = (trip.body.posts as any[]).find((x) => x.id === POST);
      assert.ok(p, "the public trip post is in the trip feed");
      assert.equal(p.media[0].media_type, "video", "trip feed");
    } finally { await s2.close(); }
    const s4 = await serve(world({ posts: [e4bbf335()], user_follows: [{ follower_id: VIEWER, following_id: AUTHOR }], objects: new Set([POSTER_KEY]) }));
    try {
      const fol = await call(s4.base, "GET", "/api/posts?feed=following", "tok-viewer");
      assert.equal(fol.status, 200, JSON.stringify(fol.body));
      assert.equal(fol.body.feed, "following");
      const p = (fol.body.posts as any[]).find((x) => x.id === POST);
      assert.ok(p, "the followed author's post is in the following feed");
      assert.equal(p.media[0].media_type, "video", "following feed");
    } finally { await s4.close(); }
    const s3 = await serve(world({ posts: [e4bbf335({ post_status: "pending_delay" })], objects: new Set([POSTER_KEY]) }));
    try {
      const pending = await call(s3.base, "GET", "/api/posts/pending", "tok-author");
      assert.equal(pending.status, 200);
      assert.equal(pending.body.posts[0].media[0].media_type, "video", "pending (withPostMedia)");
      const edited = await call(s3.base, "PATCH", `/api/posts/${POST}`, "tok-author", { content: "new caption" });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.media[0].media_type, "video", "a mutation response (withPostMedia)");
    } finally { await s3.close(); }
  });

  it("R6 POST /posts: the upload becomes a post_media row, media_urls keeps only the external ref, and the answer carries media", async () => {
    const w = world({ objects: new Set([POSTER_KEY]) });
    const s = await serve(w);
    try {
      const r = await call(s.base, "POST", "/api/posts", "tok-author", { content: "camera video", visibility: "public", mediaUrls: [MOV_REF, "https://images.example.com/x.jpg"], mediaType: "video/quicktime" });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const post = w.inserted.find((i) => i.table === "posts")!.row;
      assert.deepEqual(post.media_urls, ["https://images.example.com/x.jpg"], "2083: external references only");
      assert.equal(post.media_count, 1); assert.equal(post.has_video, true); assert.equal(post.primary_media_type, "video");
      const rows = w.inserted.filter((i) => i.table === "post_media").map((i) => i.row);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].storage_path, MOV_KEY); assert.equal(rows[0].user_id, AUTHOR); assert.equal(rows[0].post_id, NEW_POST);
      assert.equal(rows[0].thumbnail_storage_path, POSTER_KEY);
      assert.equal(r.body.media[0].media_type, "video", "the create answer renders without a refetch");
    } finally { await s.close(); }
  });

  it("R7 POST /posts refuses another user's key (403), a moderated key (409) and an unreadable ledger (503), and writes nothing", async () => {
    for (const [w, body, status] of [
      [world(), { mediaUrls: [`post-media/${VIEWER}/x.mov`] }, 403],
      [world({ ledger: [{ storage_path: MOV_KEY }] }), { mediaUrls: [MOV_REF] }, 409],
      [world({ failRead: new Set(["post_media_moderation_ledger"]) }), { mediaUrls: [MOV_REF] }, 503],
    ] as Array<[World, Row, number]>) {
      const s = await serve(w);
      try {
        const r = await call(s.base, "POST", "/api/posts", "tok-author", { content: "x", visibility: "public", ...body });
        assert.equal(r.status, status, JSON.stringify(r.body));
        assert.equal(w.inserted.length, 0, "nothing written");
      } finally { await s.close(); }
    }
  });

  it("R8 POST /posts: a failed post_media write removes the post and answers an error — never a 201 with no media", async () => {
    const w = world({ failInsert: new Set(["post_media"]) });
    const s = await serve(w);
    try {
      const r = await call(s.base, "POST", "/api/posts", "tok-author", { content: "x", visibility: "public", mediaUrls: [MOV_REF] });
      assert.notEqual(r.status, 201);
      assert.ok(r.status >= 500, `an error status, got ${r.status}`);
      assert.deepEqual(w.deleted.filter((d) => d.table === "posts").map((d) => d.eqs.id), [NEW_POST], "the compensation deletes exactly the new post");
      assert.equal(w.posts.length, 0);
    } finally { await s.close(); }
  });

  it("R10 a mutation/pending response whose post_media read fails answers media: null (census-media §47), not the old fail-open []", async () => {
    const s = await serve(world({ posts: [e4bbf335({ post_status: "pending_delay" })], failRead: new Set(["post_media"]) }));
    try {
      const pending = await call(s.base, "GET", "/api/posts/pending", "tok-author");
      assert.equal(pending.status, 200);
      assert.equal(pending.body.posts[0].media, null);
    } finally { await s.close(); }
  });

  it("R9 PATCH /posts/:id refuses an upload key (400) after the hold, and updates nothing; an external edit still applies", async () => {
    const w = world({ posts: [e4bbf335({ media_urls: [] })] });
    const s = await serve(w);
    try {
      const r = await call(s.base, "PATCH", `/api/posts/${POST}`, "tok-author", { mediaUrls: [MOV_REF] });
      assert.equal(r.status, 400);
      assert.equal(w.updated.filter((u) => u.table === "posts").length, 0);
      const ok = await call(s.base, "PATCH", `/api/posts/${POST}`, "tok-author", { mediaUrls: ["https://images.example.com/x.jpg"] });
      assert.equal(ok.status, 200);
    } finally { await s.close(); }
  });
});
