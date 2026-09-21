/**
 * resolveContentOwner — "I could not look them up" must not read as
 * "this content has no owner".
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 * supabase-js RESOLVES on a database error, so `const { data } = await …` binds
 * `data: null` for an unreadable table exactly as for a row that is not there.
 * This module's `try/catch` never fired for it. Three genuinely different
 * situations therefore reached every caller as the same `null`, with nothing
 * logged anywhere:
 *
 *   place            unowned BY DESIGN
 *   missing row      the content is gone
 *   unreadable table the lookup could not run
 *
 * and the callers act on that null: routes/moderation.ts files a report with no
 * subject, lib/moderationAudit.ts records `owner_unresolved: true` into the
 * audit trail as a FACT about the content, and routes/adminMedia.ts skips the
 * audit row entirely — after the content status change has already committed.
 *
 * The DIRECTION is deliberate and unchanged (both call sites document that a
 * null must not break a moderation action). What is tested here is that the
 * failure is now DISTINGUISHABLE: `resolveContentOwnerDetailed` reports
 * `outcome: "lookup_failed"` where it used to say "not_found".
 *
 * ── THE PAIRING ─────────────────────────────────────────────────────────────
 * "no such row" and "table unreadable" both still answer `ownerUserId: null`,
 * so an assertion on the id alone would pass either way and prove nothing. Each
 * failure case below is paired with the healthy read that differs only in
 * whether the query succeeds, and the assertions are on `outcome`.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/contentOwnerLookupFailure.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { makeFailClosedClient } from "./helpers/failClosedSupabase.js";
import { resolveContentOwner, resolveContentOwnerDetailed } from "../lib/contentOwner.js";

const AUTHOR   = "aaaaaaaa-0000-4000-a000-000000000001";
const POST     = "bbbbbbbb-0000-4000-a000-000000000002";
const LISTING  = "cccccccc-0000-4000-a000-000000000003";
const BUDDY    = "dddddddd-0000-4000-a000-000000000004";
const PLACE    = "eeeeeeee-0000-4000-a000-000000000005";

const READ_FAIL = { message: "server closed the connection unexpectedly", code: "08006" };

/** Every terminal read, in order, as `table|firstFilterColumn`. */
type Trace = string[];

function client(opts: {
  rows?: Record<string, Record<string, any>[]>;
  failTables?: string[];
  trace?: Trace;
}) {
  return makeFailClosedClient({
    rows: opts.rows ?? {},
    failOn: (ctx) => {
      opts.trace?.push(`${ctx.table}|${ctx.filters[0]?.col ?? "-"}`);
      return (opts.failTables ?? []).includes(ctx.table) ? READ_FAIL : null;
    },
  });
}

let scenarios = 0;

