/**
 * Zero matched rows reported as an adjudication — services/trust/TrustAdminService.ts
 *
 * THE CLASS
 * =========
 * confirmEvent reads the trust event, checks it is `pending_review`, and then
 * moves it with a COMPARE-AND-SWAP:
 *
 *   UPDATE trust_events SET status='confirmed' … WHERE id=? AND status='pending_review'
 *
 * The file already says why that transition matters — it is the idempotency
 * guard for everything after it: the cap application, the 30-day probation, the
 * score recalculation and the admin audit row. But it only ever read `error`,
 * and LOSING the compare-and-swap is not an error. PostgREST answers a zero-row
 * UPDATE with 204 and supabase-js resolves `{ data: null, error: null }` —
 * exactly what the winning caller sees. So two admins adjudicating the same
 * queue item (or one double-submitted request) BOTH ran the consequences, which
 * is the double-charge the guard was supposed to prevent. `.select()` makes the
 * update RETURNING so the transition is observed instead of assumed.
 *
 * dismissEvent is the same shape, with a lighter consequence (a recalc and an
 * audit row attributing an adjudication to an admin who did not make it).
 *
 * revokeModerationTrustConsequences is the read-set variant: it SELECTs the
 * moderation-sourced events, updates them by id, and returns `ids.length` — the
 * size of the READ — as `eventsDismissed`, while the write's outcome was
 * discarded entirely (neither its error nor its row count was read). That count
 * is what routes/admin.ts's restore path reports as "the sanction's trust
 * consequences were reversed".
 *
 * THE FAKE
 * ========
 * Rows are real and filters are really applied; an UPDATE resolves to the rows
 * it MATCHED (`[]` when it matched none) and to `null` when `.select()` was not
 * chained, so "matched 0" and "matched N" are different values. A fake that
 * resolved every write as `{ error: null }` could not express this defect.
 *
 * These are service-level tests: no express app, so no `req.log` shim is needed
 * and no route-level gate can produce a refusal that looks like the one under
 * test. Each refusal case asserts the SPECIFIC thrown message, and each is
 * paired with the happy path in the same block so a throw from the wrong place
 * would fail its twin.
 *
 * Runtime: node:test + node:assert/strict
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/zeroRowTrustAdjudication.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  confirmEvent,
  dismissEvent,
  revokeModerationTrustConsequences,
} from "../services/trust/TrustAdminService.js";

const ADMIN_ID = "bbbbbbbb-0000-0000-0000-000000000002";
const USER_ID  = "aaaaaaaa-0000-0000-0000-000000000001";
const EVENT_ID = "cccccccc-0000-0000-0000-000000000003";

type Row = Record<string, any>;
interface Db {
  tables: Record<string, Row[]>;
  inserts: Array<{ table: string; row: Row }>;
  /** One-shot hook, run after the next SELECT on that table resolves. */
  afterSelect: Record<string, (db: Db) => void>;
  /** Make every UPDATE/DELETE on that table resolve with this error. Reads are
   *  unaffected, so a case using it is exercising a failed WRITE and not a
   *  broken fixture. */
  failWrite: Record<string, { message: string }>;
}

