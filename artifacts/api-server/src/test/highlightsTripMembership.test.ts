/**
 * trip_only Highlights are decided by the API's definition of trip membership,
 * not by a local approximation of it — and the lookup fails CLOSED.
 *
 * WHAT WAS WRONG
 * --------------
 * Every trip_only read in routes/highlights.ts (resolveViewAccess, the profile
 * listing, /highlights/active, /highlights/following-feed) computed "shares a
 * trip" as
 *
 *     trip_members WHERE role IN ('owner','member')       -- no status, both sides
 *
 * lib/http.ts requireTripMember — the definition of record — accepts
 * role IN (owner, co_host, member, viewer) AND coalesce(status,'accepted') =
 * 'accepted', plus trips.owner_id when no row exists. trip_members encodes
 * "pending" in TWO columns (legacy role='invited', current status='invited'),
 * so the old predicate:
 *
 *   ADMITTED   role='member',  status='invited'   (pending invitee)
 *   ADMITTED   role='member',  status='removed'   (removed from the trip)
 *   DENIED     role='co_host', status='accepted'
 *   DENIED     role='viewer',  status='accepted'
 *   DENIED     the owner of a trip who holds no trip_members row on it
 *
 * The RLS policy behind the table had the same defect; migration 2530 fixes
 * that side with authz.shares_accepted_trip. This suite pins the app side.
 *
 * EVERY CASE BELOW FLIPS AGAINST THE OLD CODE: pending → served, co_host /
 * viewer / owner-without-row → withheld. The fail-closed cases flip against a
 * version that reads `.data ?? []` without checking `.error`, because the
 * explicit log line is asserted, not just the withholding.
 *
 * Run: node --import tsx/esm --test src/test/highlightsTripMembership.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import highlightsRouter from "../routes/highlights.js";

const U = {
  OWNER: "10000000-0000-4000-8000-000000000001", // owns T1 (with an owner row); accepted member of T2
  ACC: "10000000-0000-4000-8000-000000000002", // T1 member/accepted
  COHOST: "10000000-0000-4000-8000-000000000003", // T1 co_host/accepted
  VIEWER: "10000000-0000-4000-8000-000000000004", // T1 viewer/accepted
  PEND: "10000000-0000-4000-8000-000000000005", // T1 member/invited      (pending, current encoding)
  PENDCH: "10000000-0000-4000-8000-000000000006", // T1 co_host/invited     (pending co-host)
  LEGACY: "10000000-0000-4000-8000-000000000007", // T1 invited/accepted    (pending, legacy encoding)
  REMOVED: "10000000-0000-4000-8000-000000000008", // T1 member/removed
  STRANGER: "10000000-0000-4000-8000-000000000009", // no rows anywhere
  OWNER_NOROW: "10000000-0000-4000-8000-00000000000a", // owns T2, holds NO trip_members row on it
  T3_MEMBER: "10000000-0000-4000-8000-00000000000b", // T3 member/accepted; T3 is OWNED by OWNER, who holds no row there
  OWNER_REMOVED_ROW: "10000000-0000-4000-8000-00000000000c", // owns T4 but its own T4 row says status=removed
} as const;
const T1 = "20000000-0000-4000-8000-000000000001";
const T2 = "20000000-0000-4000-8000-000000000002";
const T3 = "20000000-0000-4000-8000-000000000003";
const T4 = "20000000-0000-4000-8000-000000000004";
const H_TRIP = "30000000-0000-4000-8000-000000000001";
const H_PUBLIC = "30000000-0000-4000-8000-000000000002";
const H_PEND_PUBLIC = "30000000-0000-4000-8000-000000000003";
const FUTURE = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

const highlight = (id: string, owner_id: string, visibility: string) => ({
  id, owner_id, visibility,
  media_url: "https://example.invalid/h.jpg", media_type: "image/jpeg", video_duration_seconds: null,
  caption: null, location_name: null, location_city: null, location_country: null,
  expires_at: FUTURE, created_at: "2026-01-01T00:00:00.000Z", deleted_at: null,
});

function fixtureTables(): Record<string, any[]> {
  const profiles = Object.values(U).map((id) => ({
    id, handle: `h_${id.slice(-2)}`, name: "n", avatar_url: null,
    account_status: "active", role: "user", is_official: false, verification_status: "unverified",
    show_profile_picture_publicly: true, is_private: false,
  }));
  return {
    profiles,
    trips: [
      { id: T1, owner_id: U.OWNER },
      { id: T2, owner_id: U.OWNER_NOROW },
      { id: T3, owner_id: U.OWNER }, // OWNER holds no row on T3
      { id: T4, owner_id: U.OWNER_REMOVED_ROW },
    ],
    trip_members: [
      { trip_id: T1, user_id: U.OWNER, role: "owner", status: "accepted" },
      { trip_id: T1, user_id: U.ACC, role: "member", status: "accepted" },
      { trip_id: T1, user_id: U.COHOST, role: "co_host", status: "accepted" },
      { trip_id: T1, user_id: U.VIEWER, role: "viewer", status: "accepted" },
      { trip_id: T1, user_id: U.PEND, role: "member", status: "invited" },
      { trip_id: T1, user_id: U.PENDCH, role: "co_host", status: "invited" },
      { trip_id: T1, user_id: U.LEGACY, role: "invited", status: "accepted" },
      { trip_id: T1, user_id: U.REMOVED, role: "member", status: "removed" },
      { trip_id: T2, user_id: U.OWNER, role: "member", status: "accepted" },
      { trip_id: T3, user_id: U.T3_MEMBER, role: "member", status: "accepted" },
      { trip_id: T4, user_id: U.OWNER_REMOVED_ROW, role: "owner", status: "removed" },
      { trip_id: T4, user_id: U.OWNER, role: "member", status: "accepted" },
    ],
    highlights: [highlight(H_TRIP, U.OWNER, "trip_only"), highlight(H_PUBLIC, U.OWNER, "public"), highlight(H_PEND_PUBLIC, U.PEND, "public")],
    user_follows: Object.values(U).filter((id) => id !== U.OWNER).map((id) => ({ follower_id: id, following_id: U.OWNER })),
    blocks: [], circle_memberships: [], feature_flags: [], highlight_views: [], highlight_likes: [],
  };
}

/**
 * An in-memory supabase-js stand-in that actually FILTERS on eq/in/is/gt/neq,
 * so different viewers get different membership answers. `failTables` makes
 * every read of those tables resolve with an error (supabase-js never throws).
 */
