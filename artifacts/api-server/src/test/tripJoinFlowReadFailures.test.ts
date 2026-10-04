/**
 * The join flow's reads, when the database does not answer — Trips lane,
 * census-trips §79.
 *
 * supabase-js RESOLVES `{ data: null, error }` on a database error; it does
 * not throw. Each route below read with `const { data } = await …` and turned
 * that `null` into a sentence about the trip that no query had answered:
 *
 *   accept-invite / decline-invite  "No invitation found for this trip" (404)
 *                                   — to an invited traveller, on an outage;
 *                                   404 is not retryable, so the app stops.
 *   invitable-users                 an unreadable crew roster offered the
 *                                   trip's own crew as people to invite; an
 *                                   unreadable friend list or profile read
 *                                   said "nobody to invite".
 *   plan-editable-trips             an unreadable `plan_editors` silently
 *                                   dropped every specific_members trip from
 *                                   the "add to a trip" picker.
 *   GET /trips/join-requests        the review queue was the OWNER's trips
 *                                   only, so a co-host — whom the approve and
 *                                   decline routes accept as a host — had no
 *                                   queue at all (census-trips §77.6, F06).
 *
 * Every failure here must be 503 `degraded_unavailable` (retryable), and every
 * control case (the read answered) must keep its old answer.
 *
 * Run: node --import tsx/esm --test src/test/tripJoinFlowReadFailures.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { globalErrorHandler } from "../lib/errorEnvelope.js";
import tripsRouter from "../routes/trips.js";
import tripsExpansionRouter from "../routes/trips-expansion.js";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001"; // owner
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";   // invited / co-host
const CARL = "cccccccc-0000-4000-8000-000000000003";  // crew member
const DORA = "dddddddd-0000-4000-8000-000000000004";  // friend of Alice
const EVE = "eeeeeeee-0000-4000-8000-000000000005";   // join requester
const TRIP = "11111111-0000-4000-8000-000000000001";
const TRIP2 = "22222222-0000-4000-8000-000000000002";

type Row = Record<string, any>;
interface State { [table: string]: Row[] }

/**
 * Which reads fail: `${table}:${kind}` where kind is "one" (maybeSingle/single)
 * or "list", optionally narrowed to reads filtered by `.eq(col)` as
 * `${table}:${kind}@${col}` — the two directions of a friendship are two reads.
 */
type FailKey = string;

function baseState(): State {
  return {
    trips: [
      { id: TRIP, owner_id: ALICE, title: "Lisbon", visibility: "private", plan_edit_permission: "specific_members", destination_city: "Lisbon" },
      { id: TRIP2, owner_id: CARL, title: "Porto", visibility: "private", plan_edit_permission: "owner_only", destination_city: "Porto" },
    ],
    trip_members: [
      { trip_id: TRIP, user_id: ALICE, role: "owner", status: "accepted" },
      { trip_id: TRIP, user_id: CARL, role: "member", status: "accepted" },
      { trip_id: TRIP2, user_id: CARL, role: "owner", status: "accepted" },
    ],
    user_friendships: [{ user_a: ALICE, user_b: DORA }, { user_a: CARL, user_b: ALICE }],
    profiles: [ALICE, BOB, CARL, DORA, EVE].map((id) => ({ id, handle: `h${id.slice(0, 4)}`, name: id.slice(0, 4), avatar_url: null })),
    plan_editors: [{ trip_id: TRIP, user_id: CARL }],
    trip_join_requests: [
      { id: "99999999-0000-4000-8000-000000000001", trip_id: TRIP, user_id: EVE, status: "pending", message: null, created_at: "2026-10-01T00:00:00Z" },
      { id: "99999999-0000-4000-8000-000000000002", trip_id: TRIP2, user_id: EVE, status: "pending", message: null, created_at: "2026-10-01T00:00:00Z" },
    ],
    blocks: [],
    profile_privacy_settings: [],
  };
}

