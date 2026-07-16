/**
 * Stamp generation worker — end-to-end shortfall handling through
 * runGenerationCycle with a fake Supabase client and a fake image provider.
 *
 * Proves that a degraded run (2 of 3 candidates) actually records the
 * shortfall on the queue row (last_error) and stamps
 * candidates_expected/candidates_produced into every version's
 * generation_metadata — and that a below-minimum run is retried (queued)
 * instead of being marked review_required.
 *
 * Uses Node's built-in test runner (no Jest).
 * Run: node --import tsx/esm --test src/test/stampGenerationCycle.test.ts
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

// Must be set before the worker module is imported: MIN_CANDIDATES and the
// auto-requeue sweep are read from env at module load.
process.env.STAMP_MIN_CANDIDATES = "2";
process.env.STAMP_FAILED_REQUEUE_HOURS = "0"; // disable sweep inside the cycle

const { runGenerationCycle, CANDIDATE_SHORTFALL_PREFIX } = await import(
  "../lib/stamps/generationWorker.js"
);
const { _setTestStampImageProvider, _resetProviderCache } = await import(
  "../lib/stamps/imageProvider.js"
);
const { _setTestServiceClient } = await import("../lib/supabase.js");
const { CANDIDATE_COUNT } = await import("../lib/stamps/artDirection.js");

// ── Fakes ─────────────────────────────────────────────────────────────────────

interface RecordedUpdate {
  table: string;
  payload: any;
  eqFilters: Array<[string, any]>;
}
interface RecordedInsert {
  table: string;
  rows: any[];
}

const JOB = {
  id: "job-1",
  catalog_id: "cat-1",
  attempts: 0,
  max_attempts: 3,
  triggered_by_action: "test",
};

const CATALOG_ROW = {
  id: "cat-1",
  canonical_location_key: "jp/tokyo",
  stamp_type: "city",
  display_name: "Tokyo",
  country: "Japan",
  country_code: "JP",
  region: null,
  city: "Tokyo",
  neighborhood: null,
};

/**
 * Fake Supabase client supporting the exact chains runGenerationCycle uses:
 * - queue claim:    from(q).select().eq().or().order().order().limit().maybeSingle()
 * - catalog load:   from(c).select().eq().maybeSingle()
 * - lock + status:  from(q).update().eq()[.eq()][.select()]  (also awaitable)
 * - version insert: from(v).insert(rows)
 */
function makeFakeClient() {
  const updates: RecordedUpdate[] = [];
  const inserts: RecordedInsert[] = [];

  const sc: any = {
    from(table: string) {
      return {
        select(_cols: string) {
          const b: any = {
            eq() { return b; },
            or() { return b; },
            lt() { return b; },
            order() { return b; },
            limit() { return b; },
            maybeSingle() {
              if (table === "stamp_generation_queue") {
                return Promise.resolve({ data: { ...JOB }, error: null });
              }
              if (table === "universal_stamp_catalog") {
                return Promise.resolve({ data: { ...CATALOG_ROW }, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
            then(resolve: any, reject: any) {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return b;
        },
        update(payload: any) {
          const call: RecordedUpdate = { table, payload, eqFilters: [] };
          updates.push(call);
          const result = { data: [{ id: JOB.id }], error: null };
          const b: any = {
            eq(col: string, val: any) { call.eqFilters.push([col, val]); return b; },
            select(_c: string) { return Promise.resolve(result); },
            then(resolve: any, reject: any) {
              return Promise.resolve(result).then(resolve, reject);
            },
          };
          return b;
        },
        insert(rows: any[]) {
          inserts.push({ table, rows });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { sc, updates, inserts };
}

/** Fake provider returning `count` placeholder data-URL images (no downloads). */
function makeFakeProvider(count: number) {
  return {
    async generate(_prompt: string, _n?: number) {
      return Array.from({ length: count }, (_, i) => ({
        url: `data:image/svg+xml,fake-${i}`,
        metadata: { model: "fake-provider", candidate_index: i },
      }));
    },
  };
}

afterEach(() => {
  _setTestServiceClient(null);
  _setTestStampImageProvider(null);
  _resetProviderCache();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runGenerationCycle — degraded run (2 of 3 candidates)", () => {
  it("marks review_required with the shortfall in last_error and stamps metadata on every version", async () => {
    const { sc, updates, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeProvider(2));

    const result = await runGenerationCycle();

    assert.equal(result.processed, true);
    assert.equal(result.catalogId, "cat-1");

    // Versions inserted: exactly the 2 produced candidates, each stamped with
    // the shortfall counters in generation_metadata.
    assert.equal(inserts.length, 1);
    const { table, rows } = inserts[0];
    assert.equal(table, "stamp_artwork_versions");
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.catalog_id, "cat-1");
      assert.equal(row.status, "candidate");
      assert.equal(row.generation_metadata.candidates_expected, CANDIDATE_COUNT);
      assert.equal(row.generation_metadata.candidates_produced, 2);
    }

    // Queue row: lock update first, then the review_required update carrying
    // the shortfall message.
    const review = updates.find((u) => u.payload.status === "review_required");
    assert.ok(review, "must mark the job review_required");
    assert.equal(review!.table, "stamp_generation_queue");
    assert.ok(
      typeof review!.payload.last_error === "string" &&
        review!.payload.last_error.startsWith(CANDIDATE_SHORTFALL_PREFIX),
      `last_error must carry the shortfall, got: ${review!.payload.last_error}`,
    );
    assert.ok(review!.payload.last_error.includes(`2 of ${CANDIDATE_COUNT}`));
    assert.equal(review!.payload.locked_until, null);
    assert.equal(review!.payload.locked_by, null);
    assert.deepEqual(review!.eqFilters, [["id", "job-1"]]);
  });

  it("clears last_error on a full run (no stale shortfall)", async () => {
    const { sc, updates, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeProvider(CANDIDATE_COUNT));

    const result = await runGenerationCycle();

    assert.equal(result.processed, true);
    assert.equal(inserts[0].rows.length, CANDIDATE_COUNT);
    for (const row of inserts[0].rows) {
      assert.equal(row.generation_metadata.candidates_expected, CANDIDATE_COUNT);
      assert.equal(row.generation_metadata.candidates_produced, CANDIDATE_COUNT);
    }

    const review = updates.find((u) => u.payload.status === "review_required");
    assert.ok(review);
    assert.equal(review!.payload.last_error, null);
  });
});

describe("runGenerationCycle — below-minimum run (1 of 3, STAMP_MIN_CANDIDATES=2)", () => {
  it("re-queues the job as retryable instead of marking review_required", async () => {
    const { sc, updates, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeProvider(1));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No versions must be inserted for a failed run.
    assert.equal(inserts.length, 0);

    // No review_required update at all.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a below-minimum run must never reach review_required",
    );

    // Failure update: back to queued (attempts 1 < max 3) with the shortfall
    // recorded as a retryable error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update");
    assert.equal(fail!.payload.status, "queued", "first failure must be retried, not terminal");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(fail!.payload.last_error.startsWith(CANDIDATE_SHORTFALL_PREFIX));
    assert.ok(fail!.payload.last_error.includes("minimum 2"));
    assert.equal(fail!.payload.locked_until, null);
    assert.deepEqual(fail!.eqFilters, [["id", "job-1"]]);
  });

  it("never marks a shortfall failure permanently_failed", async () => {
    const { sc, updates } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeProvider(0));

    await runGenerationCycle();

    assert.equal(
      updates.some((u) => u.payload.status === "permanently_failed"),
      false,
    );
  });
});
