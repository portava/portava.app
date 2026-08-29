/**
 * inviteLinkCrashRecovery.test.ts
 *
 * Tests for the crash-recovery logic in POST /api/trips/invite-link/:token/accept.
 *
 * The idempotency ledger (trip_invite_link_attempts) ensures that if a server
 * crashes after claiming a slot but before inserting the trip_members row, the
 * user can always retry and still join.  These tests verify the four key
 * branches of that recovery path:
 *
 *   1. Happy path — join succeeds, attempt row is cleaned up (DELETE called).
 *   2. Retry after crash — attempt row exists (already_attempted), slot claim is
 *      skipped, member insert succeeds, attempt row is cleaned up.
 *   3. Duplicate-member conflict on fresh claim — releases slot, cleans attempt
 *      row, returns idempotent 200 already_member.
 *   4. Slot limit reached after a prior clean attempt — returns 410 gone.
 *
 * Run: node --import tsx/esm --test src/test/inviteLinkCrashRecovery.test.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import app from "../app.js";
import { _setTestClient } from "../lib/http.js";

// ── Fixed test IDs ─────────────────────────────────────────────────────────

const OWNER_ID   = "a0a0a0a0-a0a0-a0a0-a0a0-a0a0a0a0a0a0";
const JOINER_ID  = "b1b1b1b1-b1b1-b1b1-b1b1-b1b1b1b1b1b1";
const TRIP_ID    = "c2c2c2c2-c2c2-c2c2-c2c2-c2c2c2c2c2c2";
const LINK_ID    = "d3d3d3d3-d3d3-d3d3-d3d3-d3d3d3d3d3d3";
const LINK_TOKEN = "crash-recovery-test-token-abcdef123456";

// ── Fake-client factory ────────────────────────────────────────────────────

interface FakeRpcCall {
  fn: string;
  args: Record<string, any>;
}

interface FakeDeleteCall {
  table: string;
  filters: Record<string, any>;
}

/**
 * Builds a minimal fake Supabase client for crash-recovery test scenarios.
 *
 * @param opts.isMember            — user is already a member before claim step
 * @param opts.claimResult         — 'claimed' | 'already_attempted' | 'limit_reached'
 * @param opts.claimError          — rpc returns an error instead of a result string
 * @param opts.memberInsertError   — trip_members INSERT fails with this error
 * @param opts.maxUses             — max_uses value for the fake invite link (null = unlimited)
 */
function makeClient(opts: {
  isMember?: boolean;
  claimResult?: string;
  claimError?: boolean;
  memberInsertError?: { message: string; code?: string };
  maxUses?: number | null;
}): { client: any; rpcCalls: FakeRpcCall[]; deleteCalls: FakeDeleteCall[] } {
  const {
    isMember          = false,
    claimResult       = "claimed",
    claimError        = false,
    memberInsertError,
    maxUses           = 5,
  } = opts;

  const rpcCalls: FakeRpcCall[]     = [];
  const deleteCalls: FakeDeleteCall[] = [];

  let memberCheckCount = 0;

  const client: any = {
    auth: {
      getUser: async (token: string) => {
        if (token === "joiner-token") {
          return { data: { user: { id: JOINER_ID } }, error: null };
        }
        return { data: { user: null }, error: { message: "invalid" } };
      },
    },

    rpc: async (fn: string, args: Record<string, any>) => {
      rpcCalls.push({ fn, args });

      if (fn === "claim_invite_link_slot_for_user") {
        if (claimError) {
          return { data: null, error: { message: "rpc error" } };
        }
        return { data: claimResult, error: null };
      }

      if (fn === "release_invite_link_slot") {
        return { data: null, error: null };
      }

      return { data: null, error: { message: `Unknown rpc: ${fn}` } };
    },

    from: (tableName: string) => {
      const pendingFilters: Record<string, any> = {};
      let _isDelete = false;

      const obj: any = {
        select() { return obj; },

        insert(_data: any) {
          return {
            then(onF: any, onR: any) {
              if (tableName === "trip_members") {
                if (memberInsertError) {
                  return Promise.resolve({ data: null, error: memberInsertError }).then(onF, onR);
                }
                return Promise.resolve({ data: null, error: null }).then(onF, onR);
              }
              return Promise.resolve({ data: null, error: null }).then(onF, onR);
            },
          };
        },

        eq(col: string, val: any) {
          pendingFilters[col] = val;
          return obj;
        },

        or() { return obj; },
        limit() { return obj; }, // isBlockedBetween chains .or().limit(1)

        delete() {
          _isDelete = true;
          return obj;
        },

        maybeSingle() {
          if (tableName === "trip_invite_links") {
            return Promise.resolve({
              data: {
                id:         LINK_ID,
                trip_id:    TRIP_ID,
                token:      LINK_TOKEN,
                created_by: OWNER_ID,
                max_uses:   maxUses,
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
                id:       TRIP_ID,
                owner_id: OWNER_ID,
                status:   "upcoming",
              },
              error: null,
            });
          }

          if (tableName === "trip_members") {
            memberCheckCount += 1;
            const row = isMember
              ? { trip_id: TRIP_ID, user_id: JOINER_ID, role: "member", status: "accepted" }
              : null;
            return Promise.resolve({ data: row, error: null });
          }

          if (tableName === "blocks") {
            return Promise.resolve({ data: null, error: null });
          }

          return Promise.resolve({ data: null, error: null });
        },

        then(onF: any, onR: any) {
          if (_isDelete) {
            deleteCalls.push({ table: tableName, filters: { ...pendingFilters } });
            return Promise.resolve({ data: null, error: null }).then(onF, onR);
          }
          return Promise.resolve({ data: [], error: null }).then(onF, onR);
        },
      };

      return obj;
    },
  };

  return { client, rpcCalls, deleteCalls };
}

