/**
 * census-layover L31, L92, L194, L263 — the external event envelope gets an
 * ingest and a consumer, and neither weakens the guarantee the envelope exists
 * for.
 *
 * ── WHAT THE ROWS SAY TODAY AND WHAT IS ACTUALLY TRUE ────────────────────────
 * L92's last parseable verdict is "No ingest; `layover_events` has no unique
 * key at all." Both halves need separating. "No ingest" was true. The second
 * half is about the WRONG TABLE: `layover_events` is the in-app audit trail and
 * migration 2860 argues at length that it is deliberately not the place for an
 * external event, because its `user_id` is NOT NULL and an external event has
 * no user. The table that holds the envelope is `layover_external_events`, it
 * has a UNIQUE index on `dedup_key`, and it is APPLIED to production — listed
 * in production-applied-migrations.json with all twelve columns present in the
 * capture named by lib/capability/snapshots/current.ts.
 *
 * So the gap was code, not schema, and this suite is the evidence for the code.
 *
 * ── WHAT THIS SUITE PROVES ───────────────────────────────────────────────────
 *   1. a valid envelope is PERSISTED with every member of §11's ten, and the
 *      stored row round-trips back into the same envelope;
 *   2. the dedup key is the SPEC's, not an invention — `source:sourceEventId`
 *      when the producer supplies one;
 *   3. a producer minting a fresh eventId per delivery still collapses, because
 *      eventId is deliberately not in the key — the failure §24 names;
 *   4. two genuinely different facts do NOT collapse;
 *   5. a duplicate is a SUCCESS that writes nothing and re-plans nothing, and
 *      the two uniqueness constraints are reported apart;
 *   6. a 23505 whose constraint name is unavailable is reported `unattributed`
 *      rather than guessed into one of the two;
 *   7. the pending read REFUSES on error instead of reporting an empty queue;
 *   8. the claim is a compare-and-swap: a second worker gets `claimed: false`;
 *   9. a replan that fails after the claim is REPORTED, not silently retried
 *      and not silently dropped;
 *  10. a replanner that THROWS does not abort the pass for the events behind it.
 *
 * ── WHAT THIS SUITE DOES NOT PROVE, STATED BECAUSE IT MATTERS ────────────────
 * `fakeLayoverDb` DOES NOT MODEL UNIQUE INDEXES. Its own header says so: "A
 * duplicate insert appends a second row instead of resolving 23505 ... this
 * double cannot DISCOVER the collision." Cases 5 and 6 therefore STAGE the
 * 23505 rather than provoking it. That makes them evidence that this code
 * HANDLES a unique violation correctly; it is not evidence that the index
 * exists or fires.
 *
 * The index itself is proven separately, against a real PostgreSQL, in
 * src/test/db/layoverExternalEventsDedup.db.test.ts.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/services/layover/__tests__/layoverExternalEventIngest.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeLayoverDb } from "../../../test/helpers/fakeLayoverDb.js";
import {
  claimExternalEvent,
  ingestExternalEvent,
  readPendingExternalEvents,
  rowToEnvelope,
} from "../LayoverExternalEventService.js";
import {
  drainPendingExternalEvents,
  type ReplanPort,
} from "../layoverExternalEventConsumer.js";
import type { LayoverEventEnvelope } from "../../airport/LayoverEventReplanner.js";

/**
 * A fixed instant. Every `occurredAt` below is derived from it by subtraction,
 * so nothing here is judged against the wall clock — the class of test bomb
 * this repository has already had detonate three times.
 */
const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const MIN = 60_000;

function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "evt-1",
    eventType: "flight.arrival_delayed",
    occurredAt: new Date(NOW - 5 * MIN).toISOString(),
    source: "acme-flight-feed",
    sourceEventId: "acme-99",
    subjectRefs: [{ kind: "flight", ref: "BA0117" }],
    payload: { delayMinutes: 25 },
    confidence: "HIGH",
    ...over,
  };
}

function db(
  rows: Record<string, unknown>[] = [],
  failures: Record<string, { message: string; code?: string }> = {},
) {
  const tables: Record<string, any[]> = { layover_external_events: rows };
  return { tables, client: makeLayoverDb(tables, { failures }) as any };
}

