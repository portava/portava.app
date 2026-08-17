/**
 * mediaFeed — unit tests for Watch mode feed API.
 *
 * Covers:
 *   A. Eligibility filter — blocks, mutes, visibility, processing state, moderation
 *   B. Cursor stability — second page never repeats items from page 1
 *   C. Creator-cap enforcement — at most maxPerPage items per creator
 *   D. Private-field stripping — private profile exposes only safe fields
 *   E. View-count deduplication — same user + item + type within TTL window
 *   F. Feature flag gating — disabled flags return 404
 *   G. Self-view rejection — POST /media/:id/view rejects own posts
 *   H. Minimum threshold enforcement — qualified_view with watchedMs < minimum not counted
 *
 * Run: node --import tsx/esm --test src/test/mediaFeed.test.ts
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import mediaFeedRouter from "../routes/mediaFeed.js";
import {
  decodeCursor,
  encodeCursor,
  applyCursorFilter,
} from "../lib/mediaCursor.js";
import {
  filterEligibleMediaCandidates,
  loadViewerTripIds,
  type MediaCandidate,
} from "../lib/mediaEligibility.js";
import { hydrateMediaFeedItem, hydrateMediaGridItem } from "../lib/mediaFeedItem.js";
import {
  enforceCreatorCapsGeneric,
} from "../services/ranking/CreatorCapEnforcer.js";

// ── Shared constants ──────────────────────────────────────────────────────────

const VIEWER_ID = "aaaaaaaa-0000-4000-a000-000000000001";
const CREATOR_A = "bbbbbbbb-0000-4000-a000-000000000002";
const CREATOR_B = "cccccccc-0000-4000-a000-000000000003";
const CREATOR_C = "dddddddd-0000-4000-a000-000000000004";
const POST_1   = "11111111-0000-4000-a000-000000000001";
const POST_2   = "22222222-0000-4000-a000-000000000002";
const POST_3   = "33333333-0000-4000-a000-000000000003";
const TOKEN = "test-media-feed-token";
const SB_URL = "http://sb.example.test";

// ── Fake media row builder ────────────────────────────────────────────────────

function makePost(overrides: Record<string, any> = {}): MediaCandidate {
  return {
    id: overrides.id ?? POST_1,
    author_id: overrides.author_id ?? CREATOR_A,
    status: overrides.status ?? "active",
    post_status: overrides.post_status ?? "published",
    visibility: overrides.visibility ?? "public",
    moderation_status: overrides.moderation_status ?? "approved",
    created_at: overrides.created_at ?? "2024-01-15T12:00:00Z",
    tags: overrides.tags ?? [],
    post_media: overrides.post_media ?? [makeMedia()],
    profiles: overrides.profiles ?? makeProfile({ id: overrides.author_id ?? CREATOR_A }),
    ...overrides,
  };
}

function makeMedia(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? "media-1",
    media_type: overrides.media_type ?? "video",
    public_url: overrides.public_url ?? `${SB_URL}/storage/v1/object/public/post-media/vid.mp4`,
    thumbnail_url: null,
    duration_seconds: 15,
    width: 1080,
    height: 1920,
    sort_order: 0,
    processing_status: overrides.processing_status ?? "ready",
    moderation_status: overrides.moderation_status ?? "approved",
    ...overrides,
  };
}

function makeProfile(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? CREATOR_A,
    username: overrides.username ?? "creator_a",
    full_name: overrides.full_name ?? "Creator A",
    avatar_url: null,
    is_private: overrides.is_private ?? false,
    is_verified: false,
    bio: overrides.bio ?? "Bio text",
    followers_count: 100,
    following_count: 50,
    account_status: overrides.account_status ?? "active",
    ...overrides,
  };
}

// ── Fake Supabase client factory ──────────────────────────────────────────────

interface FakeState {
  posts?: any[];
  postMedia?: any[];
  profiles?: any[];
  blocks?: Array<{ blocker_id: string; blocked_id: string }>;
  mutes?: Array<{ muter_id: string; muted_id: string }>;
  featureFlags?: Array<{ flag: string; enabled: boolean }>;
  userFollows?: Array<{ follower_id: string; following_id: string }>;
  postSaves?: Array<{ user_id: string; post_id: string }>;
  postReactions?: Array<{ user_id: string; post_id: string }>;
  followRequests?: Array<{ requester_id: string; target_id: string; status: string }>;
  rankEvents?: any[];
  compassPrefs?: any[];
}

function makeClient(state: FakeState = {}) {
  const insertedRows: Array<{ table: string; row: any }> = [];
  const updatedRows: Array<{ table: string; where: any; data: any }> = [];

  function builder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let selectCols = "*";
    let limitVal = 1000;
    const orderSpecs: Array<{ col: string; asc: boolean }> = [];
    let single = false;
    let maybeSingle_ = false;
    let insertPayload: any = null;
    let updatePayload: any = null;

    const rows = (): any[] => {
      const src: any[] =
        table === "posts"                ? state.posts ?? [] :
        table === "post_media"           ? state.postMedia ?? [] :
        table === "profiles"             ? state.profiles ?? [] :
        table === "blocks"               ? state.blocks ?? [] :
        table === "user_mutes"           ? state.mutes ?? [] :
        table === "feature_flags"        ? state.featureFlags ?? [] :
        table === "user_follows"         ? state.userFollows ?? [] :
        table === "post_saves"           ? state.postSaves ?? [] :
        table === "post_reactions"       ? state.postReactions ?? [] :
        table === "follow_requests"      ? state.followRequests ?? [] :
        table === "rank_events"          ? state.rankEvents ?? [] :
        table === "compass_user_preferences" ? state.compassPrefs ?? [] :
        [];
      let filtered = src.filter((r: any) => filters.every((f) => f(r)));
      if (orderSpecs.length > 0) {
        // Multi-column ordering, first spec wins ties broken by later specs —
        // matches PostgREST chained .order() calls (e.g. created_at desc, id desc).
        filtered = filtered.sort((a: any, b: any) => {
          for (const { col, asc } of orderSpecs) {
            if (a[col] < b[col]) return asc ? -1 : 1;
            if (a[col] > b[col]) return asc ? 1 : -1;
          }
          return 0;
        });
      }
      return filtered.slice(0, limitVal);
    };

    const b: any = {
      select(cols?: string) { selectCols = cols ?? "*"; return b; },
      insert(row: any) {
        insertPayload = row;
        insertedRows.push({ table, row });
        return b;
      },
      update(data: any) {
        updatePayload = data;
        updatedRows.push({ table, where: [...filters], data });
        return b;
      },
      eq(col: string, val: any) { filters.push((r) => r[col] === val); return b; },
      neq(col: string, val: any) { filters.push((r) => r[col] !== val); return b; },
      in(col: string, vals: any[]) { filters.push((r) => vals.includes(r[col])); return b; },
      not(col: string, op: string, val: any) {
        if (op === "in") filters.push((r) => !String(val).split(",").includes(String(r[col])));
        return b;
      },
      is(col: string, val: any) {
        filters.push((r) => val === null ? r[col] == null : r[col] === val);
        return b;
      },
      or(expr?: string) {
        // Implements the keyset-cursor shape produced by applyCursorFilter():
        //   "<col>.lt.<v>,and(<col>.eq.<v>,<col2>.lt.<v2>)"
        // A no-op here would make paginated grid requests re-serve page 1
        // rows, so the cursor-stability test would test nothing.
        const m = typeof expr === "string"
          ? expr.match(/^(\w+)\.lt\.(.+),and\(\1\.eq\.\2,(\w+)\.lt\.(.+)\)$/)
          : null;
        if (m) {
          const [, col, val, col2, val2] = m;
          filters.push((r) => r[col] < val || (r[col] === val && r[col2] < val2));
        }
        return b;
      },
      gte(col: string, val: any) { filters.push((r) => r[col] >= val); return b; },
      lte(col: string, val: any) { filters.push((r) => r[col] <= val); return b; },
      gt(col: string, val: any) { filters.push((r) => r[col] > val); return b; },
      lt(col: string, val: any) { filters.push((r) => r[col] < val); return b; },
      order(col: string, opts: any) { orderSpecs.push({ col, asc: opts?.ascending ?? true }); return b; },
      limit(n: number) { limitVal = n; return b; },
      range() { return b; },
      ilike(col: string, pattern: string) {
        const pat = pattern.replace(/%/g, ".*").toLowerCase();
        const re = new RegExp(pat);
        filters.push((r) => re.test(String(r[col] ?? "").toLowerCase()));
        return b;
      },
      contains() { return b; },
      maybeSingle() {
        return Promise.resolve({ data: rows()[0] ?? null, error: null });
      },
      single() {
        if (insertPayload) return Promise.resolve({ data: { id: "new-id", ...insertPayload }, error: null });
        const r = rows()[0];
        if (!r) return Promise.resolve({ data: null, error: { message: "No rows" } });
        return Promise.resolve({ data: r, error: null });
      },
      then(onF: any, onR: any) {
        return Promise.resolve({ data: rows(), error: null }).then(onF, onR);
      },
    };
    return b;
  }

  const client: any = {
    from: builder,
    auth: {
      getUser: async (t: string) =>
        t === TOKEN
          ? { data: { user: { id: VIEWER_ID } }, error: null }
          : { data: { user: null }, error: { message: "bad token" } },
    },
    _inserted: insertedRows,
    _updated: updatedRows,
  };
  return client;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function makeApp() {
  const app = express();
  app.use(express.json());
  // Shim req.log so fire-and-forget handlers (e.g. ranking snapshot .catch)
  // don't throw "Cannot read properties of undefined (reading 'warn')" after
  // the response is sent.  All pino log levels become silent no-ops in tests.
  app.use((req: any, _res: any, next: any) => {
    req.log = { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {} };
    next();
  });
  app.use(mediaFeedRouter);
  return app;
}

async function startServer(app: express.Express): Promise<{ server: http.Server; base: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function jsonFetch(
  base: string,
  path: string,
  opts: { method?: string; body?: any; token?: string } = {},
): Promise<{ status: number; body: any }> {
  const resp = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      authorization: `Bearer ${opts.token ?? TOKEN}`,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any;
  try { body = await resp.json(); } catch { body = null; }
  return { status: resp.status, body };
}

// ─────────────────────────────────────────────────────────────────────────────
// ── A. Eligibility filter unit tests ─────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("filterEligibleMediaCandidates", () => {
  it("excludes blocked creators (both directions)", async () => {
    const post = makePost({ id: POST_1, author_id: CREATOR_A });

    const fakeClient: any = {
      from(table: string) {
        const b: any = {
          select() { return b; },
          eq(col: string, val: any) { return b; },
          then(onF: any) {
            const data =
              table === "blocks" ? [{ blocked_id: CREATOR_A, blocker_id: CREATOR_B }] :
              table === "user_mutes" ? [] :
              table === "profiles" ? [] : [];
            return Promise.resolve({ data, error: null }).then(onF);
          },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
          in() { return b; },
        };
        return b;
      },
    };

    // Viewer is the blocker, CREATOR_A is blocked
    const blockerClient: any = {
      from(table: string) {
        const b: any = {
          select() { return b; },
          eq() { return b; },
          in() { return b; },
          then(onF: any) {
            const data =
              table === "blocks" ? [{ blocked_id: CREATOR_A }] :
              table === "user_mutes" ? [] :
              table === "profiles" ? [{ id: CREATOR_A, account_status: "active" }] : [];
            return Promise.resolve({ data, error: null }).then(onF);
          },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        };
        return b;
      },
    };

    const viewerCtx = {
      viewerUserId: VIEWER_ID,
      feedType: "for_you" as const,
      followedCreatorIds: new Set<string>(),
    };
    // When blocker query returns CREATOR_A in blocked_id, it's excluded
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      viewerCtx,
      blockerClient,
      new Set(), // empty mutes
    );
    assert.equal(eligible.length, 0, "blocked creator's post must be excluded");
  });

  it("excludes posts with no ready media", async () => {
    const post = makePost({
      post_media: [makeMedia({ processing_status: "processing" })],
    });
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      { viewerUserId: VIEWER_ID, feedType: "for_you", followedCreatorIds: new Set() },
      client,
      new Set(),
    );
    assert.equal(eligible.length, 0, "non-ready media must be excluded");
  });

  it("excludes posts with all media moderated out (rejected)", async () => {
    const post = makePost({
      post_media: [makeMedia({ moderation_status: "rejected" })],
    });
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      { viewerUserId: VIEWER_ID, feedType: "for_you", followedCreatorIds: new Set() },
      client,
      new Set(),
    );
    assert.equal(eligible.length, 0, "rejected media must be excluded");
  });

  it("excludes non-public posts from for_you feed", async () => {
    const post = makePost({ visibility: "private" });
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      { viewerUserId: VIEWER_ID, feedType: "for_you", followedCreatorIds: new Set() },
      client,
      new Set(),
    );
    assert.equal(eligible.length, 0, "private posts must be excluded from for_you feed");
  });

  it("excludes private posts from followed creators in following feed", async () => {
    // Inverted deliberately. This previously asserted eligible.length === 1 and
    // encoded the bug: the following branch checked only the follow edge and
    // never read `visibility`, so one follow admitted the author's private
    // posts into Watch and the grid. Following someone is not consent to their
    // private posts.
    const post = makePost({ author_id: CREATOR_A, visibility: "private" });
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      {
        viewerUserId: VIEWER_ID,
        feedType: "following",
        followedCreatorIds: new Set([CREATOR_A]),
      },
      client,
      new Set(),
    );
    assert.equal(eligible.length, 0, "a follow must NOT admit the author's private posts");
  });

  // ── Visibility gate on the following feed ──────────────────────────────────
  //
  // The following branch used to test only the follow edge, computing
  // `visibility` and never reading it. These six pin what each visibility value
  // means once a follow edge exists: a follow is not trip membership and not
  // consent to private posts, but it is still a follow for ordinary content,
  // and the viewer always sees their own.

  const TRIP_ID = "dddddddd-0000-4000-a000-000000000009";

  async function runFollowingGate(post: MediaCandidate, viewerTripIds?: Set<string>) {
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      {
        viewerUserId: VIEWER_ID,
        feedType: "following",
        followedCreatorIds: new Set([CREATOR_A]),
        ...(viewerTripIds ? { viewerTripIds } : {}),
      },
      client,
      new Set(),
    );
    return eligible;
  }

  it("visibility gate: admits an ordinary public post from a followed creator", async () => {
    const eligible = await runFollowingGate(makePost({ author_id: CREATOR_A, visibility: "public" }));
    assert.equal(eligible.length, 1, "public posts from followed creators must still be admitted");
  });

  it("visibility gate: admits a private post authored by the VIEWER themselves", async () => {
    // The self-exemption: you always see what you posted, whatever its
    // visibility. Only OTHER authors' private posts are refused.
    const eligible = await runFollowingGate(makePost({ author_id: VIEWER_ID, visibility: "private" }));
    assert.equal(eligible.length, 1, "the viewer's own private post must remain visible to them");
  });

  it("visibility gate: refuses a trip_only post when the viewer is not in that trip", async () => {
    const post = makePost({ author_id: CREATOR_A, visibility: "trip_only", trip_id: TRIP_ID });
    const eligible = await runFollowingGate(post, new Set(["some-other-trip"]));
    assert.equal(eligible.length, 0, "following an author is not membership of their trip");
  });

  it("visibility gate: admits a trip_only post when the viewer IS in that trip", async () => {
    const post = makePost({ author_id: CREATOR_A, visibility: "trip_only", trip_id: TRIP_ID });
    const eligible = await runFollowingGate(post, new Set([TRIP_ID]));
    assert.equal(eligible.length, 1, "a genuine trip member must still receive trip_only content");
  });

  it("visibility gate: fails closed on a trip_only post with a null trip_id", async () => {
    // Nothing to check membership against — admitting it would mean trusting
    // the visibility label alone.
    const post = makePost({ author_id: CREATOR_A, visibility: "trip_only", trip_id: null });
    const eligible = await runFollowingGate(post, new Set([TRIP_ID]));
    assert.equal(eligible.length, 0, "trip_only with no trip_id must be excluded, not admitted");
  });

  it("visibility gate: fails closed on trip_only when viewerTripIds was never loaded", async () => {
    // The caller-forgot-to-load case, which is also what a double read failure
    // in loadViewerTripIds produces.
    const post = makePost({ author_id: CREATOR_A, visibility: "trip_only", trip_id: TRIP_ID });
    const eligible = await runFollowingGate(post, undefined);
    assert.equal(eligible.length, 0, "absent viewerTripIds must exclude trip_only, not admit it");
  });

  it("excludes pending_delay posts", async () => {
    const post = makePost({ post_status: "pending_delay" });
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      { viewerUserId: VIEWER_ID, feedType: "for_you", followedCreatorIds: new Set() },
      client,
      new Set(),
    );
    assert.equal(eligible.length, 0, "pending_delay posts must be excluded");
  });

  it("excludes expired stories", async () => {
    const post = makePost({ expires_at: new Date(Date.now() - 1000).toISOString() });
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      { viewerUserId: VIEWER_ID, feedType: "for_you", followedCreatorIds: new Set() },
      client,
      new Set(),
    );
    assert.equal(eligible.length, 0, "expired items must be excluded");
  });

  it("excludes muted creators", async () => {
    const post = makePost({ author_id: CREATOR_A });
    const client = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const mutedSet = new Set([CREATOR_A]);
    const { eligible } = await filterEligibleMediaCandidates(
      [post],
      { viewerUserId: VIEWER_ID, feedType: "for_you", followedCreatorIds: new Set() },
      client,
      mutedSet,
    );
    assert.equal(eligible.length, 0, "muted creator posts must be excluded");
  });

  it("returns blockFetchFailed=true when block query errors", async () => {
    const post = makePost();
    const errorClient: any = {
      from(table: string) {
        const b: any = {
          select() { return b; },
          eq() { return b; },
          in() { return b; },
          then(onF: any) {
            return Promise.resolve({ data: null, error: { message: "DB error" } }).then(onF);
          },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        };
        return b;
      },
    };
    const { eligible, blockFetchFailed } = await filterEligibleMediaCandidates(
      [post],
      { viewerUserId: VIEWER_ID, feedType: "for_you", followedCreatorIds: new Set() },
      errorClient,
    );
    assert.equal(blockFetchFailed, true, "must report blockFetchFailed on DB error");
    assert.equal(eligible.length, 0, "must return empty on blockFetchFailed");
  });
});

// ── loadViewerTripIds — read isolation ────────────────────────────────────────
//
// Membership and ownership are two INDEPENDENT grants: either alone is
// sufficient. The tests below exist because `Promise.all` inside one try/catch
// would couple them — it rejects on the first rejection, so a failure of the
// rarer ownership read would discard an already-successful membership result
// and drop every trip_only post for every genuine accepted member.
//
// Each read can fail in two distinct shapes and both must be covered:
//   • the promise REJECTS      — network / client throw
//   • it resolves with an ERROR TUPLE — { data: null, error } , which is what
//     postgrest actually produces for a query error; it does not reject.

describe("loadViewerTripIds — membership and ownership read isolation", () => {
  const VIEWER = "aaaaaaaa-0000-4000-a000-000000000001";
  const TRIP_MEMBER = "trip-member-1";
  const TRIP_OWNED  = "trip-owned-1";

  type Outcome =
    | { kind: "ok"; rows: any[] }
    | { kind: "errorTuple"; message: string }
    | { kind: "reject"; message: string };

  /**
   * Minimal client exposing exactly what loadViewerTripIds calls, so each read
   * can be failed independently and in either failure shape.
   */
  function makeTripClient(members: Outcome, owned: Outcome): any {
    const settle = (outcome: Outcome) => {
      if (outcome.kind === "reject") return Promise.reject(new Error(outcome.message));
      if (outcome.kind === "errorTuple") {
        return Promise.resolve({ data: null, error: { message: outcome.message } });
      }
      return Promise.resolve({ data: outcome.rows, error: null });
    };
    return {
      from(table: string) {
        const outcome = table === "trip_members" ? members : owned;
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          then: (resolve: any, reject: any) => settle(outcome).then(resolve, reject),
        };
        return chain;
      },
    };
  }

  it("unions both reads when both succeed", async () => {
    const client = makeTripClient(
      { kind: "ok", rows: [{ trip_id: TRIP_MEMBER }] },
      { kind: "ok", rows: [{ id: TRIP_OWNED }] },
    );
    const ids = await loadViewerTripIds(client, VIEWER);
    assert.deepEqual([...ids].sort(), [TRIP_MEMBER, TRIP_OWNED].sort(),
      "membership and ownership must be unioned");
  });

  it("membership survives an ownership REJECTION", async () => {
    const client = makeTripClient(
      { kind: "ok", rows: [{ trip_id: TRIP_MEMBER }] },
      { kind: "reject", message: "ownership read exploded" },
    );
    const ids = await loadViewerTripIds(client, VIEWER);
    assert.ok(ids.has(TRIP_MEMBER),
      "a rejected ownership read must not discard a successful membership read");
    assert.equal(ids.size, 1);
  });

  it("membership survives an ownership ERROR TUPLE", async () => {
    // postgrest resolves with { data, error } rather than rejecting, so a
    // rejection-only check would let this shape through silently.
    const client = makeTripClient(
      { kind: "ok", rows: [{ trip_id: TRIP_MEMBER }] },
      { kind: "errorTuple", message: "permission denied for relation trips" },
    );
    const ids = await loadViewerTripIds(client, VIEWER);
    assert.ok(ids.has(TRIP_MEMBER),
      "an ownership error tuple must not discard a successful membership read");
    assert.equal(ids.size, 1);
  });

  it("ownership survives a membership REJECTION", async () => {
    const client = makeTripClient(
      { kind: "reject", message: "membership read exploded" },
      { kind: "ok", rows: [{ id: TRIP_OWNED }] },
    );
    const ids = await loadViewerTripIds(client, VIEWER);
    assert.ok(ids.has(TRIP_OWNED),
      "a rejected membership read must not discard a successful ownership read");
    assert.equal(ids.size, 1);
  });

  it("fails closed when NEITHER read proves anything — a trip_only post is dropped", async () => {
    // Asserted as a CONSEQUENCE, not merely as an empty set: the point is that
    // a double failure withholds content rather than leaking it.
    const client = makeTripClient(
      { kind: "reject", message: "membership read exploded" },
      { kind: "errorTuple", message: "ownership read failed" },
    );
    const ids = await loadViewerTripIds(client, VIEWER);
    assert.equal(ids.size, 0, "a double failure must yield an empty set");

    const tripOnlyPost = makePost({
      author_id: CREATOR_A, visibility: "trip_only", trip_id: "dddddddd-0000-4000-a000-000000000009",
    });
    const filterClient = makeClient({ blocks: [], mutes: [], profiles: [makeProfile()] });
    const { eligible } = await filterEligibleMediaCandidates(
      [tripOnlyPost],
      {
        viewerUserId: VIEWER_ID,
        feedType: "following",
        followedCreatorIds: new Set([CREATOR_A]),
        viewerTripIds: ids,
      },
      filterClient,
      new Set(),
    );
    assert.equal(eligible.length, 0,
      "with nothing proven, the trip_only post must be withheld — fail closed, not open");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── B. Cursor stability tests ─────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("mediaCursor", () => {
  it("round-trips a cursor payload", () => {
    const payload = { created_at: "2024-01-15T12:00:00.000Z", id: POST_1 };
    const token = encodeCursor(payload);
    const decoded = decodeCursor(token);
    assert.ok(decoded, "should decode successfully");
    assert.equal(decoded!.created_at, payload.created_at);
    assert.equal(decoded!.id, payload.id);
  });

  it("returns null for a tampered cursor", () => {
    assert.equal(decodeCursor("not-base64!@#"), null);
    assert.equal(decodeCursor(Buffer.from('{"bad":"shape"}').toString("base64url")), null);
    assert.equal(decodeCursor(Buffer.from('{"created_at":"not-a-date","id":"abc"}').toString("base64url")), null);
  });

  it("returns null for cursor with missing fields", () => {
    assert.equal(decodeCursor(Buffer.from('{"created_at":"2024-01-01T00:00:00Z"}').toString("base64url")), null);
    assert.equal(decodeCursor(Buffer.from('{"id":"' + POST_1 + '"}').toString("base64url")), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── C. Creator-cap enforcement tests ─────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("enforceCreatorCapsGeneric (media feed)", () => {
  it("caps items from one creator at maxPerPage=3 and pushes overflow to tail", () => {
    // 5 items from CREATOR_A, 2 from CREATOR_B
    const items = [
      { id: "a1", author_id: CREATOR_A },
      { id: "a2", author_id: CREATOR_A },
      { id: "a3", author_id: CREATOR_A },
      { id: "a4", author_id: CREATOR_A }, // overflow
      { id: "a5", author_id: CREATOR_A }, // overflow
      { id: "b1", author_id: CREATOR_B },
      { id: "b2", author_id: CREATOR_B },
    ];
    const capped = enforceCreatorCapsGeneric(items, (i) => i.author_id);
    // Count items per creator in the first 3 positions
    const first3 = capped.slice(0, 3);
    const aCount = first3.filter((i) => i.author_id === CREATOR_A).length;
    assert.ok(aCount <= 3, `First 3 should have at most 3 from CREATOR_A, got ${aCount}`);
    // Total items unchanged
    assert.equal(capped.length, items.length, "total items must be preserved");
  });

  it("enforces consecutive cap — no author appears more than 2 times in a row", () => {
    const items = [
      { id: "a1", author_id: CREATOR_A },
      { id: "a2", author_id: CREATOR_A },
      { id: "a3", author_id: CREATOR_A }, // would be 3rd consecutive — must be moved
      { id: "b1", author_id: CREATOR_B },
      { id: "c1", author_id: CREATOR_C },
    ];
    const capped = enforceCreatorCapsGeneric(items, (i) => i.author_id);
    // Check no author has 3+ consecutive
    for (let i = 2; i < capped.length; i++) {
      if (capped[i].author_id === capped[i - 1].author_id &&
          capped[i].author_id === capped[i - 2].author_id) {
        assert.fail(`Author ${capped[i].author_id} has 3+ consecutive items at position ${i}`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── D. Private-field stripping tests ─────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("hydrateMediaFeedItem — private profile stripping", () => {
  const baseInput = {
    row: makePost({ author_id: CREATOR_A, profiles: makeProfile({ id: CREATOR_A, is_private: true }) }),
    sourceType: "post" as const,
    viewerUserId: VIEWER_ID,
    allowedRealNameIds: new Set<string>(),
    savedPostIds: new Set<string>(),
    likedPostIds: new Set<string>(),
    pendingFollowRequestIds: new Set<string>(),
    postMedia: [makeMedia()],
    useSignedUrls: false,
    supabaseUrl: SB_URL,
  };

  it("strips bio, followersCount, followingCount for private profile when viewer is not following", () => {
    const item = hydrateMediaFeedItem({
      ...baseInput,
      followedCreatorIds: new Set<string>(), // not following
    });
    assert.equal(item.creator.bio, null, "bio must be null for private profile");
    assert.equal(item.creator.followersCount, null, "followersCount must be null for private profile");
    assert.equal(item.creator.followingCount, null, "followingCount must be null for private profile");
    // Safe fields still present
    assert.ok(item.creator.username, "username must be present");
    assert.ok(item.creator.id, "id must be present");
    assert.equal(item.creator.isPrivate, true);
  });

  it("exposes bio and counts when viewer follows the private creator", () => {
    const item = hydrateMediaFeedItem({
      ...baseInput,
      followedCreatorIds: new Set([CREATOR_A]), // following
    });
    assert.notEqual(item.creator.bio, null, "bio must be exposed when viewer follows");
    assert.notEqual(item.creator.followersCount, null, "followersCount must be exposed when viewer follows");
  });

  it("exposes bio and counts for public profiles regardless of follow state", () => {
    const input = {
      ...baseInput,
      row: makePost({ author_id: CREATOR_A, profiles: makeProfile({ id: CREATOR_A, is_private: false }) }),
      followedCreatorIds: new Set<string>(), // not following
    };
    const item = hydrateMediaFeedItem(input);
    assert.notEqual(item.creator.bio, null, "bio must be exposed for public profile");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── E–H. HTTP route tests ────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /media/feed", () => {
  let server: http.Server;
  let base: string;

  const defaultFlags = [
    { flag: "MEDIA_FOR_YOU_ENABLED", enabled: true },
    { flag: "MEDIA_FOLLOWING_ENABLED", enabled: true },
    { flag: "MEDIA_RANKING_ENABLED", enabled: true },
  ];

  before(async () => {
    const app = makeApp();
    ({ server, base } = await startServer(app));
  });

  after(() => { server.close(); });

  beforeEach(() => {
    const client = makeClient({
      posts: [
        makePost({ id: POST_1, author_id: CREATOR_A, created_at: "2024-01-15T12:00:00Z" }),
        makePost({ id: POST_2, author_id: CREATOR_B, created_at: "2024-01-15T11:00:00Z" }),
      ],
      featureFlags: defaultFlags,
      profiles: [
        makeProfile({ id: CREATOR_A }),
        makeProfile({ id: CREATOR_B }),
      ],
      userFollows: [],
    });
    _setTestClient(client, true);
  });

  it("returns 400 when mode is missing", async () => {
    const { status } = await jsonFetch(base, "/media/feed");
    assert.equal(status, 400);
  });

  it("returns 400 when mode is an unknown value", async () => {
    const { status } = await jsonFetch(base, "/media/feed?mode=bogus");
    assert.equal(status, 400);
  });

  it("returns 401 with no auth token", async () => {
    const resp = await fetch(`${base}/media/feed?mode=fullscreen`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 401);
  });

  it("returns 404 when MEDIA_FOR_YOU_ENABLED flag is off", async () => {
    const client = makeClient({
      featureFlags: [
        { flag: "MEDIA_FOR_YOU_ENABLED", enabled: false },
        { flag: "MEDIA_FOLLOWING_ENABLED", enabled: true },
      ],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you");
    assert.equal(status, 404);
    assert.equal(body.error, "feature_disabled");
  });

  it("returns 404 when MEDIA_FOLLOWING_ENABLED flag is off", async () => {
    const client = makeClient({
      featureFlags: [
        { flag: "MEDIA_FOR_YOU_ENABLED", enabled: true },
        { flag: "MEDIA_FOLLOWING_ENABLED", enabled: false },
      ],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=following");
    assert.equal(status, 404);
    assert.equal(body.error, "feature_disabled");
  });

  it("returns 400 for an invalid cursor", async () => {
    const client = makeClient({ featureFlags: defaultFlags, posts: [], profiles: [] });
    _setTestClient(client, true);
    const { status } = await jsonFetch(base, "/media/feed?mode=fullscreen&cursor=!!!invalid!!!");
    assert.equal(status, 400);
  });

  it("returns items + sessionId on a valid for_you request", async () => {
    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you&limit=10");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");
    assert.ok(typeof body.sessionId === "string", "sessionId must be a string");
  });

  it("following feed returns empty when viewer follows nobody", async () => {
    const client = makeClient({
      featureFlags: defaultFlags,
      userFollows: [], // no follows
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=following");
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
  });
});

// ── Grid feed tests ───────────────────────────────────────────────────────────

describe("GET /media/feed?mode=grid", () => {
  let server: http.Server;
  let base: string;

  const gridFlags = [
    { flag: "MEDIA_VIEW_MODE_GRID_ENABLED", enabled: true },
    { flag: "MEDIA_FOR_YOU_ENABLED", enabled: true },
  ];

  before(async () => {
    const app = makeApp();
    ({ server, base } = await startServer(app));
  });

  after(() => { server.close(); });

  beforeEach(() => {
    const client = makeClient({
      posts: [
        makePost({ id: POST_1, author_id: CREATOR_A, created_at: "2024-01-15T12:00:00Z", has_video: false, post_media: [makeMedia({ media_type: "image" })] }),
        makePost({ id: POST_2, author_id: CREATOR_B, created_at: "2024-01-15T11:00:00Z", has_video: true, post_media: [makeMedia({ media_type: "video" })] }),
        makePost({ id: POST_3, author_id: CREATOR_C, created_at: "2024-01-15T10:00:00Z", has_video: false, post_media: [makeMedia({ media_type: "image" })] }),
      ],
      featureFlags: gridFlags,
      profiles: [
        makeProfile({ id: CREATOR_A }),
        makeProfile({ id: CREATOR_B }),
        makeProfile({ id: CREATOR_C }),
      ],
      userFollows: [],
    });
    _setTestClient(client, true);
  });

  // ── A. Feature flag gate ──────────────────────────────────────────────────

  it("returns 404 when MEDIA_VIEW_MODE_GRID_ENABLED flag is off", async () => {
    const client = makeClient({
      featureFlags: [{ flag: "MEDIA_VIEW_MODE_GRID_ENABLED", enabled: false }],
      posts: [],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid");
    assert.equal(status, 404);
    assert.equal(body.error, "feature_disabled");
  });

  // ── B. Basic response shape ───────────────────────────────────────────────

  it("returns items array + sessionId on a valid grid request", async () => {
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=all&limit=10");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    assert.ok(Array.isArray(body.items), "items must be an array");
    assert.ok(typeof body.sessionId === "string", "sessionId must be a string");
  });

  it("returns lightweight items — no captions, profiles, or coordinates", async () => {
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=all&limit=10");
    assert.equal(status, 200);
    assert.ok(body.items.length > 0, "expected at least one item");

    for (const item of body.items) {
      // Required lightweight fields must be present
      assert.ok(typeof item.id === "string", "id must be a string");
      assert.ok(item.mediaType === "image" || item.mediaType === "video", "mediaType must be image or video");
      assert.ok("creatorId" in item, "creatorId must be present");
      assert.ok(typeof item.viewCount === "number", "viewCount must be a number");

      // Forbidden fields must be absent
      assert.ok(!("caption" in item), "caption must not be in grid items");
      assert.ok(!("content" in item), "content must not be in grid items");
      assert.ok(!("creator" in item), "full creator object must not be in grid items");
      assert.ok(!("viewerState" in item), "viewerState must not be in grid items");
      assert.ok(!("stats" in item), "stats object must not be in grid items");
      assert.ok(!("linkedEntity" in item), "linkedEntity must not be in grid items");
      assert.ok(!("lat" in item) && !("lng" in item) && !("latitude" in item) && !("longitude" in item),
        "coordinates must never appear in grid items");
    }
  });

  // ── C. Filter params ──────────────────────────────────────────────────────

  it("filter=videos returns only video items (has_video=true)", async () => {
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=videos&limit=10");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    for (const item of body.items) {
      assert.equal(item.mediaType, "video", `item ${item.id} should be video`);
    }
  });

  it("filter=photos returns only image items (has_video=false)", async () => {
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=photos&limit=10");
    assert.equal(status, 200, `Expected 200, got ${status}: ${JSON.stringify(body)}`);
    for (const item of body.items) {
      assert.equal(item.mediaType, "image", `item ${item.id} should be image`);
    }
  });

  it("filter=following returns empty when viewer follows nobody", async () => {
    const client = makeClient({
      featureFlags: gridFlags,
      posts: [makePost({ id: POST_1, author_id: CREATOR_A })],
      userFollows: [],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=following");
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
  });

  it("filter=following returns posts from followed creators only", async () => {
    const client = makeClient({
      featureFlags: gridFlags,
      posts: [
        makePost({ id: POST_1, author_id: CREATOR_A, created_at: "2024-01-15T12:00:00Z" }),
        makePost({ id: POST_2, author_id: CREATOR_B, created_at: "2024-01-15T11:00:00Z" }),
      ],
      userFollows: [{ follower_id: VIEWER_ID, following_id: CREATOR_A }],
      profiles: [makeProfile({ id: CREATOR_A }), makeProfile({ id: CREATOR_B })],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=following");
    assert.equal(status, 200);
    // Only CREATOR_A is followed — only POST_1 should appear
    const ids = body.items.map((i: any) => i.id);
    assert.ok(ids.includes(POST_1), "POST_1 (followed creator) must appear");
    assert.ok(!ids.includes(POST_2), "POST_2 (unfollowed creator) must not appear");
  });

  it("filter=saved returns empty when viewer has no saved posts", async () => {
    const client = makeClient({
      featureFlags: gridFlags,
      posts: [makePost({ id: POST_1, author_id: CREATOR_A })],
      postSaves: [],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=saved");
    assert.equal(status, 200);
    assert.deepEqual(body.items, []);
  });

  it("filter=saved returns viewer's saved posts", async () => {
    const client = makeClient({
      featureFlags: gridFlags,
      posts: [
        makePost({ id: POST_1, author_id: CREATOR_A, created_at: "2024-01-15T12:00:00Z" }),
        makePost({ id: POST_2, author_id: CREATOR_B, created_at: "2024-01-15T11:00:00Z" }),
      ],
      postSaves: [{ user_id: VIEWER_ID, post_id: POST_2 }],
      profiles: [makeProfile({ id: CREATOR_A }), makeProfile({ id: CREATOR_B })],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=saved");
    assert.equal(status, 200);
    const ids = body.items.map((i: any) => i.id);
    assert.ok(ids.includes(POST_2), "POST_2 (saved) must appear");
    assert.ok(!ids.includes(POST_1), "POST_1 (not saved) must not appear");
  });

  // ── D. Cursor stability ───────────────────────────────────────────────────

  it("returns a stable cursor that does not repeat items across pages", async () => {
    // Set up 4 posts so page 1 (limit=2) and page 2 (limit=2) cover all
    const client = makeClient({
      featureFlags: gridFlags,
      posts: [
        makePost({ id: POST_1, author_id: CREATOR_A, created_at: "2024-01-15T14:00:00Z" }),
        makePost({ id: POST_2, author_id: CREATOR_B, created_at: "2024-01-15T13:00:00Z" }),
        makePost({ id: POST_3, author_id: CREATOR_C, created_at: "2024-01-15T12:00:00Z" }),
      ],
      profiles: [
        makeProfile({ id: CREATOR_A }),
        makeProfile({ id: CREATOR_B }),
        makeProfile({ id: CREATOR_C }),
      ],
    });
    _setTestClient(client, true);

    const page1 = await jsonFetch(base, "/media/feed?mode=grid&filter=all&limit=2");
    assert.equal(page1.status, 200);
    const ids1: string[] = page1.body.items.map((i: any) => i.id);
    assert.equal(ids1.length, 2, "page 1 should have 2 items");

    if (!page1.body.nextCursor) {
      // All items on one page — cursor stability trivially holds
      return;
    }

    const page2 = await jsonFetch(
      base,
      `/media/feed?mode=grid&filter=all&limit=2&cursor=${page1.body.nextCursor}`,
    );
    assert.equal(page2.status, 200);
    const ids2: string[] = page2.body.items.map((i: any) => i.id);

    const overlap = ids1.filter((id) => ids2.includes(id));
    assert.deepEqual(overlap, [], `Page 2 must not repeat items from page 1; overlap: ${overlap.join(", ")}`);
  });

  // ── E. Invalid cursor ─────────────────────────────────────────────────────

  it("returns 400 for an invalid cursor on the grid endpoint", async () => {
    const { status } = await jsonFetch(base, "/media/feed?mode=grid&cursor=!!!invalid!!!");
    assert.equal(status, 400);
  });

  // ── F. Auth requirement ───────────────────────────────────────────────────

  it("returns 401 with no auth token on the grid endpoint", async () => {
    const resp = await fetch(`${base}/media/feed?mode=grid`, {
      headers: { "Content-Type": "application/json" },
    });
    assert.equal(resp.status, 401);
  });

  // ── G. Moderation exclusion ───────────────────────────────────────────────

  it("excludes posts whose only media has moderation_status=rejected", async () => {
    // A post is only eligible when it has at least one media item whose
    // moderation_status is not 'rejected' or 'flagged'.  With all media
    // rejected, the post must not appear in the grid feed.
    const client = makeClient({
      posts: [
        makePost({
          id: POST_1,
          has_video: true,
          post_media: [makeMedia({ media_type: "video", moderation_status: "rejected" })],
        }),
        makePost({
          id: POST_2,
          has_video: false,
          post_media: [makeMedia({ media_type: "image", moderation_status: "approved" })],
        }),
      ],
      featureFlags: gridFlags,
      profiles: [makeProfile({ id: CREATOR_A })],
      userFollows: [],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=all&limit=10");
    assert.equal(status, 200);
    const ids = body.items.map((i: any) => i.id);
    assert.ok(!ids.includes(POST_1), "post with only rejected media must be excluded");
    assert.ok(ids.includes(POST_2), "post with approved media must be included");
  });

  it("excludes posts whose only media has moderation_status=flagged", async () => {
    const client = makeClient({
      posts: [
        makePost({
          id: POST_1,
          has_video: true,
          post_media: [makeMedia({ media_type: "video", moderation_status: "flagged" })],
        }),
      ],
      featureFlags: gridFlags,
      profiles: [makeProfile({ id: CREATOR_A })],
      userFollows: [],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=all&limit=10");
    assert.equal(status, 200);
    assert.equal(body.items.length, 0, "post with only flagged media must be excluded");
  });

  // ── H. Relay poster URL — grid endpoint ───────────────────────────────────
  //
  // When post_media rows carry only storage_path/storage_bucket (no public_url),
  // GRID_MEDIA_COLUMNS must project those fields so hydrateMediaGridItem can
  // resolve posterUrl via the relay. This prevents relay-bucket thumbnails from
  // silently returning null for grid tiles.

  it("returns relay posterUrl when the video asset has only storage_path (no public_url)", async () => {
    const client = makeClient({
      posts: [
        makePost({
          id: POST_1,
          author_id: CREATOR_A,
          has_video: true,
          post_media: [
            makeMedia({
              id: "vid-relay-poster",
              media_type: "video",
              storage_bucket: "relay-videos",
              storage_path: "uploads/user1/clip.mp4",
              thumbnail_storage_path: "uploads/user1/clip_thumb.jpg",
              public_url: null,
              thumbnail_url: null,
            }),
          ],
        }),
      ],
      featureFlags: gridFlags,
      profiles: [makeProfile({ id: CREATOR_A })],
      userFollows: [],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=all&limit=10");
    assert.equal(status, 200);
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.match(
      item.posterUrl,
      /\/api\/media\/file\/relay-videos\/uploads\/user1\/clip_thumb\.jpg/,
      "posterUrl must be a relay URL when the video only has storage_path+thumbnail_storage_path",
    );
  });

  it("returns relay posterUrl when an image asset has only storage_path (no public_url)", async () => {
    const client = makeClient({
      posts: [
        makePost({
          id: POST_2,
          author_id: CREATOR_A,
          has_video: false,
          post_media: [
            makeMedia({
              id: "img-relay-poster",
              media_type: "image",
              storage_bucket: "relay-images",
              storage_path: "uploads/user2/photo.jpg",
              public_url: null,
              thumbnail_url: null,
            }),
          ],
        }),
      ],
      featureFlags: gridFlags,
      profiles: [makeProfile({ id: CREATOR_A })],
      userFollows: [],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, "/media/feed?mode=grid&filter=all&limit=10");
    assert.equal(status, 200);
    assert.equal(body.items.length, 1);
    const item = body.items[0];
    assert.match(
      item.posterUrl,
      /\/api\/media\/file\/relay-images\/uploads\/user2\/photo\.jpg/,
      "posterUrl must be a relay URL when the image only has storage_path",
    );
  });
});

describe("POST /media/:id/view", () => {
  let server: http.Server;
  let base: string;

  const defaultFlags = [
    { flag: "MEDIA_RANKING_ENABLED", enabled: true },
  ];

  before(async () => {
    const app = makeApp();
    ({ server, base } = await startServer(app));
  });

  after(() => { server.close(); });

  it("returns { counted: false } when MEDIA_RANKING_ENABLED is off", async () => {
    const client = makeClient({
      featureFlags: [{ flag: "MEDIA_RANKING_ENABLED", enabled: false }],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, `/media/${POST_1}/view`, {
      method: "POST",
      body: { type: "impression" },
    });
    assert.equal(status, 200);
    assert.equal(body.counted, false);
  });

  it("rejects self-views — returns { counted: false }", async () => {
    const client = makeClient({
      featureFlags: defaultFlags,
      posts: [makePost({ id: POST_1, author_id: VIEWER_ID, status: "active", post_status: "published" })],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, `/media/${POST_1}/view`, {
      method: "POST",
      body: { type: "impression" },
    });
    assert.equal(status, 200);
    assert.equal(body.counted, false, "self-views must not be counted");
  });

  it("rejects qualified_view with watchedMs below threshold", async () => {
    const client = makeClient({
      featureFlags: defaultFlags,
      posts: [makePost({ id: POST_2, author_id: CREATOR_A })],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, `/media/${POST_2}/view`, {
      method: "POST",
      body: { type: "qualified_view", watchedMs: 500 }, // below 3000ms threshold
    });
    assert.equal(status, 200);
    assert.equal(body.counted, false, "qualified_view with short watchedMs must not be counted");
  });

  it("counts a valid impression from a different creator", async () => {
    const client = makeClient({
      featureFlags: defaultFlags,
      posts: [makePost({ id: POST_2, author_id: CREATOR_A, status: "active", post_status: "published" })],
    });
    _setTestClient(client, true);
    const { status, body } = await jsonFetch(base, `/media/${POST_2}/view`, {
      method: "POST",
      body: { type: "impression" },
    });
    assert.equal(status, 200);
    assert.equal(body.counted, true, "impression from another creator must be counted");
  });

  it("returns 400 for invalid media id", async () => {
    const client = makeClient({ featureFlags: defaultFlags, posts: [] });
    _setTestClient(client, true);
    const { status } = await jsonFetch(base, `/media/not-a-uuid/view`, {
      method: "POST",
      body: { type: "impression" },
    });
    assert.equal(status, 400);
  });

  it("returns 400 for invalid view type", async () => {
    const client = makeClient({ featureFlags: defaultFlags, posts: [] });
    _setTestClient(client, true);
    const { status } = await jsonFetch(base, `/media/${POST_1}/view`, {
      method: "POST",
      body: { type: "invalid_type" },
    });
    assert.equal(status, 400);
  });
});

describe("GET /media/:id (single item)", () => {
  let server: http.Server;
  let base: string;

  before(async () => {
    const app = makeApp();
    ({ server, base } = await startServer(app));
  });

  after(() => { server.close(); });

  it("returns 404 for a non-existent media item", async () => {
    const client = makeClient({ posts: [] });
    _setTestClient(client, true);
    const { status } = await jsonFetch(base, `/media/${POST_1}`);
    // 404 (not found) or blocked (also 404)
    assert.ok([404].includes(status), `Expected 404, got ${status}`);
  });

  it("returns 400 for a non-UUID id", async () => {
    const client = makeClient({ posts: [] });
    _setTestClient(client, true);
    const { status } = await jsonFetch(base, `/media/not-a-uuid`);
    assert.equal(status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── I. Feed freshness after upload (write→read cycle) ────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//
// After a creator uploads a new post the feed must return it on the very next
// request.  Because makeClient() reads from the *same* state object reference
// on every call, pushing a row into state.posts is equivalent to a DB insert:
// the next GET /media/feed query sees it immediately.  Any in-process response
// cache that held a stale snapshot would cause these tests to fail.
//
// Sub-tests:
//   I-A  for_you feed (viewer's discovery feed) — new post visible immediately
//   I-B  following feed (follower's feed) — new post visible immediately after
//        the creator uploads

describe("GET /media/feed — freshness after upload (write→read cycle)", () => {
  let server: http.Server;
  let base: string;

  const NEW_POST = "99999999-0000-4000-a000-000000000099";

  const uploadFlags = [
    { flag: "MEDIA_FOR_YOU_ENABLED",   enabled: true },
    { flag: "MEDIA_FOLLOWING_ENABLED", enabled: true },
    { flag: "MEDIA_RANKING_ENABLED",   enabled: true },
  ];

  before(async () => {
    const app = makeApp();
    ({ server, base } = await startServer(app));
  });

  after(() => { server.close(); });

  // ── I-A. Creator's for_you feed ───────────────────────────────────────────

  it("for_you feed returns new post immediately after upload — no stale snapshot served", async () => {
    // Mutable state: start with no posts so we can confirm the before/after
    const state: FakeState = {
      posts: [],
      featureFlags: uploadFlags,
      profiles: [makeProfile({ id: CREATOR_A })],
      userFollows: [],
    };
    // makeClient reads from the *same* state reference on every DB call,
    // so pushing to state.posts simulates a DB insert visible to subsequent reads.
    const client = makeClient(state);
    _setTestClient(client, true);

    // Before upload: feed must be empty
    const before = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you&limit=10");
    assert.equal(before.status, 200, `pre-upload feed: expected 200, got ${before.status}`);
    assert.equal(
      before.body.items.length,
      0,
      "feed must return no items before the upload",
    );

    // Simulate upload: creator inserts a new post into the DB.
    // has_video:true is required — the fullscreen feed is video-first and
    // filters .eq("has_video", true) at the DB level.
    state.posts!.push(
      makePost({ id: NEW_POST, author_id: CREATOR_A, created_at: new Date().toISOString(), has_video: true }),
    );

    // After upload: feed must include the new post on the very next request
    const after = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=for_you&limit=10");
    assert.equal(after.status, 200, `post-upload feed: expected 200, got ${after.status}`);
    const ids: string[] = after.body.items.map((i: any) => i.id);
    assert.ok(
      ids.includes(NEW_POST),
      `New post ${NEW_POST} must appear in for_you feed immediately after upload; ` +
        `got: [${ids.join(", ")}]`,
    );
  });

  // ── I-B. Follower's following feed ────────────────────────────────────────

  it("follower's following feed reflects creator's new post immediately after upload", async () => {
    // VIEWER_ID is the follower; CREATOR_A is the creator.
    // Start with no posts from CREATOR_A.
    const state: FakeState = {
      posts: [],
      featureFlags: uploadFlags,
      profiles: [makeProfile({ id: CREATOR_A })],
      // Viewer follows CREATOR_A
      userFollows: [{ follower_id: VIEWER_ID, following_id: CREATOR_A }],
    };
    const client = makeClient(state);
    _setTestClient(client, true);

    // Before upload: follower's feed is empty
    const before = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=following&limit=10");
    assert.equal(before.status, 200, `pre-upload following feed: expected 200, got ${before.status}`);
    assert.equal(
      before.body.items.length,
      0,
      "follower's following feed must be empty before creator uploads",
    );

    // Simulate CREATOR_A uploading a new public post.
    // has_video:true is required — the fullscreen feed filters .eq("has_video", true).
    state.posts!.push(
      makePost({ id: NEW_POST, author_id: CREATOR_A, created_at: new Date().toISOString(), has_video: true }),
    );

    // After upload: follower's feed must surface the creator's new post
    const after = await jsonFetch(base, "/media/feed?mode=fullscreen&feedType=following&limit=10");
    assert.equal(after.status, 200, `post-upload following feed: expected 200, got ${after.status}`);
    const ids: string[] = after.body.items.map((i: any) => i.id);
    assert.ok(
      ids.includes(NEW_POST),
      `New post ${NEW_POST} must appear in follower's following feed immediately after creator uploads; ` +
        `got: [${ids.join(", ")}]`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ── J. hydrateMediaGridItem — relay URL for relay-stored videos ───────────────
// ─────────────────────────────────────────────────────────────────────────────
//
// When a video asset has a storage_path the hydrator must resolve videoUrl via
// relayUrlFor (matching the Watch-feed hydrator pattern).  A raw public_url
// that may be inaccessible for relay-bucket assets should never be returned
// when storage_path is present.

describe("hydrateMediaGridItem — relay URL resolution for video assets", () => {
  const API_BASE = "https://api.example.test";

  it("uses relay URL when video asset has storage_path and storage_bucket", () => {
    const postMedia = [
      {
        id: "vid-relay-1",
        media_type: "video",
        storage_bucket: "relay-videos",
        storage_path: "uploads/user123/clip.mp4",
        public_url: "https://sb.example.test/storage/v1/object/public/relay-videos/uploads/user123/clip.mp4",
        thumbnail_url: null,
        duration_seconds: 30,
        width: 1080,
        height: 1920,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(
      item.videoUrl,
      `${API_BASE}/api/media/file/relay-videos/uploads/user123/clip.mp4`,
      "videoUrl must use the relay path when storage_path is present",
    );
  });

  it("falls back to public_url when storage_path is absent", () => {
    const PUBLIC_URL = `${SB_URL}/storage/v1/object/public/post-media/vid.mp4`;
    const postMedia = [
      {
        id: "vid-pub-1",
        media_type: "video",
        public_url: PUBLIC_URL,
        storage_bucket: "post-media",
        // no storage_path
        thumbnail_url: null,
        duration_seconds: 15,
        width: 1080,
        height: 1920,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(
      item.videoUrl,
      PUBLIC_URL,
      "videoUrl must fall back to public_url when storage_path is absent",
    );
  });

  it("uses default bucket 'post-media' when storage_bucket is absent", () => {
    const postMedia = [
      {
        id: "vid-nobucket-1",
        media_type: "video",
        storage_path: "uploads/user456/vid.mp4",
        // no storage_bucket
        public_url: null,
        thumbnail_url: null,
        duration_seconds: 10,
        width: 720,
        height: 1280,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(
      item.videoUrl,
      `${API_BASE}/api/media/file/post-media/uploads/user456/vid.mp4`,
      "relay URL must use 'post-media' as default bucket when storage_bucket is absent",
    );
  });

  it("returns null videoUrl for image-only posts", () => {
    const postMedia = [
      {
        id: "img-1",
        media_type: "image",
        storage_path: "uploads/user789/photo.jpg",
        storage_bucket: "post-images",
        public_url: `${SB_URL}/storage/v1/object/public/post-images/photo.jpg`,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(item.videoUrl, null, "videoUrl must be null for image-only posts");
    assert.equal(item.mediaType, "image");
  });
});

// ── K. hydrateMediaGridItem — relay URL for poster images ─────────────────────
// ─────────────────────────────────────────────────────────────────────────────
//
// posterUrl must be resolved via relayUrlFor() when the underlying asset has a
// storage_path (or thumbnail_storage_path for video thumbnails) — matching the videoUrl
// relay pattern so relay-bucket thumbnails are visible even when public_url is
// absent or inaccessible.

describe("hydrateMediaGridItem — relay URL resolution for poster images", () => {
  const API_BASE = "https://api.example.test";

  it("uses relay URL for posterUrl when video has thumbnail_storage_path", () => {
    const postMedia = [
      {
        id: "vid-thumb-relay-1",
        media_type: "video",
        storage_bucket: "relay-videos",
        storage_path: "uploads/user1/clip.mp4",
        thumbnail_storage_path: "uploads/user1/clip_thumb.jpg",
        public_url: null,
        thumbnail_url: null,
        duration_seconds: 20,
        width: 1080,
        height: 1920,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(
      item.posterUrl,
      `${API_BASE}/api/media/file/relay-videos/uploads/user1/clip_thumb.jpg`,
      "posterUrl must use relay path for relay-stored video thumbnail",
    );
  });

  it("falls back to thumbnail_url for posterUrl when video has no thumbnail_storage_path", () => {
    const THUMB_URL = "https://sb.example.test/storage/v1/object/public/post-media/thumb.jpg";
    const postMedia = [
      {
        id: "vid-thumb-pub-1",
        media_type: "video",
        storage_bucket: "post-media",
        storage_path: "uploads/user2/clip.mp4",
        // no thumbnail_path
        thumbnail_url: THUMB_URL,
        public_url: null,
        duration_seconds: 15,
        width: 1080,
        height: 1920,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(
      item.posterUrl,
      THUMB_URL,
      "posterUrl must fall back to thumbnail_url when thumbnail_storage_path is absent",
    );
  });

  it("uses relay URL for posterUrl when image asset has storage_path", () => {
    const postMedia = [
      {
        id: "img-relay-1",
        media_type: "image",
        storage_bucket: "relay-images",
        storage_path: "uploads/user3/photo.jpg",
        public_url: null,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(
      item.posterUrl,
      `${API_BASE}/api/media/file/relay-images/uploads/user3/photo.jpg`,
      "posterUrl must use relay path for relay-stored image asset",
    );
  });

  it("falls back to public_url for posterUrl when image has no storage_path", () => {
    const PUBLIC_URL = `${SB_URL}/storage/v1/object/public/post-media/photo.jpg`;
    const postMedia = [
      {
        id: "img-pub-1",
        media_type: "image",
        storage_bucket: "post-media",
        // no storage_path
        public_url: PUBLIC_URL,
        thumbnail_url: null,
        duration_seconds: null,
        width: 1080,
        height: 1080,
        sort_order: 0,
        processing_status: "ready",
        moderation_status: "approved",
      },
    ];
    const row = {
      id: POST_1,
      author_id: CREATOR_A,
      view_count: 0,
      qualified_view_count: 0,
    };

    const item = hydrateMediaGridItem(row, postMedia, API_BASE);

    assert.equal(
      item.posterUrl,
      PUBLIC_URL,
      "posterUrl must fall back to public_url when storage_path is absent",
    );
  });
});
