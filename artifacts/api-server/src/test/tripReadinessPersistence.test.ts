/**
 * Trip Readiness — persistence honesty in lib/tripReadiness.computeReadiness
 *
 * computeReadiness ends with a two-step persist:
 *
 *     1. upsert the produced items into trip_readiness_items
 *     2. DELETE every stored row whose dedupe_key the new run did not produce
 *
 * Step 2 ran unconditionally, and step 1's outcome was never observed: both
 * writes were `await sc.from(...)....then(undefined, () => {})`. That handler is
 * a REJECTION handler on a client that RESOLVES — postgrest-js catches its own
 * fetch errors and hands back `{ error }` — so it never runs for a database
 * error, and the resolved `{ error }` was discarded unread. Consequences, in
 * order of severity:
 *
 *   • A FAILED UPSERT WAS FOLLOWED BY THE SWEEP ANYWAY. The new items were not
 *     written, and then the rows describing the PREVIOUS run were deleted, so
 *     trip_readiness_items was left claiming the trip has fewer blockers than
 *     either the old or the new truth. trip_readiness_items is member-readable
 *     directly over PostgREST (policy tri_member_read), so that emptier list is
 *     not only an internal cache — and this module's own header calls the
 *     critical-item list a rule that must never be hidden.
 *   • The `select("dedupe_key")` that computes the sweep set dropped its error
 *     too: an unreadable table produced an empty stale set and no sweep at all,
 *     which is the opposite failure (stale blockers linger) and equally silent.
 *
 * The fix keeps the stated posture — "persistence failure must not fail the
 * compute", the returned summary is computed in memory and stays correct — but
 * makes the writes observed, and makes the DELETE conditional on the UPSERT.
 *
 * Run: node --import tsx/esm --test src/test/tripReadinessPersistence.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeReadiness } from "../lib/tripReadiness.js";

const TRIP_ID  = "10000000-0000-0000-0000-000000000001";
const OWNER_ID = "10000000-0000-0000-0000-0000000000a1";

type Op = { table: string; op: string; payload?: any };

interface Opts {
  /** dedupe_keys already stored for this trip — sweep candidates. */
  storedKeys?: string[];
  /** Fail the read/write matching this predicate. */
  failOn?: (q: { table: string; op: string; columns: string | null }) => boolean;
}

function makeSc(opts: Opts = {}) {
  const ops: Op[] = [];

  const rows: Record<string, any[]> = {
    trips: [{
      id: TRIP_ID, owner_id: OWNER_ID, destination_country: null,
      // No dates and no budget => the engine has plenty to complain about,
      // which is what makes `items.length > 0` and the upsert run at all.
      start_date: null, end_date: null,
    }],
    trip_members: [{ trip_id: TRIP_ID, user_id: OWNER_ID, role: "owner", status: "accepted" }],
    trip_plan_items: [],
    trip_budget: [],
    trip_documents: [],
    trip_reservations: [],
    trip_traveler_passports: [],
    entry_requirements: [],
    trip_readiness_items: (opts.storedKeys ?? []).map((k) => ({ trip_id: TRIP_ID, dedupe_key: k })),
  };

  function builder(table: string) {
    let op = "select";
    let columns: string | null = null;
    let payload: any;

    const err = () => ({
      data: null,
      error: { message: `injected ${table}.${op} failure`, code: "57014" },
      status: 500,
      count: null,
    });
    const fails = () => Boolean(opts.failOn?.({ table, op, columns }));

    const b: any = {
      select(c?: string) { if (op === "select") columns = c ?? null; return b; },
      upsert(p: any) { op = "upsert"; payload = p; return b; },
      insert(p: any) { op = "insert"; payload = p; return b; },
      update(p: any) { op = "update"; payload = p; return b; },
      delete()       { op = "delete"; return b; },
      eq()  { return b; }, neq() { return b; }, in() { return b; },
      is()  { return b; }, gt()  { return b; }, lt() { return b; },
      gte() { return b; }, lte() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { return settle(true); },
      single()      { return settle(true); },
      then(onF: any, onR: any) { return settle(false).then(onF, onR); },
    };

    function settle(single: boolean) {
      ops.push({ table, op, payload });
      if (fails()) return Promise.resolve(err());
      const data = rows[table] ?? [];
      return Promise.resolve(
        op === "select"
          ? { data: single ? (data[0] ?? null) : data, error: null }
          : { data: null, error: null },
      );
    }

    return b;
  }

  return { sc: { from: (t: string) => builder(t) } as any, ops };
}

