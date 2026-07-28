/**
 * portavaFeed.test.ts
 *
 * Confirms that a new user who has only auto-followed @Portava actually sees
 * @Portava content in the feed — not an empty screen despite the follow row
 * existing.
 *
 * Covers:
 *   A. Pulse crew tab — user who only follows @Portava sees @Portava's posts
 *   B. Pulse crew tab — user who follows nobody gets an empty feed (not a crash)
 *   C. Watch/Roam feed (feedType=following) — user who only follows @Portava
 *      gets @Portava items
 *
 * Strategy: fake Supabase client injected via _setTestClient (which also sets
 * the service client override).  The fake handles every table the route
 * queries; unknown tables return [].
 *
 * Run: node --import tsx/esm --test src/test/portavaFeed.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express, { type Express } from "express";
import { _setTestClient } from "../lib/http.js";
import { invalidateFlagsCache } from "../compass/flags.js";

// ── Stable UUIDs ──────────────────────────────────────────────────────────────

const CALLER_ID  = "ca110000-0000-4000-a000-000000000001";
const PORTAVA_ID = "pv000000-0000-4000-a000-000000000001";

// ── Post / media factories ────────────────────────────────────────────────────

let _postSeq = 0;
function makePostId(): string {
  const seq = ++_postSeq;
  return `${seq.toString(16).padStart(8, "0")}-0000-4000-a000-000000000001`;
}

function makePost(overrides: Record<string, any> = {}): Record<string, any> {
  const id = overrides.id ?? makePostId();
  return {
    id,
    author_id:        overrides.author_id ?? PORTAVA_ID,
    content:          overrides.content ?? "@Portava official post",
    created_at:       overrides.created_at ?? new Date().toISOString(),
    visibility:       "public",
    status:           "active",
    post_status:      "published",
    category:         null,
    location_name:    null,
    location_city:    null,
    location_country: null,
    location_source:  null,
    location_verified: false,
    location_lat:     null,
    location_lng:     null,
    save_count:       0,
    like_count:       0,
    comment_count:    0,
    media_urls:       [],
    trip_id:          null,
    has_video:        overrides.has_video ?? false,
    pulse_geo_tags:   null,
    post_media:       overrides.post_media ?? [],
    profiles: overrides.profiles ?? {
      id:             overrides.author_id ?? PORTAVA_ID,
      username:       "portava",
      full_name:      "Portava",
      avatar_url:     null,
      verified:       true,
      is_official:    true,
      is_private:     false,
      bio:            "The official Portava account",
      account_status: "active",
    },
    ...overrides,
  };
}

function makeVideoMedia(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    id:                 overrides.id ?? "vm-0001",
    media_type:         "video",
    public_url:         "https://cdn.example.com/video.mp4",
    thumbnail_url:      null,
    thumbnail_path:     null,
    duration_seconds:   15,
    width:              1080,
    height:             1920,
    sort_order:         0,
    processing_status:  "ready",
    moderation_status:  "approved",
    storage_path:       "post-media/video.mp4",
    storage_bucket:     "post-media",
    ...overrides,
  };
}

// ── Fake client factory ───────────────────────────────────────────────────────

interface FakeState {
  posts?:       Array<Record<string, any>>;
  userFollows?: Array<{ follower_id: string; following_id: string }>;
  featureFlags?: Array<{ flag: string; enabled: boolean }>;
}

function makeClient(state: FakeState = {}) {
  const db: Record<string, any[]> = {
    posts:                      state.posts ?? [],
    user_follows:               state.userFollows ?? [],
    feature_flags:              state.featureFlags ?? [
      { flag: "COMPASS_ENABLED",          enabled: true  },
      { flag: "MEDIA_FOLLOWING_ENABLED",  enabled: true  },
      { flag: "MEDIA_FOR_YOU_ENABLED",    enabled: true  },
      { flag: "PORTAVA_PUBLISHER_BOOST_ENABLED", enabled: false },
    ],
    // All other tables return [] so non-fatal fallbacks work correctly.
    blocks:                     [],
    post_hides:                 [],
    post_saves:                 [],
    portava_featured:           [],
    profile_privacy_settings:   [],
    user_mutes:                 [],
    compass_profiles:           [
      {
        user_id:          CALLER_ID,
        current_city:     "Manila",
        persona_type:     "explorer",
        travel_intensity: "moderate",
        active_trip_id:   null,
        vibe_tags:        [],
      },
    ],
    compass_user_preferences:   [],
    hashtag_usage:              [],
    hashtags:                   [],
    tags:                       [],
    mention_tags:               [],
    profiles:                   [],
    user_location_state:        [{ user_id: CALLER_ID, city: "Manila", country: "Philippines" }],
    trust_profiles:             [],
    user_preference_profiles:   [],
    user_location_preferences:  [],
    safe_return_sessions:       [],
    rent_buddy_bookings:        [],
    trips:                      [],
    trip_members:               [],
    ranking_events:             [],
    stamp_overlays:             [],
  };

  function builder(table: string, rows: any[]) {
    let filtered = [...rows];

    const b: any = {
      select:   (_cols?: string) => builder(table, rows),
      eq:       (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      neq:      (col: string, val: any) => {
        filtered = filtered.filter((r) => r[col] !== val);
        return b;
      },
      in:       (col: string, vals: any[]) => {
        filtered = filtered.filter((r) => vals.includes(r[col]));
        return b;
      },
      not:      (col: string, op: string, val: any) => {
        if (op === "in") {
          filtered = filtered.filter((r) => !val.includes(r[col]));
        } else if (op === "is") {
          if (val === null) filtered = filtered.filter((r) => r[col] != null);
        }
        return b;
      },
      is:       (col: string, val: any) => {
        if (val === null) filtered = filtered.filter((r) => r[col] == null);
        else filtered = filtered.filter((r) => r[col] === val);
        return b;
      },
      lt:       () => b,
      lte:      () => b,
      gt:       () => b,
      gte:      () => b,
      like:     () => b,
      ilike:    () => b,
      contains: () => b,
      overlaps: () => b,
      or:       () => b,
      order:    () => b,
      limit:    () => b,
      range:    () => b,
      maybeSingle: () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      single:      () => Promise.resolve({ data: filtered[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: [...filtered], error: null }),
    };
    return b;
  }

  return {
    auth: {
      getUser: (token?: string) => {
        if (token === "caller-token") {
          return Promise.resolve({ data: { user: { id: CALLER_ID } }, error: null });
        }
        return Promise.resolve({ data: { user: null }, error: { message: "bad token" } });
      },
    },
    from: (table: string) => {
      const rows = db[table] ?? [];
      return builder(table, rows);
    },
    rpc: () => Promise.resolve({ data: null, error: null }),
  };
}

// ── Server helpers ────────────────────────────────────────────────────────────

async function startServer(app: Express) {
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = createServer(app).listen(0, "127.0.0.1", () => {
      const addr = srv.address() as { port: number };
      resolve({
        url:   `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((res) => srv.close(() => res(undefined))),
      });
    });
  });
}

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  // Stub req.log — pulse and mediaFeed routes call req.log.error / req.log.warn.
  app.use((req: any, _res: any, next: any) => {
    req.log = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} };
    next();
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// A: Pulse crew tab — only follows @Portava → @Portava posts appear
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/pulse?tab=crew — new user only follows @Portava", async () => {
  let url: string;
  let close: () => Promise<void>;

  const portavaPost = makePost({ author_id: PORTAVA_ID, content: "Official Portava post" });

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    _setTestClient(
      makeClient({
        posts:       [portavaPost],
        userFollows: [{ follower_id: CALLER_ID, following_id: PORTAVA_ID }],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns at least one @Portava post for a user who only follows @Portava", async () => {
    const r = await fetch(`${url}/api/pulse?tab=crew`, {
      headers: { Authorization: "Bearer caller-token" },
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.posts), "response.posts must be an array");
    const portavaPosts = (body.posts as any[]).filter((p: any) => p.authorId === PORTAVA_ID);
    assert.ok(
      portavaPosts.length >= 1,
      `Expected at least 1 @Portava post, got ${portavaPosts.length}. authorIds=${JSON.stringify((body.posts as any[]).map((p: any) => p.authorId))}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B: Pulse crew tab — user with no follows gets empty feed (not crash)
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/pulse?tab=crew — user follows nobody", async () => {
  let url: string;
  let close: () => Promise<void>;

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: pulseRouter } = await import("../routes/pulse.js");
    app.use("/api", pulseRouter);
    ({ url, close } = await startServer(app));

    _setTestClient(
      makeClient({
        posts:       [makePost({ author_id: PORTAVA_ID })],
        userFollows: [],   // no follows
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns 200 with an empty posts array — no crash", async () => {
    const r = await fetch(`${url}/api/pulse?tab=crew`, {
      headers: { Authorization: "Bearer caller-token" },
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.posts), "response.posts must be an array");
    assert.equal(body.posts.length, 0, "crew feed must be empty when no one is followed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C: Watch/Roam feed (feedType=following) — only follows @Portava → items appear
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/media/feed?feedType=following — new user only follows @Portava", async () => {
  let url: string;
  let close: () => Promise<void>;

  const portavaVideoPost = makePost({
    author_id: PORTAVA_ID,
    content:   "Official Portava video",
    has_video: true,
    post_media: [makeVideoMedia()],
  });

  before(async () => {
    invalidateFlagsCache();
    const app = makeApp();
    const { default: mediaFeedRouter } = await import("../routes/mediaFeed.js");
    app.use("/api", mediaFeedRouter);
    ({ url, close } = await startServer(app));

    _setTestClient(
      makeClient({
        posts:       [portavaVideoPost],
        userFollows: [{ follower_id: CALLER_ID, following_id: PORTAVA_ID }],
      }),
      true,
    );
  });

  after(async () => {
    await close();
    _setTestClient(null as any, false);
  });

  it("returns at least one @Portava item for a user who only follows @Portava", async () => {
    const r = await fetch(`${url}/api/media/feed?mode=fullscreen&feedType=following`, {
      headers: { Authorization: "Bearer caller-token" },
    });
    assert.equal(r.status, 200, `Expected 200, got ${r.status}`);
    const body = await r.json() as any;
    assert.ok(Array.isArray(body.items), "response.items must be an array");
    // Watch/Roam feed items expose creatorId (not authorId) per hydrateMediaFeedItem
    const portavaItems = (body.items as any[]).filter(
      (item: any) => item.creatorId === PORTAVA_ID || item.creator?.id === PORTAVA_ID,
    );
    assert.ok(
      portavaItems.length >= 1,
      `Expected at least 1 @Portava item, got ${portavaItems.length}. creatorIds=${JSON.stringify((body.items as any[]).map((i: any) => i.creatorId ?? i.creator?.id))}`,
    );
  });
});
