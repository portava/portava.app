/**
 * Exclusion-table reads on ROUTE surfaces must fail CLOSED — and must keep
 * working normally when the table reads fine.
 *
 * ── THE DEFECT ───────────────────────────────────────────────────────────────
 * `blocks` is an exclusion table: a ROW means DENY, so emptiness means ALLOW.
 * supabase-js RESOLVES on a database error rather than throwing, so
 *
 *     const { data } = await sc.from("blocks")...;
 *     const blocked = new Set((data ?? []).map(...));
 *
 * builds the SAME empty set when nobody is blocked and when the table could not
 * be read — and every `!blocked.has(id)` downstream then answers "allowed".
 * check-unchecked-supabase-reads classified 31 sites of exactly this shape as
 * FAIL-OPEN. This file proves the fix on the route surfaces.
 *
 * ── THE THREE ANSWERS BEING PROVEN (see src/lib/exclusionSet.ts) ─────────────
 *   shape 1  the set gates ONE interaction        → deny that interaction (403/404)
 *   shape 2  the set scopes PART of the response  → empty that part, serve the rest
 *   shape 3  the response IS a block-scoped roster → refuse, `degraded_unavailable`
 *            (503 + retryable), never an unfiltered list and never a bare
 *            `[]` that reads as "nobody".
 *
 * EVERY route below has BOTH a healthy-path case (the block table reads, the
 * normal answer is unchanged) and a failure case. A fix that made the feature
 * safe by making it always fail would pass the second and fail the first.
 *
 * ── TWO TRAPS THIS FILE DELIBERATELY AVOIDS ─────────────────────────────────
 *  1. Asserting only `status !== 200`. A request rejected at VALIDATION never
 *     reaches the code under test and would pass such an assertion. Every case
 *     below asserts the exact `error` code in the JSON envelope.
 *  2. Omitting the `req.log` the real server installs. Without it these routes
 *     CRASH with a TypeError and a 500-from-crash masquerades as fail-closed.
 *     `startApp` installs the shim, and the healthy-path cases would break
 *     loudly if it were missing.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/exclusionFailClosedRoutes.test.ts
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";

import contentTranslationRouter from "../routes/contentTranslation.js";
import engagementRouter from "../routes/engagement.js";
import friendsRouter from "../routes/friends.js";
import tripsRouter from "../routes/trips.js";
import hashtagsRouter from "../routes/hashtags.js";
import storiesRouter from "../routes/stories.js";
import tagsRouter from "../routes/tags.js";
import messagingRouter from "../routes/messaging.js";
import stampsRouter from "../routes/stamps.js";
import ogRouter from "../routes/og.js";

// ── Stable ids ────────────────────────────────────────────────────────────────
const ME      = "aaaaaaaa-0000-4000-a000-000000000001";
const FRIEND  = "bbbbbbbb-0000-4000-a000-000000000002"; // never blocked
const BLOCKED = "cccccccc-0000-4000-a000-000000000003"; // ME blocked them
const POST    = "dddddddd-0000-4000-a000-000000000004";
const STORY   = "eeeeeeee-0000-4000-a000-000000000005";
const TRIP    = "ffffffff-0000-4000-a000-000000000006";
const MY_STORY = "99999999-0000-4000-a000-000000000007"; // owned by ME — viewers list
const TOK     = "tok-me";

const FUTURE = new Date(Date.now() + 6 * 3600_000).toISOString();
const PAST   = new Date(Date.now() - 6 * 3600_000).toISOString();

// ── Fake Supabase client ──────────────────────────────────────────────────────
//
// Table-driven and deliberately generic: `failTables` decides which tables
// answer `{ data: null, error }` — the RESOLVED failure supabase-js really
// produces, never a throw. Everything else succeeds, so the fail-open path
// stays survivable end-to-end. That matters: if the failure were fatal by
// accident, "no leak" would prove nothing about the guard.

type Rows = Record<string, any[]>;

function makeClient(rows: Rows, failTables: ReadonlySet<string>) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let wantHead = false;
    let wantCount = false;

    function source(): any[] {
      return (rows[table] ?? []).filter((r) => filters.every((f) => f(r)));
    }

    function settle(single: boolean) {
      if (failTables.has(table)) {
        return Promise.resolve({
          data: null,
          error: { message: `${table} read failed`, code: "57014" },
          count: null,
        });
      }
      const out = source();
      return Promise.resolve({
        data: single ? (out[0] ?? null) : (wantHead ? null : out),
        error: null,
        count: wantCount ? out.length : null,
      });
    }

    const b: any = {
      select(_c?: string, o?: any) {
        if (o?.head) wantHead = true;
        if (o?.count) wantCount = true;
        return b;
      },
      eq(c: string, v: any)  { filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { filters.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any)  { filters.push((r) => (r[c] ?? null) === v); return b; },
      not()   { return b; },
      gt(c: string, v: any)  { filters.push((r) => String(r[c] ?? "") > String(v)); return b; },
      gte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") >= String(v)); return b; },
      lt(c: string, v: any)  { filters.push((r) => String(r[c] ?? "") < String(v)); return b; },
      lte(c: string, v: any) { filters.push((r) => String(r[c] ?? "") <= String(v)); return b; },
      upsert() { return b; },
      insert() { return b; },
      update() { return b; },
      delete() { return b; },
      contains() { return b; },
      overlaps() { return b; },
      order()  { return b; },
      range()  { return b; },
      limit()  { return b; },
      // `.or()` here understands only the two forms these sites emit:
      // `col.eq.val` alternatives and `and(...)` conjunctions of them. That is
      // enough to reproduce the real predicate for `blocks`, which is the table
      // under test; other tables in these fixtures are matched by eq/in.
      or(expr: string) {
        const clauses = splitTop(expr).map(parseClause);
        filters.push((r) => clauses.some((c) => c(r)));
        return b;
      },
      maybeSingle() { return settle(true); },
      single()      { return settle(true); },
      then(f: any, j: any) { return settle(false).then(f, j); },
    };
    return b;
  }

  return {
    from: (t: string) => chain(t),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      getUser: async (tok: string) =>
        tok === TOK
          ? { data: { user: { id: ME } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

/** Split a PostgREST `or()` body on top-level commas (not inside `and(...)`). */
function splitTop(expr: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of expr) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseClause(c: string): (r: any) => boolean {
  const and = c.match(/^and\((.*)\)$/s);
  if (and) {
    const parts = splitTop(and[1]).map(parseClause);
    return (r) => parts.every((p) => p(r));
  }
  const m = c.match(/^(\w+)\.(\w+)\.(.*)$/s);
  if (!m) return () => false;
  const [, col, op, raw] = m;
  if (op === "is") return (r) => (r[col] ?? null) === (raw === "null" ? null : raw);
  if (op === "gt") return (r) => String(r[col] ?? "") > raw;
  if (op === "in") {
    const vals = raw.replace(/^\(|\)$/g, "").split(",");
    return (r) => vals.includes(String(r[col]));
  }
  if (op === "ilike") {
    const pat = "^" + raw.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*") + "$";
    return (r) => new RegExp(pat, "i").test(String(r[col] ?? ""));
  }
  return (r) => String(r[col]) === raw;
}

