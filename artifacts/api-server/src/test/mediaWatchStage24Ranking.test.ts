/**
 * census-media §34 (owner decision F2; MD11, MD215, MD402, MD435) — the Watch
 * feed ordered by the §24 Media Ranking stage behind
 * MEDIA_WATCH_STAGE24_RANKING_ENABLED, seeded OFF by migration 3343.
 *
 * What these cases prove, through the real route (routes/mediaFeed.ts GET
 * /media/feed) over a fake PostgREST client:
 *
 *   OFF (absent, FALSE, unreadable) — the page is ordered exactly as today: by
 *     the legacy rankMediaFeed, which with MEDIA_RANKING_ENABLED off (the
 *     production value) is the DB order, and with it on lets the stamp count
 *     lift a post.
 *   ON — the same admitted page, in the order the §24 stage gives: a post the
 *     viewer said they want ("I Want This", media_intent_signals) leads, the
 *     stamp count moves nothing, every admitted post is served exactly once,
 *     impressions log the §24 terms (s24_*) and no legacy "Why This?"
 *     snapshot is written.
 *
 * And the three migration files: each seeds its flag FALSE, refuses a seed
 * that finds it ON, and its rollback refuses to delete a row that is ON.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";
import {
  isWatchStage24RankingEnabled,
  orderWatchCandidatesByStage24,
  stage24Features,
} from "../services/media/WatchStage24Ranking.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const REPO = join(SRC, "..", "..", "..");

const VIEWER_ID = "aaaaaaaa-0000-4000-a000-000000000001";
const CREATOR_A = "bbbbbbbb-0000-4000-a000-000000000002";
const CREATOR_B = "cccccccc-0000-4000-a000-000000000003";
const P_NEW = "11111111-0000-4000-a000-000000000001";
const P_OLD = "22222222-0000-4000-a000-000000000002";
const TOKEN = "test-watch-stage24-token";
const SB_URL = "http://sb.test";
const FLAG = "MEDIA_WATCH_STAGE24_RANKING_ENABLED";

function post(id: string, author: string, createdAt: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    author_id: author,
    status: "active",
    post_status: "published",
    visibility: "public",
    moderation_status: "approved",
    created_at: createdAt,
    tags: [],
    has_video: true,
    category: "food",
    post_media: [{
      id: `media-${id.slice(0, 4)}`,
      media_type: "video",
      public_url: `${SB_URL}/storage/v1/object/public/post-media/${id}.mp4`,
      thumbnail_url: null,
      duration_seconds: 15,
      width: 1080,
      height: 1920,
      sort_order: 0,
      processing_status: "ready",
      moderation_status: "approved",
    }],
    profiles: {
      id: author,
      username: `u_${author.slice(0, 4)}`,
      full_name: "Creator",
      avatar_url: null,
      is_private: false,
      is_verified: false,
      bio: "Bio",
      followers_count: 10,
      following_count: 5,
      account_status: "active",
    },
    ...extra,
  };
}

/** DB order is the order listed here (the fake's `.order()` is a no-op): newest first, as the route asks. */
const POSTS = [
  post(P_NEW, CREATOR_B, "2025-01-01T12:00:00Z"),
  post(P_OLD, CREATOR_A, "2025-01-01T10:00:00Z"),
];

interface Fake {
  tables: Record<string, any[]>;
  inserted: Array<{ table: string; rows: any[] }>;
  /** When set, every feature_flags read answers with this error. */
  flagError?: { message: string };
}