function makeFakeClient(tables: Record<string, any[]>, failTables: Set<string> = new Set()) {
  function chain(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let single = false;
    let head = false;
    const obj: any = {
      select(_c?: string, o?: any) { if (o?.head) head = true; return obj; },
      insert() { return obj; }, update() { return obj; }, upsert() { return obj; }, delete() { return obj; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return obj; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return obj; },
      in(c: string, vs: any[]) { const s = new Set(vs); filters.push((r) => s.has(r[c])); return obj; },
      is(c: string, v: any) { filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return obj; },
      gt(c: string, v: any) { filters.push((r) => r[c] > v); return obj; },
      lt(c: string, v: any) { filters.push((r) => r[c] < v); return obj; },
      ilike() { return obj; }, or() { return obj; }, not() { return obj; }, filter() { return obj; },
      order() { return obj; }, limit() { return obj; }, range() { return obj; },
      maybeSingle() { single = true; return resolve(); },
      single() { single = true; return resolve(); },
      then(f: any, r: any) { return resolve().then(f, r); },
    };
    async function resolve(): Promise<{ data: any; error: any; count: number | null }> {
      if (failTables.has(table)) return { data: null, error: { message: `${table} unavailable` }, count: null };
      const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (single) return { data: rows[0] ?? null, error: null, count: null };
      return { data: rows, error: null, count: head ? rows.length : null };
    }
    return obj;
  }
  return {
    from(table: string) { return chain(table); },
    // The bearer token IS the viewer id, so one app serves every viewer.
    auth: { getUser: async (token: string) => ({ data: { user: { id: token } }, error: null }) },
  };
}

type App = { baseUrl: string; close: () => Promise<void>; errors: Array<{ obj: unknown; msg: string }> };

