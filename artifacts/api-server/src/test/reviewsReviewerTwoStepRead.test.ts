/**
 * census-trust (wave 5, 2026-10-17) — the three review lists read their
 * reviewers in two steps, because `reviews` has no key to `profiles`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/reviewsReviewerTwoStepRead.test.ts
 *
 * THE DEFECT. GET /trips/:id/reviews, GET /places/:id/reviews and
 * GET /users/:id/reviews selected `profiles!reviewer_id(...)` from `reviews`.
 * The only foreign key on public.reviews is `reviews_reviewer_id_fkey`, which
 * runs to auth.users (production catalog, read 2026-10-17; migration 0067 and
 * the 2026-08-19 baseline agree). PostgREST refused the embed (PGRST200), and
 * all three lists answered `db_error` in production. The doubles accepted it
 * from KNOWN_UNBACKED_EMBEDS, so every suite that drove them stayed green.
 *
 * THE FIX. Read the reviews, then the reviewers' profiles in ONE batched
 * `.in("id", ids)` read, and join in code. This file proves, against the doubles
 * that now refuse the old embed:
 *   1. each list works on schemaStrictSupabase (live columns, embed guard on)
 *      and returns the shape it was written to return;
 *   2. the reviewer object carries exactly the embed's fields, and nothing else
 *      the profile read touched (account_status included) leaves the route;
 *   3. a failed profile read is a 503, never reviews with blank reviewers;
 *   4. a reviewer whose account is not active is withheld, as on every other
 *      roster of people; a reviewer with no profile row is withheld too;
 *   5. the profile read is one batch per request, never one read per review.
 *
 * Mutation proofs (2026-10-17, each restored byte-identically): re-introduce
 * the embed on any one of the three reads → the schema-strict case for that
 * list is RED (the double throws: PGRST200); replace the batch with one read
 * per reviewer → the batch case is RED; drop the profile read (attach nothing)
 * → the shape cases are RED; answer an unreadable profile read with an empty
 * map → the failure cases are RED; drop the standing check, or `account_status`
 * from the select → the standing cases are RED.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";
import { _resetVerifiedBadgeFlagCache, IDENTITY_VERIFIED_BADGE_FLAG } from "../services/identityVerification/verifiedBadges.js";
import reviewsRouter from "../routes/reviews.js";

const VIEWER = "99999999-0000-4000-a000-000000000009";
const OPTED  = "aaaaaaaa-0000-4000-a000-000000000001"; // shows their real name
const PLAIN  = "bbbbbbbb-0000-4000-a000-000000000002"; // does not
const ANON   = "cccccccc-0000-4000-a000-000000000003"; // writes anonymously
const GONE   = "dddddddd-0000-4000-a000-000000000004"; // account not active (varied per case)
const NOROW  = "eeeeeeee-0000-4000-a000-000000000005"; // no profile row at all
const HOST   = "12121212-0000-4000-a000-000000000012";
const TRIP   = "34343434-0000-4000-a000-000000000034";
const PLACE  = "56565656-0000-4000-a000-000000000056";
const EVENT  = "78787878-0000-4000-a000-000000000078";
const TOKEN  = "tok-viewer";

/** The reviewer object's keys before the fix, with the badge flag OFF (TV-2c adds `identityBadge` when ON). */
const REVIEWER_KEYS = ["avatarUrl", "displayName", "handle", "id", "verificationLevel"];

function profile(id: string, handle: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name: `${handle} legal name`, display_name: `${handle} display`,
    avatar_url: `https://cdn.invalid/${handle}.png`, verification_level: "basic_verified", account_status: "active",
    // Fields the embed never selected. None of them may reach a response.
    bio: `${handle} private bio`, home_city: "Secret City", date_of_birth: "1990-01-01", role: "user",
    ...extra,
  };
}

