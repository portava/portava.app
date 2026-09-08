/**
 * WRITE-PRECONDITION unchecked reads — lane B, part 2.
 *
 * Companion to src/test/p2LaneBWritePreconditions.test.ts, same defect and same
 * discipline. These five sites all sit on routes whose guard stack has to be
 * satisfied before the read under test is even reached (trip membership, plan
 * edit permission, the interaction-permission engine, a Shared Moments
 * capability flag), which is exactly why an `assert.notEqual(status, 200)`
 * would be worthless here: every one of those gates ALSO produces a non-200.
 * Each test therefore names the exact status and error code, AND asserts on the
 * fake's write buckets so "refused" means the write did not happen.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/p2LaneBDuplicateGuards.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { _setTestClient } from "../lib/http.js";
import { makeFailClosedClient, noopLog } from "./helpers/failClosedSupabase.js";

import planRouter from "../routes/plan.js";
import hiddenGemsRouter from "../routes/hiddenGems.js";
import sharedMomentsRouter from "../routes/sharedMoments.js";
import followsRouter from "../routes/follows.js";

const USER    = "aaaaaaaa-0000-4000-a000-000000000001";
const TARGET  = "bbbbbbbb-0000-4000-a000-000000000002";
const TRIP    = "cccccccc-0000-4000-a000-000000000003";
const MEETUP  = "dddddddd-0000-4000-a000-000000000004";
const PLACE   = "eeeeeeee-0000-4000-a000-000000000005";
const GEM     = "ffffffff-0000-4000-a000-000000000006";
const MOMENT  = "aaaaaaaa-1111-4000-a000-000000000007";
const TOKEN   = "tok-user";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

let server: http.Server;
let base: string;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).log = noopLog; next(); });
  app.use("/api", planRouter);
  app.use("/api", hiddenGemsRouter);
  app.use("/api", sharedMomentsRouter);
  app.use("/api", followsRouter);
  server = http.createServer(app);
  // 127.0.0.1 explicitly: a host-less listen(0) binds the IPv6 wildcard, and the
  // kernel may hand back a port a foreign process already holds on loopback —
  // the request then reaches the stranger and a random case in this file fails on
  // whatever it answered. The address makes the bind DEFERRED (node routes it
  // through lookupAndListen), so the callback, not the next line, is when
  // address() is readable. check:loopback-bind enforces this.
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(async () => { await new Promise<void>((r) => server.close(() => r())); });

function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      {
        hostname: url.hostname, port: Number(url.port),
        path: url.pathname + url.search, method,
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function install(spec: any) {
  spec.users = { [TOKEN]: USER };
  spec.inserted ??= {};
  spec.updated  ??= {};
  _setTestClient(makeFailClosedClient(spec), true);
  return spec;
}

function assertDbError(r: { status: number; body: any }) {
  assert.equal(r.body?.error, "db_error", `expected the db_error envelope, got ${JSON.stringify(r.body)}`);
  assert.equal(r.status, 500);
}

// ═══════════════════════════════════════════════════════════════════════════
// plan — POST /meetups/:meetupId/add-to-trip-plan
//        POST /places/:placeId/add-to-trip-plan
//
// The duplicate guard is the only thing between a second tap and a second copy
// of the same item in the shared trip timeline. `feature_flags` carries no
// trip-kernel row, so the legacy insert path runs and the write is visible in
// the fake's `inserted` bucket.
// ═══════════════════════════════════════════════════════════════════════════

function planRows(extra: Record<string, any[]> = {}) {
  return {
    profiles: [{ id: USER, account_status: "active" }],
    trips: [{ id: TRIP, owner_id: USER, plan_edit_permission: "all_members" }],
    trip_members: [],
    feature_flags: [],
    meetups: [{ id: MEETUP, title: "Sunset at Miradouro", starts_at: null, location_name: "Graça", trip_id: null }],
    discovery_places: [{ id: PLACE, name: "Time Out Market", category: "food", city: "Lisbon" }],
    trip_plan_items: [],
    ...extra,
  };
}

const EXISTING_MEETUP_ITEM = { id: "pi1", trip_id: TRIP, source_type: "meetup", source_id: MEETUP, removed_at: null };
const EXISTING_PLACE_ITEM  = { id: "pi2", trip_id: TRIP, source_type: "place",  source_id: PLACE,  removed_at: null };

describe("POST /meetups/:meetupId/add-to-trip-plan — duplicate guard", () => {
  it("FAILURE: an unreadable trip_plan_items refuses instead of adding the meetup twice", async () => {
    const spec = install({
      rows: planRows({ trip_plan_items: [EXISTING_MEETUP_ITEM] }),
      failOn: (ctx: any) => (ctx.table === "trip_plan_items" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/meetups/${MEETUP}/add-to-trip-plan`, { tripId: TRIP });
    assertDbError(r);
    assert.equal(spec.inserted.trip_plan_items, undefined, "no duplicate plan item may be written");
  });

  it("HEALTHY: a real duplicate still gets the 409", async () => {
    const spec = install({ rows: planRows({ trip_plan_items: [EXISTING_MEETUP_ITEM] }) });
    const r = await req("POST", `/api/meetups/${MEETUP}/add-to-trip-plan`, { tripId: TRIP });
    assert.equal(r.body?.error, "duplicate", `got ${JSON.stringify(r.body)}`);
    assert.equal(r.status, 409);
    assert.equal(spec.inserted.trip_plan_items, undefined);
  });

  it("HEALTHY: a first add still writes the plan item", async () => {
    const spec = install({ rows: planRows() });
    const r = await req("POST", `/api/meetups/${MEETUP}/add-to-trip-plan`, { tripId: TRIP });
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.trip_plan_items?.length, 1);
    assert.equal(spec.inserted.trip_plan_items[0].source_id, MEETUP);
  });
});

describe("POST /places/:placeId/add-to-trip-plan — duplicate guard", () => {
  it("FAILURE: an unreadable trip_plan_items refuses instead of adding the place twice", async () => {
    const spec = install({
      rows: planRows({ trip_plan_items: [EXISTING_PLACE_ITEM] }),
      failOn: (ctx: any) => (ctx.table === "trip_plan_items" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/places/${PLACE}/add-to-trip-plan`, { tripId: TRIP });
    assertDbError(r);
    assert.equal(spec.inserted.trip_plan_items, undefined, "no duplicate plan item may be written");
  });

  it("HEALTHY: a real duplicate still gets the 409", async () => {
    const spec = install({ rows: planRows({ trip_plan_items: [EXISTING_PLACE_ITEM] }) });
    const r = await req("POST", `/api/places/${PLACE}/add-to-trip-plan`, { tripId: TRIP });
    assert.equal(r.body?.error, "duplicate", `got ${JSON.stringify(r.body)}`);
    assert.equal(r.status, 409);
    assert.equal(spec.inserted.trip_plan_items, undefined);
  });

  it("HEALTHY: a first add still writes the plan item", async () => {
    const spec = install({ rows: planRows() });
    const r = await req("POST", `/api/places/${PLACE}/add-to-trip-plan`, { tripId: TRIP });
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(spec.inserted.trip_plan_items?.length, 1);
    assert.equal(spec.inserted.trip_plan_items[0].source_id, PLACE);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// hiddenGems — POST /hidden-gems/:id/plan
// ═══════════════════════════════════════════════════════════════════════════

function gemRows(extra: Record<string, any[]> = {}) {
  return planRows({
    feature_flags: [{ flag: "hidden_gems_enabled", enabled: true }],
    hidden_gems: [{
      id: GEM, name: "The Blue Door", city: "Lisbon", country: "PT", category: "food",
      description: null, submitted_by: TARGET, sensitivity: "public", status: "approved",
    }],
    ...extra,
  });
}

const EXISTING_GEM_ITEM = { id: "pi3", trip_id: TRIP, source_type: "hidden_gem", source_id: GEM, removed_at: null };

describe("POST /hidden-gems/:id/plan — duplicate guard", () => {
  it("FAILURE: an unreadable trip_plan_items refuses instead of adding the gem twice", async () => {
    const spec = install({
      rows: gemRows({ trip_plan_items: [EXISTING_GEM_ITEM] }),
      failOn: (ctx: any) =>
        // Only the duplicate-guard read is failed. The `trips` reads that
        // canEditPlan makes stay healthy, so a refusal here cannot be the
        // authorization gate answering instead of the code under test.
        ctx.table === "trip_plan_items" ? READ_FAIL : null,
    });
    const r = await req("POST", `/api/hidden-gems/${GEM}/plan`, { tripId: TRIP });
    assertDbError(r);
    assert.equal(spec.inserted.trip_plan_items, undefined, "no duplicate plan item may be written");
  });

  it("HEALTHY: a real duplicate still gets the 409", async () => {
    const spec = install({ rows: gemRows({ trip_plan_items: [EXISTING_GEM_ITEM] }) });
    const r = await req("POST", `/api/hidden-gems/${GEM}/plan`, { tripId: TRIP });
    assert.equal(r.body?.error, "duplicate", `got ${JSON.stringify(r.body)}`);
    assert.equal(r.status, 409);
    assert.equal(spec.inserted.trip_plan_items, undefined);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// sharedMoments — POST /shared-moments/:id/request
//
// The membership read is what stops the upsert running on an ALREADY-ACCEPTED
// member and demoting them to "requested" — i.e. revoking their own access.
// ═══════════════════════════════════════════════════════════════════════════

const MOMENT_FLAGS = [
  { flag: "external_places_enabled", enabled: true },
  { flag: "live_places_enabled",     enabled: true },
  { flag: "place_days_enabled",      enabled: true },
  { flag: "shared_moments_enabled",  enabled: true },
];

function momentRows(memberships: any[]) {
  return {
    profiles: [{ id: USER, account_status: "active" }],
    feature_flags: MOMENT_FLAGS,
    blocks: [],
    shared_moments: [{
      id: MOMENT, owner_id: TARGET, title: "Alfama night", status: "active",
      join_policy: "approval_required", created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    }],
    shared_moment_memberships: memberships,
    shared_moment_audit_events: [],
  };
}

const ACCEPTED_MEMBERSHIP = { moment_id: MOMENT, user_id: USER, role: "member", status: "accepted" };

describe("POST /shared-moments/:id/request — membership read", () => {
  it("FAILURE: an unreadable membership refuses instead of demoting an accepted member", async () => {
    const spec = install({
      rows: momentRows([ACCEPTED_MEMBERSHIP]),
      failOn: (ctx: any) => (ctx.table === "shared_moment_memberships" ? READ_FAIL : null),
    });
    const r = await req("POST", `/api/shared-moments/${MOMENT}/request`, {});
    assertDbError(r);
    assert.equal(
      spec.inserted.shared_moment_memberships, undefined,
      "an accepted member must not be upserted back down to 'requested'",
    );
  });

  it("HEALTHY: an accepted member gets the idempotent 200 and no write", async () => {
    const spec = install({ rows: momentRows([ACCEPTED_MEMBERSHIP]) });
    const r = await req("POST", `/api/shared-moments/${MOMENT}/request`, {});
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.status, "accepted");
    assert.equal(r.body?.idempotent, true);
    assert.equal(spec.inserted.shared_moment_memberships, undefined);
  });

  it("HEALTHY: a non-member's join request is still recorded", async () => {
    const spec = install({ rows: momentRows([]) });
    const r = await req("POST", `/api/shared-moments/${MOMENT}/request`, {});
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.status, "requested");
    assert.equal(spec.inserted.shared_moment_memberships?.[0]?.status, "requested");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// follows — POST /users/:userId/follow against a PRIVATE profile
//
// A follow of a private profile is routed into the friend-request flow. Two
// friend_requests reads decide what happens: the outgoing lookup (2 filters)
// and the incoming-pending lookup (3 filters). They are failed independently by
// filter count so each test names one site — the permission engine's own
// friend_requests probes carry the 3-filter shape, which is why the outgoing
// test can leave them healthy and prove the refusal came from the route.
// ═══════════════════════════════════════════════════════════════════════════

function followRows(friendRequests: any[]) {
  return {
    profiles: [
      { id: USER,   account_status: "active", is_private: false },
      { id: TARGET, account_status: "active", is_private: true, tag_permission: "anyone" },
    ],
    blocks: [],
    friend_requests: friendRequests,
    user_friendships: [],
    user_follows: [],
    user_account_states: [],
    user_privacy_settings: [],
    profile_privacy_settings: [],
    user_message_settings: [],
    user_interaction_cooldowns: [],
    user_mutes: [],
    user_restrictions: [],
    moderation_actions: [],
    trip_members: [],
    circle_memberships: [],
    rent_buddy_bookings: [],
  };
}

const INCOMING_PENDING = { id: "fr2", requester_id: TARGET, recipient_id: USER, status: "pending" };
// A DECLINED outgoing request is the state that actually reaches the route's
// own outgoing lookup: the permission engine only probes for status='pending',
// so it reports canAddFriend and hands the decision to the route — which is
// supposed to REACTIVATE this row rather than insert a second one. (With a
// pending row the engine short-circuits at "Friend request not allowed" and the
// read under test is never reached, which would have made the test vacuous.)
const OUTGOING_DECLINED = { id: "fr1", requester_id: USER, recipient_id: TARGET, status: "declined" };

describe("POST /users/:userId/follow — outgoing friend_requests lookup", () => {
  it("FAILURE: an unreadable outgoing lookup refuses instead of inserting over a declined request", async () => {
    const spec = install({
      rows: followRows([OUTGOING_DECLINED]),
      // 2 filters == the route's own outgoing lookup; the engine's probes all
      // carry a third (status) filter and stay healthy, so the refusal cannot
      // be the permission engine answering instead of the code under test.
      failOn: (ctx: any) =>
        ctx.table === "friend_requests" && ctx.filters.length === 2 ? READ_FAIL : null,
    });
    const r = await req("POST", `/api/users/${TARGET}/follow`, {});
    assertDbError(r);
    assert.equal(spec.inserted.friend_requests, undefined, "no second friend_requests row may be created");
    assert.equal(spec.updated.friend_requests, undefined, "and nothing may be reactivated blind");
  });

  it("HEALTHY: a declined request is still REACTIVATED rather than duplicated", async () => {
    const spec = install({ rows: followRows([OUTGOING_DECLINED]) });
    const r = await req("POST", `/api/users/${TARGET}/follow`, {});
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.status, "outgoing_pending");
    assert.equal(r.body?.reactivated, true);
    assert.equal(spec.updated.friend_requests?.[0]?.status, "pending");
    assert.equal(
      spec.inserted.friend_requests, undefined,
      "the reactivating UPDATE is the whole point — an INSERT here is the fail-open outcome",
    );
  });
});

describe("POST /users/:userId/follow — incoming friend_requests lookup", () => {
  it("FAILURE: an unreadable incoming lookup refuses instead of skipping auto-accept", async () => {
    const spec = install({
      rows: followRows([INCOMING_PENDING]),
      // 3 filters covers the incoming-pending lookup. The engine's own
      // 3-filter probes fail too, which only makes canAddFriend MORE
      // permissive — so reaching the refusal proves it is the route's, and the
      // 2-filter outgoing lookup stays healthy and correctly finds nothing.
      failOn: (ctx: any) =>
        ctx.table === "friend_requests" && ctx.filters.length >= 3 ? READ_FAIL : null,
    });
    const r = await req("POST", `/api/users/${TARGET}/follow`, {});
    assertDbError(r);
    assert.equal(spec.inserted.friend_requests, undefined, "no crossed request may be created");
    assert.equal(spec.updated.user_friendships, undefined);
  });

  it("HEALTHY: a pending incoming request is still auto-accepted into a friendship", async () => {
    const spec = install({ rows: followRows([INCOMING_PENDING]) });
    const r = await req("POST", `/api/users/${TARGET}/follow`, {});
    assert.equal(r.status, 200, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.status, "friends");
    assert.equal(r.body?.autoAccepted, true);
    assert.equal(spec.updated.friend_requests?.[0]?.status, "accepted");
    assert.equal(spec.inserted.user_friendships?.length, 1);
  });

  it("HEALTHY: with no request in either direction a new one is still created", async () => {
    const spec = install({ rows: followRows([]) });
    const r = await req("POST", `/api/users/${TARGET}/follow`, {});
    assert.equal(r.status, 201, `got ${JSON.stringify(r.body)}`);
    assert.equal(r.body?.status, "outgoing_pending");
    assert.equal(spec.inserted.friend_requests?.length, 1);
  });
});
