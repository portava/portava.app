/**
 * census-trust (wave 5, 2026-10-17) — GET /api/events/:id/reviews applies the
 * same reviewer-standing rule as the other review lists.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/eventReviewsReviewerStanding.test.ts
 *
 * THE DIVERGENCE. routes/reviews.ts now withholds a review whose reviewer's
 * account is not active (deactivated, pending_deletion, deleted), anonymous
 * reviews included, and a reviewer with no profile row (standing unknown). The
 * host's merged list (GET /users/:id/reviews) applies it to EVENT reviews too.
 * The event page's own list applied nothing, so a deactivated reviewer's event
 * review showed on the event page but not in the host's list.
 *
 * THE FIX. The event page reads its event_reviews page, then the reviewers'
 * profiles in ONE batched `.in("id", ids)` read with `account_status`, exactly
 * as reviews.ts does (event_reviews → profiles IS keyed; the two-step read is
 * for the shared standing rule and for doubles that do not resolve embeds), and
 * withholds the rows whose reviewer is not in good standing. The reviewer
 * object keeps its four fields; account_status never leaves the route. An
 * unreadable profile batch is 503 `degraded_unavailable`, as on reviews.ts.
 *
 * Mutation proofs: see the wave-5 embeds handback (scratchpad).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { makeSchemaStrictClient, type Seed } from "./helpers/schemaStrictSupabase.js";
import { makeFailClosedClient, noopLog, type FakeReadContext } from "./helpers/failClosedSupabase.js";
import { orPredicate } from "./helpers/postgrestOrFilter.js";

const VIEWER = "99999999-0000-4000-a000-000000000009";
const HOST   = "12121212-0000-4000-a000-000000000012";
const OPTED  = "aaaaaaaa-0000-4000-a000-000000000001";
const PLAIN  = "bbbbbbbb-0000-4000-a000-000000000002";
const ANON   = "cccccccc-0000-4000-a000-000000000003";
const GONE   = "dddddddd-0000-4000-a000-000000000004";
const NOROW  = "eeeeeeee-0000-4000-a000-000000000005";
const EVENT  = "78787878-0000-4000-a000-000000000078";
const TOKEN  = "tok-viewer";

const REVIEW_KEYS = ["anonymous", "body", "createdAt", "id", "rating", "reviewer"];
const REVIEWER_KEYS = ["avatarUrl", "displayName", "handle", "id"];

function profile(id: string, handle: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name: `${handle} legal name`, display_name: `${handle} display`,
    avatar_url: `https://cdn.invalid/${handle}.png`, account_status: "active", role: "user",
    bio: `${handle} private bio`, home_city: "Secret City",
    ...extra,
  };
}

function eventReview(id: string, reviewer: string, day: number, anonymous = false) {
  return {
    id, event_id: EVENT, reviewer_id: reviewer, rating: 4, body: `body ${id}`, anonymous,
    created_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`, updated_at: `2026-09-${String(day).padStart(2, "0")}T00:00:00.000Z`,
  };
}

function world(overrides: Partial<Seed> = {}): Seed {
  return {
    profiles: [profile(VIEWER, "viewer"), profile(HOST, "host"), profile(OPTED, "opted"), profile(PLAIN, "plain"), profile(ANON, "anon"), profile(GONE, "gone")],
    profile_privacy_settings: [{ user_id: OPTED, show_real_name: true }],
    user_account_states: [],
    blocks: [],
    event_roles: [],
    events: [{ id: EVENT, host_id: HOST, title: "Jazz", visibility: "public", state: "open", tags: [] }],
    event_reviews: [eventReview("e-opted", OPTED, 5), eventReview("e-plain", PLAIN, 4), eventReview("e-anon", ANON, 3, true), eventReview("e-self", VIEWER, 2)],
    ...overrides,
  };
}

let server: http.Server;
let base: string;
before(async () => {
  const { default: eventsRouter } = await import("../routes/events.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", eventsRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); _setTestClient(null, false); });

const auth = { getUser: async (token: string) => (token === TOKEN ? { data: { user: { id: VIEWER } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

/** schemaStrictSupabase, mounted, with `.range()` and `.or()` (unmodelled; the block guard uses `.or`) added by narrowing what it returns. */
function installStrict(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const profileReads: Array<{ cols: string; ids: unknown[] }> = [];
  const reviewSelects: string[] = [];
  const from = (table: string) => {
    const b = strict.from(table);
    let cols = "";
    let window: [number, number] | null = null;
    const preds: Array<(row: Record<string, any>) => boolean> = [];
    const select = b.select;
    b.select = (c?: string, o?: any) => { cols = c ?? ""; if (table === "event_reviews") reviewSelects.push(cols); return select(c, o); };
    b.or = (expr: string) => { preds.push(orPredicate(expr)); return b; };
    const inFilter = b.in;
    b.in = (col: string, vals: unknown[]) => { if (table === "profiles" && col === "id") profileReads.push({ cols, ids: vals }); return inFilter(col, vals); };
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
  _setTestClient({ from, auth }, true);
  return { strict, profileReads, reviewSelects };
}

function installFailClosed(seed: Seed, failOn?: (ctx: FakeReadContext) => boolean) {
  const profileBatches: unknown[][] = [];
  _setTestClient(makeFailClosedClient({
    rows: seed as Record<string, Record<string, any>[]>,
    users: { [TOKEN]: VIEWER },
    failOn: (ctx) => {
      const batch = ctx.filters.find((f) => f.op === "in" && f.col === "id");
      if (ctx.table === "profiles" && batch) profileBatches.push(batch.val as unknown[]);
      return failOn?.(ctx) ? { message: "server closed the connection unexpectedly", code: "08006" } : null;
    },
  }), true);
  return { profileBatches };
}

async function get(path: string, token = TOKEN): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
}

