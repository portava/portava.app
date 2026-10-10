/**
 * Account deletion and the traveller's layover data — census-layover L163, lead
 * ruling 2026-10-07 adopting OD-MAP-4 ("Keep a pseudonymized, access-restricted
 * audit record for up to 12 months, then delete it").
 *
 * WHAT WAS WRONG. Deletion keeps a tombstone profile, so no cascade off profiles
 * fires, and AccountDeletionService named no layover table: every session, stop,
 * recommendation and event survived the deletion keyed to the same uuid.
 *
 * WHAT IS ASSERTED:
 *   - layover_events are PSEUDONYMISED, never left named: user and session NULL,
 *     one random pseudonym per deletion, metadata emptied, retain_until 365 days
 *     after the deletion (never past 12 months), scoped to this user only;
 *   - then the user's crew memberships, then the sessions (whose cascade takes
 *     every other layover table) — in that order;
 *   - a database without 3621 (42703 / PGRST204) erases the events with their
 *     sessions instead (inside OD-MAP-4's ceiling), and the deletion proceeds;
 *   - any other failure is FATAL: no session delete after a failed
 *     pseudonymisation, and no profile anonymisation or auth deletion after a
 *     failed layover step — the request stays retryable.
 *
 * Run: node --import tsx/esm --test src/test/accountDeletionLayover.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeAccountDeletion, LAYOVER_AUDIT_RETENTION_DAYS } from "../services/accountDeletion/AccountDeletionService.js";

const USER_ID = "33333333-3333-4333-8333-333333333333";
type Op = { table: string; op: string; filters: any[]; payload?: any };

function makeStub(opts: { fail?: Record<string, Record<string, any>> } = {}) {
  const ops: Op[] = [];
  const authDeleted: string[] = [];
  function builder(table: string) {
    const q: any = {
      _op: "select", _filters: [] as any[], _payload: undefined as any, _single: false,
      select() { if (q._op === "select") q._op = "select"; return q; },
      delete() { q._op = "delete"; return q; },
      update(p: any) { q._op = "update"; q._payload = p; return q; },
      insert() { q._op = "insert"; return q; },
      upsert() { q._op = "upsert"; return q; },
      eq(c: string, v: any) { q._filters.push(["eq", c, v]); return q; },
      neq() { return q; }, not() { return q; }, in() { return q; }, or() { return q; },
      lte() { return q; }, gte() { return q; }, lt() { return q; }, is() { return q; },
      order() { return q; }, range() { return q; },
      limit() { return q; },
      maybeSingle() { q._single = true; return q._run(); },
      single() { q._single = true; return q._run(); },
      then(resolve: any, reject: any) { return q._run().then(resolve, reject); },
      _run() {
        if (q._op === "update" || q._op === "delete") {
          ops.push({ table, op: q._op, filters: q._filters.slice(), payload: q._payload });
          const err = opts.fail?.[`${table}:${q._op}`];
          if (err) return Promise.resolve({ data: null, error: err });
          return Promise.resolve({ data: null, error: null });
        }
        if (q._single) return Promise.resolve({ data: null, error: null });
        return Promise.resolve({ data: [], error: null });
      },
    };
    return q;
  }
  return {
    _ops: ops,
    _authDeleted: authDeleted,
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: null }),
    storage: { from: () => ({ remove: async () => ({ data: [], error: null }) }) },
    auth: { admin: { deleteUser: async (id: string) => { authDeleted.push(id); return { data: {}, error: null }; } } },
  };
}

const LAYOVER = ["layover_events", "layover_crew_members", "layover_sessions"];
const layoverOps = (c: ReturnType<typeof makeStub>) => c._ops.filter((o) => LAYOVER.includes(o.table));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("account deletion — layover (census-layover L163, OD-MAP-4)", () => {
  it("pseudonymises the events, then deletes the crew memberships, then the sessions — each scoped to this user", async () => {
    const c = makeStub();
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });
    assert.equal(out.ok, true, JSON.stringify(out.steps.filter((s) => !s.ok)));
    assert.deepEqual(layoverOps(c).map((o) => `${o.op} ${o.table}`), [
      "update layover_events", "delete layover_crew_members", "delete layover_sessions",
    ]);
    for (const o of layoverOps(c)) assert.deepEqual(o.filters, [["eq", "user_id", USER_ID]], `${o.op} ${o.table} unscoped`);
    const p = layoverOps(c)[0]!.payload;
    assert.equal(p.user_id, null);
    assert.equal(p.session_id, null);
    assert.match(String(p.erasure_pseudonym), UUID);
    assert.notEqual(p.erasure_pseudonym, USER_ID);
    assert.deepEqual(p.metadata, {});
    assert.equal(p.pseudonymised_at, out.executedAt);
    const kept = Date.parse(p.retain_until) - Date.parse(p.pseudonymised_at);
    assert.equal(kept, LAYOVER_AUDIT_RETENTION_DAYS * 86_400_000);
    const twelveMonths = new Date(p.pseudonymised_at); twelveMonths.setUTCMonth(twelveMonths.getUTCMonth() + 12);
    assert.ok(Date.parse(p.retain_until) <= twelveMonths.getTime(), "retained past OD-MAP-4's 12 months");
    for (const s of ["pseudonymise_layover_events", "delete_layover_crew_memberships", "delete_layover_sessions"]) {
      assert.equal(out.steps.find((x) => x.step === s)?.ok, true, s);
    }
  });

  it("each deletion gets its OWN pseudonym — two departed travellers are never joined", async () => {
    const a = makeStub(); const b = makeStub();
    await executeAccountDeletion(a as any, USER_ID, { actorId: null });
    await executeAccountDeletion(b as any, USER_ID, { actorId: null });
    assert.notEqual(layoverOps(a)[0]!.payload.erasure_pseudonym, layoverOps(b)[0]!.payload.erasure_pseudonym);
  });

  for (const code of ["42703", "PGRST204"]) {
    it(`a database without 3621 (${code}) erases the events with their sessions and the deletion proceeds`, async () => {
      const c = makeStub({ fail: { "layover_events:update": { code, message: "column erasure_pseudonym does not exist" } } });
      const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });
      assert.equal(out.steps.find((s) => s.step === "pseudonymise_layover_events")?.ok, true);
      assert.ok(layoverOps(c).some((o) => o.op === "delete" && o.table === "layover_sessions"));
      assert.ok(out.steps.some((s) => s.step === "anonymise_profile"));
    });
  }

  it("a FAILED pseudonymisation deletes no session and aborts before the profile is anonymised", async () => {
    const c = makeStub({ fail: { "layover_events:update": { code: "57014", message: "statement timeout" } } });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });
    assert.equal(out.ok, false);
    assert.ok(!layoverOps(c).some((o) => o.table === "layover_sessions"), "sessions deleted around an event that kept its user");
    assert.equal(out.steps.find((s) => s.step === "anonymise_profile"), undefined);
    assert.deepEqual(c._authDeleted, []);
    assert.ok(out.warnings.some((w) => w.includes("layover sessions and events may remain")));
  });

  it("a FAILED session delete aborts before the profile is anonymised (the request stays retryable)", async () => {
    const c = makeStub({ fail: { "layover_sessions:delete": { code: "57014", message: "statement timeout" } } });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });
    assert.equal(out.ok, false);
    assert.equal(out.steps.find((s) => s.step === "delete_layover_sessions")?.ok, false);
    assert.equal(out.steps.find((s) => s.step === "anonymise_profile"), undefined);
    assert.deepEqual(c._authDeleted, []);
  });

  it("a FAILED crew-membership delete deletes no session either", async () => {
    const c = makeStub({ fail: { "layover_crew_members:delete": { code: "57014", message: "statement timeout" } } });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });
    assert.equal(out.ok, false);
    assert.ok(!layoverOps(c).some((o) => o.table === "layover_sessions"));
  });

  it("a database without 2984's crew tables (42P01) is nothing to erase there, not a failure", async () => {
    const c = makeStub({ fail: { "layover_crew_members:delete": { code: "42P01", message: "relation does not exist" } } });
    const out = await executeAccountDeletion(c as any, USER_ID, { actorId: null });
    assert.equal(out.steps.find((s) => s.step === "delete_layover_crew_memberships")?.ok, true);
    assert.ok(layoverOps(c).some((o) => o.op === "delete" && o.table === "layover_sessions"));
  });
});
