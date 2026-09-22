/**
 * The Memory outbox CONSUMER — §17's "consumers must be idempotent".
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * src/test/memoryOutbox.test.ts proves the EMIT side: the vocabulary, the
 * atomicity of command-plus-event, and that no file writes the event tables
 * outside the kernel transaction. It proves nothing about the read side,
 * because until migration 2994 there was no read side: census H161 is
 * NOT-BUILT on "There are no consumers", and migration 2710's COMMENT ON TABLE
 * says so in the database.
 *
 * Every test below is about a way a consumer can be wrong that still looks
 * right in production:
 *
 *   1. AN UNREADABLE OUTBOX READING AS AN EMPTY ONE. supabase-js resolves on a
 *      database error, so an absent function, an RLS refusal and an outage all
 *      arrive as `data: null`. A consumer that treats that as "nothing to
 *      publish" reports a clean run forever while every projection goes stale.
 *   2. ACKING WHAT WAS NEVER DONE. An ack before the rebuild drops events on a
 *      crash; an ack whose returned count is ignored can mark nothing and be
 *      believed.
 *   3. RETRYING WHAT CANNOT SUCCEED. A hard-deleted Memory, an unsubscribed
 *      event type and a NOT_CONFIGURED projection are all permanent answers. A
 *      consumer that classes them as failures burns the row's attempts until it
 *      is poisoned — a correct event discarded because part of the system is
 *      honestly unbuilt.
 *   4. A PROJECTION WITH NO SUBSCRIBER. §17's event set can grow; a map that is
 *      not total lets a new event arrive with nothing listening.
 *
 * FAKE, NOT MOCK, AND THE FAKE IS THE POINT. A previous lane found three of ten
 * mutations survived because the test fake could not express the failure. The
 * client fake below therefore reproduces the two supabase-js behaviours that
 * actually cause bugs here — it RESOLVES on an error rather than rejecting, and
 * it returns `data: null` alongside that error — so a consumer that unbinds
 * `error` goes red instead of green. `fakeDbError` is what makes mutation 2
 * (below) fail.
 *
 * Offline and pure: no database, no network, no clock dependence.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  claimOutboxBatch,
  ackOutboxRows,
  failOutboxRow,
  readProjectionScope,
  drainMemoryOutbox,
  EVENT_PROJECTIONS,
  SUBSCRIBED_EVENT_TYPES,
  OUTBOX_CLAIM_FN,
  OUTBOX_ACK_FN,
  OUTBOX_FAIL_FN,
  type ClaimedOutboxRow,
} from "../services/memoryProjections/outboxConsumer.js";
import { MEMORY_DOMAIN_EVENT_TYPES } from "../lib/memoryOutbox.js";

// ── the fake ─────────────────────────────────────────────────────────────────

interface RpcCall { fn: string; args: any }

/** supabase-js RESOLVES on a database error. Reproduced exactly. */
function fakeDbError(message: string) {
  return { data: null, error: { message } };
}

interface FakeOpts {
  /** Rows memory_outbox_claim returns, or a non-array / error body. */
  claim?: ClaimedOutboxRow[] | "error" | "non_array";
  /** What memory_outbox_ack returns. Default: the number of ids asked for. */
  ack?: number | "error" | "not_a_number";
  /** memories rows by id. Absent id ⇒ no row (a hard-deleted Memory). */
  memories?: Record<string, { owner_id: string; trip_id?: string | null; place_id?: string | null }>;
  /** Make the memories read fail outright. */
  memoriesError?: boolean;
}

