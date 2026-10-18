/**
 * The disruption ledger is paged (round 2, layover lane A's finding).
 *
 * readDisruptionState read ONE page of the newest DISRUPTION_LEDGER_SCAN_LIMIT `session_updated` rows. Window edits
 * write that same event type, so about 25 edits after a report pushed the report out of view, and the read said
 * "nothing reported" (CONNECTION, source "default"): a page boundary answered as a fact about the traveller. It now
 * pages back until a row carries a disruption or the history ends, and a history longer than the bound is unknown.
 *
 *   node --import tsx/esm --test src/test/layoverDisruptionLedgerPaging.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  readDisruptionState,
  DISRUPTION_LEDGER_SCAN_LIMIT,
  DISRUPTION_LEDGER_MAX_PAGES,
} from "../services/airport/layoverSafeReturnDisruption.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const T0 = Date.parse("2026-10-18T10:00:00.000Z");

type Row = { session_id: string; user_id: string; event_type: string; created_at: string; metadata: Record<string, unknown> };
const at = (i: number) => new Date(T0 + i * 1000).toISOString();
const edit = (i: number): Row => ({ session_id: SESSION, user_id: USER, event_type: "session_updated", created_at: at(i), metadata: { fields: ["notes"] } });
const reported = (i: number, state = "DELAYED"): Row => ({
  session_id: SESSION, user_id: USER, event_type: "session_updated", created_at: at(i),
  metadata: { disruption: { state, baselineDepartureTime: "2026-10-18T18:00:00.000Z" } },
});

/** The narrow PostgREST shape the reader uses: from/select/eq/lt/order/limit, and a fault on the Nth read. */
function client(rows: Row[], opts: { failOnRead?: number } = {}) {
  let reads = 0;
  return {
    reads: () => reads,
    from(_t: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let desc = true; let lim = Infinity;
      const b: any = {
        select() { return b; },
        eq(c: keyof Row, v: unknown) { filters.push((r) => r[c] === v); return b; },
        lt(c: keyof Row, v: string) { filters.push((r) => (r[c] as string) < v); return b; },
        order(_c: string, o: { ascending: boolean }) { desc = !o.ascending; return b; },
        limit(n: number) { lim = n; return b; },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          reads += 1;
          if (opts.failOnRead === reads) return Promise.resolve({ data: null, error: { message: "page unreadable" } }).then(res, rej);
          const out = rows.filter((r) => filters.every((f) => f(r))).sort((a, b2) => (desc ? b2.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b2.created_at))).slice(0, lim);
          return Promise.resolve({ data: out, error: null }).then(res, rej);
        },
      };
      return b;
    },
  } as any;
}

describe("the disruption ledger is paged, so later window edits cannot hide a report", () => {
  it("RED before: a report followed by 60 window edits is still the session's state (it was CONNECTION / default)", async () => {
    const rows = [reported(0), ...Array.from({ length: 60 }, (_, k) => edit(k + 1))];
    const r = await readDisruptionState(client(rows), SESSION, USER);
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && { state: r.state, source: r.source }, { state: "DELAYED", source: "ledger" });
  });

  it("RED before: a history longer than the scan bound with no disruption is UNKNOWN, never CONNECTION", async () => {
    const n = DISRUPTION_LEDGER_SCAN_LIMIT * DISRUPTION_LEDGER_MAX_PAGES;
    const rows = Array.from({ length: n }, (_, k) => edit(k));
    const r = await readDisruptionState(client(rows), SESSION, USER);
    assert.equal(r.ok, false);
  });

  it("a page that fails is the read's failure, not a shorter history", async () => {
    const rows = [reported(0), ...Array.from({ length: 60 }, (_, k) => edit(k + 1))];
    const r = await readDisruptionState(client(rows, { failOnRead: 2 }), SESSION, USER);
    assert.equal(r.ok, false);
  });

  it("CONTROL: a short history with no disruption is CONNECTION, from the default, after ONE read", async () => {
    const c = client(Array.from({ length: 10 }, (_, k) => edit(k)));
    const r = await readDisruptionState(c, SESSION, USER);
    assert.deepEqual(r.ok && { state: r.state, source: r.source }, { state: "CONNECTION", source: "default" });
    assert.equal(c.reads(), 1);
  });

  it("CONTROL: a report in the newest page is found after ONE read, and the NEWEST report wins", async () => {
    const c = client([reported(0, "DELAYED"), edit(1), reported(2, "CANCELLED"), edit(3)]);
    const r = await readDisruptionState(c, SESSION, USER);
    assert.deepEqual(r.ok && { state: r.state }, { state: "CANCELLED" });
    assert.equal(c.reads(), 1);
  });
});
