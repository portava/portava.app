/**
 * WallCandidateLoaders — the non-Post candidate fetchers (spec §6/§10/§11/§12).
 *
 * Proves each loader projects its canonical rows into the right Wall shape, that
 * every candidate survives the SAME eligibility → block → visibility gate the
 * Post loader uses (projectObjects, §23/§24), that a failing loader degrades to
 * an empty set (never throws, §34), and that a mixed feed still merges + dedups
 * to one richest projection per canonical object.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  projectObjects,
  type ProjectViewerContext,
} from "../services/wall/WallProjectionService.js";
import {
  loadPostcardCandidates,
  loadVideoMediaCandidates,
  loadSharedMomentCandidates,
  mergeLoadedCandidates,
  type LoadedWallCandidates,
  type LoaderViewer,
} from "../services/wall/WallCandidateLoaders.js";
import type { WallCandidate } from "../services/wall/WallProjectionService.js";

const VIEWER = "viewer-1";

function viewerCtx(over: Partial<ProjectViewerContext> = {}): ProjectViewerContext {
  return { viewerId: VIEWER, viewerTripIds: new Set(), followedCreatorIds: new Set(), ...over };
}

/** Fake supabase whose only table is `blocks` — for driving projectObjects. */
function blocksClient(rows: Array<{ blocker_id: string; blocked_id: string }> = []) {
  return {
    from() {
      const b: any = {
        select: () => b,
        or: () => b,
        then: (onF: any, onR: any) => Promise.resolve({ data: rows, error: null }).then(onF, onR),
      };
      return b;
    },
  };
}

/**
 * A generic table-routed fake. `tables[name]` is either an array (returned for
 * both list reads and as [0] for maybeSingle) or a function of the captured
 * eq/in filters. Unknown tables return [].
 */
function tableClient(tables: Record<string, any[] | ((ctx: { eqs: any; ins: any }) => any[])>) {
  function rowsFor(table: string, ctx: { eqs: any; ins: any }): any[] {
    const t = tables[table];
    if (typeof t === "function") return t(ctx) ?? [];
    return t ?? [];
  }
  function builder(table: string) {
    const eqs: Record<string, any> = {};
    const ins: Record<string, any> = {};
    const ctx = { eqs, ins };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { eqs[c] = v; return b; },
      in: (c: string, v: any) => { ins[c] = v; return b; },
      or: () => b, order: () => b, limit: () => b, gte: () => b, lte: () => b, gt: () => b,
      maybeSingle: () => Promise.resolve({ data: rowsFor(table, ctx)[0] ?? null, error: null }),
      then: (onF: any, onR: any) => Promise.resolve({ data: rowsFor(table, ctx), error: null }).then(onF, onR),
    };
    return b;
  }
  return { from: builder };
}

/** A client whose every read throws — to exercise the fail-soft path. */
function throwingClient() {
  return {
    from() {
      const b: any = {
        select: () => b, eq: () => b, in: () => b, or: () => b, order: () => b, limit: () => b,
        gte: () => b, lte: () => b, gt: () => b,
        maybeSingle: () => Promise.reject(new Error("boom")),
        then: (_onF: any, onR: any) => Promise.reject(new Error("boom")).then(undefined, onR),
      };
      return b;
    },
  };
}

const FOLLOWED: LoaderViewer = { viewerId: VIEWER, followedCreatorIds: new Set(["author-1"]) };

// ── 1. Postcards ─────────────────────────────────────────────────────────────

