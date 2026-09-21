/**
 * §21 — per-Memory deletion as an OBSERVABLE, RETRYABLE lifecycle.
 *
 * CENSUS H193, group (a): "per-Memory deletion has no named step, no report and
 * no retry; the account-deletion machinery next door has all three". H190 names
 * the same absence from the other side: "§21's five-step deletion lifecycle
 * still does not exist".
 *
 * RED BEFORE GREEN: at `7d1f2d498` the module below does not exist, so every
 * test in this file fails at import.
 *
 * WHAT IS DELIBERATELY *NOT* ASSERTED. That the lifecycle purges anything from
 * `memory_derivative_registry` or `memory_evidence` — neither table is deployed.
 * What IS asserted is that an absent table is reported as `not_applicable` with
 * its reason and is NOT retried, while a transient failure IS retried and then
 * dead-lettered, because those two being indistinguishable is the defect that
 * makes a deletion pipeline useless.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { _setTestClient } from "../../lib/http.js";
import memoriesRouter from "../../routes/memories.js";
import {
  MEMORY_DELETION_STEPS,
  MAX_STEP_ATTEMPTS,
  runMemoryDeletionLifecycle,
} from "./memoryDeletionLifecycle.js";

const MEM = "11111111-1111-1111-1111-111111111111";
const OWNER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

interface FakeState { [t: string]: any[] }

function baseState(memState = "deleted"): FakeState {
  return {
    memories: [{
      id: MEM, owner_id: OWNER, title: "t", caption: null,
      visibility: "public", allowed_user_ids: [], hidden_user_ids: [],
      trip_id: null, event_id: null, place_id: null, canonical_location_id: null,
      location_city: null, location_country: null, location_lat: null, location_lng: null,
      starts_at: null, ends_at: null, state: memState,
      created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z",
    }],
    memory_items: [], memory_tags: [], memory_likes: [], memory_saves: [],
    user_follows: [], circle_memberships: [], trips: [], trip_members: [],
    profiles: [], blocks: [], feature_flags: [],
    compass_feed_cache: [{ user_id: OWNER, cache_key: "k", payload: {}, expires_at: "2999-01-01T00:00:00Z" }],
    compass_cache_invalidations: [],
  };
}

/**
 * `failures` maps a table to the error it answers with. An absent table gets
 * PostgREST's own 42P01, which is the ONLY thing that may be read as
 * "not deployed" — never a heuristic on the message.
 */
function makeClient(state: FakeState, failures: Record<string, any> = {}, counter?: Record<string, number>) {
  function from(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pendingUpdate: any = null;
    let pendingDelete = false;
    const fail = failures[table] ?? null;
    const builder: any = {
      select() { return builder; },
      update(p: any) { pendingUpdate = p; return builder; },
      upsert() { return builder; },
      insert() { return builder; },
      delete() { pendingDelete = true; return builder; },
      eq(c: string, v: any) { filters.push((r) => r[c] === v); return builder; },
      neq(c: string, v: any) { filters.push((r) => r[c] !== v); return builder; },
      in(c: string, vs: any[]) { filters.push((r) => vs.includes(r[c])); return builder; },
      is(c: string, v: any) { filters.push((r) => (r[c] ?? null) === v); return builder; },
      gt() { return builder; }, lt() { return builder; },
      not() { return builder; }, order() { return builder; }, limit() { return builder; },
      maybeSingle: async () => {
        if (counter) counter[table] = (counter[table] ?? 0) + 1;
        return fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null };
      },
      single: async () => (fail ? { data: null, error: fail } : { data: rows()[0] ?? null, error: null }),
      then(onF: any, onR: any) {
        if (counter) counter[table] = (counter[table] ?? 0) + 1;
        if (fail) return Promise.resolve({ data: null, error: fail, count: null }).then(onF, onR);
        if (pendingUpdate) {
          const m = rows(); m.forEach((r) => Object.assign(r, pendingUpdate));
          return Promise.resolve({ data: m, error: null, count: m.length }).then(onF, onR);
        }
        if (pendingDelete) {
          const arr = state[table] ?? [];
          const gone = arr.filter((r) => filters.every((f) => f(r)));
          state[table] = arr.filter((r) => !filters.every((f) => f(r)));
          return Promise.resolve({ data: gone, error: null, count: gone.length }).then(onF, onR);
        }
        return Promise.resolve({ data: rows(), error: null, count: rows().length }).then(onF, onR);
      },
    };
    function rows() { return (state[table] ?? []).filter((r) => filters.every((f) => f(r))); }
    return builder;
  }
  return {
    from,
    auth: {
      getUser: async (tok: string) =>
        tok === "owner-tok" ? { data: { user: { id: OWNER } }, error: null } : { data: { user: null }, error: { message: "invalid" } },
    },
  };
}

const ABSENT = { code: "42P01", message: 'relation "x" does not exist' };
const TRANSIENT = { code: "57014", message: "statement timeout" };

const run = (sc: any) =>
  runMemoryDeletionLifecycle(sc, {
    memoryId: MEM,
    ownerId: OWNER,
    actorUserId: OWNER,
    previous: { visibility: "public", state: "published" },
    now: new Date("2026-09-14T00:00:00.000Z"),
  });

