/**
 * Stories / Quick Media data source (Wall spec §18/§23).
 *
 * Loader (loadQuickMediaItems):
 *   • returns a followed person's 24-h media published through a readable post;
 *   • EXCLUDES a blocked owner (either direction) and fails CLOSED when the
 *     block list is unreadable;
 *   • EXCLUDES media_assets.visibility='private';
 *   • EXCLUDES media older than the 24-h window even if the query fed it back;
 *   • EXCLUDES an asset inheriting from a private / unpublished post, and one
 *     nothing publishes (deny by default);
 *   • admits trip_only inheritance only for an accepted trip member;
 *   • never mints a signed URL — the stored storage reference rides as-is.
 *
 * Route (GET /wall/quick-media): feature_disabled when the Wall is dark; a
 * 200 with the items otherwise; and an empty row (never a 5xx) when the source
 * throws.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import {
  loadQuickMediaItems,
  QUICK_MEDIA_WINDOW_MS,
} from "../services/wall/WallCandidateLoaders.js";
import wallRouter from "../routes/wall.js";

const VIEWER = "viewer-1";
const NOW = Date.parse("2026-09-04T12:00:00.000Z");
const iso = (deltaMs: number) => new Date(NOW + deltaMs).toISOString();
const H = 60 * 60 * 1000;

interface Fixture {
  follows?: string[];
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  blocksError?: boolean;
  assets?: any[];
  attachments?: any[];
  postMedia?: any[];
  posts?: any[];
  profiles?: any[];
  tripMembers?: Array<{ trip_id: string; user_id: string; role: string }>;
  flags?: Record<string, boolean>;
  throwOn?: string;
}

const PROFILES_DEFAULT = [
  { id: "aya", display_name: "Aya", username: "aya", avatar_url: "profile-media/avatars/aya/a.jpg", account_status: "active" },
  { id: "bo", display_name: "Bo", username: "bo", avatar_url: null, account_status: "active" },
];

function asset(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "asset-1",
    owner_user_id: "aya",
    storage_bucket: "post-media",
    storage_path: "aya/2026/09/a1.jpg",
    public_url: null,
    media_type: "image",
    thumbnail_path: "aya/2026/09/a1_thumb.jpg",
    thumbnail_url: null,
    width: 1200,
    height: 1600,
    duration_ms: null,
    moderation_status: "pending",
    processing_status: "ready",
    visibility: "inherit",
    created_at: iso(-2 * H),
    ...over,
  };
}

function post(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "post-1",
    author_id: "aya",
    visibility: "public",
    status: "active",
    post_status: "published",
    trip_id: null,
    ...over,
  };
}

function fakeClient(f: Fixture) {
  const flags = f.flags ?? { wall_enabled: true };
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any[]> = {};
    let orFilter: string | null = null;
    let single = false;
    function resolve(): any {
      if (f.throwOn === table) throw new Error(`boom:${table}`);
      if (table === "feature_flags") return { data: { enabled: !!flags[String(eqs.flag)] }, error: null };
      if (table === "user_follows") {
        if (eqs.follower_id === VIEWER) {
          return { data: (f.follows ?? []).map((id) => ({ following_id: id })), error: null };
        }
        return { data: [], error: null };
      }
      if (table === "blocks") {
        if (f.blocksError) return { data: null, error: { message: "blocks unreadable" } };
        const rows = (f.blocks ?? []).filter(
          (b) => orFilter?.includes(`blocker_id.eq.${b.blocker_id}`) || orFilter?.includes(`blocked_id.eq.${b.blocked_id}`),
        );
        return { data: rows, error: null };
      }
      if (table === "media_assets") {
        let rows = f.assets ?? [];
        if (ins.owner_user_id) rows = rows.filter((r) => ins.owner_user_id.includes(r.owner_user_id));
        return { data: rows, error: null };
      }
      if (table === "media_attachments") {
        let rows = f.attachments ?? [];
        if (ins.media_asset_id) rows = rows.filter((r) => ins.media_asset_id.includes(r.media_asset_id));
        if (ins.entity_type) rows = rows.filter((r) => ins.entity_type.includes(r.entity_type));
        return { data: rows, error: null };
      }
      if (table === "post_media") {
        let rows = f.postMedia ?? [];
        if (ins.storage_path) rows = rows.filter((r) => ins.storage_path.includes(r.storage_path));
        return { data: rows, error: null };
      }
      if (table === "posts") {
        let rows = f.posts ?? [];
        if (ins.id) rows = rows.filter((r) => ins.id.includes(r.id));
        return { data: rows, error: null };
      }
      if (table === "profiles") {
        const rows = (f.profiles ?? PROFILES_DEFAULT).filter((p) => !ins.id || ins.id.includes(p.id));
        return { data: single ? rows[0] ?? null : rows, error: null };
      }
      if (table === "trip_members") {
        const rows = (f.tripMembers ?? []).filter((m) => m.user_id === eqs.user_id && (!ins.role || ins.role.includes(m.role)));
        return { data: rows.map((m) => ({ trip_id: m.trip_id })), error: null };
      }
      if (table === "trips") return { data: [], error: null };
      return { data: single ? null : [], error: null };
    }
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any[]) => { ins[c] = v; return b; },
      or: (expr: string) => { orFilter = expr; return b; },
      gte: () => b, lte: () => b, gt: () => b, lt: () => b, is: () => b, ilike: () => b,
      order: () => b, limit: () => b,
      maybeSingle: () => { single = true; return Promise.resolve().then(resolve); },
      then: (onF: any, onR: any) => Promise.resolve().then(resolve).then(onF, onR),
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: async (token: string) =>
        token === "tok" ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

const HAPPY: Fixture = {
  follows: ["aya", "bo"],
  assets: [asset()],
  attachments: [{ media_asset_id: "asset-1", entity_type: "post", entity_id: "post-1" }],
  posts: [post()],
};

describe("loadQuickMediaItems — the §18 data source", () => {
  it("returns a followed person's recent media published through a readable post, with the stored ref unsigned", async () => {
    const items = await loadQuickMediaItems(fakeClient(HAPPY), VIEWER, { nowMs: NOW });
    assert.equal(items.length, 1);
    const it0 = items[0];
    assert.equal(it0.id, "asset-1");
    assert.equal(it0.ownerUserId, "aya");
    assert.equal(it0.postId, "post-1");
    assert.equal(it0.actor.displayName, "Aya");
    assert.equal(it0.actor.handle, "aya");
    // The stored storage reference rides as-is for the client's signing path —
    // never a minted signed URL, never a coordinate.
    assert.equal(it0.media.url, "post-media/aya/2026/09/a1.jpg");
    assert.equal(it0.media.thumbnailUrl, "post-media/aya/2026/09/a1_thumb.jpg");
    assert.ok(!/token=|\/sign\//.test(String(it0.media.url)));
    assert.equal(it0.media.kind, "image");
    assert.equal(Date.parse(it0.expiresAt) - Date.parse(it0.createdAt), QUICK_MEDIA_WINDOW_MS);
    assert.ok(!("lat" in it0) && !("lng" in it0));
  });

  it("excludes an owner the viewer blocked", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, blocks: [{ blocker_id: VIEWER, blocked_id: "aya" }] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.deepEqual(items, []);
  });

  it("excludes an owner who blocked the viewer", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, blocks: [{ blocker_id: "aya", blocked_id: VIEWER }] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.deepEqual(items, []);
  });

  it("fails CLOSED to an empty row when the block list cannot be read", async () => {
    const items = await loadQuickMediaItems(fakeClient({ ...HAPPY, blocksError: true }), VIEWER, { nowMs: NOW });
    assert.deepEqual(items, []);
  });

  it("excludes media_assets.visibility = 'private' even when its post is public", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, assets: [asset({ visibility: "private" })] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.deepEqual(items, []);
  });

  it("excludes media older than 24 h even if the query fed it back", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, assets: [asset({ created_at: iso(-QUICK_MEDIA_WINDOW_MS - 60_000) })] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.deepEqual(items, []);
    // Right at the edge of the window it still shows.
    const edge = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, assets: [asset({ created_at: iso(-QUICK_MEDIA_WINDOW_MS + 60_000) })] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.equal(edge.length, 1);
  });

  it("excludes an asset inheriting from a private post, an unpublished post, and a non-active post", async () => {
    for (const bad of [
      post({ visibility: "private" }),
      post({ post_status: "pending_departure" }),
      post({ status: "removed" }),
    ]) {
      const items = await loadQuickMediaItems(fakeClient({ ...HAPPY, posts: [bad] }), VIEWER, { nowMs: NOW });
      assert.deepEqual(items, [], JSON.stringify(bad));
    }
  });

  it("denies an asset nothing publishes (no attachment, no post_media) — even with visibility 'public'", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, attachments: [], postMedia: [], assets: [asset({ visibility: "public" })] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.deepEqual(items, []);
  });

  it("resolves the publishing post through the legacy post_media path when no attachment exists", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({
        ...HAPPY,
        attachments: [],
        postMedia: [{ post_id: "post-1", storage_path: "aya/2026/09/a1.jpg", moderation_status: "approved", processing_status: "ready" }],
      }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].postId, "post-1");
  });

  it("refuses a post that does not belong to the asset owner", async () => {
    const items = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, posts: [post({ author_id: "bo" })] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.deepEqual(items, []);
  });

  it("admits trip_only inheritance only for an accepted trip member", async () => {
    const tripPost = post({ visibility: "trip_only", trip_id: "trip-9" });
    const stranger = await loadQuickMediaItems(fakeClient({ ...HAPPY, posts: [tripPost] }), VIEWER, { nowMs: NOW });
    assert.deepEqual(stranger, []);
    const member = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, posts: [tripPost], tripMembers: [{ trip_id: "trip-9", user_id: VIEWER, role: "member" }] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.equal(member.length, 1);
  });

  it("excludes media from an account that is not active, and from someone not followed", async () => {
    const suspended = await loadQuickMediaItems(
      fakeClient({ ...HAPPY, profiles: [{ ...PROFILES_DEFAULT[0], account_status: "suspended" }] }),
      VIEWER,
      { nowMs: NOW },
    );
    assert.deepEqual(suspended, []);
    const unfollowed = await loadQuickMediaItems(fakeClient({ ...HAPPY, follows: ["bo"] }), VIEWER, { nowMs: NOW });
    assert.deepEqual(unfollowed, []);
  });

  it("excludes moderation-blocked and unready assets, and honours the limit", async () => {
    const rows = [
      asset({ id: "a-rej", moderation_status: "rejected" }),
      asset({ id: "a-proc", processing_status: "processing" }),
      asset({ id: "a-ok-1", created_at: iso(-1 * H) }),
      asset({ id: "a-ok-2", created_at: iso(-3 * H), storage_path: "aya/2026/09/a2.jpg" }),
    ];
    const attachments = rows.map((r) => ({ media_asset_id: r.id, entity_type: "post", entity_id: "post-1" }));
    const all = await loadQuickMediaItems(fakeClient({ ...HAPPY, assets: rows, attachments }), VIEWER, { nowMs: NOW });
    assert.deepEqual(all.map((i) => i.id), ["a-ok-1", "a-ok-2"]);
    const capped = await loadQuickMediaItems(fakeClient({ ...HAPPY, assets: rows, attachments }), VIEWER, { nowMs: NOW, limit: 1 });
    assert.deepEqual(capped.map((i) => i.id), ["a-ok-1"]);
  });
});

describe("GET /wall/quick-media", () => {
  let server: http.Server;
  let base = "";

  function use(fixture: Fixture) {
    _setTestClient(fakeClient(fixture), true);
  }

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(wallRouter);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  after(async () => {
    _clearTestClient();
    await new Promise<void>((r) => server.close(() => r()));
  });

  async function get(query = "") {
    const res = await fetch(`${base}/wall/quick-media${query}`, { headers: { Authorization: "Bearer tok" } });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("is feature_disabled while the Wall is dark", async () => {
    use({ ...HAPPY, flags: { wall_enabled: false } });
    const r = await get();
    // The error envelope maps feature_disabled to 404 (lib/http sendError).
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "feature_disabled");
  });

  it("returns the items when the Wall is on", async () => {
    use({ ...HAPPY, flags: { wall_enabled: true } });
    const r = await get("?limit=5");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].postId, "post-1");
    assert.equal(typeof r.body.generatedAt, "string");
  });

  it("degrades to an empty row (200) when the source throws", async () => {
    use({ ...HAPPY, flags: { wall_enabled: true }, throwOn: "user_follows" });
    const r = await get();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.items, []);
  });

  it("rejects an unauthenticated caller", async () => {
    use({ ...HAPPY, flags: { wall_enabled: true } });
    const res = await fetch(`${base}/wall/quick-media`);
    assert.equal(res.status, 401);
  });
});
