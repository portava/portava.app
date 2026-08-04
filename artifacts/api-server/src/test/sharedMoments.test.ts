import { after, before, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import express from "express";
import { _setTestClient } from "../lib/http.js";
import { areSharedMomentsEnabled } from "../lib/places/sharedMoments.js";
import sharedMomentsRouter from "../routes/sharedMoments.js";
import placeRecapsRouter from "../routes/placeRecaps.js";

function flags(enabled: Record<string, boolean>) {
  return {
    from(table: string) {
      assert.equal(table, "feature_flags");
      return {
        select() { return this; },
        eq(_column: string, value: string) {
          return { maybeSingle: async () => ({ data: { enabled: enabled[value] === true }, error: null }) };
        },
      };
    },
  };
}

const VIEWER_ID = "b1000000-0000-4000-a000-000000000001";
const MOMENT_ID = "a1000000-0000-4000-a000-000000000001";
const OWNER_TOKEN = "shared-moments-owner-token";
const CONTRIBUTION_ONE = "c1000000-0000-4000-a000-000000000001";
const CONTRIBUTION_TWO = "c2000000-0000-4000-a000-000000000002";
const CONTRIBUTION_THREE = "c3000000-0000-4000-a000-000000000003";

type RouteState = {
  feature_flags: { flag: string; enabled: boolean }[];
  shared_moment_memberships: { moment_id: string; user_id: string; role: string; status: string }[];
  shared_moment_contributions: any[];
  shared_moment_audit_events: any[];
  blocks: any[];
  profiles: any[];
  user_follows: any[];
};

function makeRouteClient(state: RouteState) {
  return {
    auth: {
      getUser: async (token: string) => token === OWNER_TOKEN
        ? { data: { user: { id: VIEWER_ID } }, error: null }
        : { data: { user: null }, error: { message: "unauthorized" } },
    },
    from(table: string) {
      const filters: ((row: any) => boolean)[] = [];
      const orders: { column: string; ascending: boolean }[] = [];
      let limit = Number.POSITIVE_INFINITY;
      let updatePayload: Record<string, unknown> | null = null;
      let insertPayload: any = null;

      const source = () => (state as any)[table] ?? [];
      const matchingRows = () => {
        let rows = source().filter((row: any) => filters.every((filter) => filter(row)));
        rows = [...rows].sort((a, b) => {
          for (const order of orders) {
            if (a[order.column] === b[order.column]) continue;
            const result = a[order.column] < b[order.column] ? -1 : 1;
            return order.ascending ? result : -result;
          }
          return 0;
        });
        return rows.slice(0, limit);
      };
      const builder: any = {
        select() { return builder; },
        eq(column: string, value: unknown) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        in(column: string, values: unknown[]) {
          filters.push((row) => values.includes(row[column]));
          return builder;
        },
        or(expression: string) {
          const cursor = expression.match(/^created_at\.lt\.([^,]+),and\(created_at\.eq\.([^,]+),id\.lt\.([^)]+)\)$/);
          if (cursor) {
            filters.push((row) => row.created_at < cursor[1] || (row.created_at === cursor[2] && row.id < cursor[3]));
          } else if (expression.startsWith("blocker_id.eq.") || expression.startsWith("blocked_id.eq.")) {
            const values = expression.split(",").map((part) => part.split(".").at(-1));
            filters.push((row) => values.includes(row.blocker_id) || values.includes(row.blocked_id));
          }
          return builder;
        },
        order(column: string, options?: { ascending?: boolean }) {
          orders.push({ column, ascending: options?.ascending !== false });
          return builder;
        },
        limit(value: number) {
          limit = value;
          return builder;
        },
        update(payload: Record<string, unknown>) {
          updatePayload = payload;
          return builder;
        },
        insert(payload: any) {
          insertPayload = payload;
          return builder;
        },
        async maybeSingle() {
          if (updatePayload) {
            const rows = matchingRows();
            for (const row of rows) Object.assign(row, updatePayload);
            return { data: rows[0] ?? null, error: null };
          }
          if (insertPayload) {
            const row = { id: `audit-${state.shared_moment_audit_events.length + 1}`, ...insertPayload };
            source().push(row);
            return { data: row, error: null };
          }
          return { data: matchingRows()[0] ?? null, error: null };
        },
        then(resolve: any, reject?: any) {
          if (insertPayload) {
            const row = { id: `audit-${state.shared_moment_audit_events.length + 1}`, ...insertPayload };
            source().push(row);
            return Promise.resolve({ data: [row], error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: matchingRows(), error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

function makeRouteState(): RouteState {
  return {
    feature_flags: [
      { flag: "external_places_enabled", enabled: true },
      { flag: "live_places_enabled", enabled: true },
      { flag: "place_days_enabled", enabled: true },
      { flag: "shared_moments_enabled", enabled: true },
    ],
    shared_moment_memberships: [
      { moment_id: MOMENT_ID, user_id: VIEWER_ID, role: "owner", status: "accepted" },
    ],
    shared_moment_contributions: [],
    shared_moment_audit_events: [],
    blocks: [],
    profiles: [],
    user_follows: [],
  };
}

let baseUrl: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", sharedMomentsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
});

after(() => server.close());

async function getFeed(path: string) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${OWNER_TOKEN}` } });
}

async function approve(contributionId: string) {
  return fetch(`${baseUrl}/shared-moments/${MOMENT_ID}/contributions/${contributionId}/approve`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
  });
}

async function invite(userId: string) {
  return fetch(`${baseUrl}/shared-moments/${MOMENT_ID}/invites`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
}

describe("Shared Moments foundation", () => {
  it("requires the Live Places master, Place Days, and Shared Moments flags together", async () => {
    assert.equal(await areSharedMomentsEnabled(flags({
      external_places_enabled: true, live_places_enabled: true, place_days_enabled: true, shared_moments_enabled: true,
    })), true);
    assert.equal(await areSharedMomentsEnabled(flags({
      external_places_enabled: true, live_places_enabled: true, place_days_enabled: true, shared_moments_enabled: false,
    })), false);
    assert.equal(await areSharedMomentsEnabled(flags({
      external_places_enabled: false, live_places_enabled: true, place_days_enabled: true, shared_moments_enabled: true,
    })), false);
    assert.equal(await areSharedMomentsEnabled(flags({
      external_places_enabled: true, live_places_enabled: false, place_days_enabled: true, shared_moments_enabled: true,
    })), false);
  });

  it("keeps suggestion states explicit and never treats an offer as membership", () => {
    const membershipStates = ["invited", "requested", "accepted", "declined", "left", "removed"];
    assert.equal(membershipStates.includes("accepted"), true);
    assert.equal(membershipStates.filter((state) => state === "accepted").length, 1);
    assert.equal(membershipStates.includes("offered"), false);
  });

  it("rejects self-invites without changing the owner's accepted role", async () => {
    const state = makeRouteState();
    _setTestClient(makeRouteClient(state), true);

    const response = await invite(VIEWER_ID);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as any).error, "invalid_payload");
    assert.deepEqual(state.shared_moment_memberships, [
      { moment_id: MOMENT_ID, user_id: VIEWER_ID, role: "owner", status: "accepted" },
    ]);
  });

  it("keeps accepted members idempotently accepted when invited again", async () => {
    const acceptedManager = "b6000000-0000-4000-a000-000000000006";
    const state = makeRouteState();
    state.shared_moment_memberships.push({
      moment_id: MOMENT_ID, user_id: acceptedManager, role: "manager", status: "accepted",
    });
    _setTestClient(makeRouteClient(state), true);

    const response = await invite(acceptedManager);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body, { ok: true, status: "accepted", idempotent: true });
    assert.deepEqual(state.shared_moment_memberships[1], {
      moment_id: MOMENT_ID, user_id: acceptedManager, role: "manager", status: "accepted",
    });
    assert.equal(state.shared_moment_audit_events.length, 0);
  });

  it("uses the created-at and UUID tuple for multi-page feed traversal", async () => {
    const state = makeRouteState();
    state.shared_moment_contributions = [
      { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: "newest", created_at: "2026-08-03T12:00:00.000Z", posts: null },
      { id: "00000000-0000-4000-8000-000000000001", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: "middle-a", created_at: "2026-08-03T11:00:00.000Z", posts: null },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: "middle-b", created_at: "2026-08-03T11:00:00.000Z", posts: null },
      { id: "11111111-1111-4111-8111-111111111111", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: "oldest", created_at: "2026-08-03T10:00:00.000Z", posts: null },
    ];
    _setTestClient(makeRouteClient(state), true);

    const first = await getFeed(`/shared-moments/${MOMENT_ID}/feed?limit=2`);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as any;
    assert.deepEqual(firstBody.items.map((item: any) => item.caption), ["newest", "middle-b"]);
    assert.equal(firstBody.nextCursor, "2026-08-03T11:00:00.000Z|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    const second = await getFeed(`/shared-moments/${MOMENT_ID}/feed?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    assert.equal(second.status, 200);
    const secondBody = await second.json() as any;
    assert.deepEqual(secondBody.items.map((item: any) => item.caption), ["middle-a", "oldest"]);
    assert.equal(secondBody.nextCursor, null);
  });

  it("rejects malformed composite feed cursors", async () => {
    const state = makeRouteState();
    _setTestClient(makeRouteClient(state), true);
    const response = await getFeed(`/shared-moments/${MOMENT_ID}/feed?cursor=not-a-cursor`);
    assert.equal(response.status, 400);
    assert.equal((await response.json() as any).error, "invalid_payload");
  });

  it("keeps paging when filtered rows consume the first database window", async () => {
    const blockedUser = "b2000000-0000-4000-a000-000000000002";
    const state = makeRouteState();
    state.blocks = [{ blocker_id: VIEWER_ID, blocked_id: blockedUser }];
    state.shared_moment_contributions = [
      { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", moment_id: MOMENT_ID, contributor_id: blockedUser, status: "approved", caption: "blocked", created_at: "2026-08-03T12:00:00.000Z", posts: null },
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: "visible-page-one", created_at: "2026-08-03T11:00:00.000Z", posts: null },
      { id: "11111111-1111-4111-8111-111111111111", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: "visible-page-two", created_at: "2026-08-03T10:00:00.000Z", posts: null },
    ];
    _setTestClient(makeRouteClient(state), true);

    const first = await getFeed(`/shared-moments/${MOMENT_ID}/feed?limit=1`);
    assert.equal(first.status, 200);
    const firstBody = await first.json() as any;
    assert.deepEqual(firstBody.items.map((item: any) => item.caption), ["visible-page-one"]);
    assert.ok(firstBody.nextCursor, "filtered rows must not hide the older visible contribution");

    const second = await getFeed(`/shared-moments/${MOMENT_ID}/feed?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor)}`);
    assert.equal(second.status, 200);
    const secondBody = await second.json() as any;
    assert.deepEqual(secondBody.items.map((item: any) => item.caption), ["visible-page-two"]);
    assert.equal(secondBody.nextCursor, null);
  });

  it("hides caption-only contributions from private non-followed accounts", async () => {
    const privateContributor = "b4000000-0000-4000-a000-000000000004";
    const state = makeRouteState();
    state.profiles = [{ id: privateContributor, is_private: true }];
    state.shared_moment_contributions = [
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", moment_id: MOMENT_ID, contributor_id: privateContributor, status: "approved", caption: "private caption", created_at: "2026-08-03T12:00:00.000Z", posts: null },
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: "owner caption", created_at: "2026-08-03T11:00:00.000Z", posts: null },
    ];
    _setTestClient(makeRouteClient(state), true);

    const response = await getFeed(`/shared-moments/${MOMENT_ID}/feed?limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.items.map((item: any) => item.caption), ["owner caption"]);
  });

  it("hides delayed-public post contributions until their publish time passes", async () => {
    const state = makeRouteState();
    const basePost = { author_id: VIEWER_ID, visibility: "public", status: "active", post_status: "published", media_urls: [], profiles: { id: VIEWER_ID, is_private: false } };
    state.shared_moment_contributions = [
      { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: null, created_at: "2026-08-03T12:00:00.000Z", post_id: "p1", posts: { ...basePost, id: "p1", content: "scheduled", publish_at: "2099-01-01T00:00:00.000Z" } },
      { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: null, created_at: "2026-08-03T11:00:00.000Z", post_id: "p2", posts: { ...basePost, id: "p2", content: "already published", publish_at: "2026-01-01T00:00:00.000Z" } },
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved", caption: null, created_at: "2026-08-03T10:00:00.000Z", post_id: "p3", posts: { ...basePost, id: "p3", content: "no schedule", publish_at: null } },
    ];
    _setTestClient(makeRouteClient(state), true);

    const response = await getFeed(`/shared-moments/${MOMENT_ID}/feed?limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.items.map((item: any) => item.caption), ["already published", "no schedule"]);
  });

  it("only audits a contribution after a real pending-to-approved transition", async () => {
    const state = makeRouteState();
    state.shared_moment_contributions = [
      { id: CONTRIBUTION_ONE, moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "pending" },
      { id: CONTRIBUTION_TWO, moment_id: MOMENT_ID, contributor_id: VIEWER_ID, status: "approved" },
      { id: CONTRIBUTION_THREE, moment_id: "a3000000-0000-4000-a000-000000000003", contributor_id: VIEWER_ID, status: "pending" },
    ];
    _setTestClient(makeRouteClient(state), true);

    const approved = await approve(CONTRIBUTION_ONE);
    assert.equal(approved.status, 200);
    assert.equal(state.shared_moment_contributions[0].status, "approved");
    assert.equal(state.shared_moment_audit_events.length, 1);

    const alreadyApproved = await approve(CONTRIBUTION_TWO);
    assert.equal(alreadyApproved.status, 404);
    assert.equal((await alreadyApproved.json() as any).error, "not_found");
    assert.equal(state.shared_moment_audit_events.length, 1);

    const wrongMoment = await approve(CONTRIBUTION_THREE);
    assert.equal(wrongMoment.status, 404);
    assert.equal((await wrongMoment.json() as any).error, "not_found");
    assert.equal(state.shared_moment_audit_events.length, 1);
  });
});

describe("Place Recap lifecycle routes", () => {
  const recapId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const token = "recap-owner-token";
  const actions: string[] = [];
  let recapServer: ReturnType<typeof createServer>;
  let recapBaseUrl: string;

  function recapClient() {
    const recap = {
      id: recapId,
      owner_id: userId,
      place_day_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      moment_id: null,
      status: "published",
    };
    return {
      auth: {
        getUser: async (authToken: string) =>
          authToken === token
            ? { data: { user: { id: userId } }, error: null }
            : { data: { user: null }, error: { message: "unauthorized" } },
      },
      from(table: string) {
        const filters: Array<(row: any) => boolean> = [];
        const rows = table === "feature_flags"
          ? [
              { flag: "external_places_enabled", enabled: true },
              { flag: "live_places_enabled", enabled: true },
              { flag: "place_days_enabled", enabled: true },
              { flag: "place_recaps_enabled", enabled: true },
            ]
          : table === "live_place_recaps"
            ? [recap]
            : table === "profiles"
              ? [{ id: userId, account_status: "active" }]
              : [];
        const chain: any = {
          select: () => chain,
          eq: (column: string, value: unknown) => {
            filters.push((row) => row[column] === value);
            return chain;
          },
          maybeSingle: async () => ({
            data: rows.find((row) => filters.every((matches) => matches(row))) ?? null,
            error: null,
          }),
        };
        return chain;
      },
      rpc: async (name: string, args: { p_action: string }) => {
        assert.equal(name, "transition_live_place_recap");
        actions.push(args.p_action);
        return { data: { recap, version: { status: args.p_action } }, error: null };
      },
    };
  }

  before(async () => {
    _setTestClient(recapClient(), true);
    const app = express();
    app.use("/api", placeRecapsRouter);
    recapServer = createServer(app);
    await new Promise<void>((resolve) => recapServer.listen(0, "127.0.0.1", resolve));
    recapBaseUrl = `http://127.0.0.1:${(recapServer.address() as { port: number }).port}/api`;
  });

  after(() => recapServer.close());

  it("passes explicit archive, restore, and remove actions to the lifecycle RPC", async () => {
    for (const action of ["archive", "restore", "remove"]) {
      const response = await fetch(`${recapBaseUrl}/place-recaps/${recapId}/${action}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).version.status, action);
    }
    assert.deepEqual(actions, ["archive", "restore", "remove"]);
  });

  it("returns invalid_payload for a malformed place recap list identifier", async () => {
    const response = await fetch(`${recapBaseUrl}/places/not-a-uuid/recaps`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as any).error, "invalid_payload");
  });
});