describe("resolveContentOwnerDetailed — simple (table, column) lookups", () => {
  it("HEALTHY: a readable posts row resolves its author", async () => {
    scenarios++;
    const r = await resolveContentOwnerDetailed(
      client({ rows: { posts: [{ id: POST, author_id: AUTHOR }] } }), "post", POST,
    );
    assert.deepEqual(r, { ownerUserId: AUTHOR, outcome: "resolved" });
  });

  it("HEALTHY TWIN: a readable posts table with no such row is 'not_found'", async () => {
    scenarios++;
    const r = await resolveContentOwnerDetailed(client({ rows: { posts: [] } }), "post", POST);
    assert.equal(r.ownerUserId, null);
    assert.equal(r.outcome, "not_found");
  });

  it("FAILURE: an unreadable posts table is 'lookup_failed', NOT 'not_found'", async () => {
    scenarios++;
    const r = await resolveContentOwnerDetailed(
      client({ rows: { posts: [{ id: POST, author_id: AUTHOR }] }, failTables: ["posts"] }),
      "post", POST,
    );
    assert.equal(r.ownerUserId, null);
    assert.equal(r.outcome, "lookup_failed");
    assert.equal((r.error as any)?.code, "08006");
  });

  it("the thin wrapper still answers null for BOTH — the direction is unchanged", async () => {
    scenarios++;
    const missing = await resolveContentOwner(client({ rows: { posts: [] } }), "post", POST);
    const failed = await resolveContentOwner(
      client({ rows: { posts: [{ id: POST, author_id: AUTHOR }] }, failTables: ["posts"] }),
      "post", POST,
    );
    assert.equal(missing, null);
    assert.equal(failed, null);
    // …which is exactly why the outcome above is the thing worth asserting.
  });

  it("'place' is unowned BY DESIGN and is not confused with either", async () => {
    scenarios++;
    const r = await resolveContentOwnerDetailed(client({}), "place", PLACE);
    assert.deepEqual(r, { ownerUserId: null, outcome: "unowned" });
  });

  it("an unknown entity type reports 'unknown_type' and issues no read", async () => {
    scenarios++;
    const trace: Trace = [];
    const r = await resolveContentOwnerDetailed(client({ trace }), "not_a_thing", POST);
    assert.equal(r.outcome, "unknown_type");
    assert.equal(trace.length, 0, `expected zero reads, saw ${JSON.stringify(trace)}`);
  });
});

describe("resolveContentOwnerDetailed — buddy_listing's two-step lookup", () => {
  it("HEALTHY: the listing-id read wins when it has a user_id", async () => {
    scenarios++;
    const trace: Trace = [];
    const r = await resolveContentOwnerDetailed(
      client({ rows: { rent_buddy_profiles: [{ id: LISTING, user_id: BUDDY }] }, trace }),
      "buddy_listing", LISTING,
    );
    assert.deepEqual(r, { ownerUserId: BUDDY, outcome: "resolved" });
    // One read: the second step must not run once the first answered.
    assert.deepEqual(trace, ["rent_buddy_profiles|id"]);
  });

  it("HEALTHY TWIN: a miss on the listing id falls through to the user-id read", async () => {
    scenarios++;
    const trace: Trace = [];
    const r = await resolveContentOwnerDetailed(
      client({ rows: { rent_buddy_profiles: [{ id: LISTING, user_id: BUDDY }] }, trace }),
      "buddy_listing", BUDDY,
    );
    assert.deepEqual(r, { ownerUserId: BUDDY, outcome: "resolved" });
    assert.deepEqual(trace, ["rent_buddy_profiles|id", "rent_buddy_profiles|user_id"]);
  });

  it("FAILURE: a failed FIRST read stops — it must not launder an outage into a fact", async () => {
    scenarios++;
    const trace: Trace = [];
    const r = await resolveContentOwnerDetailed(
      client({
        rows: { rent_buddy_profiles: [{ id: LISTING, user_id: BUDDY }] },
        failTables: ["rent_buddy_profiles"],
        trace,
      }),
      "buddy_listing", LISTING,
    );
    assert.equal(r.outcome, "lookup_failed");
    // Measured, not assumed: exactly ONE request was issued. Falling through
    // would have returned the second read's "not_found" as the answer.
    assert.equal(trace.length, 1, `expected 1 read, saw ${JSON.stringify(trace)}`);
  });

  it("HEALTHY TWIN: both steps readable and empty is 'not_found', after TWO reads", async () => {
    scenarios++;
    const trace: Trace = [];
    const r = await resolveContentOwnerDetailed(
      client({ rows: { rent_buddy_profiles: [] }, trace }), "buddy_listing", LISTING,
    );
    assert.equal(r.outcome, "not_found");
    assert.equal(trace.length, 2, `expected 2 reads, saw ${JSON.stringify(trace)}`);
  });
});

describe("vacuity", () => {
  it("exercised a non-zero number of scenarios", () => {
    assert.ok(scenarios >= 10, `expected >= 10 scenarios, ran ${scenarios}`);
  });
});