function review(id: string, reviewer: string, entityType: "trip" | "place", entityId: string, rating: number, day: number, visibility = "public") {
  return {
    id, reviewer_id: reviewer, entity_type: entityType, entity_id: entityId, rating, body: `body ${id}`,
    tags: ["calm"], visibility, state: "published", reported_by: [], photos: [],
    created_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`, updated_at: "2026-09-30T00:00:00.000Z",
  };
}

function world(overrides: Partial<Seed> = {}): Seed {
  return {
    profiles: [
      profile(VIEWER, "viewer"), profile(OPTED, "opted"), profile(PLAIN, "plain"), profile(ANON, "anon"),
      profile(GONE, "gone"),
    ],
    profile_privacy_settings: [{ user_id: OPTED, show_real_name: true }],
    blocks: [],
    user_account_states: [],
    feature_flags: [],
    trips: [{ id: TRIP, owner_id: HOST }],
    events: [{ id: EVENT, host_id: HOST }],
    reviews: [
      review("r-opted", OPTED, "trip", TRIP, 5, 5),
      review("r-plain", PLAIN, "trip", TRIP, 3, 4),
      review("r-anon", ANON, "trip", TRIP, 4, 3, "anonymous"),
      review("r-self", VIEWER, "trip", TRIP, 2, 2),
      review("p-opted", OPTED, "place", PLACE, 4, 5),
      review("p-plain", PLAIN, "place", PLACE, 2, 4),
    ],
    event_reviews: [
      { id: "e-plain", event_id: EVENT, reviewer_id: PLAIN, rating: 1, body: "event body", anonymous: false, created_at: "2026-09-06T00:00:00.000Z", updated_at: "2026-09-06T00:00:00.000Z" },
    ],
    ...overrides,
  };
}

// ── The two doubles, mounted ─────────────────────────────────────────────────

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", reviewsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); _setTestClient(null, false); });

const auth = { getUser: async (token: string) => (token === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

/**
 * schemaStrictSupabase, mounted. It models neither `.range()` nor `.or()`, which
 * these routes use for paging and for the host list's trip filter; both are
 * added here by narrowing what the double returns (`orPredicate` is the shared,
 * throwing parser of the PostgREST grammar). Everything else, including the
 * live-column check, the projection and the embed guard, is the double's own.
 */
function installStrict(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const profileReads: Array<{ cols: string; ids: unknown[] }> = [];
  const reviewSelects: string[] = [];
  const from = (table: string) => {
    const b = strict.from(table);
    const preds: Array<(row: Record<string, any>) => boolean> = [];
    let window: [number, number] | null = null;
    let cols = "";
    const select = b.select;
    b.select = (c?: string, o?: any) => { cols = c ?? ""; if (table === "reviews" || table === "event_reviews") reviewSelects.push(cols); return select(c, o); };
    const inFilter = b.in;
    b.in = (col: string, vals: unknown[]) => { if (table === "profiles" && col === "id") profileReads.push({ cols, ids: vals }); return inFilter(col, vals); };
    b.or = (expr: string) => { preds.push(orPredicate(expr)); return b; };
    b.range = (lo: number, hi: number) => { window = [lo, hi]; return b; };
    const then = b.then;
    b.then = (onF: any, onR: any) => then((r: any) => {
      let data = r?.data;
      if (Array.isArray(data)) {
        if (preds.length) data = data.filter((row: any) => preds.every((p) => p(row)));
        if (window) data = data.slice(window[0], window[1] + 1);
      }
      return onF({ ...r, data });
    }, onR);
    return b;
  };
  _resetVerifiedBadgeFlagCache();
  _setTestClient({ from, auth }, true);
  return { strict, profileReads, reviewSelects };
}

/** failClosedSupabase, mounted: any read can be made to fail the way supabase-js fails (resolved, not thrown). */
function installFailClosed(seed: Seed, failOn?: (ctx: FakeReadContext) => boolean) {
  const profileBatches: unknown[][] = [];
  const client = makeFailClosedClient({
    rows: seed as Record<string, Record<string, any>[]>,
    users: { [TOKEN]: VIEWER },
    failOn: (ctx) => {
      const batch = ctx.filters.find((f) => f.op === "in" && f.col === "id");
      if (ctx.table === "profiles" && batch) profileBatches.push(batch.val as unknown[]);
      return failOn?.(ctx) ? { message: "server closed the connection unexpectedly", code: "08006" } : null;
    },
  });
  _resetVerifiedBadgeFlagCache();
  _setTestClient(client, true);
  return { profileBatches };
}

async function get(path: string, token?: string): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
}

const isProfileBatch = (ctx: FakeReadContext) => ctx.table === "profiles" && ctx.filters.some((f) => f.op === "in" && f.col === "id");
const reviewerOf = (body: any, id: string) => body.reviews.find((r: any) => r.id === id)?.reviewer;

// ── 1. Each list works on the schema-strict double and keeps its shape ───────

describe("schema-strict: GET /trips/:id/reviews reads reviews, then one batch of profiles", () => {
  it("answers 200 with the shape it was written to return, naming only live columns", async () => {
    const { strict, profileReads, reviewSelects } = installStrict(world());
    const r = await get(`/trips/${TRIP}/reviews`, TOKEN);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(Object.keys(r.body).sort(), ["avgRating", "limit", "page", "reviews", "total"]);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["r-opted", "r-plain", "r-anon", "r-self"]);
    for (const x of r.body.reviews) assert.deepEqual(Object.keys(x).sort(), ["anonymous", "body", "createdAt", "id", "rating", "reviewer", "tags"]);
    assert.deepEqual(reviewerOf(r.body, "r-opted"), {
      id: OPTED, handle: "opted", displayName: "opted display", avatarUrl: "https://cdn.invalid/opted.png", verificationLevel: "basic_verified",
    });
    assert.equal(reviewerOf(r.body, "r-plain").displayName, null, "the universal display-name rule still holds");
    assert.equal(reviewerOf(r.body, "r-plain").handle, "plain");
    assert.equal(reviewerOf(r.body, "r-self").displayName, "viewer display", "the viewer always sees their own name");
    assert.equal(reviewerOf(r.body, "r-anon"), null);
    assert.equal(r.body.reviews.find((x: any) => x.id === "r-anon").anonymous, true);
    assert.equal(r.body.total, 4);
    assert.equal(r.body.avgRating, 3.5);
    assert.ok(reviewSelects.length > 0 && reviewSelects.every((c) => !c.includes("(")), `no embed on a reviews read: ${JSON.stringify(reviewSelects)}`);
    assert.equal(profileReads.length, 1, "one batched profiles read");
    assert.deepEqual([...profileReads[0].ids].sort(), [ANON, OPTED, PLAIN, VIEWER].sort());
  });
});

describe("schema-strict: GET /places/:id/reviews reads reviews, then one batch of profiles", () => {
  for (const token of [TOKEN, undefined]) {
    it(`answers 200 with the same shape (${token ? "signed in" : "signed out"})`, async () => {
      const { strict, profileReads } = installStrict(world());
      const r = await get(`/places/${PLACE}/reviews`, token);
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual(strict.deadColumnErrors, []);
      assert.deepEqual(Object.keys(r.body).sort(), ["avgRating", "limit", "page", "reviews", "total"]);
      assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["p-opted", "p-plain"]);
      assert.deepEqual(reviewerOf(r.body, "p-plain"), {
        id: PLAIN, handle: "plain", displayName: null, avatarUrl: "https://cdn.invalid/plain.png", verificationLevel: "basic_verified",
      });
      assert.equal(reviewerOf(r.body, "p-opted").displayName, "opted display");
      assert.equal(r.body.total, 2);
      assert.equal(profileReads.length, 1);
    });
  }
});

describe("schema-strict: GET /users/:id/reviews merges trip and event reviews over one batch of profiles", () => {
  it("answers 200 with the shape it was written to return; event reviewers come from the same batch", async () => {
    const { strict, profileReads, reviewSelects } = installStrict(world());
    const r = await get(`/users/${HOST}/reviews`, TOKEN);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(Object.keys(r.body).sort(), ["avgRating", "reviewCount", "reviews"]);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["e-plain", "r-opted", "r-plain", "r-anon", "r-self"]);
    for (const x of r.body.reviews) assert.deepEqual(Object.keys(x).sort(), ["anonymous", "body", "createdAt", "entityId", "entityType", "id", "rating", "reviewer", "tags"]);
    const event = r.body.reviews[0];
    assert.deepEqual(event, {
      id: "e-plain", rating: 1, body: "event body", tags: [], entityType: "event", entityId: EVENT, anonymous: false,
      createdAt: "2026-09-06T00:00:00.000Z",
      reviewer: { id: PLAIN, handle: "plain", displayName: null, avatarUrl: "https://cdn.invalid/plain.png", verificationLevel: "basic_verified" },
    });
    assert.equal(r.body.reviews[1].entityType, "trip");
    assert.equal(r.body.reviews[1].entityId, TRIP);
    assert.equal(r.body.reviews[1].reviewer.displayName, "opted display");
    assert.equal(r.body.reviewCount, 5);
    assert.ok(reviewSelects.every((c) => !c.includes("(")), `no embed on a reviews or event_reviews read: ${JSON.stringify(reviewSelects)}`);
    assert.equal(profileReads.length, 1, "one batched profiles read for trip AND event reviewers");
    assert.deepEqual([...profileReads[0].ids].sort(), [ANON, OPTED, PLAIN, VIEWER].sort());
  });

  it("limit cuts the page before the profile read: the batch holds only the page's reviewers", async () => {
    const { profileReads } = installStrict(world());
    const r = await get(`/users/${HOST}/reviews?limit=2`, TOKEN);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["e-plain", "r-opted"]);
    assert.equal(r.body.reviewCount, 5, "the aggregate is over every hosted review, not the page");
    assert.deepEqual([...profileReads[0].ids].sort(), [OPTED, PLAIN].sort());
  });
});

// ── 2. The reviewer fields are exactly the embed's ───────────────────────────

describe("the reviewer object carries exactly the fields the embed did", () => {
  for (const path of [`/trips/${TRIP}/reviews`, `/places/${PLACE}/reviews`, `/users/${HOST}/reviews`]) {
    it(`${path.split("/")[1]}: reviewer keys are the previous set, and no other profile column leaves the route`, async () => {
      const { profileReads } = installStrict(world());
      const r = await get(path, TOKEN);
      assert.equal(r.status, 200, r.raw);
      const reviewers = r.body.reviews.map((x: any) => x.reviewer).filter(Boolean);
      assert.ok(reviewers.length >= 2);
      for (const rv of reviewers) assert.deepEqual(Object.keys(rv).sort(), REVIEWER_KEYS);
      // The profile read may name only the embed's four, the key, and the standing column.
      assert.deepEqual(profileReads[0].cols.split(",").map((c) => c.trim()).sort(),
        ["account_status", "avatar_url", "display_name", "handle", "id", "verification_level"]);
      for (const leaked of ["account_status", "private bio", "Secret City", "1990-01-01", "legal name", "username"]) {
        assert.ok(!r.raw.includes(leaked), `${leaked} reached the response`);
      }
    });
  }

  it("with the badge flag ON the object gains identityBadge and nothing else (TV-2c, unchanged)", async () => {
    installFailClosed(world({ feature_flags: [{ flag: IDENTITY_VERIFIED_BADGE_FLAG, enabled: true }], identity_verifications: [] }));
    const r = await get(`/trips/${TRIP}/reviews`, TOKEN);
    assert.equal(r.status, 200, r.raw);
    for (const rv of r.body.reviews.map((x: any) => x.reviewer).filter(Boolean)) {
      assert.deepEqual(Object.keys(rv).sort(), [...REVIEWER_KEYS, "identityBadge"].sort());
    }
    // This double does not project: the whole seeded profile row is in hand, so only the route stands between it and the wire.
    for (const leaked of ["account_status", "private bio", "Secret City", "1990-01-01", "legal name"]) assert.ok(!r.raw.includes(leaked), `${leaked} reached the response`);
  });
});

// ── 3. A failed profile read is honest ───────────────────────────────────────

describe("an unreadable profiles batch is a 503 on every list, never reviews with blank reviewers", () => {
  for (const [path, token] of [
    [`/trips/${TRIP}/reviews`, TOKEN],
    [`/places/${PLACE}/reviews`, TOKEN],
    [`/places/${PLACE}/reviews`, undefined],
    [`/users/${HOST}/reviews`, TOKEN],
  ] as const) {
    it(`${path.split("/")[1]} (${token ? "signed in" : "signed out"}): HEALTHY TWIN 200, then FAILURE 503 degraded_unavailable`, async () => {
      installFailClosed(world());
      const ok = await get(path, token);
      assert.equal(ok.status, 200, ok.raw);
      assert.ok(ok.body.reviews.some((x: any) => x.reviewer?.handle), "the twin renders handles");

      const { profileBatches } = installFailClosed(world(), isProfileBatch);
      const r = await get(path, token);
      assert.equal(profileBatches.length, 1, "the batch was attempted once");
      assert.equal(r.status, 503, r.raw);
      assert.equal(r.body.error, "degraded_unavailable");
      assert.equal(r.body.reviews, undefined, "no list is served beside the failure");
    });
  }
});

// ── 4. Standing: a hidden account's review is not listed ─────────────────────

describe("a reviewer whose account is not active is withheld from the list", () => {
  for (const status of ["deactivated", "pending_deletion", "deleted"]) {
    it(`${status}: their named AND anonymous reviews are withheld; the aggregate is unchanged`, async () => {
      const seed = world();
      seed.profiles = seed.profiles.map((p) => (p.id === GONE ? { ...p, account_status: status } : p));
      seed.reviews = [
        review("r-opted", OPTED, "trip", TRIP, 5, 5),
        review("r-gone", GONE, "trip", TRIP, 1, 4),
        review("r-gone-anon", GONE, "trip", TRIP, 1, 3, "anonymous"),
        review("p-gone", GONE, "place", PLACE, 1, 4),
        review("p-opted", OPTED, "place", PLACE, 5, 5),
      ];
      seed.event_reviews = [{ id: "e-gone", event_id: EVENT, reviewer_id: GONE, rating: 1, body: "x", anonymous: false, created_at: "2026-09-06T00:00:00.000Z" }];
      const { strict } = installStrict(seed);

      const trip = await get(`/trips/${TRIP}/reviews`, TOKEN);
      assert.equal(trip.status, 200, trip.raw);
      assert.deepEqual(trip.body.reviews.map((x: any) => x.id), ["r-opted"]);
      assert.equal(trip.body.total, 3, "a count is not content (§27)");
      assert.ok(!trip.raw.includes("gone"), "no trace of the hidden account");

      const place = await get(`/places/${PLACE}/reviews`);
      assert.deepEqual(place.body.reviews.map((x: any) => x.id), ["p-opted"]);

      const host = await get(`/users/${HOST}/reviews`, TOKEN);
      assert.deepEqual(host.body.reviews.map((x: any) => x.id), ["r-opted"]);
      assert.equal(host.body.reviewCount, 4);
      assert.deepEqual(strict.deadColumnErrors, []);
    });
  }

  it("a reviewer with NO profile row is standing-unknown and withheld, not rendered as a reviewer with no handle", async () => {
    installStrict(world({ reviews: [review("r-opted", OPTED, "trip", TRIP, 5, 5), review("r-norow", NOROW, "trip", TRIP, 1, 4)] }));
    const r = await get(`/trips/${TRIP}/reviews`, TOKEN);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["r-opted"]);
  });

  it("CONTROL: an active reviewer with a NULL status is listed (the column's NULL reads as active, lib/http.ts)", async () => {
    const seed = world();
    seed.profiles = seed.profiles.map((p) => (p.id === PLAIN ? { ...p, account_status: null } : p));
    installStrict(seed);
    const r = await get(`/places/${PLACE}/reviews`);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["p-opted", "p-plain"]);
  });
});

// ── 5. The old embed is refused by both doubles again ────────────────────────

describe("both doubles refuse `profiles!reviewer_id(...)` from `reviews` (the ledger entry is gone)", () => {
  it("failClosedSupabase and schemaStrictSupabase throw PGRST200 on the old select", () => {
    const old = "id, rating, body, tags, visibility, created_at, reviewer_id, profiles!reviewer_id(handle, display_name, avatar_url, verification_level)";
    assert.throws(() => makeFailClosedClient({}).from("reviews").select(old), /failClosedSupabase: `profiles\(\.\.\.\)` is embedded from `reviews`.*PGRST200/);
    assert.throws(() => makeSchemaStrictClient({}).from("reviews").select(old), /schemaStrictSupabase: `profiles\(\.\.\.\)` is embedded from `reviews`.*PGRST200/);
  });

  it("CONTROL: event_reviews → profiles IS keyed (baseline event_reviews_reviewer_id_fkey), so that embed is still accepted", () => {
    assert.doesNotThrow(() => makeSchemaStrictClient({}).from("event_reviews").select("id, profiles!reviewer_id(handle)"));
  });
});
