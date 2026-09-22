/**
 * §21's third word — dead-lettering — over migration 2724 as DEPLOYED.
 *
 * SPEC: docs/specs/Portava_Highlights_Memories_Development_Architecture_Spec_v1.txt
 *   §21 (:566) "Deletion should be observable, retryable, and dead-lettered if
 *   a downstream cleanup repeatedly fails."
 * CENSUS: H192 (propagation), H193 ("TWO OF THREE … Dead-lettering does not
 *   [exist]: there is no table"). The table half of that reason is STALE —
 *   `2724_highlight_revocation_log` is applied to production at version
 *   20260915054107 — and the writer half was true until this lane.
 *
 * THE FAKE MODELS THE ONE CLIENT BEHAVIOUR THAT MATTERS: supabase-js RESOLVES
 * on a database error. It never throws, because a fake that threw would
 * exercise a catch block that does not exist in production and would let an
 * unbound `.error` pass.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/memoryRevocationDeadLetter.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DEAD_LETTER_CEILING,
  REVOCATION_LOG_DESTINATIONS,
  REVOCATION_LOG_TABLE,
  REVOCATION_OPERATIONS,
  classifyRevocationBacklog,
  readRevocationBacklog,
  recordRevocationAttempt,
  sweepRevocationDeadLetters,
  type RevocationLogRow,
} from "../lib/memoryRevocationDeadLetter.js";
import { REVOCATION_DESTINATIONS, HIGHLIGHT_LIFECYCLE_OPERATIONS } from "../services/highlights/highlightRevocation.js";

const SUBJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function logRow(over: Partial<RevocationLogRow> & { attempted_at: string; status: string }): RevocationLogRow {
  return {
    attempt_id: `a-${over.attempted_at}`,
    operation: "DELETE_HIGHLIGHT",
    subject_id: SUBJECT,
    destination: "cached_narrative",
    detail: "",
    ...over,
  } as RevocationLogRow;
}

interface FakeOpts {
  rows?: RevocationLogRow[];
  readError?: boolean;
  readNonArray?: boolean;
  insertError?: boolean;
  insertZeroRows?: boolean;
}

function makeFake(opts: FakeOpts = {}) {
  const inserted: any[][] = [];
  function builder(table: string) {
    let mode: "select" | "insert" = "select";
    let payload: any[] = [];
    const b: any = {
      select: () => b,
      order: () => b,
      limit: () => b,
      eq: () => b,
      insert: (rows: any) => { mode = "insert"; payload = Array.isArray(rows) ? rows : [rows]; return b; },
      then: (res: any, rej: any) => settle().then(res, rej),
    };
    async function settle() {
      if (table !== REVOCATION_LOG_TABLE) {
        return { data: null, error: { code: "42P01", message: `unexpected table ${table}` } };
      }
      if (mode === "insert") {
        if (opts.insertError) return { data: null, error: { message: "insert exploded" } };
        inserted.push(payload);
        if (opts.insertZeroRows) return { data: [], error: null };
        return { data: payload.map((_r, i) => ({ id: `r${i}` })), error: null };
      }
      if (opts.readError) return { data: null, error: { message: "log unreadable" } };
      if (opts.readNonArray) return { data: { nope: true }, error: null };
      return { data: opts.rows ?? [], error: null };
    }
    return b;
  }
  return { inserted, from: (t: string) => builder(t) } as any;
}

// ── 1. the vocabulary is 2724's, not an invented one ────────────────────────

describe("§21 the log's vocabulary is migration 2724's", () => {
  it("the eight destinations are §21's, in the spec's order, and match the Highlights service", () => {
    assert.deepEqual([...REVOCATION_LOG_DESTINATIONS], [...REVOCATION_DESTINATIONS]);
  });

  it("the six operations are the ones 2724's CHECK admits", () => {
    assert.deepEqual([...REVOCATION_OPERATIONS].sort(), [...HIGHLIGHT_LIFECYCLE_OPERATIONS].sort());
  });

  it("the table name is the deployed one", () => {
    assert.equal(REVOCATION_LOG_TABLE, "highlight_revocation_log");
  });
});

// ── 2. the writer ───────────────────────────────────────────────────────────

describe("§21 observable: an attempt is persisted, one row per destination", () => {
  const attempt = {
    attemptId: "attempt-1",
    operation: "DELETE_HIGHLIGHT" as const,
    subjectId: SUBJECT,
    actorId: null,
    outcomes: [
      { destination: "cached_narrative" as const, status: "revoked" as const, detail: "L1 evicted" },
      { destination: "search_index" as const, status: "not_applicable" as const, detail: "no index" },
    ],
  };

  it("writes one row per destination and confirms the count", async () => {
    const sc = makeFake();
    const r = await recordRevocationAttempt(sc, attempt);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.written, 2);
    assert.equal(sc.inserted[0].length, 2);
  });

  it("NEVER writes an undefined detail — 2724's detail is NOT NULL with a default", async () => {
    const sc = makeFake();
    await recordRevocationAttempt(sc, attempt);
    for (const row of sc.inserted[0]) assert.equal(typeof row.detail, "string");
  });

  it("a database error is a refusal, not a silent success", async () => {
    const r = await recordRevocationAttempt(makeFake({ insertError: true }), attempt);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "log_unavailable");
  });

  it("AN RLS-FILTERED INSERT — no error, no rows — is a refusal", async () => {
    // The exact shape an end-user token gets against this table, which 2724
    // grants no policy to on purpose. Reporting it as a written record would be
    // reporting a revocation nobody can find.
    const r = await recordRevocationAttempt(makeFake({ insertZeroRows: true }), attempt);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "log_write_unconfirmed");
  });

  it("an attempt that reached no destination is refused rather than recorded as clean", async () => {
    const r = await recordRevocationAttempt(makeFake(), { ...attempt, outcomes: [] });
    assert.equal(r.ok, false);
  });
});

// ── 3. the reader ───────────────────────────────────────────────────────────

describe("§28.11 an unreadable log is NEVER an empty backlog", () => {
  it("a database error is a refusal", async () => {
    const r = await readRevocationBacklog(makeFake({ readError: true }));
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.reason, "log_unavailable");
  });

  it("a non-array body is a refusal", async () => {
    const r = await readRevocationBacklog(makeFake({ readNonArray: true }));
    assert.equal(r.ok, false);
  });

  it("a genuinely empty log is ok with zero rows", async () => {
    const r = await readRevocationBacklog(makeFake({ rows: [] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.rows, []);
  });
});

// ── 4. the classifier ───────────────────────────────────────────────────────

describe("§21 dead-lettered: repeated failure is derived from the insert-only log", () => {
  it("a single failure is RETRY, not a dead letter", () => {
    const c = classifyRevocationBacklog([logRow({ attempted_at: "2026-06-01T00:00:00.000Z", status: "failed" })]);
    assert.equal(c.entries[0]?.state, "RETRY");
    assert.equal(c.deadLettered.length, 0);
  });

  it("failures at the ceiling are DEAD_LETTER", () => {
    const rows = Array.from({ length: DEFAULT_DEAD_LETTER_CEILING }, (_x, i) =>
      logRow({ attempted_at: `2026-06-0${i + 1}T00:00:00.000Z`, status: "failed" }));
    const c = classifyRevocationBacklog(rows);
    assert.equal(c.deadLettered.length, 1);
    assert.equal(c.deadLettered[0]?.consecutiveFailures, DEFAULT_DEAD_LETTER_CEILING);
  });

  it("A HEALED DESTINATION IS NOT A DEAD LETTER — failures are counted back from the newest and stop at the first success", () => {
    const rows = [
      ...Array.from({ length: 9 }, (_x, i) => logRow({ attempted_at: `2026-03-0${i + 1}T00:00:00.000Z`, status: "failed" })),
      logRow({ attempted_at: "2026-04-01T00:00:00.000Z", status: "revoked" }),
    ];
    const c = classifyRevocationBacklog(rows);
    assert.equal(c.entries[0]?.state, "RESOLVED");
    assert.equal(c.entries[0]?.consecutiveFailures, 0);
    assert.equal(c.deadLettered.length, 0);
  });

  it("a destination that succeeded and then began failing again is counted from the newest run only", () => {
    const rows = [
      logRow({ attempted_at: "2026-03-01T00:00:00.000Z", status: "failed" }),
      logRow({ attempted_at: "2026-03-02T00:00:00.000Z", status: "revoked" }),
      logRow({ attempted_at: "2026-03-03T00:00:00.000Z", status: "failed" }),
      logRow({ attempted_at: "2026-03-04T00:00:00.000Z", status: "failed" }),
    ];
    const c = classifyRevocationBacklog(rows, { ceiling: 3 });
    assert.equal(c.entries[0]?.consecutiveFailures, 2);
    assert.equal(c.entries[0]?.state, "RETRY");
  });

  it("not_implemented is UNREACHABLE: never retried, never dead-lettered, never counted as success", () => {
    const rows = Array.from({ length: 20 }, (_x, i) =>
      logRow({ attempted_at: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, status: "not_implemented" }));
    const c = classifyRevocationBacklog(rows, { ceiling: 2 });
    assert.equal(c.entries[0]?.state, "UNREACHABLE");
    assert.equal(c.retry.length, 0);
    assert.equal(c.deadLettered.length, 0);
    assert.equal(c.unreachable.length, 1);
  });

  it("not_applicable is its own state — a destination that does not exist did not fail", () => {
    const c = classifyRevocationBacklog([logRow({ attempted_at: "2026-06-01T00:00:00.000Z", status: "not_applicable" })]);
    assert.equal(c.entries[0]?.state, "NOT_APPLICABLE");
    assert.equal(c.retry.length, 0);
  });

  it("groups are (operation, subject, destination) — one subject's failure is not another's", () => {
    const rows = [
      logRow({ attempted_at: "2026-06-01T00:00:00.000Z", status: "failed" }),
      logRow({ attempted_at: "2026-06-02T00:00:00.000Z", status: "failed", subject_id: OTHER }),
      logRow({ attempted_at: "2026-06-03T00:00:00.000Z", status: "failed", destination: "share_link" }),
      logRow({ attempted_at: "2026-06-04T00:00:00.000Z", status: "failed", operation: "MAKE_PRIVATE" }),
    ];
    const c = classifyRevocationBacklog(rows, { ceiling: 2 });
    assert.equal(c.entries.length, 4);
    for (const e of c.entries) assert.equal(e.consecutiveFailures, 1);
  });

  it("a status the CHECK should have refused is reported, never dropped", () => {
    const c = classifyRevocationBacklog([logRow({ attempted_at: "2026-06-01T00:00:00.000Z", status: "weird" })]);
    assert.equal(c.entries.length, 1);
    assert.equal(c.entries[0]?.state, "UNREACHABLE");
    assert.equal(c.entries[0]?.latestStatus, "weird");
  });

  it("classification is deterministic under shuffled input", () => {
    const rows = [
      logRow({ attempted_at: "2026-06-01T00:00:00.000Z", status: "failed" }),
      logRow({ attempted_at: "2026-06-02T00:00:00.000Z", status: "failed", subject_id: OTHER }),
      logRow({ attempted_at: "2026-06-03T00:00:00.000Z", status: "revoked", destination: "share_link" }),
    ];
    assert.deepEqual(
      classifyRevocationBacklog(rows),
      classifyRevocationBacklog([...rows].reverse()),
    );
  });
});

// ── 5. the sweep ────────────────────────────────────────────────────────────

describe("§21 retryable: the sweep retries what can be retried and escalates what cannot", () => {
  const failing = (n: number, dest = "cached_narrative") =>
    Array.from({ length: n }, (_x, i) =>
      logRow({ attempted_at: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, status: "failed", destination: dest }));

  it("AN UNREADABLE LOG FAILS THE PASS — it is never reported as a clean sweep", async () => {
    const r = await sweepRevocationDeadLetters(makeFake({ readError: true }));
    assert.equal(r.ok, false);
    assert.equal(r.failureClass, "log_unavailable");
    assert.equal(r.inspected, 0);
  });

  it("an empty log is a clean, empty pass", async () => {
    const r = await sweepRevocationDeadLetters(makeFake({ rows: [] }));
    assert.equal(r.ok, true);
    assert.equal(r.inspected, 0);
    assert.equal(r.deadLettered, 0);
  });

  it("a retryable destination is re-attempted and the NEW outcome is written as a new attempt", async () => {
    const sc = makeFake({ rows: failing(2) });
    const r = await sweepRevocationDeadLetters(
      sc,
      { retryDestination: async () => ({ status: "revoked", detail: "reached on retry" }), newAttemptId: () => "retry-1" },
      { ceiling: 5 },
    );
    assert.equal(r.ok, true);
    assert.equal(r.retried, 1);
    assert.equal(r.retrySucceeded, 1);
    assert.equal(sc.inserted.length, 1);
    assert.equal(sc.inserted[0][0].attempt_id, "retry-1");
    assert.equal(sc.inserted[0][0].status, "revoked");
    assert.equal(sc.inserted[0][0].actor_id, null, "a sweep has no human actor and must not invent one");
  });

  it("A DEAD LETTER IS NOT RETRIED — it is escalated and returned", async () => {
    const sc = makeFake({ rows: failing(6) });
    let retries = 0;
    const warnings: string[] = [];
    const r = await sweepRevocationDeadLetters(
      sc,
      {
        retryDestination: async () => { retries += 1; return { status: "revoked", detail: "" }; },
        log: { warn: (_o, m) => warnings.push(m) },
      },
      { ceiling: 5 },
    );
    assert.equal(retries, 0, "a destination past the ceiling must stop being retried");
    assert.equal(r.deadLettered, 1);
    assert.equal(r.deadLetters[0]?.destination, "cached_narrative");
    assert.ok(warnings.some((m) => /dead letter/i.test(m)), "escalation means somebody is told");
  });

  it("a retry that THROWS is recorded as a failed attempt, not lost", async () => {
    const sc = makeFake({ rows: failing(1) });
    const r = await sweepRevocationDeadLetters(
      sc,
      { retryDestination: async () => { throw new Error("boom"); }, newAttemptId: () => "retry-2" },
      { ceiling: 5 },
    );
    assert.equal(r.retried, 1);
    assert.equal(r.retryFailed, 1);
    assert.equal(sc.inserted[0][0].status, "failed");
    assert.match(sc.inserted[0][0].detail, /retry threw/);
  });

  it("a retry whose RECORD could not be written counts as failed — an unrecorded revocation is not observable", async () => {
    const sc = makeFake({ rows: failing(1), insertZeroRows: true });
    const r = await sweepRevocationDeadLetters(
      sc,
      { retryDestination: async () => ({ status: "revoked", detail: "" }) },
      { ceiling: 5 },
    );
    assert.equal(r.retrySucceeded, 0);
    assert.equal(r.retryFailed, 1);
  });

  it("with no retry function injected nothing is retried, and the classification still reports", async () => {
    const r = await sweepRevocationDeadLetters(makeFake({ rows: failing(6) }), {}, { ceiling: 5 });
    assert.equal(r.retried, 0);
    assert.equal(r.deadLettered, 1);
    assert.equal(r.inspected, 1);
  });

  it("a read at its bound is reported as TRUNCATED — the numbers are a floor, not a total", async () => {
    const r = await sweepRevocationDeadLetters(makeFake({ rows: failing(3) }), {}, { limit: 3 });
    assert.equal(r.truncated, true);
  });
});