/**
 * A table-backed supabase fake.
 *
 * THE FIRST VERSION OF THIS FAKE WAS WRONG AND THE SUITE CAUGHT IT. It stubbed
 * `from()` with a builder whose only terminal was `maybeSingle()`, which is
 * enough for the consumer's own scope read and NOT enough for the rebuild the
 * consumer then performs: `readProjectionSources` awaits the builder DIRECTLY
 * (`await client.from("memories").select(...).eq(...)`), and `rebuildProjection`
 * needs `.in()` and `.upsert().select()`. Every rebuild therefore failed, every
 * event was classed as failed, nothing was ever acked — and two tests that
 * assert on ACK BEHAVIOUR went red for a reason that had nothing to do with the
 * behaviour they were written for.
 *
 * That is the failure mode worth naming: a fake too weak to reach the code
 * under test does not report "unsupported", it reports whatever the production
 * code does when a read returns undefined. Had those two assertions been
 * looser, this fake would have produced a green suite in which the consumer
 * never once acked anything. The fake is therefore a real, if tiny, database:
 * a row store, filters, and builders that resolve the way supabase-js resolves.
 */
function makeFake(opts: FakeOpts = {}) {
  const rpcCalls: RpcCall[] = [];
  const memoriesById = opts.memories ?? {};

  // The row store. `memories` is derived from the test's declaration so a test
  // states its world once.
  const tables: Record<string, any[]> = {
    memories: Object.entries(memoriesById).map(([id, m]) => ({
      id,
      owner_id: m.owner_id,
      trip_id: m.trip_id ?? null,
      place_id: m.place_id ?? null,
      title: null, caption: null, visibility: "private", state: "published",
      starts_at: "2026-01-01T00:00:00.000Z", ends_at: null,
      event_id: null, location_city: null, location_country: null,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z",
      allowed_user_ids: [], hidden_user_ids: [],
    })),
    memory_items: [],
    memory_tags: [],
    memory_derivative_registry: [],
  };

  function makeBuilder(table: string) {
    const filters: Array<(r: any) => boolean> = [];
    let pending: any[] | null = null;   // rows an upsert is returning

    const rows = () => {
      if (pending !== null) return pending;
      return (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
    };

    const settle = () => {
      // supabase-js RESOLVES on a database error and binds data to null.
      if (table === "memories" && opts.memoriesError) {
        return Promise.resolve(fakeDbError("memories unreadable"));
      }
      return Promise.resolve({ data: rows(), error: null });
    };

    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
      in: (c: string, vs: any[]) => { filters.push((r) => vs.includes(r[c])); return b; },
      is: (c: string, v: any) => { filters.push((r) => r[c] === v); return b; },
      order: () => b,
      limit: () => b,
      maybeSingle: async () => {
        const settled = await settle();
        if (settled.error) return settled;
        const list = settled.data as any[];
        return { data: list.length > 0 ? list[0] : null, error: null };
      },
      upsert: (rowOrRows: any) => {
        const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
        const store = tables[table] ?? (tables[table] = []);
        for (const r of incoming) {
          // The registry's real conflict target.
          const i = store.findIndex(
            (e) => e.projection_id === r.projection_id && e.scope_key === r.scope_key,
          );
          if (i >= 0) store[i] = { ...r, id: store[i].id };
          else store.push({ ...r, id: `reg-${store.length + 1}` });
        }
        pending = incoming.map((r, i) => ({ ...r, id: `reg-${i + 1}` }));
        return b;
      },
      // Awaiting the builder itself is how readProjectionSources reads.
      then: (res: any, rej: any) => settle().then(res, rej),
    };
    return b;
  }

  const client: any = {
    rpcCalls,
    tables,
    rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args });
      if (fn === OUTBOX_CLAIM_FN) {
        if (opts.claim === "error") return Promise.resolve(fakeDbError("claim exploded"));
        if (opts.claim === "non_array") return Promise.resolve({ data: { nope: true }, error: null });
        return Promise.resolve({ data: opts.claim ?? [], error: null });
      }
      if (fn === OUTBOX_ACK_FN) {
        if (opts.ack === "error") return Promise.resolve(fakeDbError("ack exploded"));
        if (opts.ack === "not_a_number") return Promise.resolve({ data: "two", error: null });
        const asked = Array.isArray(args?.p_ids) ? args.p_ids.length : 0;
        return Promise.resolve({ data: typeof opts.ack === "number" ? opts.ack : asked, error: null });
      }
      if (fn === OUTBOX_FAIL_FN) return Promise.resolve({ data: 1, error: null });
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
    from: (table: string) => makeBuilder(table),
  };
  return client;
}

