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
  // DISRUPTION_LEDGER_MAX_PAGES: retired by pass 12 C6 (the read is filtered server-side and no longer pages)
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

/** The narrow PostgREST shape the reader uses (from/select/eq/lt/not/order/limit), recording each call it is sent, and a fault on the Nth read. */
function client(rows: Row[], opts: { failOnRead?: number } = {}) {
  let reads = 0; const sent: string[] = [];
  return {
    reads: () => reads, sent: () => sent,
    from(_t: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let desc = true; let lim = Infinity;
      const b: any = {
        select() { return b; },
        eq(c: keyof Row, v: unknown) { sent.push(`eq(${String(c)}, ${String(v)})`); filters.push((r) => r[c] === v); return b; },
        lt(c: keyof Row, v: string) { sent.push(`lt(${String(c)})`); filters.push((r) => (r[c] as string) < v); return b; }, not(c: string, op: string, v: unknown) { sent.push(`not(${c}, ${op}, ${String(v)})`); const path = /^(\w+)->(\w+)$/.exec(c); if (!path || op !== "is" || v !== null) throw new Error(`unmodelled not(${c}, ${op})`); filters.push((r) => { const o = (r as any)[path[1]]; return o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, path[2]); }); return b; }, // PostgREST: `col->key IS NULL` is SQL NULL only when the key is absent; a JSON null is 'null'::jsonb, NOT NULL
        order(_c: string, o: { ascending: boolean }) { sent.push(`order(${_c}, ${o.ascending ? "asc" : "desc"})`); desc = !o.ascending; return b; },
        limit(n: number) { sent.push(`limit(${n})`); lim = n; return b; },
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

  it("ADAPTED (pass 12 C6; was: past the 40-page bound, UNKNOWN): 2,000 edits and no report is CONNECTION from ONE filtered read", async () => {
    const n = DISRUPTION_LEDGER_SCAN_LIMIT * 40; // the old bound's 2,000 rows: the database, not a page bound, now says that no row carries a disruption
    const c = client(Array.from({ length: n }, (_, k) => edit(k)));
    const r = await readDisruptionState(c, SESSION, USER);
    assert.deepEqual(r.ok && { state: r.state, source: r.source }, { state: "CONNECTION", source: "default" }); assert.equal(c.reads(), 1);
  });

  it("ADAPTED (pass 12 C6; was: the 2nd page fails): the one read failing is the read's failure, not a shorter history", async () => {
    const rows = [reported(0), ...Array.from({ length: 60 }, (_, k) => edit(k + 1))];
    const r = await readDisruptionState(client(rows, { failOnRead: 1 }), SESSION, USER);
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

// ═══ PASS 12 C6 (independent verification, 2026-10-18) — appended: the lines above are counted ═══
// Round 2's pager read up to 40 pages of 50 `session_updated` rows for a session whose newest rows carry no report: the
// overview (every load and every 60 s), the disruption route and the replan each paid up to 2,000 rows. The read now
// asks the DATABASE for the rows that carry a disruption — PostgREST `metadata->disruption=not.is.null` — newest first,
// in one read. fakeLayoverDb's `.not()` is a no-op, so the filter is pinned here, on the call this client records.
const malformed = (i: number): Row => ({ session_id: SESSION, user_id: USER, event_type: "session_updated", created_at: at(i), metadata: { disruption: null } });

describe("pass 12 C6 — the disruption ledger is filtered server-side: one read, no paging", () => {
  it("the read sends `.not(\"metadata->disruption\", \"is\", null)` — exactly that path — newest first, and ONE read finds a report behind 2,000 edits", async () => {
    const c = client([reported(0, "CANCELLED"), ...Array.from({ length: 2000 }, (_, k) => edit(k + 1))]);
    const r = await readDisruptionState(c, SESSION, USER);
    assert.deepEqual(r.ok && { state: r.state, source: r.source, recordedAt: r.recordedAt }, { state: "CANCELLED", source: "ledger", recordedAt: at(0) });
    assert.equal(c.reads(), 1, "one read, whatever the history's length");
    assert.deepEqual(c.sent(), [
      `eq(session_id, ${SESSION})`, `eq(user_id, ${USER})`, "eq(event_type, session_updated)",
      "not(metadata->disruption, is, null)",
      "order(created_at, desc)", `limit(${DISRUPTION_LEDGER_SCAN_LIMIT})`,
    ]);
  });

  it("a FULL filtered page none of whose rows carries a disruption record is UNKNOWN — a report could lie beyond it — never CONNECTION", async () => {
    const c = client([reported(0), ...Array.from({ length: DISRUPTION_LEDGER_SCAN_LIMIT }, (_, k) => malformed(k + 1))]);
    const r = await readDisruptionState(c, SESSION, USER);
    assert.equal(r.ok, false);
    assert.equal(c.reads(), 1);
  });

  it("CONTROL (answers unchanged): a newer row whose disruption is not a record is skipped, and the newest REPORT still wins, from one read", async () => {
    const c = client([reported(0, "DELAYED"), edit(1), reported(2, "CANCELLED"), malformed(3), edit(4)]);
    const r = await readDisruptionState(c, SESSION, USER);
    assert.deepEqual(r.ok && { state: r.state, recordedAt: r.recordedAt }, { state: "CANCELLED", recordedAt: at(2) });
    assert.equal(c.reads(), 1);
  });
});
