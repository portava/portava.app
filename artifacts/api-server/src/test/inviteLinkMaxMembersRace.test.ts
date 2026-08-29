/**
 * inviteLinkMaxMembersRace.test.ts
 *
 * Verifies that the max_members capacity guard prevents over-subscription when
 * two accept requests race past the application-layer pre-flight check.
 *
 * Background:
 *   Two layers enforce max_members:
 *
 *   1. Fast-path in claim_invite_link_slot_for_user (migration 0115):
 *      Returns 'trip_full' when the trip is obviously full at claim time,
 *      skipping the INSERT entirely. This is an optimisation — not a race guard.
 *
 *   2. BEFORE INSERT trigger on trip_members (migration 0115):
 *      The authoritative atomic gate. Fires within the INSERT transaction,
 *      acquires FOR UPDATE on the trips row, counts accepted members, and raises
 *      SQLSTATE P0001 / message 'trip_full' if the cap is reached.  Two
 *      concurrent INSERTs serialise at the FOR UPDATE lock, so only one can
 *      commit when max_members = 1.
 *
 *   This test covers both layers and the handler paths that consume them.
 *
 * Scenarios:
 *   1. claim returns 'trip_full' → handler returns HTTP 410 with
 *      { error:"gone", reason:"trip_full" } without touching trip_members.
 *
 *   2. Race via claim layer: stateful fake client lets first call return
 *      'claimed' and second return 'trip_full'.  Exactly one 201, one 410.
 *
 *   3. Race via trigger layer: both claims return 'claimed', but the second
 *      INSERT fails with { code:'P0001', message:'trip_full' } (trigger fired).
 *      Handler must release the slot and return 410 with reason:"trip_full".
 *
 *   4. Trigger 'trip_full' on a retry attempt (isRetryAttempt=true): slot was
 *      already claimed in a prior crash — handler must NOT release the slot.
 *
 *   5. release_invite_link_slot is NOT called when claim returns 'trip_full'
 *      (no slot was consumed).
 *
 *   6. trip_members INSERT is not attempted when claim returns 'trip_full'.
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ---------------------------------------------------------------------------
// Fixed test IDs — only [0-9a-f] hex chars so UUID_RE validation passes
// ---------------------------------------------------------------------------
const OWNER_ID   = "a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1";
const JOINER_A   = "b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2";
const TRIP_ID    = "d4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4";
const LINK_ID    = "e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5";
const LINK_TOKEN = "max-members-race-guard-token-abc123456";

// ---------------------------------------------------------------------------
// Shared fake-client base builder
// ---------------------------------------------------------------------------
function makeBaseClient(opts: {
  userId: string;
  claimResult: string | (() => string);
  insertError?: { message: string; code?: string } | null;
  isRetryAttempt?: boolean;
}): {
  client: any;
  rpcCalls: Array<{ fn: string; args: Record<string, any> }>;
  tripMemberInserts: { count: number };
} {
  const { userId, isRetryAttempt = false, insertError = null } = opts;
  const rpcCalls: Array<{ fn: string; args: Record<string, any> }> = [];
  const tripMemberInserts = { count: 0 };

  const getClaimResult = typeof opts.claimResult === "function"
    ? opts.claimResult
    : () => opts.claimResult as string;

  // When isRetryAttempt=true, the attempt row already exists: getUser must
  // return the retry-user token and the first table query for attempts returns a row.
  let attemptLedgerHasRow = isRetryAttempt;

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === `token-${userId}`) {
          return { data: { user: { id: userId } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid token" } };
      },
    },

    rpc: async (fn: string, args: Record<string, any>) => {
      rpcCalls.push({ fn, args });
      if (fn === "claim_invite_link_slot_for_user") {
        // When isRetryAttempt, the DB function returns 'already_attempted'.
        if (attemptLedgerHasRow) return { data: "already_attempted", error: null };
        return { data: getClaimResult(), error: null };
      }
      if (fn === "release_invite_link_slot") {
        return { data: null, error: null };
      }
      return { data: null, error: { message: `Unknown rpc: ${fn}` } };
    },

    from: (tableName: string) => {
      const obj: any = {
        select() { return obj; },
        eq()     { return obj; },
        or()     { return obj; },
        limit() { return obj; }, // isBlockedBetween chains .or().limit(1)
        delete() {
          // Simulate attempt row cleanup.
          attemptLedgerHasRow = false;
          return obj;
        },

        insert() {
          if (tableName === "trip_members") {
            tripMemberInserts.count += 1;
          }
          const err = (tableName === "trip_members") ? (insertError ?? null) : null;
          return {
            then(onF: any, onR: any) {
              return Promise.resolve({ data: null, error: err }).then(onF, onR);
            },
          };
        },

        maybeSingle() {
          if (tableName === "trip_invite_links") {
            return Promise.resolve({
              data: {
                id:         LINK_ID,
                trip_id:    TRIP_ID,
                token:      LINK_TOKEN,
                created_by: OWNER_ID,
                max_uses:   10,
                use_count:  0,
                revoked_at: null,
                expires_at: null,
                created_at: "2026-01-01T00:00:00Z",
              },
              error: null,
            });
          }
          if (tableName === "trips") {
            return Promise.resolve({
              data: {
                id:          TRIP_ID,
                owner_id:    OWNER_ID,
                status:      "upcoming",
                end_date:    "2099-12-31",
                max_members: 1,
              },
              error: null,
            });
          }
          if (tableName === "trip_members") {
            return Promise.resolve({ data: null, error: null });
          }
          if (tableName === "blocks") {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },

        then(onF: any, onR: any) {
          if (tableName === "trip_members") {
            // Pre-flight count: 0 members so both concurrent requests pass it.
            return Promise.resolve({ data: [], error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };
      return obj;
    },
  };

  return { client, rpcCalls, tripMemberInserts };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function postAccept(
  port: number,
  token: string,
  userId: string,
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api/trips/invite-link/${encodeURIComponent(token)}/accept`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer token-${userId}`,
    },
    body: JSON.stringify({}),
  });
  let body: any;
  try {
    body = res.headers.get("content-type")?.includes("application/json")
      ? await res.json()
      : await res.text();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("POST /api/trips/invite-link/:token/accept — max_members atomic race guard", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  // ── 1. claim fast-path: returns 'trip_full' → 410 with reason:"trip_full" ─
  it('returns 410 with { error:"gone", reason:"trip_full" } when claim returns trip_full', async () => {
    const { client } = makeBaseClient({ userId: JOINER_A, claimResult: "trip_full" });
    _setTestClient(client, true);

    const r = await postAccept(port, LINK_TOKEN, JOINER_A);

    assert.equal(r.status, 410, "trip_full from claim must return HTTP 410");
    assert.equal(r.body.error, "gone");
    assert.equal(
      r.body.reason,
      "trip_full",
      'reason must be "trip_full" so the mobile client re-fetches instead of showing a generic error',
    );
    assert.ok(
      typeof r.body.message === "string" && r.body.message.length > 0,
      "response must include a human-readable message",
    );
  });

  // ── 2. Race via claim layer: stateful client, one 201 + one 410 ───────────
  //    Both requests pass the JS pre-flight (both see 0 members).
  //    First claim call → 'claimed', second → 'trip_full'.
  it("allows exactly one joiner when two requests race and claim returns trip_full on the second", async () => {
    let claimCallCount = 0;
    const { client, rpcCalls, tripMemberInserts } = makeBaseClient({
      userId: JOINER_A,
      claimResult: () => {
        claimCallCount += 1;
        return claimCallCount === 1 ? "claimed" : "trip_full";
      },
    });
    _setTestClient(client, true);

    const [r1, r2] = await Promise.all([
      postAccept(port, LINK_TOKEN, JOINER_A),
      postAccept(port, LINK_TOKEN, JOINER_A),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 410], "one request must succeed (201) and one must fail (410)");

    const winner = r1.status === 201 ? r1 : r2;
    const loser  = r1.status === 410 ? r1 : r2;

    assert.equal(winner.body.status, "joined");
    assert.equal(loser.body.error,  "gone");
    assert.equal(
      loser.body.reason,
      "trip_full",
      'losing request must get reason:"trip_full"',
    );

    const claimCalls = rpcCalls.filter((c) => c.fn === "claim_invite_link_slot_for_user");
    assert.equal(claimCalls.length, 2, "both requests must have called the claim function");

    assert.equal(
      tripMemberInserts.count,
      1,
      "only the winning request should attempt a trip_members INSERT",
    );
  });

  // ── 3. Race via trigger layer: both claims succeed, second INSERT fails ───
  //    Both requests get 'claimed' from the RPC (fast-path missed the race).
  //    The BEFORE INSERT trigger fires on the second INSERT and returns
  //    P0001/'trip_full'.  The handler must release the slot and return 410.
  it("handles trigger trip_full on INSERT: releases slot and returns 410 with reason:trip_full", async () => {
    let insertCallCount = 0;
    let dynamicInsertError: { message: string; code?: string } | null = null;

    // We need two separate invocations; use a closure-based fake.
    const rpcCalls: Array<{ fn: string; args: Record<string, any> }> = [];
    const tripMemberInserts = { count: 0 };

    const client: any = {
      auth: {
        getUser: async (token: string) => {
          if (token === `token-${JOINER_A}`) {
            return { data: { user: { id: JOINER_A } }, error: null };
          }
          return { data: { user: null }, error: { message: "invalid token" } };
        },
      },

      rpc: async (fn: string, args: Record<string, any>) => {
        rpcCalls.push({ fn, args });
        if (fn === "claim_invite_link_slot_for_user") {
          return { data: "claimed", error: null };
        }
        if (fn === "release_invite_link_slot") {
          return { data: null, error: null };
        }
        return { data: null, error: { message: `Unknown rpc: ${fn}` } };
      },

      from: (tableName: string) => {
        const obj: any = {
          select() { return obj; },
          eq()     { return obj; },
          or()     { return obj; },
          limit() { return obj; }, // isBlockedBetween chains .or().limit(1)
          delete() { return obj; },

          insert() {
            if (tableName === "trip_members") {
              tripMemberInserts.count += 1;
              insertCallCount += 1;
              // First INSERT succeeds; second fails with the trigger error.
              const err = insertCallCount >= 2
                ? { code: "P0001", message: "trip_full" }
                : null;
              return {
                then(onF: any, onR: any) {
                  return Promise.resolve({ data: null, error: err }).then(onF, onR);
                },
              };
            }
            return {
              then(onF: any, onR: any) {
                return Promise.resolve({ data: null, error: null }).then(onF, onR);
              },
            };
          },

          maybeSingle() {
            if (tableName === "trip_invite_links") {
              return Promise.resolve({
                data: {
                  id:         LINK_ID,
                  trip_id:    TRIP_ID,
                  token:      LINK_TOKEN,
                  created_by: OWNER_ID,
                  max_uses:   10,
                  use_count:  0,
                  revoked_at: null,
                  expires_at: null,
                  created_at: "2026-01-01T00:00:00Z",
                },
                error: null,
              });
            }
            if (tableName === "trips") {
              return Promise.resolve({
                data: {
                  id:          TRIP_ID,
                  owner_id:    OWNER_ID,
                  status:      "upcoming",
                  end_date:    "2099-12-31",
                  max_members: 1,
                },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },

          then(onF: any, onR: any) {
            if (tableName === "trip_members") {
              return Promise.resolve({ data: [], error: null }).then(onF, onR);
            }
            return Promise.resolve({ data: [], error: null }).then(onF, onR);
          },
        };
        return obj;
      },
    };

    _setTestClient(client, true);

    const [r1, r2] = await Promise.all([
      postAccept(port, LINK_TOKEN, JOINER_A),
      postAccept(port, LINK_TOKEN, JOINER_A),
    ]);

    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [201, 410], "one request must succeed (201) and one must fail (410)");

    const loser = r1.status === 410 ? r1 : r2;
    assert.equal(loser.body.error, "gone");
    assert.equal(
      loser.body.reason,
      "trip_full",
      "trigger trip_full error must surface as reason:trip_full in the 410 response",
    );

    // The losing request must have called release_invite_link_slot to give back
    // the slot it claimed before its INSERT was rejected by the trigger.
    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      1,
      "the losing request must release its slot so use_count is not permanently bumped",
    );
  });

  // ── 4. Trigger trip_full on a retry attempt: slot must NOT be released ────
  //    When isRetryAttempt=true, the slot was claimed in a prior partial failure.
  //    The trigger fires during the retry INSERT.  The handler must NOT call
  //    release (the slot was never freshly claimed in this request).
  it("does not release slot on trigger trip_full when the slot came from a prior attempt", async () => {
    const { client, rpcCalls } = makeBaseClient({
      userId:         JOINER_A,
      claimResult:    "claimed",
      isRetryAttempt: true,
      insertError:    { code: "P0001", message: "trip_full" },
    });
    _setTestClient(client, true);

    const r = await postAccept(port, LINK_TOKEN, JOINER_A);

    assert.equal(r.status, 410);
    assert.equal(r.body.reason, "trip_full");

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      0,
      "release_invite_link_slot must NOT be called when the slot was from a prior attempt",
    );
  });

  // ── 5. No release when claim fast-path returns 'trip_full' ───────────────
  it("does not call release_invite_link_slot when claim returns trip_full (no slot consumed)", async () => {
    const { client, rpcCalls } = makeBaseClient({ userId: JOINER_A, claimResult: "trip_full" });
    _setTestClient(client, true);

    await postAccept(port, LINK_TOKEN, JOINER_A);

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      0,
      "release_invite_link_slot must not be called — no slot was consumed for trip_full",
    );
  });

  // ── 6. No INSERT when claim fast-path returns 'trip_full' ────────────────
  it("does not attempt a trip_members INSERT when claim returns trip_full", async () => {
    const { client, tripMemberInserts } = makeBaseClient({
      userId:      JOINER_A,
      claimResult: "trip_full",
    });
    _setTestClient(client, true);

    await postAccept(port, LINK_TOKEN, JOINER_A);

    assert.equal(
      tripMemberInserts.count,
      0,
      "trip_members INSERT must be skipped entirely when claim fast-path returns trip_full",
    );
  });
});