describe("loadPostcardCandidates (spec §10)", () => {
  // THE DISCRIMINATOR is a LIVE `passport_postcards` row (status='active', not
  // tombstoned) pointing at the post — the fact the /postcards system records
  // when a post actually becomes a Postcard. `posts.add_to_passport` is only
  // the author's intent flag and defaults TRUE at the DB, in POST /posts and in
  // POST /postcards, so every fixture below carries add_to_passport=true and
  // it must decide nothing.
  const POSTS = [
    { id: "pc-1", author_id: "author-1", trip_id: null, content: "Hoi An lanterns", visibility: "public",
      status: "active", post_status: "published", created_at: "2026-09-01T10:00:00Z", published_at: "2026-09-01T10:00:00Z",
      canonical_place_id: "place-1", add_to_passport: true, has_video: false, media_count: 1,
      category: "culture", location_city: "Hoi An", location_country: "VN", save_count: 4 },
    // A Hidden-Gem / plain post: add_to_passport DEFAULTED true, but no
    // passport_postcards row was ever created for it — it is NOT a postcard.
    { id: "gem-x", author_id: "author-1", trip_id: null, content: "a hidden gem", visibility: "public",
      status: "active", post_status: "published", created_at: "2026-09-01T09:00:00Z", published_at: "2026-09-01T09:00:00Z",
      canonical_place_id: null, add_to_passport: true, has_video: false, media_count: 1,
      category: "gem", location_city: null, location_country: null, save_count: 0 },
  ];
  const PASSPORT_POSTCARDS = [
    { post_id: "pc-1", user_id: "author-1", status: "active", deleted_at: null, created_at: "2026-09-01T10:00:00Z" },
  ];
  const POST_MEDIA = [
    { id: "pm-1", post_id: "pc-1", media_type: "image", public_url: "https://cdn/x.jpg", thumbnail_url: "https://cdn/t.jpg",
      width: 1200, height: 800, duration_seconds: null, sort_order: 0, processing_status: "ready", moderation_status: "approved" },
  ];
  const PROFILES = [{ id: "author-1", display_name: "Aya", username: "aya", avatar_url: null, account_status: "active" }];
  const PLACES = [{ id: "place-1", name: "Ancient Town", city: "Hoi An", country_code: "VN" }];

  const client = (over: Record<string, any> = {}) =>
    tableClient({ posts: POSTS, passport_postcards: PASSPORT_POSTCARDS, post_media: POST_MEDIA, profiles: PROFILES, places: PLACES, ...over });

  it("emits a post as a Postcard ONLY when a live passport_postcards row points at it (D2 ruling)", async () => {
    const loaded = await loadPostcardCandidates(client(), "for_you", FOLLOWED);
    assert.deepEqual(
      loaded.candidates.map((c) => c.canonicalObjectId),
      ["pc-1"],
      "gem-x has add_to_passport=true (the default) and no postcard row — it is not a Postcard",
    );
    const c = loaded.candidates[0];
    assert.equal(c.objectType, "postcard");
    assert.equal(c.authorId, "author-1");
    assert.equal(c.media?.length, 1);
    assert.equal(c.media?.[0].kind, "image");
    assert.equal(c.place?.placeId, "place-1");
    assert.equal(c.actor?.displayName, "Aya");
    // Ranking signal + live-strip place derivation are populated.
    assert.equal(loaded.signals.get("pc-1")?.saveCount, 4);
    assert.equal(loaded.placeByObject.get("pc-1")?.city, "Hoi An");
  });

  it("a hidden or tombstoned passport_postcards row does not resurrect the post as a Postcard", async () => {
    const loaded = await loadPostcardCandidates(
      client({
        passport_postcards: [
          { post_id: "pc-1", user_id: "author-1", status: "hidden", deleted_at: null, created_at: "2026-09-01T10:00:00Z" },
          { post_id: "gem-x", user_id: "author-1", status: "active", deleted_at: "2026-09-02T00:00:00Z", created_at: "2026-09-01T09:00:00Z" },
        ],
      }),
      "for_you",
      FOLLOWED,
    );
    assert.equal(loaded.candidates.length, 0, "moderation-hidden and tombstoned postcards are not live");
  });

  it("a Postcard whose post is not yet published is not served (D1 — delayed-publish gate)", async () => {
    // Both have live postcard rows; only the published post may reach the Wall.
    const pending = { ...POSTS[0], id: "pc-pending", post_status: "pending_location_exit" };
    const loaded = await loadPostcardCandidates(
      client({
        posts: [pending, POSTS[0]],
        passport_postcards: [
          { post_id: "pc-pending", user_id: "author-1", status: "active", deleted_at: null, created_at: "2026-09-01T10:00:00Z" },
          ...PASSPORT_POSTCARDS,
        ],
      }),
      "following",
      FOLLOWED,
    );
    assert.deepEqual(loaded.candidates.map((c) => c.canonicalObjectId), ["pc-1"], "the pending postcard stays hidden");
  });

  it("the reads carry the canonical predicates (live postcard rows for followed authors; active + published posts)", async () => {
    type Captured = { eqs: Record<string, any>; ins: Record<string, any> };
    // A holder object (not `let x = null` reassigned inside a callback): TypeScript
    // narrows the latter to `null`/`never` at the assertions below.
    const captured: { postcard?: Captured; posts?: Captured } = {};
    const loaded = await loadPostcardCandidates(
      client({
        passport_postcards: (ctx: Captured) => { captured.postcard = { eqs: { ...ctx.eqs }, ins: { ...ctx.ins } }; return PASSPORT_POSTCARDS; },
        posts: (ctx: Captured) => { captured.posts = { eqs: { ...ctx.eqs }, ins: { ...ctx.ins } }; return POSTS; },
      }),
      "for_you",
      FOLLOWED,
    );
    assert.equal(loaded.candidates.length, 1);
    assert.ok(captured.postcard, "passport_postcards was read");
    assert.equal(captured.postcard?.eqs.status, "active", "discriminator: live postcard rows only");
    assert.deepEqual(captured.postcard?.ins.user_id, ["author-1"], "discriminator: scoped to followed authors");
    assert.ok(captured.posts, "posts was read");
    assert.deepEqual(captured.posts?.ins.id, ["pc-1"], "posts are fetched BY the postcard rows' post_id");
    assert.equal(captured.posts?.eqs.status, "active");
    assert.equal(captured.posts?.eqs.post_status, "published", "the same DB predicate the Following / global feeds apply");
  });

  it("returns empty when the viewer follows no one (no in-graph postcards)", async () => {
    const loaded = await loadPostcardCandidates(client(), "for_you", { viewerId: VIEWER, followedCreatorIds: new Set() });
    assert.equal(loaded.candidates.length, 0);
  });

  it("degrades to empty when the read throws (fail-soft §34)", async () => {
    const loaded = await loadPostcardCandidates(throwingClient(), "following", FOLLOWED);
    assert.equal(loaded.candidates.length, 0);
  });

  it("freezes to the For You snapshot: a postcard created after the horizon is excluded (D5)", async () => {
    // A fake that HONORS `.lte('created_at', X)` on the posts query so the freeze
    // horizon is actually exercised (the generic tableClient treats lte as a no-op).
    function snapshotPostsClient(posts: any[]) {
      const tables: Record<string, any[]> = {
        posts,
        passport_postcards: posts.map((p) => ({ post_id: p.id, user_id: p.author_id, status: "active", deleted_at: null, created_at: p.created_at })),
        post_media: [],
        profiles: [{ id: "author-1", display_name: "Aya", username: "aya", account_status: "active" }],
        places: [],
      };
      function builder(table: string) {
        let lteCreatedAt: string | null = null;
        const b: any = {
          select: () => b,
          eq: () => b,
          in: () => b,
          or: () => b,
          order: () => b,
          limit: () => b,
          gte: () => b,
          gt: () => b,
          lte: (c: string, v: string) => {
            if (c === "created_at") lteCreatedAt = v;
            return b;
          },
          maybeSingle: () => Promise.resolve({ data: (tables[table] ?? [])[0] ?? null, error: null }),
          then: (onF: any, onR: any) => {
            let rows = tables[table] ?? [];
            if (table === "posts" && lteCreatedAt) rows = rows.filter((r) => String(r.created_at) <= lteCreatedAt!);
            return Promise.resolve({ data: rows, error: null }).then(onF, onR);
          },
        };
        return b;
      }
      return { from: builder };
    }

    const base = {
      author_id: "author-1", trip_id: null, content: "lanterns", visibility: "public", status: "active", post_status: "published",
      canonical_place_id: null, add_to_passport: true, has_video: false, media_count: 0,
      category: "culture", location_city: "Hoi An", location_country: "VN", save_count: 0,
    };
    const posts = [
      { ...base, id: "pc-old", created_at: "2026-09-01T00:00:00Z", published_at: "2026-09-01T00:00:00Z" },
      { ...base, id: "pc-new", created_at: "2026-09-10T00:00:00Z", published_at: "2026-09-10T00:00:00Z" },
    ];
    // With a horizon between the two, only the pre-horizon postcard is returned.
    const frozen = await loadPostcardCandidates(snapshotPostsClient(posts), "for_you", FOLLOWED, { snapshotAtIso: "2026-09-05T00:00:00Z" });
    assert.deepEqual(frozen.candidates.map((c) => c.canonicalObjectId), ["pc-old"], "the post-snapshot postcard is frozen out");
    // Without a horizon, both surface.
    const live = await loadPostcardCandidates(snapshotPostsClient(posts), "for_you", FOLLOWED);
    assert.deepEqual(live.candidates.map((c) => c.canonicalObjectId).sort(), ["pc-new", "pc-old"], "no horizon ⇒ both surface");
  });

  it("postcards run the same visibility gate: a private one from another author is dropped", async () => {
    const priv = [{ ...POSTS[0], id: "pc-priv", author_id: "author-2", visibility: "private", canonical_place_id: null }];
    const loaded = await loadPostcardCandidates(
      tableClient({
        posts: priv,
        passport_postcards: [{ post_id: "pc-priv", user_id: "author-2", status: "active", deleted_at: null, created_at: priv[0].created_at }],
        post_media: [],
        profiles: [{ id: "author-2", display_name: "Ben", username: "ben", account_status: "active" }],
        places: [],
      }),
      "for_you",
      { viewerId: VIEWER, followedCreatorIds: new Set(["author-2"]) },
    );
    assert.equal(loaded.candidates.length, 1, "loader emits it; the gate decides readability");
    const projected = await projectObjects(blocksClient(), loaded.candidates, viewerCtx());
    assert.equal(projected.length, 0, "the private postcard from another author is gated out");
  });
});

