/**
 * census-layover L194, L263, L198 — the dedup index is REAL, against a real
 * PostgreSQL, because the in-memory double cannot prove it.
 *
 * ── WHY THIS FILE EXISTS SEPARATELY ──────────────────────────────────────────
 * `src/services/layover/__tests__/layoverExternalEventIngest.test.ts` proves
 * that the ingest HANDLES a unique violation correctly. It cannot prove the
 * violation happens, because `fakeLayoverDb` models no unique indexes — its own
 * header says "A duplicate insert appends a second row instead of resolving
 * 23505 ... this double cannot DISCOVER the collision", so that suite STAGES
 * the error.
 *
 * A staged 23505 is evidence about the handler and nothing at all about the
 * schema. L194's verdict — "no dedup index or unique constraint of any kind" —
 * was written about `layover_events`, and the answer to it is a constraint on a
 * different table that has to actually exist and actually fire. That is what
 * this file checks, by inserting two rows and watching PostgreSQL refuse the
 * second.
 *
 * ── WHAT THIS RUNS AGAINST ───────────────────────────────────────────────────
 * `scripts/local-db/up.sh`'s throwaway cluster, carrying the baseline plus the
 * canonical chain replayed in byte order — so the `layover_external_events`
 * here is the one migration 2860 defines, not a fixture someone wrote to match
 * it. Skips when LOCAL_DB_URL is unset; `scripts/local-db/run-tests.sh` is the
 * run that refuses skipped > 0, so the skip cannot be mistaken for a pass where
 * it counts.
 *
 * Run: bash scripts/local-db/up.sh && bash scripts/local-db/run-tests.sh
 */
import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { HAVE_DB, exec, psql, rows, scalar } from "./localDb.js";

const SOURCE = "dedup-suite-feed";

function cleanup(): void {
  if (!HAVE_DB) return;
  exec(`DELETE FROM public.layover_external_events WHERE source = '${SOURCE}';`);
}

/** One insert, returning psql's exit status and stderr rather than throwing. */
function insertEvent(over: Record<string, string> = {}) {
  const v = {
    event_id: "evt-a",
    event_type: "'flight.arrival_delayed'",
    occurred_at: "'2026-09-22T11:55:00Z'",
    received_at: "'2026-09-22T12:00:00Z'",
    source: `'${SOURCE}'`,
    source_event_id: "'feed-1'",
    subject_refs: `'[{"kind":"flight","ref":"BA0117"}]'::jsonb`,
    payload: `'{"delayMinutes":25}'::jsonb`,
    dedup_key: `'${SOURCE}:feed-1'`,
    confidence: "'HIGH'",
    ...over,
  };
  return psql(
    `INSERT INTO public.layover_external_events
       (event_id, event_type, occurred_at, received_at, source, source_event_id,
        subject_refs, payload, dedup_key, confidence)
     VALUES ('${v.event_id}', ${v.event_type}, ${v.occurred_at}, ${v.received_at},
             ${v.source}, ${v.source_event_id}, ${v.subject_refs}, ${v.payload},
             ${v.dedup_key}, ${v.confidence});`,
  );
}