describe("L92/L31 — ingest normalises and persists the full ten-member envelope", () => {
  it("stores every member, and the stored row rebuilds into the same envelope", async () => {
    const { tables, client } = db();
    const res = await ingestExternalEvent(client, raw(), NOW);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.duplicate, false);

    assert.equal(tables.layover_external_events.length, 1, "the event must reach the store");
    const row = tables.layover_external_events[0];

    // Every column 2860 defines, named. An envelope missing one member is not a
    // slightly worse envelope; it is the shape §24 cannot be built on.
    assert.equal(row.event_id, "evt-1");
    assert.equal(row.event_type, "flight.arrival_delayed");
    assert.equal(row.occurred_at, new Date(NOW - 5 * MIN).toISOString());
    assert.equal(row.received_at, new Date(NOW).toISOString());
    assert.equal(row.source, "acme-flight-feed");
    assert.equal(row.source_event_id, "acme-99");
    assert.deepEqual(row.subject_refs, [{ kind: "flight", ref: "BA0117" }]);
    assert.deepEqual(row.payload, { delayMinutes: 25 });
    assert.equal(row.dedup_key, "acme-flight-feed:acme-99");
    assert.equal(row.confidence, "HIGH");

    // `processed_at` is the CONSUMER's column and the ingest must not set it,
    // not even to null: an ingest that wrote it could also un-process a row.
    assert.equal("processed_at" in row, false, "ingest must not name processed_at");

    const rebuilt = rowToEnvelope(row as any);
    assert.ok(rebuilt, "a row this code wrote must rebuild into an envelope");
    assert.deepEqual(rebuilt, res.ok ? res.event : null);
  });

  it("a refused envelope is named, and nothing is written", async () => {
    const { tables, client } = db();
    // Future-dated: a clock fault or a forgery, and admitting it lets a producer
    // pre-empt every later real event.
    const res = await ingestExternalEvent(client, raw({ occurredAt: new Date(NOW + MIN).toISOString() }), NOW);
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.kind, "rejected");
    assert.equal(!res.ok && res.kind === "rejected" && res.reason, "occurred_in_future");
    assert.equal(tables.layover_external_events.length, 0, "a refused event must not be stored");
  });

  it("a twelfth event type cannot be introduced by writing one", async () => {
    const { tables, client } = db();
    const res = await ingestExternalEvent(client, raw({ eventType: "flight.diverted" }), NOW);
    assert.equal(!res.ok && res.kind === "rejected" && res.reason, "unknown_event_type");
    assert.equal(tables.layover_external_events.length, 0);
  });
});

describe("L263/§24 — the dedup key is the spec's, and eventId is not in it", () => {
  it("the stable source key is `source:sourceEventId`", async () => {
    const { tables, client } = db();
    await ingestExternalEvent(client, raw(), NOW);
    assert.equal(tables.layover_external_events[0].dedup_key, "acme-flight-feed:acme-99");
  });

  it("a producer minting a fresh eventId per delivery still collapses", async () => {
    const { client } = db();
    const a = await ingestExternalEvent(client, raw({ eventId: "delivery-a" }), NOW);
    const b = await ingestExternalEvent(client, raw({ eventId: "delivery-b" }), NOW);
    assert.ok(a.ok && b.ok);
    // THE POINT. Two different delivery ids, ONE dedup key — so the UNIQUE index
    // refuses the second. Were eventId part of the key, a producer that re-mints
    // per delivery would defeat deduplication entirely, which is the failure §24
    // names by name.
    assert.equal(
      a.ok && b.ok && a.event.dedupKey === b.event.dedupKey,
      true,
      "eventId must not participate in the dedup key",
    );
  });

  it("with no sourceEventId, the key is a content digest — same fact collapses", async () => {
    const { client } = db();
    const a = await ingestExternalEvent(client, raw({ eventId: "x1", sourceEventId: undefined }), NOW);
    const b = await ingestExternalEvent(client, raw({ eventId: "x2", sourceEventId: undefined }), NOW);
    assert.ok(a.ok && b.ok);
    assert.equal(a.ok && a.event.dedupKey.startsWith("sha256:"), true);
    assert.equal(a.ok && b.ok && a.event.dedupKey === b.event.dedupKey, true);
  });

  it("two genuinely different facts do NOT collapse", async () => {
    const { client } = db();
    const a = await ingestExternalEvent(client, raw({ eventId: "y1", sourceEventId: undefined }), NOW);
    const b = await ingestExternalEvent(
      client,
      raw({ eventId: "y2", sourceEventId: undefined, payload: { delayMinutes: 40 } }),
      NOW,
    );
    assert.ok(a.ok && b.ok);
    assert.notEqual(a.ok && a.event.dedupKey, b.ok ? b.event.dedupKey : null);
  });

  it("subject order does not change the content key", async () => {
    const { client } = db();
    const refs = [{ kind: "flight", ref: "BA0117" }, { kind: "airport", ref: "LHR" }];
    const a = await ingestExternalEvent(client, raw({ eventId: "z1", sourceEventId: undefined, subjectRefs: refs }), NOW);
    const b = await ingestExternalEvent(
      client,
      raw({ eventId: "z2", sourceEventId: undefined, subjectRefs: [...refs].reverse() }),
      NOW,
    );
    assert.ok(a.ok && b.ok);
    assert.equal(a.ok && b.ok && a.event.dedupKey === b.event.dedupKey, true);
  });
});