// ── 2. Video / media ─────────────────────────────────────────────────────────

describe("loadVideoMediaCandidates (spec §11)", () => {
  const author1Profile = { id: "author-1", username: "aya", display_name: "Aya", name: "Aya", avatar_url: null, verified: false, is_official: false, account_status: "active" };
  const MEDIA_POSTS = [
    { id: "vid-1", author_id: "author-1", trip_id: null, content: "beach clip", visibility: "public", status: "active",
      post_status: "published", created_at: "2026-09-01T10:00:00Z", category: "beach", location_name: "My Khe",
      location_city: "Da Nang", location_country: "VN", canonical_place_id: "place-1", media_urls: [],
      post_media: [{ id: "m-v", media_type: "video", public_url: "https://cdn/v.mp4", thumbnail_url: "https://cdn/vt.jpg", width: 1080, height: 1920, duration_seconds: 12, sort_order: 0, processing_status: "ready", moderation_status: "approved" }],
      profiles: [author1Profile] },
    { id: "img-1", author_id: "author-1", trip_id: null, content: "coffee", visibility: "public", status: "active",
      post_status: "published", created_at: "2026-09-01T09:00:00Z", category: "food", location_name: null,
      location_city: "Da Nang", location_country: "VN", canonical_place_id: null, media_urls: [],
      post_media: [{ id: "m-i", media_type: "image", public_url: "https://cdn/i.jpg", thumbnail_url: null, width: 800, height: 800, duration_seconds: null, sort_order: 0, processing_status: "ready", moderation_status: "approved" }],
      profiles: [author1Profile] },
  ];

  function mediaClient(followRows: any[] = [{ following_id: "author-1" }]) {
    return tableClient({
      profiles: (ctx) => (ctx.ins["account_status"] ? [] : [{ id: VIEWER, location_country: "VN", date_of_birth: null, account_status: "active" }]),
      user_follows: followRows,
      trip_members: [],
      trips: [],
      blocks: [],
      user_mutes: [],
      posts: MEDIA_POSTS,
    });
  }

  it("populates DisplayMedia and classifies video vs photo", async () => {
    const loaded = await loadVideoMediaCandidates(mediaClient(), VIEWER);
    const byId = new Map(loaded.candidates.map((c) => [c.canonicalObjectId, c]));
    const vid = byId.get("vid-1")!;
    assert.equal(vid.objectType, "video");
    assert.equal(vid.media?.[0].kind, "video");
    assert.equal(vid.media?.[0].durationMs, 12000);
    assert.equal(vid.media?.[0].url, "https://cdn/v.mp4");
    assert.equal(vid.place?.placeId, "place-1");
    const img = byId.get("img-1")!;
    assert.equal(img.objectType, "social_post");
    assert.equal(img.media?.[0].kind, "image");
  });

  it("returns empty when the viewer follows no one", async () => {
    const loaded = await loadVideoMediaCandidates(mediaClient([]), VIEWER);
    assert.equal(loaded.candidates.length, 0);
  });

  it("degrades to empty when the media read throws (fail-soft §34)", async () => {
    const loaded = await loadVideoMediaCandidates(throwingClient(), VIEWER);
    assert.equal(loaded.candidates.length, 0);
  });
});