const readinessOps = (ops: Op[], op: string) =>
  ops.filter((o) => o.table === "trip_readiness_items" && o.op === op);

describe("computeReadiness — persistence of trip_readiness_items", () => {
  it("1. CONTROL — a healthy run upserts the new items and sweeps the stale key", async () => {
    const { sc, ops } = makeSc({ storedKeys: ["stale:key:gone"] });
    const summary = await computeReadiness(sc, TRIP_ID);
    assert.ok(summary.items.length > 0, "fixture produced no readiness items — the test would be vacuous");
    assert.equal(readinessOps(ops, "upsert").length, 1, "the produced items must be written");
    assert.equal(readinessOps(ops, "delete").length, 1, "the stale row must be swept");
  });

  it("2. CONTROL — with nothing stale, nothing is deleted", async () => {
    const { sc, ops } = makeSc({ storedKeys: [] });
    await computeReadiness(sc, TRIP_ID);
    assert.equal(readinessOps(ops, "upsert").length, 1);
    assert.equal(readinessOps(ops, "delete").length, 0);
  });

  it("3. a FAILED upsert must not be followed by the stale sweep", async () => {
    const { sc, ops } = makeSc({
      storedKeys: ["stale:key:gone"],
      failOn: ({ table, op }) => table === "trip_readiness_items" && op === "upsert",
    });
    const summary = await computeReadiness(sc, TRIP_ID);

    assert.equal(readinessOps(ops, "upsert").length, 1, "the upsert must still be attempted");
    assert.equal(
      readinessOps(ops, "delete").length, 0,
      "the new items were NOT written, so deleting the previous ones leaves the stored " +
      "readiness list emptier than either the old or the new truth",
    );
    // The stated posture is preserved: persistence failure does not fail the
    // compute, and the returned summary is the in-memory one.
    assert.ok(summary.items.length > 0);
    assert.equal(typeof summary.score, "number");
  });

  it("4. a FAILED sweep-set read must not be reported as 'nothing is stale'", async () => {
    // The select that decides what to sweep is the only trip_readiness_items
    // read; failing it leaves the function unable to know the stored set.
    const { sc, ops } = makeSc({
      storedKeys: ["stale:key:gone"],
      failOn: ({ table, op }) => table === "trip_readiness_items" && op === "select",
    });
    const summary = await computeReadiness(sc, TRIP_ID);
    assert.equal(readinessOps(ops, "select").length, 1);
    // It still must not delete on an unknown set, and it still must answer.
    assert.equal(readinessOps(ops, "delete").length, 0);
    assert.ok(summary.items.length > 0);
    // And the upsert of the fresh items is unaffected by that read failing.
    assert.equal(readinessOps(ops, "upsert").length, 1);
  });

  it("5. a healthy run reports the items it actually stored", async () => {
    const { sc, ops } = makeSc({ storedKeys: [] });
    const summary = await computeReadiness(sc, TRIP_ID);
    const written = readinessOps(ops, "upsert")[0]?.payload as any[];
    assert.ok(Array.isArray(written), "upsert payload not recorded");
    assert.equal(
      written.length, summary.items.length,
      "every item in the answer must be one of the rows the persist step wrote",
    );
    assert.deepEqual(
      written.map((r) => r.dedupe_key).sort(),
      summary.items.map((i: any) => i.dedupeKey).sort(),
    );
  });
});