function makeClient(state: State, fail: Set<FailKey>, users: Record<string, string>) {
  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = [];
    const eqCols: string[] = [];
    let op: "select" | "update" | "delete" | "insert" | "upsert" = "select";
    let payload: any = null;
    const failed = (kind: string) => fail.has(`${table}:${kind}`) || eqCols.some((c) => fail.has(`${table}:${kind}@${c}`));
    const rows = () => (state[table] ?? []).filter((r) => filters.every((f) => f(r)));
    const b: any = {
      select() { return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      upsert(p: any) { op = "upsert"; payload = p; return b; },
      eq(c: string, v: any) { eqCols.push(c); filters.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return b; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return b; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return b; },
      not() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      range() { return b; },
      async maybeSingle() {
        if (op !== "select") return { data: null, error: null };
        if (failed("one")) return { data: null, error: { message: "boom", code: "08006" } };
        const m = rows();
        return { data: m[0] ? { ...m[0] } : null, error: null };
      },
      async single() { return b.maybeSingle(); },
      then(onF: any, onR: any) {
        let out: any;
        if (op === "update") { for (const r of rows()) Object.assign(r, payload); out = { data: null, error: null }; }
        else if (op === "delete") { state[table] = (state[table] ?? []).filter((r) => !filters.every((f) => f(r))); out = { data: null, error: null }; }
        else if (op === "insert" || op === "upsert") out = { data: null, error: null };
        else if (failed("list")) out = { data: null, error: { message: "boom", code: "08006" } };
        else out = { data: rows().map((r) => ({ ...r })), error: null };
        return Promise.resolve(out).then(onF, onR);
      },
    };
    return b;
  }
  return {
    from,
    rpc: async () => ({ data: null, error: null }),
    auth: {
      getUser: async (token: string) => {
        const id = users[token];
        return id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "bad" } };
      },
    },
  };
}

async function withServer(state: State, fail: Set<FailKey>, fn: (port: number) => Promise<void>) {
  const client = makeClient(state, fail, { alice: ALICE, bob: BOB, carl: CARL });
  _setTestClient(client as any, true);
  _setTestServiceClient(client as any);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.log = { error() {}, info() {}, warn() {} }; next(); });
  app.use("/api", tripsExpansionRouter);
  app.use("/api", tripsRouter);
  app.use(globalErrorHandler as any);
  const srv = createServer(app);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  try {
    await fn((srv.address() as any).port);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
    _setTestServiceClient(null as any);
  }
}

async function call(port: number, method: string, path: string, token: string) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", connection: "close" },
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

describe("accept-invite / decline-invite: an unreadable invitation is not an absent one", () => {
  for (const action of ["accept-invite", "decline-invite"]) {
    it(`${action}: unreadable trip_members → 503 degraded_unavailable, nothing written`, async () => {
      const s = baseState();
      s.trip_members.push({ trip_id: TRIP, user_id: BOB, role: "invited", status: "accepted" });
      const before = JSON.stringify(s.trip_members);
      await withServer(s, new Set(["trip_members:one"]), async (port) => {
        const r = await call(port, "POST", `/api/trips/${TRIP}/${action}`, "bob");
        assert.equal(r.status, 503, JSON.stringify(r.body));
        assert.equal(r.body?.error, "degraded_unavailable");
        assert.notEqual(r.body?.error, "not_found");
      });
      assert.equal(JSON.stringify(s.trip_members), before, "a refused read writes nothing");
    });

    it(`${action}: control — a READ that finds no row is still 404 not_found`, async () => {
      await withServer(baseState(), new Set(), async (port) => {
        const r = await call(port, "POST", `/api/trips/${TRIP}/${action}`, "bob");
        assert.equal(r.status, 404);
        assert.equal(r.body?.error, "not_found");
      });
    });
  }
});