// ── Server ────────────────────────────────────────────────────────────────────
let base = "";
let server: Server;

before(async () => {
  const app = express();
  app.use(express.json());
  // The req.log the real server installs. Without it these routes throw a
  // TypeError on their first log call and a crash-500 would look fail-closed.
  app.use((req, _res, next) => {
    (req as any).log = { info() {}, warn() {}, error() {}, debug() {} };
    next();
  });
  app.use("/api", contentTranslationRouter);
  app.use("/api", engagementRouter);
  app.use("/api", friendsRouter);
  app.use("/api", tripsRouter);
  app.use("/api", hashtagsRouter);
  app.use("/api", storiesRouter);
  app.use("/api", tagsRouter);
  app.use("/api", messagingRouter);
  app.use("/api", stampsRouter);
  app.use("/api", ogRouter);
  server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const a = server.address() as { port: number };
  base = `http://127.0.0.1:${a.port}/api`;
});

after(() => { server.closeAllConnections?.(); server.close(); });

/** Everything the routes under test read, on a healthy day. */
function fixture(): Rows {
  return {
    profiles: [
      { id: ME,      handle: "me",      name: "Me",      display_name: "Me",      username: "me",      avatar_url: null, account_status: "active", verified: false, is_private: false, tag_permission: "anyone", bio: "hola", bio_original_language: "es", passport_visibility: "public", notifications_inbox_viewed_at: null, highlights_viewed_at: null },
      { id: FRIEND,  handle: "friend",  name: "Friend",  display_name: "Friend",  username: "friend",  avatar_url: null, account_status: "active", verified: false, is_private: false, tag_permission: "anyone" },
      { id: BLOCKED, handle: "blocked", name: "Blocked", display_name: "Blocked", username: "blocked", avatar_url: null, account_status: "active", verified: false, is_private: false, tag_permission: "anyone" },
    ],
    profile_privacy_settings: [],
    // ME blocked BLOCKED. FRIEND is untouched — that asymmetry is what the
    // healthy-path assertions measure.
    blocks: [{ id: "b1", blocker_id: ME, blocked_id: BLOCKED }],
    posts: [{
      id: POST, author_id: FRIEND, visibility: "public", status: "active",
      post_status: "published", trip_id: null, content: "hola", original_language: "es",
      media_urls: [], created_at: PAST, like_count: 2, comment_count: 0,
    }],
    content_stamps: [
      { user_id: FRIEND,  created_at: PAST, entity_type: "post", entity_id: POST },
      { user_id: BLOCKED, created_at: PAST, entity_type: "post", entity_id: POST },
    ],
    stories: [
      { id: STORY, owner_id: FRIEND, state: "active", expires_at: FUTURE, created_at: PAST, visibility: "public", close_friends_only: false, trip_id: null, hide_viewer_list: false, media_url: "u", media_type: "image/jpeg", caption: null, hidden_user_ids: [], allowed_user_ids: [] },
      { id: "11111111-0000-4000-a000-00000000000a", owner_id: BLOCKED, state: "active", expires_at: FUTURE, created_at: PAST, visibility: "public", close_friends_only: false, trip_id: null, hide_viewer_list: false, media_url: "u", media_type: "image/jpeg", caption: null, hidden_user_ids: [], allowed_user_ids: [] },
      { id: MY_STORY, owner_id: ME, state: "active", expires_at: FUTURE, created_at: PAST, visibility: "public", close_friends_only: false, trip_id: null, hide_viewer_list: false, media_url: "u", media_type: "image/jpeg", caption: null, hidden_user_ids: [], allowed_user_ids: [] },
    ],
    story_views: [
      { story_id: MY_STORY, viewer_id: FRIEND,  viewed_at: PAST },
      { story_id: MY_STORY, viewer_id: BLOCKED, viewed_at: PAST },
    ],
    user_follows: [
      { follower_id: ME, following_id: FRIEND },
      { follower_id: ME, following_id: BLOCKED },
      { follower_id: FRIEND, following_id: ME },
    ],
    user_friendships: [
      { user_a: ME, user_b: FRIEND },
      { user_a: ME, user_b: BLOCKED },
    ],
    circle_memberships: [
      { user_id: ME, other_id: FRIEND },
      { user_id: ME, other_id: BLOCKED },
    ],
    trip_members: [
      { trip_id: TRIP, user_id: ME,      role: "owner",  status: "accepted" },
      { trip_id: TRIP, user_id: FRIEND,  role: "member", status: "accepted" },
      { trip_id: TRIP, user_id: BLOCKED, role: "member", status: "accepted" },
    ],
    hashtags: [{ id: "h1", slug: "trip", name: "trip", usage_count: 2 }],
    hashtag_usage: [{ source_id: POST, source_type: "post", hashtag_id: "h1", created_at: PAST }],
    close_friends: [],
    // stories_enabled must be ON or /stories/* answers feature_disabled (404)
    // and the block read is never reached — a vacuous test.
    feature_flags: [
      { flag: "stories_enabled", enabled: true },
      { flag: "tagging_enabled", enabled: true },
      // Without this the stamps router 503s at its own feature gate and the
      // block check is never reached — the exact vacuity this file warns about.
      { flag: "stamp_system_v2_enabled", enabled: true },
    ],
    // One highlight from an unblocked circle member and one from a blocked one.
    // The badge must count exactly the first — so a fail-open block read would
    // count TWO, and the fail-closed answer is 0. Without both rows the
    // newHighlights assertions below would be satisfied by an empty table.
    highlights: [
      { id: "hl-friend",  owner_id: FRIEND,  deleted_at: null, expires_at: FUTURE, created_at: PAST, visibility: "public" },
      { id: "hl-blocked", owner_id: BLOCKED, deleted_at: null, expires_at: FUTURE, created_at: PAST, visibility: "public" },
    ],
    memories: [],
    content_translations: [],
    friend_requests: [],
    circle_invites: [],
    trip_invites: [],
    message_requests: [],
    app_notifications: [],
    conversations: [],
    conversation_participants: [],
    messages: [],
    content_tags: [],
    stamp_definitions: [{ id: "sd1", slug: "s", name: "S", icon_url: null, rarity: "common", stamp_type: "city", category: "travel" }],
    user_stamps: [{
      id: "us1", user_id: FRIEND, stamp_definition_id: "sd1", earned_at: PAST,
      is_revoked: false, display_on_passport: true, visibility: "public",
      city: "Lisbon", country: "PT",
      stamp_definitions: { slug: "s", name: "S", icon_url: null, rarity: "common", stamp_type: "city", category: "travel" },
    }],
    events: [{
      id: TRIP, host_id: FRIEND, title: "Party", description: "fun",
      city: "Lisbon", country: "PT", visibility: "public", state: "published",
      cover_url: null, cover_image_width: null, cover_image_height: null,
    }],
  };
}

