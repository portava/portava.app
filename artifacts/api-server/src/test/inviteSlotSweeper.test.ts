/**
 * inviteSlotSweeper.test.ts
 *
 * Contract tests for sweepStrandedSlots() in lib/inviteSlotSweeper.ts.
 *
 * Verifies:
 *   1. Returns { fixed: 0, slots: [], error: null } when no stranded slots exist.
 *   2. Shapes RPC rows into camelCase SweepResult slots.
 *   3. Forwards ttlMinutes to the RPC as min_age_minutes.
 *   4. Uses SWEEP_TTL_MINUTES as the default when ttlMinutes is not specified.
 *   5. Returns { fixed: 0, slots: [], error } and increments consecutiveFailures
 *      when the RPC returns an error.
 *   6. Skips gracefully (no throw) when the service client is null.
 *
 * Run: node --import tsx/esm --test src/test/inviteSlotSweeper.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sweepStrandedSlots,
  getSweeperStatus,
  SWEEP_TTL_MINUTES,
} from "../lib/inviteSlotSweeper.js";

const LINK_ID    = "aa000000-0000-0000-0000-000000000001";
const USER_ID    = "bb000000-0000-0000-0000-000000000002";
const TRIP_ID    = "cc000000-0000-0000-0000-000000000003";
const CLAIMED_AT = "2026-01-01T00:00:00Z";

function makeClient(opts: {
  rpcRows?: any[];
  rpcError?: { message: string };
  capturedArgs?: { fn: string; args: Record<string, any> }[];
}): any {
  const { rpcRows = [], rpcError, capturedArgs = [] } = opts;
  return {
    rpc: async (fn: string, args: Record<string, any>) => {
      capturedArgs.push({ fn, args });
      if (rpcError) return { data: null, error: rpcError };
      return { data: rpcRows, error: null };
    },
  };
}

describe("sweepStrandedSlots", () => {
  it("returns fixed=0 and empty slots when there are no stranded slots", async () => {
    const client = makeClient({ rpcRows: [] });
    const result = await sweepStrandedSlots({ client });
    assert.equal(result.fixed, 0);
    assert.deepEqual(result.slots, []);
    assert.equal(result.error, null);
  });

  it("shapes RPC rows into camelCase slots", async () => {
    const rpcRows = [
      { link_id: LINK_ID, user_id: USER_ID, trip_id: TRIP_ID, claimed_at: CLAIMED_AT },
    ];
    const client = makeClient({ rpcRows });
    const result = await sweepStrandedSlots({ client });
    assert.equal(result.fixed, 1);
    assert.equal(result.slots.length, 1);
    const slot = result.slots[0];
    assert.equal(slot.linkId,    LINK_ID,    "linkId");
    assert.equal(slot.userId,    USER_ID,    "userId");
    assert.equal(slot.tripId,    TRIP_ID,    "tripId");
    assert.equal(slot.claimedAt, CLAIMED_AT, "claimedAt");
  });

  it("forwards ttlMinutes to the RPC as min_age_minutes", async () => {
    const captured: { fn: string; args: Record<string, any> }[] = [];
    const client = makeClient({ rpcRows: [], capturedArgs: captured });
    await sweepStrandedSlots({ client, ttlMinutes: 120 });
    const call = captured.find((c) => c.fn === "reconcile_invite_link_slots");
    assert.ok(call, "reconcile_invite_link_slots should have been called");
    assert.equal(call!.args.min_age_minutes, 120);
  });

  it("uses SWEEP_TTL_MINUTES as the default min_age_minutes", async () => {
    const captured: { fn: string; args: Record<string, any> }[] = [];
    const client = makeClient({ rpcRows: [], capturedArgs: captured });
    await sweepStrandedSlots({ client });
    const call = captured.find((c) => c.fn === "reconcile_invite_link_slots");
    assert.ok(call, "reconcile_invite_link_slots should have been called");
    assert.equal(call!.args.min_age_minutes, SWEEP_TTL_MINUTES);
  });

  it("returns error and increments consecutiveFailures when RPC fails", async () => {
    const client = makeClient({ rpcError: { message: "connection timeout" } });
    const before = getSweeperStatus().consecutiveFailures;
    const result = await sweepStrandedSlots({ client });
    assert.equal(result.fixed, 0);
    assert.deepEqual(result.slots, []);
    assert.ok(result.error, "error should be set");
    assert.equal(
      getSweeperStatus().consecutiveFailures,
      before + 1,
      "consecutiveFailures should increment",
    );
  });

  it("returns fixed=0 gracefully when client is null (service not ready)", async () => {
    const result = await sweepStrandedSlots({ client: null });
    assert.equal(result.fixed, 0);
    assert.deepEqual(result.slots, []);
    assert.equal(result.error, null);
  });

  it("handles multiple stranded slots and returns correct fixed count", async () => {
    const rpcRows = [
      { link_id: LINK_ID, user_id: USER_ID,   trip_id: TRIP_ID, claimed_at: CLAIMED_AT },
      { link_id: LINK_ID, user_id: "dd000000-0000-0000-0000-000000000004", trip_id: TRIP_ID, claimed_at: CLAIMED_AT },
    ];
    const client = makeClient({ rpcRows });
    const result = await sweepStrandedSlots({ client });
    assert.equal(result.fixed, 2);
    assert.equal(result.slots.length, 2);
  });
});