// ── 3. Shared Moments ─────────────────────────────────────────────────────────

describe("loadSharedMomentCandidates (spec §12)", () => {
  const MOMENT = { id: "m-1", owner_id: "owner-1", title: "Sunset crew", description: null, place_id: "place-1", trip_id: null, status: "active", created_at: "2026-09-01T18:00:00Z", join_policy: "invite_only" };
  const MEMBERS = [
    { moment_id: "m-1", user_id: "owner-1", status: "accepted" },
    { moment_id: "m-1", user_id: "friend-1", status: "accepted" },
    { moment_id: "m-1", user_id: VIEWER, status: "accepted" },
    { moment_id: "m-1", user_id: "blocked-1", status: "accepted" },
  ];
  const PROFILES = [
    { id: "owner-1", display_name: "Owner", username: "own", account_status: "active" },
    { id: "friend-1", display_name: "Friend", username: "fr", account_status: "active" },
  ];
  const PLACES = [{ id: "place-1", name: "Rooftop", city: "Bangkok", country_code: "TH" }];

  // shared_moments capability requires the whole Live Places flag chain ON.
  const ON_FLAGS: Record<string, boolean> = {
    external_places_enabled: true, live_places_enabled: true, place_days_enabled: true, shared_moments_enabled: true,
  };

  function momentClient(flags: Record<string, boolean>, blocks: any[] = []) {
    return tableClient({
      feature_flags: (ctx) => [{ enabled: !!flags[String(ctx.eqs["flag"])] }],
      shared_moment_memberships: (ctx) =>
        ctx.ins["moment_id"] ? MEMBERS : [{ role: "member", status: "accepted", shared_moments: MOMENT }],
      blocks,
      profiles: PROFILES,
      places: PLACES,
    });
  }

  it("emits nothing when the Shared Moments capability is off (fail-closed)", async () => {
    const loaded = await loadSharedMomentCandidates(momentClient({ ...ON_FLAGS, shared_moments_enabled: false }), VIEWER);
    assert.equal(loaded.candidates.length, 0);
  });

  it("surfaces an accepted moment with block-filtered coarse participants", async () => {
    const loaded = await loadSharedMomentCandidates(
      momentClient(ON_FLAGS, [{ blocker_id: VIEWER, blocked_id: "blocked-1" }]),
      VIEWER,
    );
    assert.equal(loaded.candidates.length, 1);
    const c = loaded.candidates[0];
    assert.equal(c.objectType, "shared_moment");
    assert.equal(c.canonicalObjectId, "m-1");
    assert.equal(c.authorId, "owner-1");
    assert.equal(c.callerVisibilityResolved, true);
    assert.equal(c.place?.city, "Bangkok");
    const pids = (c.participants ?? []).map((p) => p.userId);
    assert.ok(pids.includes("owner-1") && pids.includes("friend-1"), "co-members surfaced");
    assert.ok(!pids.includes(VIEWER), "the viewer is not a participant label");
    assert.ok(!pids.includes("blocked-1"), "a blocked co-member is filtered out");
  });

  it("drops a shared moment whose OWNER is suspended/banned (D4 — real status, not hardcoded 'active')", async () => {
    // Owner profile is suspended. Before the fix the loader hardcoded
    // authorAccountStatus:'active', so passesEligibility could never drop it.
    const suspendedOwner = tableClient({
      feature_flags: (ctx) => [{ enabled: !!ON_FLAGS[String(ctx.eqs["flag"])] }],
      shared_moment_memberships: (ctx) =>
        ctx.ins["moment_id"] ? MEMBERS : [{ role: "member", status: "accepted", shared_moments: MOMENT }],
      blocks: [],
      profiles: [
        { id: "owner-1", display_name: "Owner", username: "own", account_status: "suspended" },
        { id: "friend-1", display_name: "Friend", username: "fr", account_status: "active" },
      ],
      places: PLACES,
    });
    const loaded = await loadSharedMomentCandidates(suspendedOwner, VIEWER);
    assert.equal(loaded.candidates.length, 1, "loader emits it; the eligibility gate decides");
    assert.equal(
      loaded.candidates[0].authorAccountStatus,
      "suspended",
      "the real owner status is threaded, not a hardcoded 'active'",
    );
    // No block staged — the ONLY reason to drop is the suspended owner (eligibility).
    const projected = await projectObjects(blocksClient(), loaded.candidates, viewerCtx());
    assert.equal(projected.length, 0, "passesEligibility drops the suspended owner's moment");
  });

  it("freezes to the For You snapshot: a Moment created after the horizon is excluded (D5)", async () => {
    const lateMoment = { ...MOMENT, id: "m-late", created_at: "2026-09-10T00:00:00Z" };
    const mkClient = () =>
      tableClient({
        feature_flags: (ctx) => [{ enabled: !!ON_FLAGS[String(ctx.eqs["flag"])] }],
        shared_moment_memberships: (ctx) =>
          ctx.ins["moment_id"]
            ? [{ moment_id: "m-late", user_id: VIEWER, status: "accepted" }]
            : [{ role: "member", status: "accepted", shared_moments: lateMoment }],
        blocks: [],
        profiles: PROFILES,
        places: PLACES,
      });
    // Snapshot BEFORE the moment's created_at ⇒ it must not enter mid-pagination.
    const frozen = await loadSharedMomentCandidates(mkClient(), VIEWER, { snapshotAtIso: "2026-09-05T00:00:00Z" });
    assert.equal(frozen.candidates.length, 0, "a post-snapshot moment is excluded from the frozen set");
    // No horizon ⇒ the moment surfaces normally.
    const live = await loadSharedMomentCandidates(mkClient(), VIEWER);
    assert.equal(live.candidates.length, 1, "without a horizon the moment surfaces");
  });

  it("a moment owned by a blocked user is dropped by the gate", async () => {
    const loaded = await loadSharedMomentCandidates(momentClient(ON_FLAGS), VIEWER);
    // Viewer has blocked the owner ⇒ projectObjects drops it (block gate).
    const projected = await projectObjects(
      blocksClient([{ blocker_id: VIEWER, blocked_id: "owner-1" }]),
      loaded.candidates,
      viewerCtx(),
    );
    assert.equal(projected.length, 0);
  });

  it("degrades to empty when the membership read throws (fail-soft §34)", async () => {
    // Flags read succeeds (capability on) but the membership read throws.
    const c: any = {
      from(table: string) {
        const b: any = {
          select: () => b, eq: () => b, in: () => b, or: () => b, order: () => b, limit: () => b,
          maybeSingle: () => Promise.resolve({ data: { enabled: true }, error: null }),
          then: (onF: any, onR: any) =>
            table === "feature_flags"
              ? Promise.resolve({ data: [], error: null }).then(onF, onR)
              : Promise.reject(new Error("boom")).then(undefined, onR),
        };
        return b;
      },
    };
    const loaded = await loadSharedMomentCandidates(c, VIEWER);
    assert.equal(loaded.candidates.length, 0);
  });
});