function row(over: Partial<ClaimedOutboxRow> = {}): ClaimedOutboxRow {
  return {
    id: 1,
    event_id: "e1",
    memory_id: "m1",
    type: "memory.created",
    created_at: "2026-01-01T00:00:00.000Z",
    attempts: 1,
    locked_until: "2026-01-01T00:05:00.000Z",
    ...over,
  };
}

// ── 1. the event -> projection map is TOTAL ─────────────────────────────────

describe("§17 every Memory domain event has a subscriber", () => {
  it("the map covers all eight memory.* events, exactly", () => {
    const mapped = Object.keys(EVENT_PROJECTIONS).sort();
    const expected = [...MEMORY_DOMAIN_EVENT_TYPES].sort();
    assert.deepEqual(mapped, expected,
      "an event with no subscriber is a projection that silently never fires");
  });

  it("SUBSCRIBED_EVENT_TYPES is the memory.* subset and nothing else", () => {
    assert.ok(SUBSCRIBED_EVENT_TYPES.length > 0);
    for (const t of SUBSCRIBED_EVENT_TYPES) {
      assert.ok(t.startsWith("memory."), `${t} is not a memory-domain event`);
    }
  });

  it("no event maps to a NOT_CONFIGURED projection", () => {
    // SearchEmbedding and NarrativeDerivative refuse by design. Subscribing an
    // event to one would make every delivery report a failure that no operator
    // can fix.
    for (const [event, ids] of Object.entries(EVENT_PROJECTIONS)) {
      for (const id of ids) {
        assert.ok(id !== "SearchEmbedding" && id !== "NarrativeDerivative",
          `${event} subscribes to ${id}, which is NOT_CONFIGURED`);
      }
    }
  });
});

// ── 2. an unreadable outbox is never an empty one ───────────────────────────