function makeClient(tables: Record<string, Row[]>): { db: Db; client: any } {
  const db: Db = { tables, inserts: [], afterSelect: {}, failWrite: {} };
  const src = (t: string) => (db.tables[t] ??= []);

  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = [];
    let verb: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let payload: any = null;
    let returning = false;
    let single = false;
    const b: any = {
      select() { returning = true; return b; },
      insert(p: any) { verb = "insert"; payload = p; return b; },
      upsert(p: any) { verb = "upsert"; payload = p; return b; },
      update(p: any) { verb = "update"; payload = p; return b; },
      delete() { verb = "delete"; return b; },
      eq(c: string, v: any) { preds.push((r) => r[c] === v); return b; },
      neq(c: string, v: any) { preds.push((r) => r[c] !== v); return b; },
      in(c: string, v: any[]) { preds.push((r) => v.includes(r[c])); return b; },
      is(c: string, v: any) { preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b; },
      lt() { return b; }, gt() { return b; }, gte() { return b; }, lte() { return b; },
      not() { return b; }, or() { return b; }, order() { return b; }, limit() { return b; },
      maybeSingle() { single = true; return run(); },
      single() { single = true; return run(); },
      then(onF: any, onR: any) { return run().then(onF, onR); },
    };
    const match = () => src(table).filter((r) => preds.every((p) => p(r)));
    async function run(): Promise<{ data: any; error: any; count?: number }> {
      if (verb === "select") {
        // Copies: a read must not hand back an object the race hook can mutate
        // under the caller, or a CAS test passes at the pre-check instead.
        const m = match().map((r) => ({ ...r }));
        const out = { data: single ? (m[0] ?? null) : m, error: null, count: m.length };
        const hook = db.afterSelect[table];
        if (hook) { delete db.afterSelect[table]; hook(db); }
        return out;
      }
      if (verb === "insert" || verb === "upsert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `gen-${src(table).length + 1}`, ...r }));
        for (const r of rows) { src(table).push(r); db.inserts.push({ table, row: r }); }
        return { data: single ? (rows[0] ?? null) : rows, error: null };
      }
      if (db.failWrite[table]) return { data: null, error: db.failWrite[table] };
      const m = match();
      const snapshot = m.map((r) => ({ ...r }));
      if (verb === "update") for (const r of m) Object.assign(r, payload);
      else db.tables[table] = src(table).filter((r) => !m.includes(r));
      return { data: returning ? (single ? (snapshot[0] ?? null) : snapshot) : null, error: null, count: snapshot.length };
    }
    return b;
  }

  return { db, client: { from, rpc: async () => ({ data: null, error: null }) } };
}

const auditRows = (db: Db) => db.inserts.filter((i) => i.table === "trust_admin_actions").map((i) => i.row);

// ── confirmEvent ────────────────────────────────────────────────────────────

describe("confirmEvent — losing the pending_review compare-and-swap", () => {
  it("does not apply caps, probation or an audit row when another admin got there first", async () => {
    const { db, client } = makeClient({
      trust_events: [
        { id: EVENT_ID, user_id: USER_ID, event_type: "behavior_report_confirmed", severity: "severe", status: "pending_review" },
      ],
      trust_caps: [],
      trust_reviews: [],
      trust_admin_actions: [],
      trust_scores: [],
      user_trust_state: [],
    });
    // The read really sees pending_review — so the pre-check passes and the
    // compare-and-swap really runs. The other admin confirms in that window.
    db.afterSelect.trust_events = (d) => {
      d.tables.trust_events[0]!.status = "confirmed";
      d.tables.trust_events[0]!.reviewed_by = "someone-else";
    };

    await assert.rejects(
      () => confirmEvent(client as any, ADMIN_ID, EVENT_ID, "spam"),
      /not pending review/i,
      "a confirm that changed nothing must not report ok",
    );

    assert.equal(
      auditRows(db).length,
      0,
      "no confirm_event audit row may record an adjudication this admin did not make",
    );
    assert.equal(
      db.tables.trust_events[0]!.reviewed_by,
      "someone-else",
      "the first admin's attribution stands",
    );
  });

  it("a genuine confirmation transitions the event and writes its audit row", async () => {
    const { db, client } = makeClient({
      trust_events: [
        { id: EVENT_ID, user_id: USER_ID, event_type: "behavior_report_confirmed", severity: "minor", status: "pending_review" },
      ],
      trust_caps: [],
      trust_reviews: [],
      trust_admin_actions: [],
      trust_scores: [],
      user_trust_state: [],
    });

    const r = await confirmEvent(client as any, ADMIN_ID, EVENT_ID, "spam");

    assert.deepEqual(r, { ok: true });
    assert.equal(db.tables.trust_events[0]!.status, "confirmed");
    assert.equal(db.tables.trust_events[0]!.reviewed_by, ADMIN_ID);
    assert.equal(auditRows(db).filter((a) => a.action_type === "confirm_event").length, 1);
  });
});

// ── dismissEvent ────────────────────────────────────────────────────────────

