/**
 * countUserTrips — owner-without-trip_members-row regression
 *
 * Guards against undercounting trips for owners who have no corresponding
 * row in trip_members (e.g. trips created before automatic owner-row
 * insertion was in place).
 *
 * Run: node --import tsx/esm --test src/test/tripCountsOwnerFallback.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countUserTrips } from "../lib/tripCounts.js";

const OWNER_ID   = "user-owner-no-membership-row";
const MEMBER_ID  = "user-member-with-membership-row";
const TRIP_ID_1  = "trip-00000000-0000-4000-8000-000000000001";
const TRIP_ID_2  = "trip-00000000-0000-4000-8000-000000000002";
const TRIP_ID_3  = "trip-00000000-0000-4000-8000-000000000003";

/**
 * Builds a minimal fake Supabase client that responds to the three queries
 * countUserTrips issues:
 *   1. trip_members  → filtered by user_id + role != invited
 *   2. trips         → filtered by owner_id
 *   3. trips (count) → filtered by .in("id", [...]) + not("status", null)
 */
function makeClient(opts: {
  memberRows: { trip_id: string }[];
  ownerRows:  { id: string }[];
  activeTrips: { id: string }[];
}) {
  function buildChain(table: string): any {
    const state: Record<string, any> = { table };

    const chain: any = {
      select(cols: string, options?: any) {
        state.cols    = cols;
        state.options = options;
        return chain;
      },
      eq(col: string, val: any)  { state[col] = val; return chain; },
      neq(col: string, val: any) { state[`neq_${col}`] = val; return chain; },
      not(col: string, _op: string, _val?: any) { state[`not_${col}`] = true; return chain; },
      in(col: string, vals: any[]) { state[`in_${col}`] = vals; return chain; },

      // Resolves the query
      then(resolve: (v: any) => void) {
        let result: any;

        if (table === "trip_members") {
          // Query (1): memberships for user
          const rows = opts.memberRows.filter(
            (r) => !state.neq_role // if neq("role","invited") is set, pass all since our fakes aren't 'invited'
          );
          result = { data: opts.memberRows, error: null };
        } else if (table === "trips" && state.in_id === undefined) {
          // Query (2): ownership lookup — trips.owner_id = userId
          if (state.owner_id === OWNER_ID) {
            result = { data: opts.ownerRows, error: null };
          } else {
            result = { data: [], error: null };
          }
        } else {
          // Query (3): count active trips from union set
          const inIds: string[] = state.in_id ?? [];
          const active = opts.activeTrips.filter((t) => inIds.includes(t.id));
          const countVal = state.options?.head === true ? active.length : active.length;
          result = { count: countVal, data: active, error: null };
        }

        return Promise.resolve(result).then(resolve);
      },
    };
    return chain;
  }

  return {
    from: (table: string) => buildChain(table),
  };
}

describe("countUserTrips — owner without trip_members row", () => {
  it("counts the trip when the owner has no trip_members row", async () => {
    // Owner created TRIP_ID_1 but has no trip_members row for it.
    const sc = makeClient({
      memberRows:  [],                          // no trip_members row for owner
      ownerRows:   [{ id: TRIP_ID_1 }],         // owner_id = OWNER_ID on the trip
      activeTrips: [{ id: TRIP_ID_1 }],         // trip exists with non-null status
    });

    const result = await countUserTrips(sc, OWNER_ID);
    assert.equal(result.count, 1, "owner trip must be counted even without a trip_members row");
  });

  it("does not double-count a trip when the owner also has a trip_members row", async () => {
    // Owner has both an owner_id entry AND a trip_members row (normal case).
    const sc = makeClient({
      memberRows:  [{ trip_id: TRIP_ID_1 }],
      ownerRows:   [{ id: TRIP_ID_1 }],
      activeTrips: [{ id: TRIP_ID_1 }],
    });

    const result = await countUserTrips(sc, OWNER_ID);
    assert.equal(result.count, 1, "union dedup must not double-count when both rows exist");
  });

  it("counts trips from both ownership and membership, deduped", async () => {
    // TRIP_ID_1: owner only (no trip_members row)
    // TRIP_ID_2: member only (has trip_members row, different owner)
    // TRIP_ID_3: both owner + member row
    const sc = makeClient({
      memberRows:  [{ trip_id: TRIP_ID_2 }, { trip_id: TRIP_ID_3 }],
      ownerRows:   [{ id: TRIP_ID_1 },      { id: TRIP_ID_3 }],
      activeTrips: [{ id: TRIP_ID_1 }, { id: TRIP_ID_2 }, { id: TRIP_ID_3 }],
    });

    const result = await countUserTrips(sc, OWNER_ID);
    assert.equal(result.count, 3, "should count 3 distinct trips (1 owner-only, 1 member-only, 1 both)");
  });

  it("excludes trips with null status even if the owner has no trip_members row", async () => {
    // TRIP_ID_1: owner only, but status is null (draft/deleted)
    const sc = makeClient({
      memberRows:  [],
      ownerRows:   [{ id: TRIP_ID_1 }],
      activeTrips: [],                          // TRIP_ID_1 not in activeTrips (null status)
    });

    const result = await countUserTrips(sc, OWNER_ID);
    assert.equal(result.count, 0, "trips with null status must not be counted");
  });

  it("returns 0 when the user has no trips at all", async () => {
    const sc = makeClient({
      memberRows:  [],
      ownerRows:   [],
      activeTrips: [],
    });

    const result = await countUserTrips(sc, OWNER_ID);
    assert.equal(result.count, 0, "user with no trips must return count 0");
  });
});
