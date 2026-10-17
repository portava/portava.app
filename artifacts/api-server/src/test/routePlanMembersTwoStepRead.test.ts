/**
 * census-trips (wave 5, 2026-10-17) — GET /api/route-plans/:id/members reads its
 * members' profiles in two steps, because `route_plan_members` has no key to
 * `profiles`; and a read that fails now says so.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/routePlanMembersTwoStepRead.test.ts
 *
 * THE DEFECT. The members list selected `profiles(id, display_name, handle,
 * avatar_url)` from `route_plan_members`. The only foreign key on that table's
 * user_id is `route_plan_members_user_id_fkey` → auth.users (production catalog,
 * read by the lead 2026-10-17; migration 0059 and the 2026-08-19 baseline agree).
 * PostgREST refused the embed (PGRST200). The route destructured `{ data }` and
 * never read `error`, so the refusal arrived as `members: []`: every route plan
 * in production showed nobody joined. The stops read had the same unread error,
 * so an unreadable progress read showed 0 of 0 stops.
 *
 * THE FIX. Read the members, then their profiles in ONE batched
 * `.in("id", ids)` read on the service client (as GET /trips/:tripId/members
 * does), joined in code. Proven here, against the doubles that refuse the embed:
 *   1. the list answers 200 on schemaStrictSupabase with its old shape and the
 *      universal display-name rule;
 *   2. one batched profile read per request;
 *   3. a failed members, profiles or stops read is `db_error`, never an empty
 *      list or a zero progress count;
 *   4. account state is treated as the trip's own crew roster treats it (GET
 *      /trips/:tripId/members lists every member whatever their account state):
 *      a deactivated member is still listed, and a member with no profile row is
 *      listed as "Traveler", as the embed rendered a missing row.
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
import routePlanRouter from "../routes/routePlan.js";

const OWNER  = "11111111-0000-4000-a000-000000000001"; // the viewer in most cases
const OPTED  = "22222222-0000-4000-a000-000000000002"; // shows their real name
const PLAIN  = "33333333-0000-4000-a000-000000000003"; // does not
const GONE   = "44444444-0000-4000-a000-000000000004"; // account state varied per case
const NOROW  = "55555555-0000-4000-a000-000000000005"; // no profile row
const PLAN   = "66666666-0000-4000-a000-000000000006";
const TRIP   = "77777777-0000-4000-a000-000000000007";
const TOKEN  = "tok-owner";
const TOKEN_PLAIN = "tok-plain";

const MEMBER_KEYS = ["arrivedCount", "avatarUrl", "displayName", "isOwner", "joinedAt", "totalCount", "userId"];

function profile(id: string, handle: string, extra: Record<string, unknown> = {}) {
  return {
    id, handle, username: handle, name: `${handle} legal name`, display_name: `${handle} display`,
    avatar_url: `https://cdn.invalid/${handle}.png`, account_status: "active", role: "user",
    bio: `${handle} private bio`, home_city: "Secret City",
    ...extra,
  };
}

function member(userId: string, minute: number) {
  return { id: `rpm-${userId.slice(0, 4)}`, route_plan_id: PLAN, user_id: userId, joined_at: `2026-09-01T00:${String(minute).padStart(2, "0")}:00.000Z` };
}

function world(overrides: Partial<Seed> = {}): Seed {
  return {
    profiles: [profile(OWNER, "owner"), profile(OPTED, "opted"), profile(PLAIN, "plain"), profile(GONE, "gone")],
    user_account_states: [],
    profile_privacy_settings: [{ user_id: OPTED, show_real_name: true }],
    route_plans: [{ id: PLAN, owner_user_id: OWNER, trip_id: TRIP, title: "Walk", status: "active" }],
    trip_members: [
      { trip_id: TRIP, user_id: OWNER, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: PLAIN, role: "member", status: "accepted" },
    ],
    trips: [{ id: TRIP, owner_id: OWNER }],
    route_plan_members: [member(OWNER, 1), member(OPTED, 2), member(PLAIN, 3)],
    route_stops: [
      { id: "s1", route_plan_id: PLAN, checkpoint_status: "arrived", order_index: 0 },
      { id: "s2", route_plan_id: PLAN, checkpoint_status: "pending", order_index: 1 },
      { id: "s3", route_plan_id: PLAN, checkpoint_status: "pending", order_index: 2 },
    ],
    ...overrides,
  };
}

let server: http.Server;
let base: string;
before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", routePlanRouter);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); _setTestClient(null, false); });

const USERS: Record<string, string> = { [TOKEN]: OWNER, [TOKEN_PLAIN]: PLAIN };
const auth = { getUser: async (token: string) => (USERS[token] ? { data: { user: { id: USERS[token] } }, error: null } : { data: { user: null }, error: { message: "invalid" } }) };

function installStrict(seed: Seed) {
  const strict = makeSchemaStrictClient(seed);
  const profileReads: Array<{ cols: string; ids: unknown[] }> = [];
  const memberSelects: string[] = [];
  const from = (table: string) => {
    const b = strict.from(table);
    let cols = "";
    const select = b.select;
    b.select = (c?: string, o?: any) => { cols = c ?? ""; if (table === "route_plan_members") memberSelects.push(cols); return select(c, o); };
    const inFilter = b.in;
    b.in = (col: string, vals: unknown[]) => { if (table === "profiles" && col === "id") profileReads.push({ cols, ids: vals }); return inFilter(col, vals); };
    return b;
  };
  _setTestClient({ from, auth }, true);
  return { strict, profileReads, memberSelects };
}

function installFailClosed(seed: Seed, failOn?: (ctx: FakeReadContext) => boolean) {
  _setTestClient(makeFailClosedClient({
    rows: seed as Record<string, Record<string, any>[]>,
    users: USERS,
    failOn: (ctx) => (failOn?.(ctx) ? { message: "server closed the connection unexpectedly", code: "08006" } : null),
  }), true);
}

async function get(path: string, token = TOKEN): Promise<{ status: number; body: any; raw: string }> {
  const res = await fetch(`${base}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  const raw = await res.text();
  let body: any;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { status: res.status, body, raw };
}

const byUser = (body: any, id: string) => body.members.find((m: any) => m.userId === id);

describe("schema-strict: GET /api/route-plans/:id/members reads members, then one batch of profiles", () => {
  it("answers 200 with the shape it was written to return, naming only live columns", async () => {
    const { strict, profileReads, memberSelects } = installStrict(world());
    const r = await get(`/route-plans/${PLAN}/members`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(strict.deadColumnErrors, []);
    assert.deepEqual(Object.keys(r.body).sort(), ["arrivedCount", "members", "totalStops"]);
    assert.equal(r.body.totalStops, 3);
    assert.equal(r.body.arrivedCount, 1);
    assert.deepEqual(r.body.members.map((m: any) => m.userId), [OWNER, OPTED, PLAIN]);
    for (const m of r.body.members) assert.deepEqual(Object.keys(m).sort(), MEMBER_KEYS);
    assert.deepEqual(byUser(r.body, OWNER), {
      userId: OWNER, displayName: "owner display", avatarUrl: "https://cdn.invalid/owner.png", isOwner: true,
      joinedAt: "2026-09-01T00:01:00.000Z", arrivedCount: 1, totalCount: 3,
    });
    assert.equal(byUser(r.body, OPTED).displayName, "opted display", "an opted-in member shows their name");
    assert.equal(byUser(r.body, PLAIN).displayName, "@plain", "the universal display-name rule still holds");
    assert.equal(byUser(r.body, PLAIN).avatarUrl, "https://cdn.invalid/plain.png");
    assert.equal(byUser(r.body, PLAIN).isOwner, false);
    assert.ok(memberSelects.length === 1 && !memberSelects[0].includes("("), `no embed on the members read: ${JSON.stringify(memberSelects)}`);
    assert.equal(profileReads.length, 1, "one batched profiles read");
    assert.deepEqual([...profileReads[0].ids].sort(), [OWNER, OPTED, PLAIN].sort());
    assert.deepEqual(profileReads[0].cols.split(",").map((c) => c.trim()).sort(), ["avatar_url", "display_name", "handle", "id"]);
    for (const leaked of ["private bio", "Secret City", "legal name", "account_status"]) assert.ok(!r.raw.includes(leaked), `${leaked} reached the response`);
  });

  it("a trip member who does not own the plan sees the same list (and their own name)", async () => {
    installStrict(world());
    const r = await get(`/route-plans/${PLAN}/members`, TOKEN_PLAIN);
    assert.equal(r.status, 200, r.raw);
    assert.equal(byUser(r.body, PLAIN).displayName, "plain display", "the viewer always sees their own name");
    assert.equal(byUser(r.body, OWNER).displayName, "@owner");
  });

  it("no members: 200 with an empty list and no profile read", async () => {
    const { profileReads } = installStrict(world({ route_plan_members: [] }));
    const r = await get(`/route-plans/${PLAN}/members`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.members, []);
    assert.equal(r.body.totalStops, 3);
    assert.equal(profileReads.length, 0);
  });
});

describe("account state follows the trip's own crew roster (GET /trips/:tripId/members)", () => {
  for (const status of ["deactivated", "pending_deletion", "deleted"]) {
    it(`${status}: the member is still listed, as on the trip roster`, async () => {
      const seed = world({ route_plan_members: [member(OWNER, 1), member(GONE, 2)] });
      seed.profiles = seed.profiles.map((p) => (p.id === GONE ? { ...p, account_status: status } : p));
      installStrict(seed);
      const r = await get(`/route-plans/${PLAN}/members`);
      assert.equal(r.status, 200, r.raw);
      assert.deepEqual(r.body.members.map((m: any) => m.userId), [OWNER, GONE]);
      assert.equal(byUser(r.body, GONE).displayName, "@gone");
    });
  }

  it("a member with NO profile row is listed as Traveler with no avatar (the embed's own fallback)", async () => {
    installStrict(world({ route_plan_members: [member(OWNER, 1), member(NOROW, 2)] }));
    const r = await get(`/route-plans/${PLAN}/members`);
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(byUser(r.body, NOROW), { userId: NOROW, displayName: "Traveler", avatarUrl: null, isOwner: false, joinedAt: "2026-09-01T00:02:00.000Z", arrivedCount: 1, totalCount: 3 });
  });
});

describe("a failed read is db_error, never an empty list or a zero count", () => {
  const cases: Array<[string, (ctx: FakeReadContext) => boolean]> = [
    ["route_plan_members", (ctx) => ctx.table === "route_plan_members"],
    ["profiles batch", (ctx) => ctx.table === "profiles" && ctx.filters.some((f) => f.op === "in" && f.col === "id")],
    ["route_stops", (ctx) => ctx.table === "route_stops"],
  ];
  for (const [name, failOn] of cases) {
    it(`${name}: HEALTHY TWIN 200, then FAILURE db_error with no members key`, async () => {
      installFailClosed(world());
      const ok = await get(`/route-plans/${PLAN}/members`);
      assert.equal(ok.status, 200, ok.raw);
      assert.equal(ok.body.members.length, 3);
      assert.equal(ok.body.totalStops, 3);

      installFailClosed(world(), failOn);
      const r = await get(`/route-plans/${PLAN}/members`);
      assert.equal(r.status, 500, r.raw);
      assert.equal(r.body.error, "db_error");
      assert.equal(r.body.members, undefined, "no list is served beside the failure");
      assert.equal(r.body.totalStops, undefined, "no progress count is served beside the failure");
    });
  }
});

describe("both doubles refuse `profiles(...)` from `route_plan_members`", () => {
  it("failClosedSupabase and schemaStrictSupabase throw PGRST200 on the old select", () => {
    const old = "user_id, joined_at, profiles(id, display_name, handle, avatar_url)";
    assert.throws(() => makeFailClosedClient({}).from("route_plan_members").select(old), /failClosedSupabase: `profiles\(\.\.\.\)` is embedded from `route_plan_members`.*PGRST200/);
    assert.throws(() => makeSchemaStrictClient({}).from("route_plan_members").select(old), /schemaStrictSupabase: `profiles\(\.\.\.\)` is embedded from `route_plan_members`.*PGRST200/);
  });
});