describe("GET /trips/:tripId/invitable-users: no picker out of a read that failed", () => {
  it("control — every read answers: crew are crew, friends are invitable", async () => {
    await withServer(baseState(), new Set(), async (port) => {
      const r = await call(port, "GET", `/api/trips/${TRIP}/invitable-users`, "alice");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.groupMembers.map((u: any) => u.id), [CARL]);
      assert.deepEqual(r.body.otherFollowers.map((u: any) => u.id), [DORA]);
    });
  });

  it("a co-host is crew, not someone to invite; a member who left is invitable again", async () => {
    const s = baseState();
    s.user_friendships.push({ user_a: ALICE, user_b: BOB });
    s.trip_members.push({ trip_id: TRIP, user_id: BOB, role: "co_host", status: "accepted" });
    s.trip_members.find((m) => m.user_id === CARL && m.trip_id === TRIP)!.status = "left";
    await withServer(s, new Set(), async (port) => {
      const r = await call(port, "GET", `/api/trips/${TRIP}/invitable-users`, "alice");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.groupMembers.map((u: any) => u.id), [BOB]);
      assert.deepEqual(r.body.otherFollowers.map((u: any) => u.id).sort(), [CARL, DORA].sort());
    });
  });

  for (const [key, what] of [
    ["trip_members:list", "the crew roster (crew would be offered as people to invite)"],
    ["user_friendships:list@user_a", "the friends the caller added (\"nobody to invite\")"],
    ["user_friendships:list@user_b", "the friends who added the caller (half a picker)"],
    ["profiles:list", "the profiles (every person dropped)"],
  ] as const) {
    it(`unreadable ${what} → 503 degraded_unavailable`, async () => {
      await withServer(baseState(), new Set([key]), async (port) => {
        const r = await call(port, "GET", `/api/trips/${TRIP}/invitable-users`, "alice");
        assert.equal(r.status, 503, JSON.stringify(r.body));
        assert.equal(r.body?.error, "degraded_unavailable");
      });
    });
  }
});

describe("GET /me/plan-editable-trips: an unreadable editor list does not drop trips", () => {
  it("control — a specific_members editor sees the trip", async () => {
    await withServer(baseState(), new Set(), async (port) => {
      const r = await call(port, "GET", `/api/me/plan-editable-trips`, "carl");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.trips.map((t: any) => t.id).sort(), [TRIP, TRIP2].sort());
    });
  });

  it("unreadable plan_editors → 503, not a picker without the trip", async () => {
    await withServer(baseState(), new Set(["plan_editors:list"]), async (port) => {
      const r = await call(port, "GET", `/api/me/plan-editable-trips`, "carl");
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body?.error, "degraded_unavailable");
    });
  });
});

describe("GET /trips/join-requests: the co-host's review queue (TRIP-F06)", () => {
  it("the owner sees the requests on the trips they own", async () => {
    await withServer(baseState(), new Set(), async (port) => {
      const r = await call(port, "GET", `/api/trips/join-requests`, "alice");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.requests.map((q: any) => q.tripId), [TRIP]);
    });
  });

  it("an accepted co-host sees the requests on the trip they co-host", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP, user_id: BOB, role: "co_host", status: "accepted" });
    await withServer(s, new Set(), async (port) => {
      const r = await call(port, "GET", `/api/trips/join-requests`, "bob");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.requests.map((q: any) => q.tripId), [TRIP]);
    });
  });

  it("a plain member, an invited co-host and a co-host who left see nothing", async () => {
    for (const row of [
      { role: "member", status: "accepted" },
      { role: "co_host", status: "left" },
      { role: "invited", status: "accepted" },
    ]) {
      const s = baseState();
      s.trip_members.push({ trip_id: TRIP, user_id: BOB, ...row });
      await withServer(s, new Set(), async (port) => {
        const r = await call(port, "GET", `/api/trips/join-requests`, "bob");
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.requests, [], JSON.stringify(row));
      });
    }
  });

  it("a trip both owned and co-hosted is listed once", async () => {
    const s = baseState();
    s.trip_members.push({ trip_id: TRIP2, user_id: ALICE, role: "co_host", status: "accepted" });
    await withServer(s, new Set(), async (port) => {
      const r = await call(port, "GET", `/api/trips/join-requests`, "alice");
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.requests.map((q: any) => q.tripId).sort(), [TRIP, TRIP2].sort());
    });
  });

  it("an unreadable co-host roster → 503, not the owner's half presented as the queue", async () => {
    await withServer(baseState(), new Set(["trip_members:list"]), async (port) => {
      const r = await call(port, "GET", `/api/trips/join-requests`, "alice");
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body?.error, "degraded_unavailable");
    });
  });
});