describe("layover_external_events — §24's dedup guarantee, on a real database", { skip: !HAVE_DB }, () => {
  before(cleanup);
  after(cleanup);

  it("the table and both uniqueness constraints exist as 2860 defines them", () => {
    const idx = rows<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'layover_external_events'`,
    );
    const byName = new Map(idx.map((r) => [r.indexname, r.indexdef]));

    const dedup = byName.get("layover_external_events_dedup_uidx");
    assert.ok(dedup, "the dedup index must exist — it is the whole point of the table");
    assert.match(dedup, /UNIQUE INDEX/, "a non-unique index on dedup_key guarantees nothing");
    assert.match(dedup, /\(dedup_key\)/);

    const pending = byName.get("layover_external_events_pending_idx");
    assert.ok(pending, "the fanout read's index must exist");
    // PARTIAL, on purpose: the pending set is a query, not a queue service, and
    // a full index on occurred_at would not serve it once the table is mostly
    // processed rows.
    assert.match(pending, /WHERE \(processed_at IS NULL\)/);
  });

  it("a SECOND delivery of the same fact is REFUSED by the database, with 23505", () => {
    const first = insertEvent();
    assert.equal(first.status, 0, first.stderr);

    // Same dedup_key, DIFFERENT event_id — a producer minting a fresh id per
    // delivery, which is the failure §24 names. If eventId were part of the
    // key, this would be admitted and the traveller would be replanned twice.
    const second = insertEvent({ event_id: "evt-b" });
    assert.notEqual(second.status, 0, "the second delivery must be refused, not stored");
    assert.match(second.stderr, /duplicate key value violates unique constraint/);
    assert.match(
      second.stderr,
      /layover_external_events_dedup_uidx/,
      "the refusal must name the dedup index, which is how the ingest tells same_fact from same_delivery",
    );

    assert.equal(
      scalar(`SELECT count(*)::text FROM public.layover_external_events WHERE source = '${SOURCE}'`),
      "1",
      "exactly one row survives — a duplicate changes nothing",
    );
  });

  it("the same event_id twice is refused by the PRIMARY KEY, a different constraint", () => {
    // Different dedup_key so the dedup index is not what catches it. The two
    // constraints say different things and the ingest reports them apart.
    const again = insertEvent({ dedup_key: `'${SOURCE}:feed-2'`, source_event_id: "'feed-2'" });
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /layover_external_events_pkey/);
  });

  it("two genuinely different facts are both admitted", () => {
    const other = insertEvent({
      event_id: "evt-c",
      dedup_key: `'${SOURCE}:feed-3'`,
      source_event_id: "'feed-3'",
    });
    assert.equal(other.status, 0, other.stderr);
    assert.equal(
      scalar(`SELECT count(*)::text FROM public.layover_external_events WHERE source = '${SOURCE}'`),
      "2",
      "deduplication must not collapse distinct facts",
    );
  });

  it("a future-dated event is refused by the table's own CHECK, not only by the normaliser", () => {
    // The normaliser refuses `occurredAt > receivedAt` in code. This is the
    // second refusal: a row that reached the database some other way — a
    // backfill, a future writer — is still refused.
    const future = insertEvent({
      event_id: "evt-future",
      dedup_key: `'${SOURCE}:feed-future'`,
      source_event_id: "'feed-future'",
      occurred_at: "'2026-09-22T12:05:00Z'",
    });
    assert.notEqual(future.status, 0, "a future-dated event must not be storable");
    assert.match(future.stderr, /layover_external_events_not_future/);
  });

  it("the pending index actually serves the consumer's query", () => {
    // Not "an index exists" but "the planner uses it for the read the consumer
    // issues". An index the query cannot use is an index that costs writes and
    // buys nothing, and this is the read `readPendingExternalEvents` makes.
    const plan = exec(
      `EXPLAIN (COSTS OFF) SELECT event_id FROM public.layover_external_events
        WHERE processed_at IS NULL ORDER BY occurred_at ASC LIMIT 50;`,
    ).join(" ");
    assert.match(
      plan,
      /layover_external_events_pending_idx/,
      `the pending read must use the partial index; plan was: ${plan}`,
    );
  });

  it("RLS is on and no policy exists, so no client role can read a row", () => {
    // 2860's deliberate choice: an external operational event is not a
    // traveller's data, and there is no surface that shows one. RLS enabled
    // with zero policies means `authenticated` sees nothing; the service role
    // bypasses RLS, which is how the consumer reads it.
    assert.equal(
      scalar(`SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.layover_external_events'::regclass`),
      "true",
      "RLS must be enabled",
    );
    assert.equal(
      scalar(`SELECT count(*)::text FROM pg_policies WHERE schemaname='public' AND tablename='layover_external_events'`),
      "0",
      "a policy nobody needs is a policy nobody reviews",
    );
  });
});

describe("migration 2981 — the ingest flag is seeded, and seeded OFF", { skip: !HAVE_DB }, () => {
  it("the row exists under the exact name the code reads", () => {
    const flag = rows<{ flag: string; enabled: boolean }>(
      `SELECT flag, enabled FROM public.feature_flags WHERE flag = 'layover_event_ingest_enabled'`,
    );
    assert.equal(flag.length, 1, "seeded as a row so the audited toggle path can reach it");
    assert.equal(
      flag[0]!.enabled,
      false,
      "2981 makes the gate REACHABLE, not open — enabling it admits producer writes that move traveller return deadlines",
    );
  });

  it("no near-miss spelling exists", () => {
    assert.equal(
      scalar(
        `SELECT count(*)::text FROM public.feature_flags
          WHERE flag IN ('layover_event_ingest','layover_events_ingest_enabled')`,
      ),
      "0",
      "a row under a name no code reads is a gate nothing can reach",
    );
  });
});