const reviewerOf = (body: any, id: string) => body.reviews.find((r: any) => r.id === id)?.reviewer;
const isProfileBatch = (ctx: FakeReadContext) => ctx.table === "profiles" && ctx.filters.some((f) => f.op === "in" && f.col === "id");

describe("schema-strict: GET /api/events/:id/reviews keeps its shape over one batch of profiles", () => {
  it("answers 200 with the shape it was written to return, naming only live columns", async () => {
    const { strict, profileReads, reviewSelects } = installStrict(world());
    const r = await get(`/events/${EVENT}/reviews`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(Object.keys(r.body).sort(), ["limit", "page", "reviews"]);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["e-opted", "e-plain", "e-anon", "e-self"]);
    for (const x of r.body.reviews) assert.deepEqual(Object.keys(x).sort(), REVIEW_KEYS);
    assert.deepEqual(reviewerOf(r.body, "e-opted"), { id: OPTED, handle: "opted", displayName: "opted display", avatarUrl: "https://cdn.invalid/opted.png" });
    assert.deepEqual(reviewerOf(r.body, "e-plain"), { id: PLAIN, handle: "plain", displayName: null, avatarUrl: "https://cdn.invalid/plain.png" });
    assert.equal(reviewerOf(r.body, "e-self").displayName, "viewer display", "the viewer always sees their own name");
    assert.equal(reviewerOf(r.body, "e-anon"), null, "an anonymous review carries no reviewer");
    for (const x of r.body.reviews.filter((y: any) => y.reviewer)) assert.deepEqual(Object.keys(x.reviewer).sort(), REVIEWER_KEYS);
    assert.ok(reviewSelects.length === 1 && !reviewSelects[0].includes("("), `the event_reviews read embeds nothing: ${JSON.stringify(reviewSelects)}`);
    assert.equal(profileReads.length, 1, "one batched profiles read");
    assert.deepEqual([...profileReads[0].ids].sort(), [ANON, OPTED, PLAIN, VIEWER].sort());
    assert.deepEqual(profileReads[0].cols.split(",").map((c) => c.trim()).sort(), ["account_status", "avatar_url", "display_name", "handle", "id"]);
    for (const leaked of ["account_status", "private bio", "Secret City", "legal name"]) assert.ok(!r.raw.includes(leaked), `${leaked} reached the response`);
  });
});

describe("a reviewer whose account is not active is withheld, as on routes/reviews.ts", () => {
  for (const status of ["deactivated", "pending_deletion", "deleted"]) {
    it(`${status}: their named AND anonymous event reviews are withheld`, async () => {
      const seed = world({ event_reviews: [eventReview("e-opted", OPTED, 5), eventReview("e-gone", GONE, 4), eventReview("e-gone-anon", GONE, 3, true)] });
      seed.profiles = seed.profiles.map((p) => (p.id === GONE ? { ...p, account_status: status } : p));
      const { strict } = installStrict(seed);
      const r = await get(`/events/${EVENT}/reviews`);
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["e-opted"]);
      assert.ok(!r.raw.includes("gone"), "no trace of the hidden account");
      assert.deepEqual(strict.deadColumnErrors, []);
    });
  }

  it("a reviewer with NO profile row is standing-unknown and withheld", async () => {
    installStrict(world({ event_reviews: [eventReview("e-opted", OPTED, 5), eventReview("e-norow", NOROW, 4)] }));
    const r = await get(`/events/${EVENT}/reviews`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.reviews.map((x: any) => x.id), ["e-opted"]);
  });

  it("CONTROL: a NULL status reads as active and is listed (lib/http.ts)", async () => {
    const seed = world();
    seed.profiles = seed.profiles.map((p) => (p.id === PLAIN ? { ...p, account_status: null } : p));
    installStrict(seed);
    const r = await get(`/events/${EVENT}/reviews`);
    assert.ok(r.body.reviews.some((x: any) => x.id === "e-plain"));
  });
});

describe("an unreadable profile batch is 503 degraded_unavailable, never reviews with blank reviewers", () => {
  it("HEALTHY TWIN 200, then FAILURE 503 with no `reviews` key", async () => {
    installFailClosed(world());
    const ok = await get(`/events/${EVENT}/reviews`);
    assert.equal(ok.status, 200, ok.raw);
    assert.ok(ok.body.reviews.some((x: any) => x.reviewer?.handle), "the twin renders handles");

    const { profileBatches } = installFailClosed(world(), isProfileBatch);
    const r = await get(`/events/${EVENT}/reviews`);
    assert.equal(profileBatches.length, 1, "the batch was attempted once");
    assert.equal(r.status, 503, r.raw);
    assert.equal(r.body.error, "degraded_unavailable");
    assert.equal(r.body.reviews, undefined);
  });
});