describe("L263 — a duplicate is a success that changes nothing", () => {
  // STAGED, not discovered: fakeLayoverDb has no unique indexes. See the header.
  it("a dedup-key collision reports `same_fact` and is ok:true", async () => {
    const { client } = db([], {
      "layover_external_events:insert": {
        code: "23505",
        message: 'duplicate key value violates unique constraint "layover_external_events_dedup_uidx"',
      },
    });
    const res = await ingestExternalEvent(client, raw(), NOW);
    assert.equal(res.ok, true, "a duplicate is not an error — a producer told 409 retries");
    assert.equal(res.ok && res.duplicate, true);
    assert.equal(res.ok && res.duplicateKind, "same_fact");
  });

  it("a primary-key collision reports `same_delivery`", async () => {
    const { client } = db([], {
      "layover_external_events:insert": {
        code: "23505",
        message: 'duplicate key value violates unique constraint "layover_external_events_pkey"',
      },
    });
    const res = await ingestExternalEvent(client, raw(), NOW);
    assert.equal(res.ok && res.duplicateKind, "same_delivery");
  });

  it("a 23505 naming no constraint is `unattributed`, never guessed", async () => {
    const { client } = db([], {
      "layover_external_events:insert": { code: "23505", message: "duplicate key value" },
    });
    const res = await ingestExternalEvent(client, raw(), NOW);
    assert.equal(res.ok && res.duplicate, true);
    assert.equal(
      res.ok && res.duplicateKind,
      "unattributed",
      "attributing an unnamed collision would mis-report a producer bug",
    );
  });

  it("a non-23505 write failure is a failure, not a duplicate", async () => {
    const { client } = db([], {
      "layover_external_events:insert": { code: "08006", message: "connection failure" },
    });
    const res = await ingestExternalEvent(client, raw(), NOW);
    assert.equal(res.ok, false);
    assert.equal(!res.ok && res.kind, "write_failed");
  });
});

describe("L194/L198 — the pending read and the claim", () => {
  function storedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      event_id: "evt-1",
      event_type: "flight.arrival_delayed",
      occurred_at: new Date(NOW - 5 * MIN).toISOString(),
      received_at: new Date(NOW - 4 * MIN).toISOString(),
      source: "acme-flight-feed",
      source_event_id: "acme-99",
      subject_refs: [{ kind: "flight", ref: "BA0117" }],
      payload: { delayMinutes: 25 },
      dedup_key: "acme-flight-feed:acme-99",
      confidence: "HIGH",
      processed_at: null,
      ...over,
    };
  }

  it("a failed read REFUSES rather than reporting an empty queue", async () => {
    const { client } = db([storedRow()], {
      "layover_external_events:select": { message: "relation unavailable" },
    });
    const read = await readPendingExternalEvents(client, 10);
    assert.equal(read.ok, false, "an unreadable queue and an empty queue are opposite facts");
    assert.equal(!read.ok && read.reason, "read_failed");
  });

  it("processed rows are excluded and unreadable rows are counted, not dropped silently", async () => {
    const { client } = db([
      storedRow({ event_id: "done", processed_at: new Date(NOW).toISOString() }),
      storedRow({ event_id: "good" }),
      // A vocabulary that moved in code without a migration. Not coerced into a
      // valid envelope: the stored row is evidence, and inventing a band for it
      // would make a safety input up.
      storedRow({ event_id: "bad-type", event_type: "flight.diverted" }),
      storedRow({ event_id: "bad-conf", confidence: "PROBABLY" }),
    ]);
    const read = await readPendingExternalEvents(client, 10);
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok ? read.events.map((e) => e.eventId) : [], ["good"]);
    assert.equal(read.ok && read.unreadable, 2);
  });

  it("the claim is a compare-and-swap: the second worker is told it lost", async () => {
    const { tables, client } = db([storedRow()]);
    const first = await claimExternalEvent(client, "evt-1", NOW);
    assert.equal(first.ok && first.claimed, true);
    assert.equal(tables.layover_external_events[0].processed_at, new Date(NOW).toISOString());

    // The row is no longer `processed_at IS NULL`, so the second UPDATE matches
    // nothing. Without this, both workers replan and the traveller is notified
    // twice for one gate change.
    const second = await claimExternalEvent(client, "evt-1", NOW + 1000);
    assert.equal(second.ok && second.claimed, false);
    assert.equal(
      tables.layover_external_events[0].processed_at,
      new Date(NOW).toISOString(),
      "the loser must not overwrite the winner's stamp",
    );
  });
});