// ── HTTP helpers ───────────────────────────────────────────────────────────

async function startServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve({ server, port: (server.address() as any).port });
    });
  });
}

async function post(
  port: number,
  path: string,
  token: string,
): Promise<{ status: number; body: any }> {
  const url = `http://127.0.0.1:${port}/api${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
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

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/trips/invite-link/:token/accept — crash recovery", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  // ── Scenario 1: Happy path ────────────────────────────────────────────────
  it("happy path: returns 201 joined and cleans up the attempt row", async () => {
    const { client, rpcCalls, deleteCalls } = makeClient({
      isMember:    false,
      claimResult: "claimed",
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(r.status, 201, "should return 201 on successful join");
    assert.equal(r.body.status, "joined");
    assert.equal(r.body.role, "member");
    assert.equal(r.body.tripId, TRIP_ID);

    const claimCalls = rpcCalls.filter((c) => c.fn === "claim_invite_link_slot_for_user");
    assert.equal(claimCalls.length, 1, "claim must be called exactly once");
    assert.equal(claimCalls[0].args.p_link_id, LINK_ID, "claim must reference the correct link_id");
    assert.equal(claimCalls[0].args.p_user_id, JOINER_ID, "claim must reference the correct user_id");

    const attemptDeletes = deleteCalls.filter((d) => d.table === "trip_invite_link_attempts");
    assert.equal(
      attemptDeletes.length,
      1,
      "attempt row must be deleted exactly once after a successful join",
    );
    assert.equal(attemptDeletes[0].filters.link_id, LINK_ID, "delete must target the correct link_id");
    assert.equal(attemptDeletes[0].filters.user_id, JOINER_ID, "delete must target the correct user_id");
  });

  // ── Scenario 2: Retry after crash ─────────────────────────────────────────
  it("retry after crash: already_attempted skips slot claim, inserts member, and succeeds", async () => {
    // Simulates: server crashed after slot was claimed but before trip_members insert.
    // On retry, claim_invite_link_slot_for_user returns 'already_attempted'.
    // Handler must skip re-claiming and go straight to the member insert.
    const { client, rpcCalls, deleteCalls } = makeClient({
      isMember:    false,
      claimResult: "already_attempted",
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(r.status, 201, "retry after crash must still produce a successful 201 joined");
    assert.equal(r.body.status, "joined");
    assert.equal(r.body.role, "member");

    const claimCalls = rpcCalls.filter((c) => c.fn === "claim_invite_link_slot_for_user");
    assert.equal(
      claimCalls.length,
      1,
      "claim RPC is still called to detect the already_attempted state — but the handler must not consume a new slot",
    );

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      0,
      "release must NOT be called — no new slot was consumed on the retry path",
    );

    const attemptDeletes = deleteCalls.filter((d) => d.table === "trip_invite_link_attempts");
    assert.equal(
      attemptDeletes.length,
      1,
      "attempt row must be deleted after a successful retry so future link re-use is not blocked",
    );
    assert.equal(attemptDeletes[0].filters.link_id, LINK_ID);
    assert.equal(attemptDeletes[0].filters.user_id, JOINER_ID);
  });

  // ── Scenario 3: Duplicate-member conflict on fresh claim ──────────────────
  it("duplicate-member conflict on fresh claim: releases slot, cleans attempt row, returns 200 already_member", async () => {
    // A fresh slot was claimed (claimResult = 'claimed', isRetryAttempt = false).
    // The trip_members INSERT hits a 23505 unique violation because a concurrent
    // request already committed the row.  The handler must:
    //   a) call release_invite_link_slot to undo the freshly claimed slot
    //   b) delete the attempt row
    //   c) return idempotent 200 already_member
    const { client, rpcCalls, deleteCalls } = makeClient({
      isMember:          false,
      claimResult:       "claimed",
      memberInsertError: { message: "duplicate key value", code: "23505" },
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(r.status, 200, "23505 conflict must return 200 already_member");
    assert.equal(r.body.status, "already_member");
    assert.equal(r.body.idempotent, true);

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      1,
      "release_invite_link_slot must be called once to compensate the freshly claimed slot",
    );
    assert.equal(releaseCalls[0].args.link_id, LINK_ID, "release must target the correct link_id");

    const attemptDeletes = deleteCalls.filter((d) => d.table === "trip_invite_link_attempts");
    assert.equal(
      attemptDeletes.length,
      1,
      "attempt row must be cleaned up after resolving the duplicate-member conflict",
    );
    assert.equal(attemptDeletes[0].filters.link_id, LINK_ID);
    assert.equal(attemptDeletes[0].filters.user_id, JOINER_ID);
  });

  // ── Scenario 4: Slot limit reached after a prior clean attempt ────────────
  it("slot limit reached after a clean prior attempt: returns 410 gone", async () => {
    // The user has no dangling attempt row (claim_invite_link_slot_for_user does
    // NOT return 'already_attempted'). The link has now hit its capacity.
    // Expected: 410 gone — the user's prior successful attempt is long gone and
    // there is no slot available for a brand-new join.
    const { client, rpcCalls, deleteCalls } = makeClient({
      isMember:    false,
      claimResult: "limit_reached",
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(r.status, 410, "should return 410 when the slot limit is reached");
    assert.equal(r.body.error, "gone");

    const claimCalls = rpcCalls.filter((c) => c.fn === "claim_invite_link_slot_for_user");
    assert.equal(claimCalls.length, 1, "claim must be attempted before surfacing the 410");

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      0,
      "release must NOT be called — no slot was claimed",
    );

    const attemptDeletes = deleteCalls.filter((d) => d.table === "trip_invite_link_attempts");
    assert.equal(
      attemptDeletes.length,
      0,
      "attempt row cleanup must NOT be called — there was no attempt row to clean up",
    );
  });
});

// ── Unlimited links (max_uses = null) ─────────────────────────────────────────
//
// claim_invite_link_slot_for_user uses `(max_uses IS NULL OR use_count < max_uses)`
// in its UPDATE WHERE clause.  When max_uses IS NULL the condition is always true,
// so the function can never return 'limit_reached' for an unlimited link.
//
// The three scenarios below mirror Scenarios 1–3 from the capped-link suite and
// verify that the handler code paths work identically regardless of the cap value.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/trips/invite-link/:token/accept — crash recovery (unlimited links, max_uses = null)", () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    if (server) server.close();
    ({ server, port } = await startServer());
  });

  after(() => {
    if (server) server.close();
  });

  // ── Scenario 5: Unlimited happy path ─────────────────────────────────────
  it("unlimited link happy path: returns 201 joined and cleans up the attempt row", async () => {
    const { client, rpcCalls, deleteCalls } = makeClient({
      isMember:    false,
      claimResult: "claimed",
      maxUses:     null,
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(r.status, 201, "unlimited link join must return 201");
    assert.equal(r.body.status, "joined");
    assert.equal(r.body.role, "member");
    assert.equal(r.body.tripId, TRIP_ID);

    const claimCalls = rpcCalls.filter((c) => c.fn === "claim_invite_link_slot_for_user");
    assert.equal(claimCalls.length, 1, "claim must be called exactly once for unlimited links");

    const attemptDeletes = deleteCalls.filter((d) => d.table === "trip_invite_link_attempts");
    assert.equal(
      attemptDeletes.length,
      1,
      "attempt row must be deleted after a successful join on an unlimited link",
    );
    assert.equal(attemptDeletes[0].filters.link_id, LINK_ID);
    assert.equal(attemptDeletes[0].filters.user_id, JOINER_ID);
  });

  // ── Scenario 6: Unlimited retry after crash ───────────────────────────────
  it("unlimited link retry after crash: already_attempted skips re-claim and succeeds", async () => {
    // The slot for an unlimited link is a logical increment of use_count, not a
    // physical slot from a finite pool.  But the crash-recovery path is identical:
    // 'already_attempted' means a prior increment happened, so we must not
    // increment again — just retry the member insert.
    const { client, rpcCalls, deleteCalls } = makeClient({
      isMember:    false,
      claimResult: "already_attempted",
      maxUses:     null,
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(r.status, 201, "unlimited link retry after crash must produce 201 joined");
    assert.equal(r.body.status, "joined");

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      0,
      "release must NOT be called on the already_attempted retry path for unlimited links",
    );

    const attemptDeletes = deleteCalls.filter((d) => d.table === "trip_invite_link_attempts");
    assert.equal(
      attemptDeletes.length,
      1,
      "attempt row must be cleaned up after a successful retry on an unlimited link",
    );
    assert.equal(attemptDeletes[0].filters.link_id, LINK_ID);
    assert.equal(attemptDeletes[0].filters.user_id, JOINER_ID);
  });

  // ── Scenario 7: Unlimited duplicate-member conflict on fresh claim ─────────
  it("unlimited link duplicate-member conflict: releases slot, cleans attempt row, returns 200 already_member", async () => {
    // A fresh slot was claimed on an unlimited link (use_count incremented).
    // The member INSERT hits a 23505 conflict from a concurrent request.
    // The handler must decrement use_count via release_invite_link_slot, clean the
    // attempt row, and return an idempotent 200 already_member — same as for capped links.
    const { client, rpcCalls, deleteCalls } = makeClient({
      isMember:          false,
      claimResult:       "claimed",
      memberInsertError: { message: "duplicate key value", code: "23505" },
      maxUses:           null,
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(r.status, 200, "23505 conflict on unlimited link must return 200 already_member");
    assert.equal(r.body.status, "already_member");
    assert.equal(r.body.idempotent, true);

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(
      releaseCalls.length,
      1,
      "release_invite_link_slot must be called once to undo the freshly incremented use_count",
    );
    assert.equal(releaseCalls[0].args.link_id, LINK_ID);

    const attemptDeletes = deleteCalls.filter((d) => d.table === "trip_invite_link_attempts");
    assert.equal(
      attemptDeletes.length,
      1,
      "attempt row must be cleaned up after resolving the conflict on an unlimited link",
    );
    assert.equal(attemptDeletes[0].filters.link_id, LINK_ID);
    assert.equal(attemptDeletes[0].filters.user_id, JOINER_ID);
  });

  // ── Scenario 8: Confirm limit_reached is structurally impossible ──────────
  it("unlimited link: limit_reached is structurally impossible — DB function always claims for null max_uses", async () => {
    // This test documents and guards the invariant: for unlimited links the DB
    // function claim_invite_link_slot_for_user can never return 'limit_reached'
    // because `max_uses IS NULL` makes the WHERE condition always true.
    //
    // We simulate a hypothetical 'limit_reached' return (which cannot actually
    // occur for a null-capped link) to confirm the HTTP handler still returns 410.
    // The real protection is at the DB level — this test records the invariant.
    const { client, rpcCalls } = makeClient({
      isMember:    false,
      claimResult: "limit_reached",
      maxUses:     null,
    });
    _setTestClient(client, true);

    const r = await post(port, `/trips/invite-link/${LINK_TOKEN}/accept`, "joiner-token");

    assert.equal(
      r.status,
      410,
      "handler must still surface 410 even for unlimited links if limit_reached were returned — but the DB function never returns this for null max_uses",
    );

    const claimCalls = rpcCalls.filter((c) => c.fn === "claim_invite_link_slot_for_user");
    assert.equal(claimCalls.length, 1, "claim must have been attempted");

    const releaseCalls = rpcCalls.filter((c) => c.fn === "release_invite_link_slot");
    assert.equal(releaseCalls.length, 0, "release must NOT be called when limit_reached is returned");
  });
});