describe("dismissEvent — losing the pending_review compare-and-swap", () => {
  it("does not audit a dismissal another admin made", async () => {
    const { db, client } = makeClient({
      trust_events: [
        { id: EVENT_ID, user_id: USER_ID, status: "pending_review" },
      ],
      trust_reviews: [],
      trust_admin_actions: [],
      trust_scores: [],
    });
    db.afterSelect.trust_events = (d) => { d.tables.trust_events[0]!.status = "dismissed"; };

    await assert.rejects(
      () => dismissEvent(client as any, ADMIN_ID, EVENT_ID, "not a finding"),
      /not pending review/i,
    );
    assert.equal(auditRows(db).length, 0);
  });

  it("a genuine dismissal transitions the event and writes its audit row", async () => {
    const { db, client } = makeClient({
      trust_events: [{ id: EVENT_ID, user_id: USER_ID, status: "pending_review" }],
      trust_reviews: [],
      trust_admin_actions: [],
      trust_scores: [],
    });

    const r = await dismissEvent(client as any, ADMIN_ID, EVENT_ID, "not a finding");

    assert.deepEqual(r, { ok: true });
    assert.equal(db.tables.trust_events[0]!.status, "dismissed");
    assert.equal(auditRows(db).filter((a) => a.action_type === "dismiss_event").length, 1);
  });
});

// ── revokeModerationTrustConsequences ───────────────────────────────────────

describe("revokeModerationTrustConsequences — the count is the write's, not the read's", () => {
  it("reports only the events the update really dismissed", async () => {
    const { db, client } = makeClient({
      trust_events: [
        { id: "e1", user_id: USER_ID, source_type: "moderation", status: "confirmed" },
        { id: "e2", user_id: USER_ID, source_type: "moderation", status: "confirmed" },
      ],
      trust_caps: [],
      trust_admin_actions: [],
      trust_scores: [],
      user_trust_state: [],
    });
    // e2 is dismissed by a concurrent reversal between the SELECT and the
    // UPDATE, so the write moves one of the two it selected.
    db.afterSelect.trust_events = (d) => { d.tables.trust_events[1]!.status = "dismissed"; };

    const r = await revokeModerationTrustConsequences(client as any, ADMIN_ID, USER_ID, "Account restored");

    assert.equal(r.eventsDismissed, 1, "the read set was 2; this call dismissed one");
    const audit = auditRows(db).find((a) => (a.metadata as any)?.op === "revoke_moderation_trust");
    assert.ok(audit, "the audit row is still written");
    assert.equal(
      (audit!.metadata as any).eventsDismissed,
      1,
      "and the audit records what happened, not what was selected",
    );
  });

  it("reports every event when the update really dismisses them all", async () => {
    const { db, client } = makeClient({
      trust_events: [
        { id: "e1", user_id: USER_ID, source_type: "moderation", status: "confirmed" },
        { id: "e2", user_id: USER_ID, source_type: "moderation", status: "applied" },
      ],
      trust_caps: [],
      trust_admin_actions: [],
      trust_scores: [],
      user_trust_state: [],
    });

    const r = await revokeModerationTrustConsequences(client as any, ADMIN_ID, USER_ID, "Account restored");

    assert.equal(r.eventsDismissed, 2);
    assert.equal(db.tables.trust_events.every((e) => e.status === "dismissed"), true);
  });

  it("reports zero — and never throws — when the dismissal itself fails", async () => {
    const { db, client } = makeClient({
      trust_events: [
        { id: "e1", user_id: USER_ID, source_type: "moderation", status: "confirmed" },
      ],
      trust_caps: [],
      trust_admin_actions: [],
      trust_scores: [],
      user_trust_state: [],
    });
    // Fail only writes to trust_events; every read still works, so this case
    // exercises a failed WRITE and not a fixture that cannot be read.
    db.failWrite.trust_events = { message: "permission denied" };

    const r = await revokeModerationTrustConsequences(client as any, ADMIN_ID, USER_ID, "Account restored");

    assert.equal(r.eventsDismissed, 0, "a failed dismissal must not be reported as a reversal");
    assert.equal(db.tables.trust_events[0]!.status, "confirmed", "and nothing moved");
  });
});