async function startApp(failTables: Set<string> = new Set()): Promise<App> {
  _setTestClient(makeFakeClient(fixtureTables(), failTables) as any, true);
  const errors: Array<{ obj: unknown; msg: string }> = [];
  const app = express();
  app.use(express.json());
  app.use((req: any, _r: any, n: any) => {
    req.log = { error: (obj: unknown, msg: string) => errors.push({ obj, msg }), info: () => {}, warn: () => {} };
    n();
  });
  app.use("/api", highlightsRouter);
  return new Promise((resolve, reject) => {
    const srv = http.createServer(app);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.unref();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        errors,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
    srv.on("error", reject);
  });
}

async function call(app: App, method: string, path: string, viewer: string) {
  const res = await fetch(app.baseUrl + path, { method, headers: { Authorization: `Bearer ${viewer}` } });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

const idsOf = (arr: any[]) => new Set((arr ?? []).map((h: any) => h.id as string));
const feedIds = (body: any) => new Set(((body?.users ?? []) as any[]).flatMap((u) => (u.highlights ?? []).map((h: any) => h.id as string)));

/** viewer → may see OWNER's trip_only highlight? Exactly requireTripMember on both sides. */
const EXPECTED: Array<[keyof typeof U, boolean, string]> = [
  ["ACC", true, "accepted member"],
  ["COHOST", true, "accepted co_host (was DENIED by the old role list)"],
  ["VIEWER", true, "accepted viewer (was DENIED by the old role list)"],
  ["OWNER_NOROW", true, "owner of T2 with no membership row; OWNER is accepted on T2 (was DENIED) — viewer-side owner fallback"],
  ["T3_MEMBER", true, "accepted member of T3, which OWNER owns without holding a row (was DENIED) — highlight-owner-side owner fallback"],
  ["OWNER_REMOVED_ROW", false, "owns T4 but its own T4 row says status=removed; requireTripMember consults the row and denies, no fallback"],
  ["PEND", false, "pending invitee, role=member status=invited (was ADMITTED)"],
  ["PENDCH", false, "pending co-host, status=invited (was ADMITTED by RLS)"],
  ["LEGACY", false, "legacy pending, role=invited status=accepted"],
  ["REMOVED", false, "removed member, status=removed (was ADMITTED)"],
  ["STRANGER", false, "no relationship"],
];

describe("highlights: trip_only is decided by requireTripMember's rule, on both sides", () => {
  let app: App;
  before(async () => { app = await startApp(); });
  after(async () => { await app.close(); });

  for (const [who, visible, why] of EXPECTED) {
    it(`GET /users/:id/highlights — ${who}: ${visible ? "sees" : "does not see"} the trip_only highlight (${why})`, async () => {
      const r = await call(app, "GET", `/api/users/${U.OWNER}/highlights`, U[who]);
      assert.equal(r.status, 200);
      const ids = idsOf(r.body.highlights);
      assert.ok(ids.has(H_PUBLIC), "the public highlight is always served");
      assert.equal(ids.has(H_TRIP), visible);
    });

    it(`GET /highlights/active — ${who}: ${visible ? "sees" : "does not see"} the trip_only highlight`, async () => {
      const r = await call(app, "GET", `/api/highlights/active`, U[who]);
      assert.equal(r.status, 200);
      const ids = idsOf(r.body.highlights);
      assert.ok(ids.has(H_PUBLIC));
      assert.equal(ids.has(H_TRIP), visible);
    });

    it(`GET /highlights/following-feed — ${who}: ${visible ? "sees" : "does not see"} the trip_only highlight`, async () => {
      const r = await call(app, "GET", `/api/highlights/following-feed`, U[who]);
      assert.equal(r.status, 200);
      const ids = feedIds(r.body);
      assert.ok(ids.has(H_PUBLIC));
      assert.equal(ids.has(H_TRIP), visible);
    });

    it(`POST /highlights/:id/view (resolveViewAccess) — ${who}: ${visible ? "200" : "404"}`, async () => {
      const r = await call(app, "POST", `/api/highlights/${H_TRIP}/view`, U[who]);
      assert.equal(r.status, visible ? 200 : 404);
      if (!visible) assert.equal(r.body?.error, "not_found");
    });
  }

  it("the owner always sees their own trip_only highlight", async () => {
    const r = await call(app, "GET", `/api/users/${U.OWNER}/highlights`, U.OWNER);
    assert.ok(idsOf(r.body.highlights).has(H_TRIP));
    const v = await call(app, "POST", `/api/highlights/${H_TRIP}/view`, U.OWNER);
    assert.equal(v.status, 200);
  });

  it("GET /highlights/active?tripId= scopes to the trip's ACCEPTED crew (owner fallback included), not to anyone holding a row", async () => {
    // PEND holds a T1 row (member/invited) and owns a PUBLIC highlight. With the
    // old `role IN (owner,member)` filter that highlight was inside the T1 page.
    const r = await call(app, "GET", `/api/highlights/active?tripId=${T1}`, U.ACC);
    assert.equal(r.status, 200);
    const ids = idsOf(r.body.highlights);
    assert.ok(ids.has(H_PUBLIC), "the trip owner's public highlight is in the trip page");
    assert.ok(!ids.has(H_PEND_PUBLIC), "a pending invitee's highlight is NOT in the trip page");

    // T2's owner holds no row; the fallback puts them in the crew. Nothing of
    // theirs exists, but the page must not be the UNFILTERED page it used to be.
    const r2 = await call(app, "GET", `/api/highlights/active?tripId=${T2}`, U.ACC);
    assert.equal(r2.status, 200);
    assert.ok(!idsOf(r2.body.highlights).has(H_PEND_PUBLIC));

    // A trip that does not exist has no crew: an EMPTY page, not everything.
    const r3 = await call(app, "GET", `/api/highlights/active?tripId=40000000-0000-4000-8000-000000000000`, U.ACC);
    assert.equal(r3.status, 200);
    assert.deepEqual(r3.body.highlights, []);
  });
});

for (const failing of ["trip_members", "trips"] as const) {
  describe(`highlights: an errored ${failing} read FAILS CLOSED (withheld, and said so)`, () => {
    let app: App;
    before(async () => { app = await startApp(new Set([failing])); });
    after(async () => { await app.close(); });

    it("GET /users/:id/highlights — accepted member: trip_only withheld, public still served, error logged", async () => {
      app.errors.length = 0;
      const r = await call(app, "GET", `/api/users/${U.OWNER}/highlights`, U.ACC);
      assert.equal(r.status, 200);
      const ids = idsOf(r.body.highlights);
      assert.ok(ids.has(H_PUBLIC));
      assert.ok(!ids.has(H_TRIP));
      assert.ok(app.errors.some((e) => /trip membership/.test(e.msg)), `no membership-failure log line; got ${JSON.stringify(app.errors.map((e) => e.msg))}`);
    });

    it("GET /highlights/active — withheld and logged", async () => {
      app.errors.length = 0;
      const r = await call(app, "GET", `/api/highlights/active`, U.ACC);
      assert.equal(r.status, 200);
      assert.ok(idsOf(r.body.highlights).has(H_PUBLIC));
      assert.ok(!idsOf(r.body.highlights).has(H_TRIP));
      assert.ok(app.errors.some((e) => /trip membership/.test(e.msg)));
    });

    it("GET /highlights/following-feed — withheld and logged", async () => {
      app.errors.length = 0;
      const r = await call(app, "GET", `/api/highlights/following-feed`, U.ACC);
      assert.equal(r.status, 200);
      assert.ok(feedIds(r.body).has(H_PUBLIC));
      assert.ok(!feedIds(r.body).has(H_TRIP));
      assert.ok(app.errors.some((e) => /trip membership/.test(e.msg)));
    });

    it("POST /highlights/:id/view — 404, and logged", async () => {
      app.errors.length = 0;
      const r = await call(app, "POST", `/api/highlights/${H_TRIP}/view`, U.ACC);
      assert.equal(r.status, 404);
      assert.ok(app.errors.some((e) => /trip membership/.test(e.msg)));
    });

    it("GET /highlights/active?tripId= — an unreadable crew is db_error, not an unfiltered page", async () => {
      const r = await call(app, "GET", `/api/highlights/active?tripId=${T1}`, U.ACC);
      // The CODE, not a band. `status >= 500` also admits a 500 thrown by a
      // crash in the handler — which is the trap this suite exists to avoid,
      // because a crash and a deliberate refusal are not the same result.
      assert.equal(r.status, 500, `expected 500 db_error, got ${r.status}`);
      assert.equal(r.body?.error, "db_error");
    });
  });
}