describe("the consumer reports honestly", () => {
  function storedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      event_id: "evt-1",
      event_type: "flight.arrival_delayed",
      occurred_at: new Date(NOW - 5 * MIN).toISOString(),
      received_at: new Date(NOW - 4 * MIN).toISOString(),
      source: "acme-flight-feed",
      source_event_id: "acme-99",
      subject_refs: [{ kind: "flight", ref: "BA0117" }],
      payload: { delayMinutes: 25 },
      dedup_key: "acme-flight-feed:acme-99",
      confidence: "HIGH",
      processed_at: null,
      ...over,
    };
  }

  const okPort: ReplanPort = { async replan() { return { ok: true, impacted: 2, notifications: 1 }; } };

  it("a successful drain claims and reports each event", async () => {
    const { tables, client } = db([storedRow({ event_id: "a" }), storedRow({ event_id: "b", dedup_key: "k-b" })]);
    const report = await drainPendingExternalEvents(client, okPort, { limit: 10, nowMs: NOW });
    assert.deepEqual(report.drained.map((d) => d.eventId), ["a", "b"]);
    assert.equal(report.failedAfterClaim.length, 0);
    assert.equal(report.readFailed, null);
    for (const row of tables.layover_external_events) {
      assert.equal(row.processed_at, new Date(NOW).toISOString(), "every drained event must be stamped");
    }
  });

  it("a read failure is reported as a read failure, not as an empty drain", async () => {
    const { client } = db([storedRow()], {
      "layover_external_events:select": { message: "relation unavailable" },
    });
    const report = await drainPendingExternalEvents(client, okPort, { limit: 10, nowMs: NOW });
    assert.equal(report.drained.length, 0);
    assert.equal(
      report.readFailed,
      "relation unavailable",
      "a drain that reports an outage as a quiet day is worse than one that reports nothing",
    );
  });

  it("a replan that fails after the claim is REPORTED, and the stamp stays", async () => {
    const { tables, client } = db([storedRow()]);
    const failing: ReplanPort = { async replan() { return { ok: false, reason: "airport unreadable" }; } };
    const report = await drainPendingExternalEvents(client, failing, { limit: 10, nowMs: NOW });

    assert.equal(report.drained.length, 0);
    assert.deepEqual(report.failedAfterClaim, [{ eventId: "evt-1", reason: "airport unreadable" }]);
    // The stamp STAYS. Un-stamping on every failure would convert a visible
    // stale plan into an invisible double notification, because a replan can
    // fail after it has already notified.
    assert.equal(tables.layover_external_events[0].processed_at, new Date(NOW).toISOString());
  });

  it("a replanner that throws does not abort the events behind it", async () => {
    const { client } = db([
      storedRow({ event_id: "boom" }),
      storedRow({ event_id: "after", dedup_key: "k-after" }),
    ]);
    const flaky: ReplanPort = {
      async replan(e: LayoverEventEnvelope) {
        if (e.eventId === "boom") throw new Error("kaboom");
        return { ok: true, impacted: 1, notifications: 0 };
      },
    };
    const report = await drainPendingExternalEvents(client, flaky, { limit: 10, nowMs: NOW });
    assert.deepEqual(report.drained.map((d) => d.eventId), ["after"]);
    assert.equal(report.failedAfterClaim.length, 1);
    assert.match(report.failedAfterClaim[0]!.reason, /replan threw: kaboom/);
  });

  it("an event another worker already claimed is counted, not replanned", async () => {
    // Staged as already-stamped, which is what a rival worker leaves behind. The
    // pending read filters it out, so the count comes from the pending set being
    // empty rather than from a lost race — and `claimedByAnother` stays 0 here,
    // which is the honest reading. The lost-race path is proven by the
    // compare-and-swap case above.
    const { client } = db([storedRow({ processed_at: new Date(NOW - MIN).toISOString() })]);
    let calls = 0;
    const counting: ReplanPort = {
      async replan() { calls += 1; return { ok: true, impacted: 0, notifications: 0 }; },
    };
    const report = await drainPendingExternalEvents(client, counting, { limit: 10, nowMs: NOW });
    assert.equal(calls, 0, "a processed event must never be replanned again");
    assert.equal(report.drained.length, 0);
    assert.equal(report.readFailed, null);
  });
});