// ── 4. Merge / dedupe + mixed feed ────────────────────────────────────────────

function cand(over: Partial<WallCandidate>): WallCandidate {
  return { objectType: "social_post", canonicalObjectId: "x", authorId: "author-1", visibility: "public", publishedAt: "2026-09-01T00:00:00Z", ...over };
}
function loaded(candidates: WallCandidate[], signals: Array<[string, any]> = [], places: Array<[string, any]> = []): LoadedWallCandidates {
  return { candidates, signals: new Map(signals), placeByObject: new Map(places) };
}

describe("mergeLoadedCandidates", () => {
  it("keeps the richest projection per canonical object (postcard beats plain post)", () => {
    const base = loaded([cand({ canonicalObjectId: "p1", objectType: "social_post" })]);
    const postcards = loaded([cand({ canonicalObjectId: "p1", objectType: "postcard", media: [{ mediaId: "m", kind: "image", url: "u" }] })]);
    const merged = mergeLoadedCandidates(base, postcards);
    assert.equal(merged.candidates.length, 1);
    assert.equal(merged.candidates[0].objectType, "postcard");
  });

  it("prefers a media-populated projection over a media-less one of the same type", () => {
    const base = loaded([cand({ canonicalObjectId: "p2", objectType: "video" })]); // no media
    const media = loaded([cand({ canonicalObjectId: "p2", objectType: "video", media: [{ mediaId: "m", kind: "video", url: "u" }] })]);
    const merged = mergeLoadedCandidates(base, media);
    assert.equal(merged.candidates.length, 1);
    assert.equal(merged.candidates[0].media?.length, 1);
  });

  it("unions signals + places first-writer-wins and keeps distinct ids", () => {
    const base = loaded([cand({ canonicalObjectId: "a" })], [["a", { saveCount: 9 }]], [["a", { placeId: "pl-a", name: "A" }]]);
    const extra = loaded(
      [cand({ canonicalObjectId: "a", objectType: "postcard" }), cand({ canonicalObjectId: "b", objectType: "shared_moment", callerVisibilityResolved: true })],
      [["a", { saveCount: 0 }], ["b", { saveCount: 1 }]],
      [["b", { placeId: "pl-b", name: "B" }]],
    );
    const merged = mergeLoadedCandidates(base, extra);
    assert.deepEqual(merged.candidates.map((c) => c.canonicalObjectId).sort(), ["a", "b"]);
    assert.equal(merged.signals.get("a")?.saveCount, 9, "base signal for 'a' is preserved");
    assert.equal(merged.signals.get("b")?.saveCount, 1, "new signal for 'b' is added");
    assert.equal(merged.placeByObject.get("a")?.placeId, "pl-a");
    assert.equal(merged.placeByObject.get("b")?.placeId, "pl-b");
  });

  it("a failing loader that returned empty leaves the base untouched", () => {
    const base = loaded([cand({ canonicalObjectId: "p1" })]);
    const failed = loaded([]); // what a fail-soft loader returns on error
    const merged = mergeLoadedCandidates(base, failed, failed, failed);
    assert.deepEqual(merged.candidates.map((c) => c.canonicalObjectId), ["p1"]);
  });

  it("a merged mixed feed still gates + dedups through projectObjects", async () => {
    const base = loaded([
      cand({ canonicalObjectId: "p1", objectType: "social_post" }),
      cand({ canonicalObjectId: "p2", authorId: "author-2", visibility: "private" }), // dropped by gate
    ]);
    const postcards = loaded([cand({ canonicalObjectId: "p1", objectType: "postcard", media: [{ mediaId: "m", kind: "image", url: "u" }] })]);
    const moments = loaded([cand({ canonicalObjectId: "m1", objectType: "shared_moment", authorId: "author-3", callerVisibilityResolved: true })]);
    const merged = mergeLoadedCandidates(base, postcards, moments);
    const projected = await projectObjects(blocksClient(), merged.candidates, viewerCtx());
    const byId = new Map(projected.map((p) => [p.canonicalObjectId, p]));
    assert.equal(byId.get("p1")?.objectType, "postcard", "p1 kept its richest (postcard) projection");
    assert.equal(byId.get("m1")?.objectType, "shared_moment", "the consented moment is admitted");
    assert.ok(!byId.has("p2"), "the private post from another author is gated out");
  });
});