describe("§21 memory deletion lifecycle", () => {
  it("reports all five §21 states, in order, every time", async () => {
    const report = await run(makeClient(baseState()));
    assert.deepEqual(report.steps.map((s) => s.step), [...MEMORY_DELETION_STEPS]);
    assert.equal(report.steps.length, 5);
  });

  it("an ABSENT store is `not_applicable` with its reason, and is not retried", async () => {
    const counter: Record<string, number> = {};
    const sc = makeClient(baseState(), { memory_derivative_registry: ABSENT, memory_evidence: ABSENT }, counter);
    const report = await run(sc);
    const derivatives = report.steps.find((s) => s.step === "DERIVATIVES_PURGED")!;
    assert.equal(derivatives.outcome, "not_applicable");
    assert.equal(derivatives.attempts, 1, "a missing table is not conjured by a retry");
    assert.ok(derivatives.detail.length > 0, "an absent store must say why");
    const evidence = report.steps.find((s) => s.step === "RAW_EVIDENCE_PURGED")!;
    assert.equal(evidence.outcome, "not_applicable");
    assert.equal(evidence.attempts, 1);
    assert.equal(report.deadLettered, false, "an absent store is not a failure to retry");
    assert.equal(report.completed, true);
  });

  it("a TRANSIENT failure is retried to the cap and then dead-lettered", async () => {
    const counter: Record<string, number> = {};
    const sc = makeClient(baseState(), { memory_derivative_registry: TRANSIENT, memory_evidence: ABSENT }, counter);
    const report = await run(sc);
    const derivatives = report.steps.find((s) => s.step === "DERIVATIVES_PURGED")!;
    assert.equal(derivatives.outcome, "failed");
    assert.equal(derivatives.attempts, MAX_STEP_ATTEMPTS);
    assert.equal(derivatives.retryable, true);
    assert.equal(report.deadLettered, true);
    assert.equal(report.completed, false);
  });

  it("dead-lettering is reported as NOT durable, because no table holds it", async () => {
    const sc = makeClient(baseState(), { memory_derivative_registry: TRANSIENT, memory_evidence: ABSENT });
    const report = await run(sc);
    assert.equal(report.deadLettered, true);
    assert.equal(report.deadLetterDurable, false,
      "a dead letter nobody stores must not be reported as stored");
  });

  it("reachedState stops at the first step that did not complete", async () => {
    const sc = makeClient(baseState(), { memory_derivative_registry: TRANSIENT, memory_evidence: ABSENT });
    const report = await run(sc);
    assert.equal(report.reachedState, "PUBLIC_REVOKED");
  });

  it("DELETED refuses to report success while the row is still published", async () => {
    const sc = makeClient(baseState("published"), { memory_derivative_registry: ABSENT, memory_evidence: ABSENT });
    const report = await run(sc);
    const final = report.steps.find((s) => s.step === "DELETED")!;
    assert.equal(final.outcome, "failed");
    assert.equal(report.completed, false);
  });

  it("DELETED is `done` when the row really is deleted", async () => {
    const sc = makeClient(baseState("deleted"), { memory_derivative_registry: ABSENT, memory_evidence: ABSENT });
    const report = await run(sc);
    assert.equal(report.steps.find((s) => s.step === "DELETED")!.outcome, "done");
    assert.equal(report.completed, true);
  });

  it("PUBLIC_REVOKED evicts the cached Compass projection and says how many", async () => {
    const state = baseState();
    const sc = makeClient(state, { memory_derivative_registry: ABSENT, memory_evidence: ABSENT });
    const report = await run(sc);
    const revoked = report.steps.find((s) => s.step === "PUBLIC_REVOKED")!;
    assert.equal(revoked.outcome, "done");
    assert.equal(state.compass_feed_cache.length, 0, "the owner's cached feed is gone");
    assert.equal((revoked.facts as any).invalidated >= 1, true);
  });

  it("every step carries an attempt count, so `0 revoked` can never read as success by omission", async () => {
    const report = await run(makeClient(baseState(), { memory_derivative_registry: ABSENT, memory_evidence: ABSENT }));
    for (const s of report.steps) {
      assert.equal(typeof s.attempts, "number");
      assert.ok(s.attempts >= 1, `${s.step} must record at least one attempt`);
    }
  });
});

// ── The wiring ───────────────────────────────────────────────────────────────

describe("DELETE /api/memories/:id runs the §21 lifecycle", () => {
  it("logs a five-step report from the route", async () => {
    const state = baseState("published");
    const logged: Array<{ obj: any; msg: string }> = [];
    _setTestClient(makeClient(state) as any, true);
    const app = express();
    app.use(express.json());
    app.use((req: any, _r: any, next: any) => {
      req.log = {
        error: (obj: any, msg: string) => logged.push({ obj, msg }),
        warn: (obj: any, msg: string) => logged.push({ obj, msg }),
        info: (obj: any, msg: string) => logged.push({ obj, msg }),
      };
      next();
    });
    app.use("/api", memoriesRouter);
    const srv = http.createServer(app);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const { port } = srv.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/memories/${MEM}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer owner-tok", connection: "close" },
      });
      assert.equal(res.status, 204);
      const line = logged.find((l) => /deletion lifecycle/i.test(l.msg));
      assert.ok(line, `expected a §21 lifecycle log line, saw: ${logged.map((l) => l.msg).join(" | ")}`);
      assert.deepEqual(line!.obj.report.steps.map((s: any) => s.step), [...MEMORY_DELETION_STEPS]);
      assert.equal(line!.obj.report.memoryId, MEM);
    } finally {
      srv.closeAllConnections();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