function setup(failTables: string[] = []) {
  const c = makeClient(fixture(), new Set(failTables)) as any;
  _setTestClient(c, true);
  _setTestServiceClient(c);
}

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${TOK}`, connection: "close" },
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Shape 3's answer, asserted as one thing so every site proves the same code. */
function assertRefused(res: { status: number; body: any }, where: string) {
  assert.equal(res.status, 503, `${where}: must refuse with 503, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body?.error, "degraded_unavailable",
    `${where}: must answer the "check could not be performed" code, not an unfiltered 200 and not a bare db_error`);
  assert.equal(res.body?.retryable, true, `${where}: the client must be told to retry`);
}

// ══ SHAPE 1 — the set gates ONE interaction → deny that interaction ══════════

describe("shape 1: a two-party block gate denies its one interaction", () => {
  it("healthy: GET /content/post/:id/translation authorizes the post", async () => {
    setup();
    const r = await get(`/content/post/${POST}/translation?lang=es`);
    assert.equal(r.status, 200);
    // Reaching `skipped` proves authorizePost returned the row — i.e. the block
    // check ran and passed, not that the request died earlier.
    assert.equal(r.body?.ok, true);
    assert.equal(r.body?.skipped, true);
  });

  it("blocks unreadable: the same request is refused as not_found", async () => {
    setup(["blocks"]);
    const r = await get(`/content/post/${POST}/translation?lang=es`);
    assert.equal(r.status, 404, "an unresolvable block state must not read as 'not blocked'");
    assert.equal(r.body?.error, "not_found");
  });

  it("healthy: GET /content/bio/:id/translation authorizes the bio", async () => {
    setup();
    const r = await get(`/content/bio/${ME}/translation?lang=es`);
    assert.equal(r.status, 200);
    assert.equal(r.body?.skipped, true);
  });

  it("blocks unreadable: the bio translation is refused as not_found", async () => {
    setup(["blocks"]);
    const r = await get(`/content/bio/${ME}/translation?lang=es`);
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
  });

  it("healthy: GET /stories/:id serves a story whose owner is not blocked", async () => {
    setup();
    const r = await get(`/stories/${STORY}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body?.story?.id ?? r.body?.id, STORY);
  });

  it("blocks unreadable: the same story is not_found (checkStoryAccess denies)", async () => {
    setup(["blocks"]);
    const r = await get(`/stories/${STORY}`);
    assert.equal(r.status, 404);
    assert.equal(r.body?.error, "not_found");
  });
});

// ══ SHAPE 3 — the response IS a block-scoped roster → refuse, retryably ══════

describe("shape 3: a wholly block-scoped roster refuses rather than leak or lie", () => {
  it("healthy: GET /engagement/likes lists the unblocked liker and omits the blocked one", async () => {
    setup();
    const r = await get(`/engagement/likes?targetType=post_like&targetId=${POST}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body?.users ?? []).map((u: any) => u.id);
    assert.ok(ids.includes(FRIEND), "the unblocked liker must still be listed");
    assert.ok(!ids.includes(BLOCKED), "the blocked liker must not be");
  });

  it("blocks unreadable: GET /engagement/likes refuses", async () => {
    setup(["blocks"]);
    assertRefused(await get(`/engagement/likes?targetType=post_like&targetId=${POST}`), "engagement/likes");
  });

  it("healthy: GET /circles/:id/invitable-users omits only the blocked user", async () => {
    setup();
    const r = await get(`/circles/${ME}/invitable-users`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = [...(r.body?.groupMembers ?? []), ...(r.body?.otherFollowers ?? [])].map((u: any) => u.id);
    assert.ok(ids.includes(FRIEND));
    assert.ok(!ids.includes(BLOCKED));
  });

  it("blocks unreadable: GET /circles/:id/invitable-users refuses", async () => {
    setup(["blocks"]);
    assertRefused(await get(`/circles/${ME}/invitable-users`), "circles/invitable-users");
  });

  it("healthy: GET /trips/:id/invitable-users omits only the blocked user", async () => {
    setup();
    const r = await get(`/trips/${TRIP}/invitable-users`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = [...(r.body?.groupMembers ?? []), ...(r.body?.otherFollowers ?? [])].map((u: any) => u.id);
    assert.ok(ids.includes(FRIEND));
    assert.ok(!ids.includes(BLOCKED));
  });

  it("blocks unreadable: GET /trips/:id/invitable-users refuses", async () => {
    setup(["blocks"]);
    assertRefused(await get(`/trips/${TRIP}/invitable-users`), "trips/invitable-users");
  });

  it("healthy: GET /hashtags/:slug/feed serves the post feed", async () => {
    setup();
    const r = await get(`/hashtags/trip/feed?tab=recent`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body?.posts ?? r.body?.items));
  });

  it("blocks unreadable: GET /hashtags/:slug/feed refuses (every tab filters on the set)", async () => {
    setup(["blocks"]);
    assertRefused(await get(`/hashtags/trip/feed?tab=recent`), "hashtags/feed");
  });

  it("healthy: GET /stories/feed returns the unblocked owner's story only", async () => {
    setup();
    const r = await get(`/stories/feed`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const owners = (r.body?.users ?? []).map((u: any) => u.userId ?? u.id);
    assert.ok(!owners.includes(BLOCKED), "a blocked owner must never appear in the feed");
  });

  it("blocks unreadable: GET /stories/feed refuses instead of serving an unfiltered feed", async () => {
    setup(["blocks"]);
    assertRefused(await get(`/stories/feed`), "stories/feed");
  });

  it("healthy: GET /stories/:id/viewers lists the unblocked viewer only", async () => {
    setup();
    const r = await get(`/stories/${MY_STORY}/viewers`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body?.viewers ?? []).map((v: any) => v.userId);
    assert.ok(ids.includes(FRIEND), "the unblocked viewer must still be listed");
    assert.ok(!ids.includes(BLOCKED), "the blocked viewer must not be");
  });

  it("blocks unreadable: GET /stories/:id/viewers refuses rather than list an unfiltered roster", async () => {
    setup(["blocks"]);
    assertRefused(await get(`/stories/${MY_STORY}/viewers`), "stories/viewers");
  });
});

// ══ SHAPE 2 — the set scopes PART of the response → empty that part only ═════

describe("shape 2: a partially block-scoped response empties only that part", () => {
  it("healthy: GET /tags/suggestions returns the unblocked user, not the blocked one", async () => {
    setup();
    const r = await get(`/tags/suggestions?q=friend&surface=message`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = (r.body?.suggestions ?? []).map((s: any) => s.id);
    assert.ok(ids.includes(FRIEND), "the unblocked handle must still be suggested");
    assert.ok(!ids.includes(BLOCKED));
  });

  it("blocks unreadable: GET /tags/suggestions still answers 200 but suggests NO users", async () => {
    setup(["blocks"]);
    const r = await get(`/tags/suggestions?q=friend&surface=message`);
    assert.equal(r.status, 200, "the picker must not 503 — only its user half is block-scoped");
    const users = (r.body?.suggestions ?? []).filter((s: any) => s.type === "user");
    assert.deepEqual(users, [], "no user may be suggested while block state is unknown");
  });

  it("healthy: GET /me/unread-counts answers with all four counters", async () => {
    setup();
    const r = await get(`/me/unread-counts`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const k of ["messages", "notifications", "meetups", "newHighlights"]) {
      assert.equal(typeof r.body?.[k], "number", `${k} must still be reported`);
    }
    assert.equal(r.body?.newHighlights, 1,
      "the unblocked circle member's highlight counts; the blocked one's does not");
  });

  it("blocks unreadable: /me/unread-counts still answers, with newHighlights 0", async () => {
    setup(["blocks"]);
    const r = await get(`/me/unread-counts`);
    assert.equal(r.status, 200, "three of the four counters are not block-scoped — do not 503 the badge");
    assert.equal(r.body?.newHighlights, 0,
      "an unreadable block list must under-report, never count a blocked user's highlight");
    assert.equal(typeof r.body?.notifications, "number", "the non-block-scoped counters survive");
  });
});

// ══ Two more shape-1 gates, each with its own refusal envelope ══════════════

describe("shape 1 (cont.): the block gate's own error envelope per surface", () => {
  it("healthy: GET /stamps/user/:id serves another user's public stamps", async () => {
    setup();
    const r = await get(`/stamps/user/${FRIEND}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body?.stamps));
  });

  it("blocks unreadable: GET /stamps/user/:id answers forbidden, not the passport", async () => {
    setup(["blocks"]);
    const r = await get(`/stamps/user/${FRIEND}`);
    assert.equal(r.status, 403);
    assert.equal(r.body?.error, "forbidden");
  });

  it("healthy: GET /og/event/:id renders the real public card", async () => {
    setup();
    const r = await fetch(`${base}/og/event/${TRIP}`, {
      headers: { Authorization: `Bearer ${TOK}`, connection: "close" },
    });
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes("Party"), "the public event's own title must appear");
  });

  it("blocks unreadable: GET /og/event/:id falls back to the generic private card", async () => {
    setup(["blocks"]);
    const r = await fetch(`${base}/og/event/${TRIP}`, {
      headers: { Authorization: `Bearer ${TOK}`, connection: "close" },
    });
    assert.equal(r.status, 200, "the OG endpoint always renders — the question is WHAT");
    const html = await r.text();
    assert.ok(!html.includes("Party"),
      "an unreadable block state must withhold the host's event title from the preview");
  });
});