describe("§28.11 an unreadable outbox is NEVER 'nothing to publish'", () => {
  it("a database error on claim is a refusal, not an empty batch", async () => {
    const r = await claimOutboxBatch(makeFake({ claim: "error" }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "claim_unavailable");
  });

  it("a non-array body is a refusal, not an empty batch", async () => {
    const r = await claimOutboxBatch(makeFake({ claim: "non_array" }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "claim_unavailable");
  });

  it("a genuinely empty outbox is ok with zero rows", async () => {
    const r = await claimOutboxBatch(makeFake({ claim: [] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok === true && r.rows, []);
  });

  it("a failed claim makes the whole DRAIN report failure, not success-with-zero", async () => {
    const d = await drainMemoryOutbox(makeFake({ claim: "error" }));
    assert.equal(d.ok, false, "a pass that could not read must not report ok");
    assert.equal(d.failureClass, "claim_unavailable");
    assert.equal(d.claimed, 0);
  });
});

// ── 3. the ack ───────────────────────────────────────────────────────────────

describe("§17 acking", () => {
  it("an empty id list does not call the database at all", async () => {
    const c = makeFake();
    const r = await ackOutboxRows(c, []);
    assert.equal(r.ok, true);
    assert.equal(r.ok === true && r.acked, 0);
    assert.equal(c.rpcCalls.filter((k: RpcCall) => k.fn === OUTBOX_ACK_FN).length, 0);
  });

  it("a database error on ack is a refusal", async () => {
    const r = await ackOutboxRows(makeFake({ ack: "error" }), [1, 2]);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "ack_unavailable");
  });

  it("a non-numeric ack body is a refusal — a count that is not a count", async () => {
    const r = await ackOutboxRows(makeFake({ ack: "not_a_number" }), [1]);
    assert.equal(r.ok, false);
  });

  it("AN ACK SHORT OF THE BATCH FAILS THE PASS — it must never be averaged away", async () => {
    // The regression: ack two, database marks one, consumer reports a clean
    // drain. The missing row is re-claimed and re-rebuilt on every pass forever
    // while the pass keeps saying ok.
    const c = makeFake({
      claim: [row({ id: 1, memory_id: "m1" }), row({ id: 2, event_id: "e2", memory_id: "m2" })],
      ack: 1,
      memories: { m1: { owner_id: "u1" }, m2: { owner_id: "u1" } },
    });
    const d = await drainMemoryOutbox(c);
    assert.equal(d.ok, false, "acking fewer rows than were completed is a failed pass");
    assert.equal(d.failureClass, "ack_incomplete");
    assert.equal(d.acked, 1);
  });
});

// ── 4. ORDER: rebuild before ack ────────────────────────────────────────────

describe("§17 at-least-once: the rebuild happens BEFORE the ack", () => {
  it("the memories read precedes the ack rpc", async () => {
    // Acking first would silently DROP an event on a crash, which is exactly
    // the loss the outbox pattern exists to prevent. Order is asserted rather
    // than assumed because both orders produce a green 'it drained' otherwise.
    const c = makeFake({
      claim: [row({ id: 7, memory_id: "m1" })],
      memories: { m1: { owner_id: "u1" } },
    });
    const seen: string[] = [];
    const origFrom = c.from.bind(c);
    c.from = (t: string) => { seen.push(`from:${t}`); return origFrom(t); };
    const origRpc = c.rpc.bind(c);
    c.rpc = (fn: string, args: any) => { seen.push(`rpc:${fn}`); return origRpc(fn, args); };

    await drainMemoryOutbox(c);

    const memIdx = seen.indexOf("from:memories");
    const ackIdx = seen.indexOf(`rpc:${OUTBOX_ACK_FN}`);
    assert.ok(memIdx >= 0, "the consumer must read the Memory it is projecting");
    assert.ok(ackIdx >= 0, "the consumer must ack");
    assert.ok(memIdx < ackIdx, "the ack must come AFTER the work, never before");
  });

  it("the claim comes first of all", async () => {
    const c = makeFake({ claim: [], memories: {} });
    await drainMemoryOutbox(c);
    assert.equal(c.rpcCalls[0]?.fn, OUTBOX_CLAIM_FN);
  });
});

// ── 5. permanent answers are ACKED, not retried forever ─────────────────────

describe("a permanent answer is acked, never retried until poisoned", () => {
  it("a HARD-DELETED Memory is acked, not failed", async () => {
    // memory_event_outbox.memory_id is deliberately not a foreign key, so an
    // event outlives its Memory. Failing it would burn attempts until the row
    // was poisoned and then sit in the backlog forever.
    const c = makeFake({ claim: [row({ id: 3, memory_id: "gone" })], memories: {} });
    const d = await drainMemoryOutbox(c);
    assert.equal(d.ok, true);
    assert.equal(d.acked, 1, "nothing left to project ⇒ ack");
    assert.equal(d.failed, 0);
    assert.equal(d.outcomes[0]?.failureClass, "memory_absent");
    assert.equal(c.rpcCalls.filter((k: RpcCall) => k.fn === OUTBOX_FAIL_FN).length, 0);
  });

  it("an UNSUBSCRIBED event type is acked with its class recorded", async () => {
    const c = makeFake({
      claim: [row({ id: 4, type: "highlight.created", memory_id: "m1" })],
      memories: { m1: { owner_id: "u1" } },
    });
    const d = await drainMemoryOutbox(c);
    assert.equal(d.ok, true);
    assert.equal(d.acked, 1);
    assert.equal(d.outcomes[0]?.failureClass, "unsubscribed_event_type");
  });

  it("AN UNREADABLE memories table is NOT permanent — it fails and is retried", async () => {
    // The distinction this pair exists for: 'the row is gone' and 'the table
    // would not answer' arrive at the same call site as a falsy row. Treating
    // an outage as a deletion would ACK an event whose projections were never
    // rebuilt — a silent, permanent loss.
    const c = makeFake({ claim: [row({ id: 5, memory_id: "m1" })], memoriesError: true });
    const d = await drainMemoryOutbox(c);
    assert.equal(d.acked, 0, "an outage must never be acked");
    assert.equal(d.failed, 1);
    assert.equal(d.outcomes[0]?.failureClass, "memory_unavailable");
    assert.equal(c.rpcCalls.filter((k: RpcCall) => k.fn === OUTBOX_FAIL_FN).length, 1);
  });
});

// ── 6. idempotency ───────────────────────────────────────────────────────────

describe("§17 consumers must be idempotent", () => {
  it("draining the SAME event twice produces the same outcome both times", async () => {
    const mk = () => makeFake({
      claim: [row({ id: 9, memory_id: "m1" })],
      memories: { m1: { owner_id: "u1", trip_id: "t1" } },
    });
    const first = await drainMemoryOutbox(mk());
    const second = await drainMemoryOutbox(mk());
    assert.deepEqual(
      { ok: first.ok, acked: first.acked, failed: first.failed },
      { ok: second.ok, acked: second.acked, failed: second.failed },
      "a redelivered event must reach the same answer",
    );
  });

  it("the claim always asks for a lease and a max-attempts bound", async () => {
    // Without a lease two workers process one event; without a bound a poison
    // row is redelivered forever and blocks nothing but wastes every pass.
    const c = makeFake({ claim: [] });
    await drainMemoryOutbox(c);
    const claim = c.rpcCalls.find((k: RpcCall) => k.fn === OUTBOX_CLAIM_FN);
    assert.ok(claim, "the drain must claim");
    assert.equal(typeof claim.args.p_lease_seconds, "number");
    assert.ok(claim.args.p_lease_seconds > 0, "a zero lease is no lease");
    assert.equal(typeof claim.args.p_max_attempts, "number");
    assert.ok(claim.args.p_max_attempts > 0);
  });
});

// ── 7. the scope read is privacy-filtered (§23) ─────────────────────────────

describe("§23 the consumer reads ids, never the Memory body", () => {
  it("the scope read selects only scope keys", async () => {
    const selected: string[] = [];
    const c: any = {
      from: (_t: string) => {
        const b: any = {
          select: (cols: string) => { selected.push(cols); return b; },
          eq: () => b,
          maybeSingle: () => Promise.resolve({ data: { id: "m1", owner_id: "u1" }, error: null }),
        };
        return b;
      },
    };
    await readProjectionScope(c, "m1");
    assert.equal(selected.length, 1);
    for (const forbidden of ["title", "caption", "location_lat", "location_lng",
                             "allowed_user_ids", "hidden_user_ids", "media_url"]) {
      assert.ok(!selected[0]!.includes(forbidden),
        `the scope read must not select ${forbidden} — §23 says a consumer reads ids`);
    }
  });

  it("a missing owner_id is 'absent', not a scope with an undefined owner", async () => {
    const r = await readProjectionScope(makeFake({ memories: {} }), "nope");
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "memory_absent");
  });
});

// ── 8. the TS <-> SQL contract ──────────────────────────────────────────────

describe("the RPC contract matches migration 2994's signatures", () => {
  /**
   * The seam nothing else covers. Both halves can be individually correct and
   * still not meet: PostgREST dispatches a function call by ARGUMENT NAME, so
   * `p_id` where the function wants `p_ids` is not a type error, not a runtime
   * exception in the client, and not a rejected promise — it is a resolved
   * response carrying a "function does not exist" error, which is exactly the
   * shape this consumer treats as an outage. It would retry forever.
   *
   * Verified against the real functions on 2026-09-22, by applying 2994 to a
   * from-scratch replay of the canonical chain (scripts/local-db) and reading
   * pg_proc:
   *
   *   memory_outbox_ack(p_ids bigint[])
   *   memory_outbox_claim(p_limit integer DEFAULT 100,
   *                       p_lease_seconds integer DEFAULT 300,
   *                       p_max_attempts integer DEFAULT 5)
   *   memory_outbox_fail(p_id bigint, p_class text)
   *
   * These assertions are that reading, frozen. They cannot prove the deployed
   * function still matches — only a live-DB test does that, and the five
   * live-DB checks do not run in this environment — but they DO fail the moment
   * either side is renamed in the repository.
   */
  it("the function names are 2994's", () => {
    assert.equal(OUTBOX_CLAIM_FN, "memory_outbox_claim");
    assert.equal(OUTBOX_ACK_FN, "memory_outbox_ack");
    assert.equal(OUTBOX_FAIL_FN, "memory_outbox_fail");
  });

  it("claim sends exactly p_limit, p_lease_seconds, p_max_attempts", async () => {
    const c = makeFake({ claim: [] });
    await claimOutboxBatch(c);
    const args = c.rpcCalls.find((k: RpcCall) => k.fn === OUTBOX_CLAIM_FN).args;
    assert.deepEqual(Object.keys(args).sort(),
      ["p_lease_seconds", "p_limit", "p_max_attempts"]);
  });

  it("ack sends exactly p_ids, as an ARRAY", async () => {
    const c = makeFake();
    await ackOutboxRows(c, [1, 2]);
    const args = c.rpcCalls.find((k: RpcCall) => k.fn === OUTBOX_ACK_FN).args;
    assert.deepEqual(Object.keys(args), ["p_ids"]);
    assert.ok(Array.isArray(args.p_ids), "p_ids is bigint[] — a bare id would not dispatch");
  });

  it("fail sends exactly p_id and p_class", async () => {
    const c = makeFake();
    await failOutboxRow(c, 1, "x");
    const args = c.rpcCalls.find((k: RpcCall) => k.fn === OUTBOX_FAIL_FN).args;
    assert.deepEqual(Object.keys(args).sort(), ["p_class", "p_id"]);
  });

  it("every claimed-row field the consumer READS survives into its outcome", async () => {
    // An earlier version of this test asserted `Object.keys(row())`, which
    // checked the TEST FIXTURE and not the code: dropping a field from the
    // production interface left it green. Mutation caught that. The fields
    // that matter are the ones the consumer actually consumes, so those are
    // what is asserted, end to end, from claimed row to reported outcome.
    //
    // `created_at` is the one with teeth: it feeds projection_lag through
    // `Date.parse`, and a column the function stopped returning would arrive as
    // undefined, parse to NaN, and silently report every lag as zero rather
    // than failing.
    const c = makeFake({
      claim: [row({ id: 42, event_id: "ev-42", memory_id: "m1", type: "memory.confirmed" })],
      memories: { m1: { owner_id: "u1" } },
    });
    const d = await drainMemoryOutbox(c);
    const o = d.outcomes[0]!;
    assert.equal(o.id, 42);
    assert.equal(o.eventId, "ev-42");
    assert.equal(o.memoryId, "m1");
    assert.equal(o.eventType, "memory.confirmed");
  });

  it("created_at reaches the lag sample as a parseable instant", async () => {
    const samples: any[] = [];
    const c = makeFake({
      claim: [row({ id: 1, memory_id: "m1", created_at: "2026-01-01T00:00:00.000Z" })],
      memories: { m1: { owner_id: "u1" } },
    });
    await drainMemoryOutbox(c, { logger: { info: (o: any) => samples.push(o) } });
    assert.equal(samples.length, 1, "one event ⇒ one projection_lag sample");
    assert.equal(samples[0].metric, "projection_lag");
    assert.ok(Number.isFinite(samples[0].lagMs), "an unparseable created_at would make this NaN");
  });
});

// ── 9. failOutboxRow ────────────────────────────────────────────────────────

describe("failure classes", () => {
  it("failOutboxRow passes a CLASS, not a message body", async () => {
    const c = makeFake();
    await failOutboxRow(c, 11, "registry_unavailable");
    const call = c.rpcCalls.find((k: RpcCall) => k.fn === OUTBOX_FAIL_FN);
    assert.equal(call.args.p_id, 11);
    assert.equal(call.args.p_class, "registry_unavailable");
  });

  it("a failing fail is reported rather than thrown", async () => {
    const c: any = { rpc: () => Promise.resolve(fakeDbError("nope")) };
    const r = await failOutboxRow(c, 1, "x");
    assert.equal(r.ok, false);
  });
});
