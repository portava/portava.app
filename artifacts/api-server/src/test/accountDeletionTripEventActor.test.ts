/**
 * Account deletion — trip_events.actor_id (Trip Kernel residual identifier)
 *
 * Under test: services/accountDeletion/AccountDeletionService.ts
 *
 * THE DEFECT this proves is closed:
 *   trip_events.actor_id (migration 2316) is declared
 *   `uuid REFERENCES profiles(id) ON DELETE SET NULL`. That SET NULL never fires,
 *   because executeAccountDeletion keeps an anonymised TOMBSTONE profile rather
 *   than deleting profiles(id) — the same trap 2172/2170/2187 fell into and
 *   2203/2204/2190 corrected. Without an explicit step, a departed user's uuid
 *   would survive in the kernel's append-only log as a residual identifier,
 *   joinable to that uuid across every other table that keeps it.
 *
 *   It must be a SET NULL and NOT a delete: trip_events is the trip's history,
 *   shared with every member of that trip. Deleting the rows would erase THEIR
 *   record of what happened to their trip.
 *
 * The fake APPLIES the update to seeded rows, so the property proven is literal:
 * the departed user's events are anonymised, another member's are not, and the
 * rows themselves survive.
 *
 * Mutation proof: delete the `null_trip_event_actor` step from
 * AccountDeletionService and the "actor_id is now NULL" assertion goes RED.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionTripEventActor.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeAccountDeletion } from "../services/accountDeletion/AccountDeletionService.js";
import { ANONYMISED_FK_NULLED, POST_BASELINE_TABLES } from "../lib/deletionDispositions.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

interface Op { table: string; op: string; filters: any[]; values?: any }

/** Applying fake — mirrors src/test/accountDeletionAcceptedBy.test.ts. */
function makeClient(seed: Record<string, any[]> = {}) {
  const store: Record<string, any[]> = {};
  for (const [t, rows] of Object.entries(seed)) store[t] = rows.map((r) => ({ ...r }));
  const ops: Op[] = [];
  const authDeleted: string[] = [];

  function builder(table: string) {
    const q: any = {
      _op: "select",
      _filters: [] as any[],
      _values: undefined as any,
      _single: false,
      _limit: undefined as number | undefined,
      select() { q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(v: any) { q._op = "update"; q._values = v; return q; },
      upsert(v: any) { q._op = "upsert"; q._values = v; return q; },
      insert(v: any) { q._op = "insert"; q._values = v; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq(c: string, v: any) { q._filters.push(["neq", c, v]); return q; },
      not(c: string, op: string, v: any) { q._filters.push(["not", c, op, v]); return q; },
      lte(c: string, v: any) { q._filters.push(["lte", c, v]); return q; },
      in(c: string, v: any[]) { q._filters.push(["in", c, v]); return q; },
      or(expr: string) { q._filters.push(["or", expr]); return q; },
      order() { return q; },
      limit(n: number) { q._limit = n; return q; },
      maybeSingle() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        ops.push({ table, op: q._op, filters: q._filters, values: q._values });
        const rows = store[table] ?? [];
        if (q._op === "update") {
          const eqs = q._filters.filter((f: any[]) => f[0] === "eq");
          for (const row of rows) {
            if (eqs.every(([, c, v]: any[]) => row[c] === v)) Object.assign(row, q._values);
          }
        }
        let data: any = rows;
        if (q._limit) data = data.slice(0, q._limit);
        if (q._single) data = data.length > 0 ? data[0] : null;
        return Promise.resolve({ data, error: null });
      },
    };
    return q;
  }

  return {
    _ops: ops,
    _store: store,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      ops.push({ table: `rpc:${fn}`, op: "rpc", filters: [], values: args });
      return { data: null, error: null };
    },
    storage: {
      from: () => ({ remove: async (paths: string[]) => ({ data: paths.map((p) => ({ name: p })), error: null }) }),
    },
    auth: {
      admin: {
        deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; },
      },
    },
  };
}

const opFor = (c: any, table: string, op: string) =>
  c._ops.find((o: Op) => o.table === table && o.op === op);

describe("executeAccountDeletion — trip_events.actor_id", () => {
  it("NULLs the departed user's actor_id and leaves another member's events untouched", async () => {
    const c = makeClient({
      trip_events: [
        { id: "e-own",   actor_id: USER_ID,  event_type: "trip.completed", aggregate_version: 2 },
        { id: "e-other", actor_id: OTHER_ID, event_type: "trip.completed", aggregate_version: 3 },
        { id: "e-free",  actor_id: null,     event_type: "trip.completed", aggregate_version: 4 },
      ],
    });

    const out = await executeAccountDeletion(c, USER_ID, { actorId: "admin-1" });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const rows = c._store.trip_events as any[];
    const own = rows.find((r) => r.id === "e-own")!;
    const other = rows.find((r) => r.id === "e-other")!;

    // The mutation anchor: without the step, no update runs and this stays USER_ID.
    assert.equal(own.actor_id, null, "the deleted user's actor_id must be NULLed");
    assert.equal(other.actor_id, OTHER_ID, "another member's event must NOT change");
    assert.equal(rows.length, 3, "no event row may be removed — this is the trip's shared history");
    assert.equal(own.event_type, "trip.completed", "the event itself is retained, only the identifier goes");
    assert.equal(own.aggregate_version, 2, "the aggregate version the event records must survive intact");
  });

  it("runs null_trip_event_actor scoped by actor_id, as a SET NULL and never a DELETE", async () => {
    const c = makeClient();
    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps));

    const upd = opFor(c, "trip_events", "update");
    assert.ok(upd, "the cascade must UPDATE trip_events");
    assert.deepEqual(upd!.values, { actor_id: null }, "it must SET actor_id = NULL, not rewrite the event");
    assert.deepEqual(upd!.filters, [["eq", "actor_id", USER_ID]],
      "the update must be scoped to this user's events, by actor_id");

    assert.ok(out.steps.some((s) => s.step === "null_trip_event_actor" && s.ok),
      "the null_trip_event_actor step must run and succeed");
    assert.equal(opFor(c, "trip_events", "delete"), undefined,
      "trip_events is append-only and shared: the rows must be retained, not deleted");
  });

  it("warns without aborting when the SET NULL fails", async () => {
    const c: any = makeClient();
    const inner = c.from;
    c.from = (t: string) => {
      const q = inner(t);
      if (t === "trip_events") {
        const run = q._run.bind(q);
        q._run = () => {
          if (q._op === "update") return Promise.resolve({ data: null, error: { message: "permission denied" } });
          return run();
        };
      }
      return q;
    };

    const out = await executeAccountDeletion(c, USER_ID, { actorId: null });

    assert.ok(out.steps.some((s) => s.step === "null_trip_event_actor" && !s.ok),
      "the failing step must be recorded");
    assert.ok(out.warnings.some((w) => w.includes("trip_events")),
      "the residual-identifier risk must be surfaced: " + JSON.stringify(out.warnings));
    assert.equal(out.ok, true, "a failed non-fatal step must not abort the deletion");
    assert.deepEqual(c._authDeleted, [USER_ID]);
  });

  it("is classified in the deletion-coverage manifest, not left to an FK that never fires", () => {
    assert.ok(ANONYMISED_FK_NULLED.includes("trip_events"),
      "trip_events must be recorded in ANONYMISED_FK_NULLED");
    assert.ok(POST_BASELINE_TABLES.includes("trip_events"),
      "trip_events is post-baseline and must be declared so, or the coverage guard cannot see it at recapture");
  });
});