function makeClient(fake: Fake) {
  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    const rows = () => (fake.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const result = () =>
      table === "feature_flags" && fake.flagError
        ? { data: null, error: fake.flagError }
        : { data: rows(), error: null };
    const b: any = {
      select() { return b; },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      not() { return b; },
      is(col: string, val: any) { filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return b; },
      or() { return b; },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return b; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return b; },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      ilike() { return b; },
      contains() { return b; },
      maybeSingle() {
        const r = result();
        return Promise.resolve(r.error ? r : { data: (r.data as any[])[0] ?? null, error: null });
      },
      single() {
        const r = rows()[0];
        return Promise.resolve(r ? { data: r, error: null } : { data: null, error: { message: "No rows" } });
      },
      upsert(payload: any) {
        fake.inserted.push({ table, rows: Array.isArray(payload) ? payload : [payload] });
        return Promise.resolve({ data: null, error: null });
      },
      insert(payload: any) {
        fake.inserted.push({ table, rows: Array.isArray(payload) ? payload : [payload] });
        return Promise.resolve({ data: null, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve(result()).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from: builder,
    rpc: () => Promise.resolve({ data: null, error: { message: "no rpc in this fake" } }),
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
  };
}

function fakeWith(opts: {
  stage24?: boolean | "absent";
  legacyRanking?: boolean;
  wants?: string[];
  stampsOnNew?: number;
  flagError?: boolean;
}): Fake {
  const flags: any[] = [
    { flag: "MEDIA_FOR_YOU_ENABLED", enabled: true },
    { flag: "MEDIA_FOLLOWING_ENABLED", enabled: true },
    { flag: "MEDIA_RANKING_ENABLED", enabled: opts.legacyRanking ?? false },
  ];
  if (opts.stage24 !== undefined && opts.stage24 !== "absent") flags.push({ flag: FLAG, enabled: opts.stage24 });
  const stamps = Array.from({ length: opts.stampsOnNew ?? 0 }, (_, i) => ({
    entity_type: "media", entity_id: P_NEW, user_id: `stamper-${i}`,
  }));
  return {
    tables: {
      posts: POSTS,
      feature_flags: flags,
      content_stamps: stamps,
      media_intent_signals: (opts.wants ?? []).map((id) => ({
        user_id: VIEWER_ID, media_id: id, entity_type: "media", entity_id: id, updated_at: "2025-01-02T00:00:00Z",
      })),
    },
    inserted: [],
    flagError: opts.flagError ? { message: "flag read failed" } : undefined,
  };
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
    next();
  });
  app.use(mediaFeedRouter);
  return app;
}

async function watchOrder(base: string, fake: Fake): Promise<string[]> {
  _setTestClient(makeClient(fake), true);
  const resp = await fetch(`${base}/media/feed?mode=fullscreen&feedType=for_you&limit=10`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  const body: any = await resp.json();
  assert.equal(resp.status, 200, JSON.stringify(body));
  // Impressions and snapshots are written fire-and-forget after the response.
  await new Promise((r) => setTimeout(r, 60));
  return (body.items as any[]).map((i) => i.id);
}

describe("census-media §34 — GET /media/feed with the §24 stage flag", () => {
  let server: http.Server;
  let base: string;
  before(async () => {
    server = http.createServer(makeApp());
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => { server.close(); });

  it("OFF by absence: today's order — with MEDIA_RANKING_ENABLED off, the DB order, whatever the viewer wants", async () => {
    assert.deepEqual(await watchOrder(base, fakeWith({ stage24: "absent", wants: [P_OLD] })), [P_NEW, P_OLD]);
  });

  it("OFF as a FALSE row: identical to absent", async () => {
    assert.deepEqual(await watchOrder(base, fakeWith({ stage24: false, wants: [P_OLD] })), [P_NEW, P_OLD]);
  });

  it("OFF with the legacy ranker on: the legacy ranker still decides, and writes its Why-This snapshot", async () => {
    const fake = fakeWith({ stage24: false, legacyRanking: true, wants: [P_OLD], stampsOnNew: 40 });
    assert.deepEqual(await watchOrder(base, fake), [P_NEW, P_OLD]);
    assert.ok(fake.inserted.some((i) => i.table === "media_ranking_snapshots"), "the legacy snapshot is written as today");
    const impressions = fake.inserted.find((i) => i.table === "rank_events")?.rows ?? [];
    assert.equal(impressions.length, 2);
    assert.ok(impressions.every((r) => !Object.keys(r.features).some((k) => k.startsWith("s24_"))), "no §24 term is logged while OFF");
  });

  it("ON: the §24 stage orders the page — the post the viewer wants leads", async () => {
    assert.deepEqual(await watchOrder(base, fakeWith({ stage24: true, wants: [P_OLD] })), [P_OLD, P_NEW]);
    // and it is the want that moved it: move the want, the order follows
    assert.deepEqual(await watchOrder(base, fakeWith({ stage24: true, wants: [P_NEW] })), [P_NEW, P_OLD]);
  });

  it("ON: the stamp count moves nothing, even with the legacy ranker's master switch on", async () => {
    const fake = fakeWith({ stage24: true, legacyRanking: true, wants: [P_OLD], stampsOnNew: 40 });
    assert.deepEqual(await watchOrder(base, fake), [P_OLD, P_NEW]);
    assert.ok(!fake.inserted.some((i) => i.table === "media_ranking_snapshots"), "no legacy Why-This snapshot for a page the legacy ranker did not order");
    const impressions = fake.inserted.find((i) => i.table === "rank_events")?.rows ?? [];
    assert.deepEqual(impressions.map((r) => r.item_id), [P_OLD, P_NEW]);
    for (const r of impressions) {
      assert.equal(typeof r.features.s24_score, "number", "each impression logs the §24 score it was ordered by");
      assert.equal(typeof r.features.s24_intent, "number");
      assert.ok(!("savesShares" in r.features) && !("watchCompletion" in r.features), "no legacy term is logged");
    }
    assert.equal(impressions[0].features.s24_intent, 1);
  });

  it("an unreadable flag is OFF: today's order", async () => {
    // Every feature_flags read fails here, so MEDIA_FOR_YOU_ENABLED would too —
    // this case therefore reads the flag through its reader, not the route.
    const fake = fakeWith({ stage24: true, flagError: true });
    assert.equal(await isWatchStage24RankingEnabled(makeClient(fake) as any), false);
    assert.equal(await isWatchStage24RankingEnabled(null), false);
  });
});

describe("census-media §34 — orderWatchCandidatesByStage24", () => {
  const nowMs = Date.parse("2025-01-02T00:00:00Z");
  const viewer = { viewerId: VIEWER_ID, viewerCountry: null, followedCreatorIds: new Set<string>(), viewerTripIds: new Set<string>() };

  it("returns the SAME objects, each exactly once, and fills the §24 features", async () => {
    const page = POSTS.map((p) => ({ ...p }));
    const features = new Map<string, Record<string, number>>();
    const out = await orderWatchCandidatesByStage24(makeClient(fakeWith({ wants: [P_OLD] })) as any, viewer, page, nowMs, features);
    assert.deepEqual(out.map((c) => c.id), [P_OLD, P_NEW]);
    assert.ok(out.every((c) => page.includes(c)), "no row is copied or invented");
    assert.equal(new Set(out).size, page.length);
    assert.deepEqual([...features.keys()].sort(), [P_NEW, P_OLD].sort());
    assert.ok(Object.keys(features.get(P_OLD)!).every((k) => k.startsWith("s24_")));
  });

  it("an empty page is empty, and reads nothing", async () => {
    const fake = fakeWith({});
    let reads = 0;
    const client = makeClient(fake);
    const counting = { ...client, from: (t: string) => { reads++; return client.from(t); } };
    assert.deepEqual(await orderWatchCandidatesByStage24(counting as any, viewer, [], nowMs), []);
    assert.equal(reads, 0);
  });

  it("stage24Features keeps numbers only, prefixed, and records the §2 partition", () => {
    const f = stage24Features({ score: 0.5, intent: 1, provenanceClass: "synthetic" } as any);
    assert.deepEqual(f, { s24_score: 0.5, s24_intent: 1, s24_synthetic: 1 });
  });
});

describe("census-media §34 — migrations 3340–3343 and their rollbacks", () => {
  const CASES = [
    ["3340_media_tab_world_default_flag.sql", "MEDIA_TAB_WORLD_DEFAULT_ENABLED", "2026-09-27-3340-media-tab-world-default-flag-rollback.sql"],
    ["3341_media_watch_context_overlay_flag.sql", "MEDIA_WATCH_CONTEXT_OVERLAY_ENABLED", "2026-09-27-3341-media-watch-context-overlay-flag-rollback.sql"],
    ["3342_media_watch_tap_to_play_flag.sql", "MEDIA_WATCH_TAP_TO_PLAY_ENABLED", "2026-09-27-3342-media-watch-tap-to-play-flag-rollback.sql"],
    ["3343_media_watch_stage24_ranking_flag.sql", FLAG, "2026-09-27-3343-media-watch-stage24-ranking-flag-rollback.sql"],
  ] as const;

  for (const [file, flag, rollback] of CASES) {
    it(`${file} seeds ${flag} FALSE, is a seed and not DDL, and refuses to find it ON`, () => {
      const code = readFileSync(join(SRC, "migrations", file), "utf8").replace(/--[^\n]*/g, "");
      assert.match(code, new RegExp(`'${flag}',\\s*false,`));
      assert.match(code, /ON CONFLICT \(flag\) DO NOTHING/);
      assert.equal((code.match(/INSERT INTO/g) ?? []).length, 1);
      assert.ok(!/\b(ALTER|CREATE|DROP)\s+(TABLE|TYPE|INDEX|POLICY|FUNCTION)\b/i.test(code));
      assert.ok(!/\bUPDATE\s+public\./i.test(code), "a seed never flips an existing row");
      assert.match(code, new RegExp(`flag = '${flag}' AND enabled = TRUE;\\s*IF on_count <> 0 THEN\\s*RAISE EXCEPTION`));
    });

    it(`${rollback} deletes only a FALSE row and refuses when ${flag} is ON`, () => {
      const code = readFileSync(join(REPO, "db", "rollback", rollback), "utf8").replace(/--[^\n]*/g, "");
      assert.match(code, new RegExp(`flag = '${flag}' AND enabled = TRUE;\\s*IF on_count <> 0 THEN\\s*RAISE EXCEPTION`));
      assert.match(code, new RegExp(`DELETE FROM public\\.feature_flags\\s+WHERE flag = '${flag}' AND enabled = FALSE;`));
    });
  }
});
