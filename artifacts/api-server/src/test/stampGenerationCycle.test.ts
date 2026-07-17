/**
 * Stamp generation worker — end-to-end shortfall handling and real-image
 * upload path through runGenerationCycle with a fake Supabase client and
 * a fake image provider.
 *
 * Covers:
 * - Degraded run (2 of 3 candidates via data-URL provider): records shortfall
 *   in last_error and stamps candidates_expected/candidates_produced on every
 *   version's generation_metadata.
 * - Below-minimum run: re-queued as retryable, no version rows inserted.
 * - Real-image path (http URLs): successful download + storage upload inserts
 *   version rows with public_url from storage.
 * - Mid-batch download failure: no version rows inserted, status back to
 *   queued with last_error describing the download failure.
 * - Mid-batch storage upload failure: same — no version rows, status queued.
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

const {
  runGenerationCycle,
  CANDIDATE_SHORTFALL_PREFIX,
  sweepStaleArtwork,
  resetStaleArtworkSweepState,
  evaluateCandidateShortfall,
} = await import("../lib/stamps/generationWorker.js");
const { _setTestStampImageProvider, _resetProviderCache } = await import(
  "../lib/stamps/imageProvider.js"
);
const { _setTestServiceClient } = await import("../lib/supabase.js");
const { CANDIDATE_COUNT, STYLE_VERSION, isArtworkStale, buildStampPrompt } = await import("../lib/stamps/artDirection.js");

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

interface FakeClientConfig {
  /**
   * When set, the queue `maybeSingle` returns this job fixture instead of the
   * default JOB constant.
   */
  jobOverride?: typeof JOB;
  /**
   * When set, the catalog `maybeSingle` returns this row instead of the
   * default CATALOG_ROW constant. Use to exercise wrong-country-code, null-city,
   * or other catalog-shape scenarios without manually patching sc.from.
   */
  catalogOverride?: typeof CATALOG_ROW;
}

/**
 * Fake Supabase client supporting the exact chains runGenerationCycle uses:
 * - queue claim:    from(q).select().eq().or().order().order().limit().maybeSingle()
 * - catalog load:   from(c).select().eq().maybeSingle()
 * - lock + status:  from(q).update().eq()[.eq()][.select()]  (also awaitable)
 * - version insert: from(v).insert(rows)
 */
function makeFakeClient(config: FakeClientConfig = {}) {
  const updates: RecordedUpdate[] = [];
  const inserts: RecordedInsert[] = [];
  const queueJob = config.jobOverride ?? JOB;
  const catalogRow = config.catalogOverride ?? CATALOG_ROW;

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
                return Promise.resolve({ data: { ...queueJob }, error: null });
              }
              if (table === "universal_stamp_catalog") {
                return Promise.resolve({ data: { ...catalogRow }, error: null });
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

// ── Storage-aware fake client ─────────────────────────────────────────────────

interface StorageConfig {
  /** Called for every upload. Throw to simulate an upload failure. */
  onUpload?: (path: string, buffer: Buffer) => void;
  /** Base URL prepended to the storage path for getPublicUrl. */
  publicUrlBase?: string;
  /**
   * When set, the `stamp_artwork_versions` insert returns this as an error
   * instead of succeeding. All other inserts are unaffected.
   */
  insertError?: { message: string };
  /**
   * When set, the queue `maybeSingle` returns this job fixture instead of the
   * default JOB constant. Use to exercise exhausted-attempts scenarios without
   * manually patching sc.from.
   */
  jobOverride?: typeof JOB;
  /**
   * When set, the catalog `maybeSingle` returns this row instead of the
   * default CATALOG_ROW constant. Use to exercise wrong-country-code, null-city,
   * or other catalog-shape scenarios without manually patching sc.from.
   */
  catalogOverride?: typeof CATALOG_ROW;
  /**
   * Called when storage.remove() is invoked. Throw to simulate a cleanup
   * failure — the orphan-cleanup catch block in the worker must swallow it
   * and still write the original generation error to last_error.
   */
  onRemove?: (paths: string[]) => void;
  /**
   * When set, storage.remove() resolves with `{ data: null, error }` instead
   * of throwing. Exercises the silent-error path: the worker must detect the
   * returned error object and log orphan_cleanup_error rather than
   * orphan_cleanup (success).
   */
  removeError?: { message: string };
}

interface StorageCall {
  path: string;
  bufferLength: number;
}

interface StorageDeleteCall {
  paths: string[];
}

/**
 * Extends the base fake client with a `storage` mock so tests can exercise
 * the real downloadImageBuffer + uploadToStorage code paths (http URLs).
 *
 * By default every upload succeeds and returns a public URL of the form
 * `https://storage.fake/<path>`. Pass `onUpload` to inject failures.
 */
function makeFakeClientWithStorage(opts: StorageConfig = {}) {
  const base = makeFakeClient({ jobOverride: opts.jobOverride, catalogOverride: opts.catalogOverride });
  const storageCalls: StorageCall[] = [];
  const deleteCalls: StorageDeleteCall[] = [];
  const publicUrlBase = opts.publicUrlBase ?? "https://storage.fake";

  base.sc.storage = {
    from(_bucket: string) {
      return {
        upload(path: string, buffer: Buffer) {
          // Call the hook first so a thrown error prevents the path from being
          // recorded as a successful upload (mirrors real storage behaviour).
          if (opts.onUpload) opts.onUpload(path, buffer);
          storageCalls.push({ path, bufferLength: buffer.length });
          return Promise.resolve({ error: null });
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `${publicUrlBase}/${path}` } };
        },
        remove(paths: string[]) {
          // Call the hook first — a thrown error propagates out of remove()
          // so the worker's cleanup catch block must handle it.
          if (opts.onRemove) opts.onRemove(paths);
          deleteCalls.push({ paths });
          // If a removeError is configured, resolve with the error object
          // (no throw) to exercise the silent-error path.
          if (opts.removeError) {
            return Promise.resolve({ data: null, error: opts.removeError });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };

  // If an insertError is configured, wrap the `from` accessor so that inserts
  // into stamp_artwork_versions return the specified error instead of succeeding.
  if (opts.insertError) {
    const originalFrom = base.sc.from.bind(base.sc);
    const insertError = opts.insertError;
    base.sc.from = function (table: string) {
      const proxy = originalFrom(table);
      if (table === "stamp_artwork_versions") {
        proxy.insert = function (rows: any[]) {
          // Still record the attempt so tests can inspect it.
          base.inserts.push({ table, rows });
          return Promise.resolve({ data: null, error: insertError });
        };
      }
      return proxy;
    };
  }

  return { ...base, storageCalls, deleteCalls };
}

// ── Fetch mock helpers ────────────────────────────────────────────────────────

/** A tiny fake image body (8 bytes is enough for a Buffer). */
const FAKE_IMAGE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type FetchOverride = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

let _savedFetch: typeof globalThis.fetch | undefined;

/**
 * Replace globalThis.fetch for the duration of a test.
 * The caller must call restoreFetch() in afterEach / cleanup.
 */
function installFetch(fn: FetchOverride) {
  _savedFetch = globalThis.fetch;
  (globalThis as any).fetch = fn;
}

function restoreFetch() {
  if (_savedFetch !== undefined) {
    (globalThis as any).fetch = _savedFetch;
    _savedFetch = undefined;
  }
}

/** Fetch that always returns a 200 with FAKE_IMAGE_BYTES. */
function successFetch(): FetchOverride {
  return async (_url) =>
    new Response(FAKE_IMAGE_BYTES, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
}

/**
 * Fetch that fails on the N-th call (1-based).
 * Earlier calls return 200 with FAKE_IMAGE_BYTES.
 */
function failOnNthFetch(n: number): FetchOverride {
  let call = 0;
  return async (_url) => {
    call++;
    if (call === n) {
      return new Response("Not Found", { status: 404 });
    }
    return new Response(FAKE_IMAGE_BYTES, {
      status: 200,
      headers: { "Content-Type": "image/png" },
    });
  };
}

/** Provider returning `count` real http URLs (triggers download + upload). */
function makeFakeHttpProvider(count: number) {
  return {
    async generate(_prompt: string, _n?: number) {
      return Array.from({ length: count }, (_, i) => ({
        url: `https://img.fake/candidate-${i}.png`,
        metadata: { model: "fake-provider", candidate_index: i },
      }));
    },
  };
}

afterEach(() => {
  _setTestServiceClient(null);
  _setTestStampImageProvider(null);
  _resetProviderCache();
  restoreFetch();
  resetStaleArtworkSweepState();
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

  it("reaches retryable_failed when attempts are exhausted on a shortfall run", async () => {
    // Simulate a job that has already used max_attempts - 1 attempts.
    const exhaustedJob = { ...JOB, attempts: 2, max_attempts: 3 };

    const { sc, updates, inserts } = makeFakeClientWithStorage({
      jobOverride: exhaustedJob,
    });
    _setTestServiceClient(sc);
    // Provider returns only 1 candidate — below STAMP_MIN_CANDIDATES=2.
    _setTestStampImageProvider(makeFakeProvider(1));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No version rows must be inserted for a failed run.
    assert.equal(inserts.length, 0);

    // No review_required update at all.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a below-minimum run must never reach review_required",
    );

    // With attempts 2 + 1 = 3 >= max_attempts 3, status must be retryable_failed.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update");
    assert.equal(
      fail!.payload.status,
      "retryable_failed",
      "exhausted shortfall attempts must produce retryable_failed, not queued",
    );
    assert.equal(fail!.payload.attempts, 3);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.startsWith(CANDIDATE_SHORTFALL_PREFIX),
      `last_error must carry the shortfall prefix, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
    assert.deepEqual(fail!.eqFilters, [["id", "job-1"]]);
  });

  it("reaches retryable_failed when attempts are exhausted and provider returns 0 candidates", async () => {
    // Zero-candidate path: provider returns nothing at all (different code path
    // from the 1-candidate case) but must still reach retryable_failed when
    // all attempts are used up.
    const exhaustedJob = { ...JOB, attempts: 2, max_attempts: 3 };

    const { sc, updates, inserts } = makeFakeClientWithStorage({
      jobOverride: exhaustedJob,
    });
    _setTestServiceClient(sc);
    // Provider returns 0 candidates — zero-candidate shortfall path.
    _setTestStampImageProvider(makeFakeProvider(0));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No version rows must be inserted for a failed run.
    assert.equal(inserts.length, 0);

    // No review_required update at all.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a zero-candidate run must never reach review_required",
    );

    // With attempts 2 + 1 = 3 >= max_attempts 3, status must be retryable_failed.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update");
    assert.equal(
      fail!.payload.status,
      "retryable_failed",
      "exhausted zero-candidate shortfall must produce retryable_failed, not queued",
    );
    assert.equal(fail!.payload.attempts, 3);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.startsWith(CANDIDATE_SHORTFALL_PREFIX),
      `last_error must carry the shortfall prefix, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
    assert.deepEqual(fail!.eqFilters, [["id", "job-1"]]);
  });

  it("records shortfall prefix in last_error when provider returns 0 candidates and attempts are not exhausted", async () => {
    // Non-exhausted zero-candidate path: provider returns nothing but the job
    // still has remaining attempts, so it should re-queue as "queued" — and
    // last_error must still carry the CANDIDATE_SHORTFALL_PREFIX so operators
    // can see context even before exhaustion.
    const { sc, updates, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    // Provider returns 0 candidates — zero-candidate shortfall path.
    _setTestStampImageProvider(makeFakeProvider(0));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No version rows must be inserted for a failed run.
    assert.equal(inserts.length, 0);

    // No review_required update at all.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a zero-candidate run must never reach review_required",
    );

    // Default JOB has attempts=0 < max_attempts=3, so the job must re-queue.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update");
    assert.equal(
      fail!.payload.status,
      "queued",
      "non-exhausted zero-candidate shortfall must re-queue, not reach retryable_failed",
    );
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.startsWith(CANDIDATE_SHORTFALL_PREFIX),
      `last_error must carry the shortfall prefix even on a non-exhausted zero-candidate run, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.deepEqual(fail!.eqFilters, [["id", "job-1"]]);
  });
});

// ── Real-image path (http URLs): download + storage upload ────────────────────

describe("runGenerationCycle — real http images: successful download + upload", () => {
  it("uploads each candidate buffer to storage and inserts version rows with public_url", async () => {
    const { sc, updates, inserts, storageCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, true);
    assert.equal(result.catalogId, "cat-1");

    // One storage upload per candidate.
    assert.equal(storageCalls.length, CANDIDATE_COUNT);
    for (const call of storageCalls) {
      assert.ok(call.path.startsWith("catalog/cat-1/"), `storage path must include catalogId, got: ${call.path}`);
      assert.equal(call.bufferLength, FAKE_IMAGE_BYTES.length);
    }

    // One batch insert with all candidates.
    assert.equal(inserts.length, 1);
    const { table, rows } = inserts[0];
    assert.equal(table, "stamp_artwork_versions");
    assert.equal(rows.length, CANDIDATE_COUNT);
    for (const row of rows) {
      assert.equal(row.catalog_id, "cat-1");
      assert.equal(row.status, "candidate");
      // public_url must come from storage.getPublicUrl, not the original http URL.
      assert.ok(
        row.public_url.startsWith("https://storage.fake/catalog/cat-1/"),
        `public_url should be from storage, got: ${row.public_url}`,
      );
      assert.ok(
        row.storage_path.startsWith("catalog/cat-1/"),
        `storage_path should be set, got: ${row.storage_path}`,
      );
    }

    // Queue row marked review_required with no error.
    const review = updates.find((u) => u.payload.status === "review_required");
    assert.ok(review, "must mark the job review_required");
    assert.equal(review!.payload.last_error, null);
    assert.equal(review!.payload.locked_until, null);
    assert.equal(review!.payload.locked_by, null);
  });
});

describe("runGenerationCycle — real http images: mid-batch download failure", () => {
  it("records no version rows and re-queues the job with last_error describing the failure", async () => {
    // Fail the 2nd download so the first candidate is processed but the batch
    // never reaches the insert step.
    const { sc, updates, inserts, storageCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    // Provider returns CANDIDATE_COUNT http images; second download will 404.
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(failOnNthFetch(2));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No version rows inserted — the whole batch is abandoned on failure.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch failure");

    // The first candidate uploaded before the failure — that's acceptable; what
    // matters is no DB row references an orphaned upload.
    // (storageCalls may be 1 because the first download succeeded before the 2nd failed)

    // No review_required update.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed batch must never reach review_required",
    );

    // Failure update present: back to queued (attempts 1 < max 3).
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first failure (attempts < max) must go back to queued");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" && fail!.payload.last_error.includes("404"),
      `last_error must mention the HTTP status, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
  });
});

describe("runGenerationCycle — real http images: mid-batch storage upload failure", () => {
  it("records no version rows and re-queues the job with last_error describing the upload failure", async () => {
    let uploadCall = 0;
    const { sc, updates, inserts } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        // Fail the second upload.
        if (uploadCall === 2) throw new Error("Storage upload failed: bucket quota exceeded");
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No version rows — batch never reached the insert.
    assert.equal(inserts.length, 0, "must not insert any version rows after a storage upload failure");

    // No review_required.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
    );

    // Failure update with the storage error in last_error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first storage failure must go back to queued for retry");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.toLowerCase().includes("storage"),
      `last_error must mention storage failure, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
  });
});

// ── Orphan cleanup: delete already-uploaded files when a later step fails ─────

describe("runGenerationCycle — orphan cleanup on mid-batch failure", () => {
  it("deletes the first candidate's storage file when the second upload fails", async () => {
    let uploadCall = 0;
    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 2) throw new Error("Storage upload failed: bucket quota exceeded");
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // First upload succeeded before the second one failed.
    assert.equal(storageCalls.length, 1, "exactly one upload should have succeeded before the failure");

    // No DB rows inserted.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch failure");

    // Cleanup: the worker must have issued a storage delete for the orphaned file.
    assert.equal(deleteCalls.length, 1, "must issue exactly one storage delete call for cleanup");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, 1, "one path must be deleted (the first successfully-uploaded candidate)");
    assert.ok(
      paths[0].startsWith("catalog/cat-1/") && paths[0].endsWith(".png"),
      `deleted path must be the catalog storage path, got: ${paths[0]}`,
    );

    // The deleted path must match the uploaded path.
    assert.equal(paths[0], storageCalls[0].path, "deleted path must match the path that was uploaded");
  });

  it("deletes the first two candidates' storage files when the third upload fails", async () => {
    let uploadCall = 0;
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 3) throw new Error("Storage upload failed: bucket quota exceeded");
      },
    });
    _setTestServiceClient(sc);
    // Use a provider that returns exactly 3 candidates (the default CANDIDATE_COUNT).
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // Two uploads succeeded before the third failed.
    assert.equal(storageCalls.length, 2, "two uploads should have succeeded before the third failed");

    // No DB rows inserted.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch failure");

    // Cleanup: both uploaded paths must be deleted.
    assert.equal(deleteCalls.length, 1, "must issue exactly one storage delete call for cleanup");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, 2, "both previously-uploaded paths must be deleted");
    for (const p of paths) {
      assert.ok(
        p.startsWith("catalog/cat-1/") && p.endsWith(".png"),
        `deleted path must be a catalog storage path, got: ${p}`,
      );
    }
    // All uploaded paths must appear in the delete list.
    for (const call of storageCalls) {
      assert.ok(paths.includes(call.path), `uploaded path ${call.path} must be in the delete list`);
    }
  });

  it("deletes the successfully-uploaded candidate when the second download fails", async () => {
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    // First download succeeds, second returns 404 (triggering an exception in downloadImageBuffer).
    installFetch(failOnNthFetch(2));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // First candidate was uploaded before the second download failed.
    assert.equal(storageCalls.length, 1, "first candidate should have been uploaded before the download failure");

    // No DB rows inserted.
    assert.equal(inserts.length, 0);

    // Cleanup delete must be issued for the orphaned upload.
    assert.equal(deleteCalls.length, 1, "must issue a storage delete for the orphaned upload");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, 1);
    // The path must follow the exact catalog/<catalogId>/<versionId>.png template
    // used by uploadToStorage. A typo in that template would produce an unrecognisable
    // path and this assertion would catch it.
    assert.ok(
      paths[0].startsWith("catalog/cat-1/"),
      `deleted path must start with "catalog/cat-1/", got: ${paths[0]}`,
    );
    assert.ok(
      paths[0].endsWith(".png"),
      `deleted path must end with ".png", got: ${paths[0]}`,
    );
    assert.equal(paths[0], storageCalls[0].path, "deleted path must match the orphaned upload path");
  });

  it("deletes both uploaded candidates when the third download fails after two uploads", async () => {
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    // First two downloads succeed (and their uploads complete); third returns 404.
    installFetch(failOnNthFetch(3));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // Two candidates were downloaded and uploaded before the third download failed.
    assert.equal(storageCalls.length, 2, "two uploads should have succeeded before the third download failed");

    // No DB rows inserted — the batch is abandoned on failure.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch download failure");

    // Cleanup: both uploaded paths must be deleted in a single remove() call.
    assert.equal(deleteCalls.length, 1, "must issue exactly one storage delete call for cleanup");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, 2, "both previously-uploaded paths must be deleted");

    // Both deleted paths must follow the exact catalog/<catalogId>/<versionId>.png template.
    for (const p of paths) {
      assert.ok(
        p.startsWith("catalog/cat-1/"),
        `deleted path must start with "catalog/cat-1/", got: ${p}`,
      );
      assert.ok(
        p.endsWith(".png"),
        `deleted path must end with ".png", got: ${p}`,
      );
    }

    // Each deleted path must match the corresponding storageCalls entry.
    assert.equal(
      paths[0],
      storageCalls[0].path,
      `first deleted path must match the first uploaded path, got: ${paths[0]} vs ${storageCalls[0].path}`,
    );
    assert.equal(
      paths[1],
      storageCalls[1].path,
      `second deleted path must match the second uploaded path, got: ${paths[1]} vs ${storageCalls[1].path}`,
    );
  });

  it("records status=queued, attempts=1, and last_error with 404 when the third download fails after two uploads", async () => {
    const { sc, updates, inserts, storageCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    // First two downloads succeed (and their uploads complete); third returns 404.
    installFetch(failOnNthFetch(3));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // Two uploads succeeded before the third download failed.
    assert.equal(storageCalls.length, 2, "two uploads should have succeeded before the third download failed");

    // No DB rows inserted — the batch is abandoned on failure.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch download failure");

    // No review_required update.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed batch must never reach review_required",
    );

    // Failure update: back to queued (attempts 1 < max 3), last_error mentions 404.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first failure (attempts < max) must go back to queued");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" && fail!.payload.last_error.includes("404"),
      `last_error must mention the HTTP 404 status, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
  });

  it("uses retryable_failed — not queued — when the third-download failure exhausts all attempts", async () => {
    // Job has already consumed max_attempts - 1 attempts; this run is the last one.
    const exhaustedJob = { ...JOB, attempts: 2, max_attempts: 3 };
    const { sc, updates, inserts } = makeFakeClientWithStorage({
      jobOverride: exhaustedJob,
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    // First two downloads succeed (and their uploads complete); third returns 404.
    installFetch(failOnNthFetch(3));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No version rows inserted — the batch is abandoned on failure.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch download failure");

    // No review_required update.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed batch must never reach review_required",
    );

    // With attempts 2 + 1 = 3 >= max_attempts 3, status must be retryable_failed.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(
      fail!.payload.status,
      "retryable_failed",
      "exhausted attempts on a download failure must produce retryable_failed, not queued",
    );
    assert.equal(fail!.payload.attempts, 3);
    assert.ok(
      typeof fail!.payload.last_error === "string" && fail!.payload.last_error.includes("404"),
      `last_error must mention the HTTP 404 status, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
  });

  it("does not issue a delete when the first download fails before any upload", async () => {
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    // The very first download returns 404 — nothing is ever uploaded.
    installFetch(failOnNthFetch(1));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No uploads happened, so there is nothing to clean up.
    assert.equal(storageCalls.length, 0, "no upload should have been attempted after the first download failed");
    assert.equal(inserts.length, 0, "must not insert any version rows");
    assert.equal(deleteCalls.length, 0, "must not issue a storage delete when nothing was uploaded");
  });

  it("does not issue a delete when no uploads preceded the failure", async () => {
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        // Fail the very first upload.
        throw new Error("Storage upload failed: service unavailable");
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);
    assert.equal(inserts.length, 0);
    assert.equal(storageCalls.length, 0, "no uploads should have succeeded");
    assert.equal(deleteCalls.length, 0, "no delete should be issued when nothing was uploaded");
  });

  it("deletes only the real upload path when a mixed batch's second http download fails after the first upload", async () => {
    // Provider: 1 data-URL placeholder (no download/upload) + 2 real http URLs.
    // The first http download+upload succeeds; the second http download returns 404.
    // Expected: exactly one delete call containing the path from the first real upload.
    // The data-URL placeholder must never produce a storage path or appear in the delete list.
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    // 1 data-URL + 2 http URLs = CANDIDATE_COUNT (3) candidates total.
    _setTestStampImageProvider(makeMixedProvider(1, 2));
    // First fetch (for the first real http URL) succeeds; second fetch fails with 404.
    installFetch(failOnNthFetch(2));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // The first real http candidate was uploaded before the second download failed.
    assert.equal(storageCalls.length, 1, "exactly one real upload should have succeeded before the download failure");

    // No DB rows inserted — the batch was abandoned on failure.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch download failure");

    // Cleanup must issue exactly one delete call for the orphaned upload.
    assert.equal(deleteCalls.length, 1, "must issue exactly one storage delete call for cleanup");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, 1, "deleted paths must contain exactly one entry (the first real upload)");

    // The deleted path must follow the catalog/<catalogId>/<versionId>.png template.
    assert.ok(
      paths[0].startsWith("catalog/cat-1/"),
      `deleted path must start with "catalog/cat-1/", got: ${paths[0]}`,
    );
    assert.ok(
      paths[0].endsWith(".png"),
      `deleted path must end with ".png", got: ${paths[0]}`,
    );

    // The deleted path must match the path that was actually uploaded (not a placeholder).
    assert.equal(
      paths[0],
      storageCalls[0].path,
      `deleted path must match the uploaded storage path, got: ${paths[0]} vs ${storageCalls[0].path}`,
    );
  });

  it("records status=queued, attempts=1, and last_error with the upload error when the second upload fails after one upload", async () => {
    // Focused on the failure shape — status/attempts/last_error — independent of
    // path-format (deleteCalls) assertions.
    const uploadErrorMessage = "Storage upload failed: bucket quota exceeded";
    let uploadCall = 0;
    const { sc, updates, inserts, storageCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 2) throw new Error(uploadErrorMessage);
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // First upload succeeded; second threw.
    assert.equal(storageCalls.length, 1, "exactly one upload should have succeeded before the failure");

    // No version rows — the batch never reached the insert step.
    assert.equal(inserts.length, 0, "must not insert any version rows after an upload failure");

    // No review_required update.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed batch must never reach review_required",
    );

    // Failure update: back to queued (attempts 1 < max 3), last_error carries the upload error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first upload failure (attempts < max) must go back to queued");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(uploadErrorMessage),
      `last_error must include the upload error message, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
  });

  it("deletes both uploaded candidates when a mixed batch's third http download fails after two uploads", async () => {
    // Provider: 1 data-URL placeholder (no download/upload) + 3 real http URLs.
    // The first two http downloads+uploads succeed; the third http download returns 404.
    // Expected: exactly one delete call containing the paths from both real uploads.
    // The data-URL placeholder must never produce a storage path or appear in the delete list.
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    // 1 data-URL + 3 http URLs = 4 candidates total.
    _setTestStampImageProvider(makeMixedProvider(1, 3));
    // First two fetches (for the first two real http URLs) succeed; third fetch fails with 404.
    installFetch(failOnNthFetch(3));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // Two real http candidates were uploaded before the third download failed.
    assert.equal(storageCalls.length, 2, "exactly two real uploads should have succeeded before the download failure");

    // No DB rows inserted — the batch was abandoned on failure.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch download failure");

    // Cleanup must issue exactly one delete call for the two orphaned uploads.
    assert.equal(deleteCalls.length, 1, "must issue exactly one storage delete call for cleanup");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, 2, "deleted paths must contain exactly two entries (the two real uploads)");

    // Both deleted paths must follow the catalog/<catalogId>/<versionId>.png template.
    for (const p of paths) {
      assert.ok(
        p.startsWith("catalog/cat-1/"),
        `deleted path must start with "catalog/cat-1/", got: ${p}`,
      );
      assert.ok(
        p.endsWith(".png"),
        `deleted path must end with ".png", got: ${p}`,
      );
    }

    // Each deleted path must be cross-checked against the corresponding storageCalls entry.
    assert.equal(
      paths[0],
      storageCalls[0].path,
      `first deleted path must match the first uploaded path, got: ${paths[0]} vs ${storageCalls[0].path}`,
    );
    assert.equal(
      paths[1],
      storageCalls[1].path,
      `second deleted path must match the second uploaded path, got: ${paths[1]} vs ${storageCalls[1].path}`,
    );
  });
});

/**
 * Provider returning a mix of data-URL placeholders (no download/upload) and
 * real http URLs (download + upload path).  The data-URLs come first so the
 * upload loop encounters the placeholder BEFORE any real upload.
 */
function makeMixedProvider(dataUrlCount: number, httpCount: number) {
  return {
    async generate(_prompt: string, _n?: number) {
      const results: Array<{ url: string; metadata: Record<string, unknown> }> = [];
      for (let i = 0; i < dataUrlCount; i++) {
        results.push({
          url: `data:image/svg+xml,fake-placeholder-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        });
      }
      for (let i = 0; i < httpCount; i++) {
        results.push({
          url: `https://img.fake/real-candidate-${i}.png`,
          metadata: { model: "fake-provider", candidate_index: dataUrlCount + i },
        });
      }
      return results;
    },
  };
}

// ── Placeholder data-URL candidates excluded from orphan cleanup ──────────────

describe("runGenerationCycle — placeholder data-URL candidates excluded from orphan cleanup", () => {
  it("deletes only the real upload when a later http upload fails after a placeholder candidate", async () => {
    // Provider: one data-URL placeholder, then two real http URLs (= CANDIDATE_COUNT total).
    // Storage: first real upload succeeds; second real upload fails.
    // Expected: cleanup issues one delete — for the real upload path, not the placeholder.
    let uploadCall = 0;
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        // Fail the second storage upload (third overall candidate, second real one).
        if (uploadCall === 2) throw new Error("Storage upload failed: quota exceeded");
      },
    });
    _setTestServiceClient(sc);
    // 1 data-URL + 2 http URLs = CANDIDATE_COUNT (3) candidates total.
    _setTestStampImageProvider(makeMixedProvider(1, 2));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // No DB rows inserted — the batch failed before the insert step.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch failure");

    // Only the first real (http) upload succeeded before the second failed.
    assert.equal(storageCalls.length, 1, "exactly one real upload should have succeeded");

    // Cleanup must issue exactly one delete call — for the real upload only.
    assert.equal(deleteCalls.length, 1, "must issue exactly one storage delete for cleanup");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, 1, "deleted paths must contain exactly one entry (the real candidate)");

    // The deleted path must be a real catalog storage path, not a placeholder path.
    assert.ok(
      paths[0].startsWith("catalog/cat-1/") && paths[0].endsWith(".png"),
      `deleted path must be a real storage path (catalog/...), got: ${paths[0]}`,
    );

    // The deleted path must match the path that was actually uploaded.
    assert.equal(
      paths[0],
      storageCalls[0].path,
      "deleted path must match the uploaded path",
    );

    // The placeholder path must never appear in the delete list.
    assert.equal(
      paths.some((p: string) => p.startsWith("placeholder/")),
      false,
      "placeholder paths must never appear in the orphan cleanup delete list",
    );
  });

  it("issues no delete when only a data-URL placeholder precedes a download failure", async () => {
    // Provider: one data-URL placeholder, then one real http URL.
    // With STAMP_MIN_CANDIDATES=2 and 2 total candidates this is a degraded-but-reviewable
    // run — the shortfall check passes and the loop starts.  The real http URL fails to
    // download, so the loop throws.  Because the data-URL never triggers a storage upload,
    // uploadedStoragePaths stays empty and no delete should be issued.
    const { sc, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    // 1 data-URL + 1 http URL = 2 candidates (≥ STAMP_MIN_CANDIDATES=2, < CANDIDATE_COUNT=3).
    _setTestStampImageProvider(makeMixedProvider(1, 1));
    // Every fetch fails so the real http URL's download throws.
    installFetch(async (_url) => new Response("Not Found", { status: 404 }));

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);
    assert.equal(inserts.length, 0, "must not insert version rows after a download failure");

    // The data-URL candidate must not trigger any storage upload.
    assert.equal(storageCalls.length, 0, "data-URL candidates must not trigger storage uploads");

    // No real upload ever succeeded, so no orphan delete should be issued.
    assert.equal(
      deleteCalls.length,
      0,
      "must not issue any delete when no real uploads preceded the failure",
    );
  });
});

  it("issues no storage deletes when a mixed run fully succeeds (data-URL + real http)", async () => {
    // Provider: 1 data-URL placeholder + 2 real http URLs = CANDIDATE_COUNT (3) total.
    // All fetches succeed, all uploads succeed, and the DB insert succeeds.
    // Expected: processed === true, zero delete calls, version rows for all 3 candidates.
    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeMixedProvider(1, 2));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    // The cycle must report success.
    assert.equal(result.processed, true);
    assert.equal(result.catalogId, "cat-1");

    // Exactly 2 storage uploads — one per real http candidate (placeholder skipped).
    assert.equal(storageCalls.length, 2, "must upload exactly the 2 real http candidates");

    // One batch insert with all 3 candidates (placeholder + 2 real).
    assert.equal(inserts.length, 1, "must perform exactly one batch insert");
    const { table, rows } = inserts[0];
    assert.equal(table, "stamp_artwork_versions");
    assert.equal(rows.length, CANDIDATE_COUNT, "must insert a row for every candidate including the placeholder");

    // Queue row marked review_required.
    const review = updates.find((u) => u.payload.status === "review_required");
    assert.ok(review, "must mark the job review_required on success");
    assert.equal(review!.payload.last_error, null);
    assert.equal(review!.payload.locked_until, null);
    assert.equal(review!.payload.locked_by, null);

    // No storage deletes must be issued on a fully-successful run.
    assert.equal(
      deleteCalls.length,
      0,
      "a fully-successful mixed run must never issue any storage delete calls",
    );
  });

  it("inserts the placeholder row with the data-URL in public_url and a placeholder storage_path — not a real storage URL", async () => {
    // Provider: 1 data-URL placeholder + 2 real http URLs = CANDIDATE_COUNT (3) total.
    // All fetches and uploads succeed.
    // Asserts the content of each inserted version row so a regression that
    // accidentally overwrites public_url with a storage URL, or sets storage_path
    // on a placeholder, is caught immediately.
    const { sc, inserts } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    // Provider emits the placeholder FIRST so the loop encounters a data-URL before any http URL.
    _setTestStampImageProvider(makeMixedProvider(1, 2));
    installFetch(successFetch());

    const result = await runGenerationCycle();
    assert.equal(result.processed, true);

    assert.equal(inserts.length, 1, "must perform exactly one batch insert");
    const { rows } = inserts[0];
    assert.equal(rows.length, CANDIDATE_COUNT, "must insert a row for every candidate");

    // The first row corresponds to the data-URL placeholder (provider emits it first).
    const placeholderRow = rows[0];
    assert.ok(
      placeholderRow.public_url.startsWith("data:"),
      `placeholder row public_url must be the original data-URL, got: ${placeholderRow.public_url}`,
    );
    assert.ok(
      !placeholderRow.public_url.startsWith("https://storage.fake"),
      `placeholder row public_url must NOT be a storage URL, got: ${placeholderRow.public_url}`,
    );
    // storage_path for a placeholder is a synthetic non-catalog path — it must NOT
    // point into the real catalog/ prefix that real uploads use.
    assert.ok(
      typeof placeholderRow.storage_path === "string" &&
        !placeholderRow.storage_path.startsWith("catalog/"),
      `placeholder row storage_path must not be a real catalog storage path, got: ${placeholderRow.storage_path}`,
    );

    // The remaining two rows correspond to the real http candidates.
    const realRows = rows.slice(1);
    assert.equal(realRows.length, 2, "must have exactly 2 real-http candidate rows");
    for (const row of realRows) {
      assert.ok(
        row.public_url.startsWith("https://storage.fake/catalog/cat-1/"),
        `real-http row public_url must be from storage, got: ${row.public_url}`,
      );
      assert.ok(
        typeof row.storage_path === "string" && row.storage_path.startsWith("catalog/cat-1/"),
        `real-http row storage_path must be a catalog storage path, got: ${row.storage_path}`,
      );
    }
  });

// ── DB insert failure after all uploads succeed ───────────────────────────────

describe("runGenerationCycle — DB insert failure after all uploads succeed", () => {
  it("resets job status to queued, records last_error, and clears the lock", async () => {
    // All uploads succeed; the version-row batch insert returns a DB error.
    const insertErrMsg = "duplicate key value violates unique constraint \"stamp_artwork_versions_pkey\"";
    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      insertError: { message: insertErrMsg },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    // The cycle must report failure.
    assert.equal(result.processed, false);

    // All uploads still completed — storage was not involved in the failure.
    assert.equal(
      storageCalls.length,
      CANDIDATE_COUNT,
      "all candidate uploads must complete before the insert is attempted",
    );

    // The insert was attempted (the wrapped fake records it) but the error
    // from the DB caused the catch path to fire — no review_required.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed insert must never reach review_required",
    );

    // Failure update: job is reset to queued (first failure, attempts 1 < max 3),
    // last_error carries the insert error message, and the lock is cleared.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(
      fail!.payload.status,
      "queued",
      "first insert failure (attempts < max) must go back to queued for retry",
    );
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(insertErrMsg),
      `last_error must contain the insert error message, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null, "locked_until must be cleared after insert failure");
    assert.equal(fail!.payload.locked_by, null, "locked_by must be cleared after insert failure");
    assert.deepEqual(fail!.eqFilters, [["id", "job-1"]]);

    // Orphan cleanup: a storage delete must be issued for each uploaded path so
    // the successfully-uploaded objects don't remain without a DB row.
    assert.equal(
      deleteCalls.length,
      1,
      "must issue exactly one storage delete call after a DB insert failure",
    );
    const { paths: deletedPaths } = deleteCalls[0];
    assert.equal(
      deletedPaths.length,
      CANDIDATE_COUNT,
      "every uploaded storage path must be included in the delete call",
    );
    for (const call of storageCalls) {
      assert.ok(
        deletedPaths.includes(call.path),
        `uploaded path ${call.path} must appear in the orphan-cleanup delete list`,
      );
    }
  });

  it("still resets the job even when the storage delete itself throws", async () => {
    // All uploads succeed; the version insert fails; and the cleanup remove call
    // throws synchronously (e.g. network error). The job must still be reset
    // and the real insert error must be preserved in last_error.
    const insertErrMsg = "insert failed: connection timeout";
    const { sc, updates, inserts, storageCalls } = makeFakeClientWithStorage({
      insertError: { message: insertErrMsg },
    });

    // Override the storage remove to throw.
    const originalStorageFrom = sc.storage.from.bind(sc.storage);
    sc.storage.from = function (bucket: string) {
      const b = originalStorageFrom(bucket);
      b.remove = function (_paths: string[]) {
        throw new Error("Storage remove failed: network error");
      };
      return b;
    };

    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    // All uploads completed before the insert failure.
    assert.equal(storageCalls.length, CANDIDATE_COUNT);

    // Insert was attempted but failed.
    assert.equal(inserts.length, 1);

    // Despite the cleanup throwing, the cycle must still report failure (not
    // crash) and the queue row must be updated with the original insert error.
    assert.equal(result.processed, false);

    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed insert must never reach review_required even when cleanup also throws",
    );

    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first failure must go back to queued");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(insertErrMsg),
      `last_error must carry the original insert error, not the cleanup error; got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null, "lock must be cleared even when cleanup throws");
    assert.equal(fail!.payload.locked_by, null);
  });

  it("preserves the original insert error in last_error when cleanup remove() silently returns an error object", async () => {
    // All uploads succeed; the stamp_artwork_versions insert fails; and the
    // cleanup remove() call resolves with { error: { message: '...' } } (no
    // throw). The job must still be reset and last_error must carry the original
    // insert error — not the cleanup error.
    const insertErrMsg = "insert failed: unique constraint violation";
    const removeErrMsg = "remove failed: storage bucket unreachable";
    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      insertError: { message: insertErrMsg },
      removeError: { message: removeErrMsg },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    // The cycle must report failure.
    assert.equal(result.processed, false, "processed must be false when the insert fails");

    // All uploads completed before the insert was attempted.
    assert.equal(storageCalls.length, CANDIDATE_COUNT, "all uploads must complete before the insert");

    // The insert was attempted (and failed).
    assert.equal(inserts.length, 1, "the insert must have been attempted");

    // The cleanup remove() was called (the worker still tried to clean up).
    assert.equal(deleteCalls.length, 1, "remove() must be called for orphan cleanup");

    // The job must never reach review_required.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed insert must never reach review_required",
    );

    // The failure update must carry the original insert error — not the remove error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first failure must go back to queued");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(insertErrMsg),
      `last_error must carry the original insert error, not the cleanup error; got: ${fail!.payload.last_error}`,
    );
    assert.equal(
      fail!.payload.last_error.includes(removeErrMsg),
      false,
      "last_error must not be overwritten with the cleanup remove error",
    );
    assert.equal(fail!.payload.locked_until, null, "lock must be cleared even when cleanup silently errors");
    assert.equal(fail!.payload.locked_by, null);
  });

  it("still deletes orphaned files when the insert failure follows all uploads", async () => {
    // All CANDIDATE_COUNT uploads succeed; only the DB insert fails.
    // Cleanup must delete all uploaded paths.
    const insertErrMsg = "insert failed: FK violation";
    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      insertError: { message: insertErrMsg },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    await runGenerationCycle();

    // All uploads completed before the insert.
    assert.equal(storageCalls.length, CANDIDATE_COUNT);

    // Cleanup delete must have been issued for every uploaded path.
    assert.equal(deleteCalls.length, 1, "must issue exactly one storage delete call for cleanup");
    const { paths } = deleteCalls[0];
    assert.equal(paths.length, CANDIDATE_COUNT, "all uploaded paths must be cleaned up");
    for (const call of storageCalls) {
      assert.ok(paths.includes(call.path), `uploaded path ${call.path} must be in the delete list`);
    }

    // last_error must carry the insert error, not a cleanup error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update");
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(insertErrMsg),
      `last_error must carry the insert error, got: ${fail!.payload.last_error}`,
    );
  });

  it("reaches retryable_failed when attempts are exhausted by insert errors", async () => {
    // Simulate a job that has already used max_attempts - 1 attempts.
    const exhaustedJob = { ...JOB, attempts: 2, max_attempts: 3 };

    const insertErrMsg = "insert failed: FK violation";
    const { sc, updates } = makeFakeClientWithStorage({
      insertError: { message: insertErrMsg },
      jobOverride: exhaustedJob,
    });

    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // With attempts 2 + 1 = 3 >= max_attempts 3, status must be retryable_failed.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update");
    assert.equal(
      fail!.payload.status,
      "retryable_failed",
      "exhausted attempts must produce retryable_failed, not queued",
    );
    assert.equal(fail!.payload.attempts, 3);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(insertErrMsg),
      `last_error must contain the insert error, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
  });

  it("cleans up only real upload paths — not placeholder paths — when a mixed-batch insert fails", async () => {
    // Provider: 1 data-URL placeholder + 2 real http URLs = CANDIDATE_COUNT (3) total.
    // All fetches and uploads succeed; the DB insert returns an error.
    // Expected: deleteCalls contains exactly the 2 real upload paths (matching
    // storageCalls); the placeholder data-URL must never produce a storage path
    // or appear in the delete list.
    const insertErrMsg = "insert failed: unique constraint violation on mixed batch";
    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      insertError: { message: insertErrMsg },
    });
    _setTestServiceClient(sc);
    // 1 data-URL placeholder + 2 real http URLs = CANDIDATE_COUNT (3) candidates total.
    _setTestStampImageProvider(makeMixedProvider(1, 2));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    // The cycle must report failure.
    assert.equal(result.processed, false);

    // Exactly 2 storage uploads — only the real http candidates are uploaded;
    // the data-URL placeholder is never sent to storage.
    assert.equal(
      storageCalls.length,
      2,
      "exactly 2 real http candidates must be uploaded (placeholder skipped)",
    );

    // The insert was attempted but failed.
    assert.equal(inserts.length, 1, "the batch insert must have been attempted");

    // No review_required update.
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed insert must never reach review_required",
    );

    // Failure update present.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first insert failure must go back to queued");
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(insertErrMsg),
      `last_error must carry the insert error, got: ${fail!.payload.last_error}`,
    );

    // Orphan cleanup: exactly one delete call issued.
    assert.equal(
      deleteCalls.length,
      1,
      "must issue exactly one storage delete call for orphan cleanup",
    );
    const { paths: deletedPaths } = deleteCalls[0];

    // The delete list must contain exactly the 2 real upload paths.
    assert.equal(
      deletedPaths.length,
      2,
      "deleted paths must contain exactly 2 entries — one per real upload (placeholder excluded)",
    );

    // Every real uploaded path must appear in the delete list.
    for (const call of storageCalls) {
      assert.ok(
        deletedPaths.includes(call.path),
        `real upload path ${call.path} must appear in the orphan-cleanup delete list`,
      );
    }

    // All deleted paths must be real catalog storage paths (not placeholder-derived).
    for (const p of deletedPaths) {
      assert.ok(
        p.startsWith("catalog/cat-1/") && p.endsWith(".png"),
        `deleted path must be a real catalog storage path, got: ${p}`,
      );
    }

    // No placeholder-derived path (data: URI or synthetic path) must appear in the delete list.
    assert.equal(
      deletedPaths.some((p: string) => p.startsWith("data:") || p.startsWith("placeholder/")),
      false,
      "placeholder-derived paths must never appear in the orphan-cleanup delete list",
    );
  });
});

// ── Orphan cleanup failure: original error must survive in last_error ──────────

describe("runGenerationCycle — orphan cleanup throws: original error preserved in last_error", () => {
  it("preserves the original upload error in last_error when cleanup remove() also throws", async () => {
    // Set up: second upload fails (generation error), cleanup remove() also throws.
    let uploadCall = 0;
    const originalUploadError = "Storage upload failed: bucket quota exceeded";
    const cleanupError = "Storage remove failed: bucket unreachable";
    let cleanupThrew = false;

    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 2) throw new Error(originalUploadError);
      },
      onRemove(_paths) {
        cleanupThrew = true;
        throw new Error(cleanupError);
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    // Must not throw or produce an unhandled rejection.
    const result = await runGenerationCycle();

    // 1. Job is re-queued (not permanently_failed).
    assert.equal(result.processed, false);
    assert.equal(
      updates.some((u) => u.payload.status === "permanently_failed"),
      false,
      "a cleanup failure must never cause permanently_failed",
    );
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed run must never reach review_required",
    );

    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(
      fail!.payload.status,
      "queued",
      "first failure (attempts < max) must go back to queued for retry",
    );
    assert.equal(fail!.payload.attempts, 1);

    // 2. last_error reflects the original upload failure — not the cleanup error.
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(originalUploadError),
      `last_error must carry the original upload error, got: ${fail!.payload.last_error}`,
    );
    assert.ok(
      !fail!.payload.last_error.includes(cleanupError),
      `last_error must NOT be overwritten by the cleanup error, got: ${fail!.payload.last_error}`,
    );

    // 3. Cleanup was attempted (remove was called), confirming the cleanup path ran.
    assert.equal(cleanupThrew, true, "onRemove must have been called and thrown");
    // The first upload succeeded, so cleanup should have been attempted.
    assert.equal(storageCalls.length, 1, "exactly one upload should have succeeded before the failure");
    // deleteCalls is empty because remove() threw before the push recorded it.
    assert.equal(deleteCalls.length, 0, "no delete recorded when remove() threw before completing");

    // 4. Lock is cleared regardless of cleanup outcome.
    assert.equal(fail!.payload.locked_until, null, "locked_until must be cleared after failure");
    assert.equal(fail!.payload.locked_by, null, "locked_by must be cleared after failure");

    // 5. No version rows inserted.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch failure");
  });

  it("logs orphan_cleanup_error with job_id, catalog_id, and paths so ops can reconstruct the full cleanup scope", async () => {
    // One upload succeeds; the second upload fails (generation error path fires);
    // cleanup remove() throws. The orphan_cleanup_error log event must be parseable
    // JSON and must carry job_id, catalog_id, AND paths — so ops know exactly
    // which files need manual removal without bucket access.
    let uploadCall = 0;
    const originalUploadError = "Storage upload failed: bucket quota exceeded";
    const cleanupErrorMsg = "Storage remove failed: network timeout";

    const { sc, storageCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 2) throw new Error(originalUploadError);
      },
      onRemove(_paths) {
        throw new Error(cleanupErrorMsg);
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    // Capture console.error lines so we can inspect the logged JSON payload.
    const loggedErrors: string[] = [];
    const origError = console.error.bind(console);
    console.error = (...args: any[]) => { loggedErrors.push(args.join(" ")); origError(...args); };

    try {
      await runGenerationCycle();
    } finally {
      console.error = origError;
    }

    // The first upload should have succeeded before the second failed.
    assert.equal(storageCalls.length, 1, "exactly one upload should have succeeded before the second failed");

    // Find the orphan_cleanup_error log line.
    const cleanupErrorLine = loggedErrors.find((l) => l.includes("orphan_cleanup_error"));
    assert.ok(
      cleanupErrorLine,
      "must log at least one line containing 'orphan_cleanup_error' when remove() throws",
    );

    // The line must be parseable as JSON (not a raw Error string).
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(cleanupErrorLine!);
    } catch {
      assert.fail(`orphan_cleanup_error log line must be parseable JSON, got: ${cleanupErrorLine}`);
    }

    // Must carry job_id so ops can correlate with the generation job.
    assert.ok(
      "job_id" in parsed && typeof parsed.job_id === "string" && parsed.job_id.length > 0,
      `orphan_cleanup_error must include a non-empty job_id, got: ${JSON.stringify(parsed)}`,
    );

    // Must carry catalog_id so ops can identify which catalog entry is affected.
    assert.ok(
      "catalog_id" in parsed && typeof parsed.catalog_id === "string" && parsed.catalog_id.length > 0,
      `orphan_cleanup_error must include a non-empty catalog_id, got: ${JSON.stringify(parsed)}`,
    );

    // Must carry paths so ops can enumerate every file that needs manual removal
    // without needing bucket access. This is the key ops-visibility assertion:
    // the log alone must be sufficient to reconstruct the full cleanup scope.
    assert.ok(
      "paths" in parsed && Array.isArray(parsed.paths),
      `orphan_cleanup_error must include a paths array, got: ${JSON.stringify(parsed)}`,
    );

    const paths = parsed.paths as unknown[];
    assert.ok(
      paths.length > 0,
      `paths array must be non-empty when at least one upload preceded the failure, got: ${JSON.stringify(parsed)}`,
    );

    // Each entry in paths must be the exact storage path that was uploaded,
    // so ops can issue targeted deletes.
    assert.equal(
      paths[0],
      storageCalls[0].path,
      `paths[0] must match the uploaded storage path; got paths[0]=${paths[0]}, uploaded=${storageCalls[0].path}`,
    );
  });

  it("preserves the original DB insert error in last_error when cleanup remove() also throws", async () => {
    // All uploads succeed; DB insert fails; cleanup remove() also throws.
    const originalInsertError = "insert failed: unique constraint violation";
    const cleanupError = "Storage remove failed: permission denied";
    let cleanupThrew = false;

    const { sc, updates, storageCalls } = makeFakeClientWithStorage({
      insertError: { message: originalInsertError },
      onRemove(_paths) {
        cleanupThrew = true;
        throw new Error(cleanupError);
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    // Must not throw or produce an unhandled rejection.
    const result = await runGenerationCycle();

    assert.equal(result.processed, false);

    // All uploads completed before the insert failure.
    assert.equal(storageCalls.length, CANDIDATE_COUNT);

    // Cleanup was attempted.
    assert.equal(cleanupThrew, true, "onRemove must have been called and thrown");

    // last_error carries the original insert error — not the cleanup error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(originalInsertError),
      `last_error must carry the original insert error, got: ${fail!.payload.last_error}`,
    );
    assert.ok(
      !fail!.payload.last_error.includes(cleanupError),
      `last_error must NOT be overwritten by the cleanup error, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null);
    assert.equal(fail!.payload.locked_by, null);
  });
});

// ── Orphan cleanup: remove() returns error object instead of throwing ──────────

describe("runGenerationCycle — orphan cleanup: remove() returns error object (no throw)", () => {
  it("logs orphan_cleanup_error, preserves original last_error, and still resets the job when remove() resolves with an error", async () => {
    // Second upload fails → generation error path fires. The storage remove()
    // call does NOT throw; instead it resolves with { error: { message: "..." } }.
    // The worker must detect the returned error, log orphan_cleanup_error (not
    // the success event), and preserve the original generation error in last_error.
    let uploadCall = 0;
    const originalUploadError = "Storage upload failed: bucket quota exceeded";
    const removeErrorMessage = "object not found";

    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 2) throw new Error(originalUploadError);
      },
      removeError: { message: removeErrorMessage },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    // Capture console output to assert which event was logged.
    const loggedErrors: string[] = [];
    const loggedInfos: string[] = [];
    const origError = console.error.bind(console);
    const origLog = console.log.bind(console);
    console.error = (...args: any[]) => { loggedErrors.push(args.join(" ")); origError(...args); };
    console.log   = (...args: any[]) => { loggedInfos.push(args.join(" ")); origLog(...args); };

    let result: Awaited<ReturnType<typeof runGenerationCycle>>;
    try {
      result = await runGenerationCycle();
    } finally {
      console.error = origError;
      console.log   = origLog;
    }

    // 1. Cycle reports failure (generation itself failed).
    assert.equal(result!.processed, false, "processed must be false when generation fails");

    // 2. No permanently_failed or review_required.
    assert.equal(
      updates.some((u) => u.payload.status === "permanently_failed"),
      false,
      "a silent cleanup error must never cause permanently_failed",
    );
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed run must never reach review_required",
    );

    // 3. First upload succeeded; cleanup delete was called (remove resolved, did not throw).
    assert.equal(storageCalls.length, 1, "first upload should have succeeded before the second failed");
    assert.equal(deleteCalls.length, 1, "remove() must have been called for the orphaned upload");

    // 4. orphan_cleanup_error must be logged — not the success event.
    const hasCleanupError = loggedErrors.some(
      (l) => l.includes("orphan_cleanup_error") && l.includes(removeErrorMessage),
    );
    const hasCleanupSuccess = loggedInfos.some((l) => l.includes('"orphan_cleanup"'));
    assert.equal(
      hasCleanupError,
      true,
      "must log orphan_cleanup_error when remove() resolves with an error object",
    );
    assert.equal(
      hasCleanupSuccess,
      false,
      "must NOT log orphan_cleanup (success) when remove() returned an error",
    );

    // 4b. orphan_cleanup_error log entry must include the affected paths array.
    const cleanupErrorLine = loggedErrors.find(
      (l) => l.includes("orphan_cleanup_error") && l.includes(removeErrorMessage),
    );
    let parsedCleanupError: any;
    try {
      parsedCleanupError = JSON.parse(cleanupErrorLine!);
    } catch {
      assert.fail(`orphan_cleanup_error log line must be parseable JSON, got: ${cleanupErrorLine}`);
    }
    assert.ok(
      Array.isArray(parsedCleanupError.paths) && parsedCleanupError.paths.length > 0,
      `orphan_cleanup_error must include a non-empty paths array so ops can manually recover files, got: ${JSON.stringify(parsedCleanupError)}`,
    );
    assert.equal(
      parsedCleanupError.paths.length,
      1,
      `paths must list exactly the one successfully uploaded file (upload #1 succeeded, upload #2 threw), got: ${JSON.stringify(parsedCleanupError.paths)}`,
    );

    // 5. Job is reset and last_error carries the original generation error — not the cleanup error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first failure (attempts < max) must go back to queued");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(originalUploadError),
      `last_error must carry the original upload error, got: ${fail!.payload.last_error}`,
    );
    assert.ok(
      !fail!.payload.last_error.includes(removeErrorMessage),
      `last_error must NOT be overwritten by the cleanup error, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null, "lock must be cleared even when cleanup returns an error");
    assert.equal(fail!.payload.locked_by, null);

    // 6. No version rows inserted.
    assert.equal(inserts.length, 0, "must not insert any version rows after a mid-batch failure");
  });

  it("writes cleanup_error and cleanup_error_paths to the queue row when remove() resolves with an error", async () => {
    // Ensures the admin badge appears for the silent-error path — not just
    // when remove() throws.
    let uploadCall = 0;
    const originalUploadError = "Storage upload failed: quota exceeded";
    const removeErrorMessage = "object not found";

    const { sc, updates, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 2) throw new Error(originalUploadError);
      },
      removeError: { message: removeErrorMessage },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    try {
      await runGenerationCycle();
    } finally {
      restoreFetch();
      _setTestServiceClient(null);
      _setTestStampImageProvider(null);
    }

    // remove() was called once (one orphaned upload from the first slot).
    assert.equal(storageCalls.length, 1, "first upload should have succeeded");
    assert.equal(deleteCalls.length, 1, "remove() must have been called");

    // Wait one microtask tick so the fire-and-forget .then() resolves.
    await Promise.resolve();

    // A cleanup_error update must have been written to the queue row.
    const cleanupUpdate = updates.find(
      (u) => u.table === "stamp_generation_queue" && u.payload.cleanup_error !== undefined,
    );
    assert.ok(
      cleanupUpdate,
      "must write cleanup_error to the queue row when remove() resolves with an error object",
    );
    assert.equal(
      cleanupUpdate!.payload.cleanup_error,
      removeErrorMessage,
      "cleanup_error must carry the remove() error message",
    );
    assert.ok(
      Array.isArray(cleanupUpdate!.payload.cleanup_error_paths) &&
        cleanupUpdate!.payload.cleanup_error_paths.length > 0,
      "cleanup_error_paths must list the orphaned file paths",
    );
  });

  it("logs orphan_cleanup_error and preserves the original DB insert error in last_error when remove() resolves with an error after a failed insert", async () => {
    // All CANDIDATE_COUNT uploads succeed; the stamp_artwork_versions insert
    // returns a DB error; and then storage.remove() resolves with
    // { data: null, error: { message: "..." } } instead of throwing.
    // The worker must detect the returned error object and log orphan_cleanup_error
    // (not the success event), while preserving the original insert error in last_error.
    const originalInsertError = "insert failed: unique constraint violation on stamp_artwork_versions_pkey";
    const removeErrorMessage = "storage remove failed: object not found";

    const { sc, updates, inserts, storageCalls, deleteCalls } = makeFakeClientWithStorage({
      insertError: { message: originalInsertError },
      removeError: { message: removeErrorMessage },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    // Capture console output to assert which event was logged.
    const loggedErrors: string[] = [];
    const loggedInfos: string[] = [];
    const origError = console.error.bind(console);
    const origLog = console.log.bind(console);
    console.error = (...args: any[]) => { loggedErrors.push(args.join(" ")); origError(...args); };
    console.log   = (...args: any[]) => { loggedInfos.push(args.join(" ")); origLog(...args); };

    let result: Awaited<ReturnType<typeof runGenerationCycle>>;
    try {
      result = await runGenerationCycle();
    } finally {
      console.error = origError;
      console.log   = origLog;
    }

    // 1. All uploads completed before the insert was attempted.
    assert.equal(
      storageCalls.length,
      CANDIDATE_COUNT,
      "all candidate uploads must complete before the insert is attempted",
    );

    // 2. The insert was attempted (recorded by the fake) but failed.
    assert.equal(inserts.length, 1, "the insert must have been attempted");

    // 3. Cycle reports failure.
    assert.equal(result!.processed, false, "processed must be false when the insert fails");

    // 4. No permanently_failed or review_required.
    assert.equal(
      updates.some((u) => u.payload.status === "permanently_failed"),
      false,
      "a silent cleanup error must never cause permanently_failed",
    );
    assert.equal(
      updates.some((u) => u.payload.status === "review_required"),
      false,
      "a failed insert must never reach review_required",
    );

    // 5. Cleanup was called — remove() resolved (did not throw), so deleteCalls is populated.
    assert.equal(deleteCalls.length, 1, "remove() must have been called for the orphaned uploads");
    assert.equal(
      deleteCalls[0].paths.length,
      CANDIDATE_COUNT,
      "all uploaded paths must be passed to remove()",
    );

    // 6. orphan_cleanup_error must be logged — not the success event.
    const hasCleanupError = loggedErrors.some(
      (l) => l.includes("orphan_cleanup_error") && l.includes(removeErrorMessage),
    );
    const hasCleanupSuccess = loggedInfos.some((l) => l.includes('"' + 'orphan_cleanup"'));
    assert.equal(
      hasCleanupError,
      true,
      "must log orphan_cleanup_error when remove() resolves with an error object",
    );
    assert.equal(
      hasCleanupSuccess,
      false,
      "must NOT log orphan_cleanup (success) when remove() returned an error",
    );

    // 6b. orphan_cleanup_error log entry must include the affected paths array.
    const cleanupErrorLine = loggedErrors.find(
      (l) => l.includes("orphan_cleanup_error") && l.includes(removeErrorMessage),
    );
    let parsedCleanupError: any;
    try {
      parsedCleanupError = JSON.parse(cleanupErrorLine!);
    } catch {
      assert.fail(`orphan_cleanup_error log line must be parseable JSON, got: ${cleanupErrorLine}`);
    }
    assert.ok(
      Array.isArray(parsedCleanupError.paths) && parsedCleanupError.paths.length > 0,
      `orphan_cleanup_error must include a non-empty paths array so ops can manually recover files, got: ${JSON.stringify(parsedCleanupError)}`,
    );
    assert.equal(
      parsedCleanupError.paths.length,
      CANDIDATE_COUNT,
      `paths must list all ${CANDIDATE_COUNT} successfully uploaded files (all uploads completed before the insert failed), got: ${JSON.stringify(parsedCleanupError.paths)}`,
    );

    // 7. Job is reset; last_error carries the original insert error — not the cleanup error.
    const fail = updates.find(
      (u) => u.payload.status === "queued" || u.payload.status === "retryable_failed",
    );
    assert.ok(fail, "must record a failure update on the queue row");
    assert.equal(fail!.payload.status, "queued", "first failure (attempts < max) must go back to queued");
    assert.equal(fail!.payload.attempts, 1);
    assert.ok(
      typeof fail!.payload.last_error === "string" &&
        fail!.payload.last_error.includes(originalInsertError),
      `last_error must carry the original insert error, got: ${fail!.payload.last_error}`,
    );
    assert.ok(
      !fail!.payload.last_error.includes(removeErrorMessage),
      `last_error must NOT be overwritten by the cleanup error, got: ${fail!.payload.last_error}`,
    );
    assert.equal(fail!.payload.locked_until, null, "lock must be cleared even when cleanup returns an error");
    assert.equal(fail!.payload.locked_by, null);
  });
});

// ── Unrecognized country code: explicit fallback, not wrong art-direction ─────

describe("runGenerationCycle — catalog row with unrecognized country code (XX)", () => {
  it("buildStampPrompt returns the generic landmark fallback for an unknown country code on a country stamp", () => {
    // Verify artDirection.ts does NOT silently produce wrong art-direction for an
    // unrecognized country_code. The landmarkHint branch must reach the explicit
    // generic-fallback string rather than returning undefined or an empty string.
    const prompt = buildStampPrompt({
      id: "cat-xx",
      display_name: "Unknown Country",
      country: "Unknown",
      country_code: "XX",
      region: null,
      city: null,
      neighborhood: null,
      stamp_type: "country",
      canonical_location_key: "xx/unknown",
    });

    // The prompt must contain the generic fallback text — not an empty hint.
    assert.ok(
      prompt.includes("generalized destination motif"),
      `prompt for unknown country code must include the generic landmark fallback, got: ${prompt.slice(0, 200)}`,
    );

    // The prompt must still include the unrecognized code in the typography block
    // (it should NOT be silently stripped or replaced).
    assert.ok(
      prompt.includes("XX"),
      `prompt must reference the country code "XX" in the typography guidance, got: ${prompt.slice(0, 200)}`,
    );
  });

  it("completes the generation cycle with review_required and inserts version rows", async () => {
    // Exercise the full worker path with a catalog row whose country_code is "XX"
    // and stamp_type is "country" — this hits both the destinationInstruction
    // unknown-code path and the landmarkHint generic-fallback branch.
    const { sc, updates, inserts } = makeFakeClient({
      catalogOverride: {
        ...CATALOG_ROW,
        country_code: "XX",
        stamp_type: "country",
      },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeProvider(CANDIDATE_COUNT));

    const result = await runGenerationCycle();

    // The worker must complete successfully — unrecognized code must not crash
    // the cycle or silently route to an untested branch.
    assert.equal(result.processed, true);
    assert.equal(result.catalogId, "cat-1");

    // Version rows must be inserted — generation proceeded to completion.
    assert.equal(inserts.length, 1);
    const { table, rows } = inserts[0];
    assert.equal(table, "stamp_artwork_versions");
    assert.equal(rows.length, CANDIDATE_COUNT);
    for (const row of rows) {
      assert.equal(row.catalog_id, "cat-1");
      assert.equal(row.status, "candidate");
    }

    // Job must reach review_required — the defined successful-run outcome.
    const review = updates.find((u) => u.payload.status === "review_required");
    assert.ok(review, "must mark the job review_required after a full run with unknown country code");
    assert.equal(review!.payload.last_error, null);
    assert.equal(review!.payload.locked_until, null);
    assert.equal(review!.payload.locked_by, null);
    assert.deepEqual(review!.eqFilters, [["id", "job-1"]]);

    // Must never reach permanently_failed — the fallback is defined, not fatal.
    assert.equal(
      updates.some((u) => u.payload.status === "permanently_failed"),
      false,
      "unrecognized country code must not cause permanently_failed",
    );
  });
});

// ── Orphaned paths don't accumulate across retries with persistent cleanup failure ──

describe("runGenerationCycle — orphaned paths do not accumulate across retries when cleanup keeps failing", () => {
  it("logs two separate orphan_cleanup_error events and each cycle's cleanup covers only its own uploads", async () => {
    // Setup: provider returns CANDIDATE_COUNT http URLs per cycle.
    // The 2nd upload of each batch fails (one success then one failure per cycle),
    // and the remove() call also throws every time.
    //
    // This confirms that uploadedStoragePaths is reset per cycle: if paths
    // accumulated, cycle 2's remove call would receive paths from both cycles.
    let uploadCallTotal = 0;
    const removedPathsPerCall: string[][] = [];
    const logLines: string[] = [];

    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
      if (typeof args[0] === "string") logLines.push(args[0]);
      originalConsoleError(...args);
    };

    try {
      const { sc, storageCalls } = makeFakeClientWithStorage({
        onUpload(_path, _buf) {
          uploadCallTotal++;
          // Fail the 2nd upload of every CANDIDATE_COUNT-sized batch so exactly
          // one upload succeeds per cycle before the batch throws.
          // (uploadCallTotal 1→ok, 2→fail | 3→ok, 4→fail | ...)
          if (uploadCallTotal % 2 === 0) {
            throw new Error("Storage upload failed: quota exceeded");
          }
        },
        onRemove(paths) {
          // Record which paths each cleanup attempt received, then throw to
          // simulate storage being unreachable (triggers orphan_cleanup_error).
          removedPathsPerCall.push([...paths]);
          throw new Error("Storage remove failed: bucket unreachable");
        },
      });
      _setTestServiceClient(sc);
      _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
      installFetch(successFetch());

      // Run two cycles on the same job.
      const result1 = await runGenerationCycle();
      const result2 = await runGenerationCycle();

      // Both cycles fail because the batch upload never completes.
      assert.equal(result1.processed, false, "cycle 1 must report failure");
      assert.equal(result2.processed, false, "cycle 2 must report failure");

      // Count orphan_cleanup_error log events — must be exactly two, one per cycle.
      const cleanupErrorEvents = logLines.filter((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed.event === "stamp.generation.orphan_cleanup_error";
        } catch {
          return false;
        }
      });
      assert.equal(
        cleanupErrorEvents.length,
        2,
        "must log exactly two orphan_cleanup_error events — one per cycle, not one combined call",
      );

      // Cleanup was attempted twice — once per cycle.
      assert.equal(
        removedPathsPerCall.length,
        2,
        "storage remove must have been called once per cycle",
      );

      // Each cycle's cleanup call must reference only that cycle's own upload.
      // If uploadedStoragePaths accumulated across cycles, cycle 2's call would
      // contain 2 paths (one from each cycle) instead of just 1.
      assert.equal(
        removedPathsPerCall[0].length,
        1,
        "cycle 1 cleanup must cover exactly 1 path (its own upload only)",
      );
      assert.equal(
        removedPathsPerCall[1].length,
        1,
        "cycle 2 cleanup must cover exactly 1 path (its own upload only — not cycle 1's too)",
      );

      // The two cycles must have uploaded different paths (different versionIds).
      assert.notEqual(
        removedPathsPerCall[0][0],
        removedPathsPerCall[1][0],
        "each cycle's upload path must be distinct (different versionIds)",
      );

      // Both uploaded paths follow the correct storage template.
      for (const paths of removedPathsPerCall) {
        assert.ok(
          paths[0].startsWith("catalog/cat-1/") && paths[0].endsWith(".png"),
          `cleanup path must follow catalog/<catalogId>/<versionId>.png, got: ${paths[0]}`,
        );
      }

      // Total uploads across both cycles: 1 success per cycle (the 2nd upload of
      // each batch throws before being recorded as a successful storageCalls entry).
      assert.equal(
        storageCalls.length,
        2,
        "exactly one upload should have succeeded per cycle (2 total)",
      );

      // Each cycle's cleanup path must match that cycle's successful upload path.
      assert.equal(
        removedPathsPerCall[0][0],
        storageCalls[0].path,
        "cycle 1 cleanup path must match cycle 1's successful upload path",
      );
      assert.equal(
        removedPathsPerCall[1][0],
        storageCalls[1].path,
        "cycle 2 cleanup path must match cycle 2's successful upload path",
      );
    } finally {
      console.error = originalConsoleError;
    }
  });
});

// ── cleanup_error_paths accumulates across retries (DB-level) ─────────────────

describe("runGenerationCycle — cleanup_error_paths accumulates on the queue row across retries", () => {
  it("appends new orphaned paths to existing cleanup_error_paths rather than overwriting them", async () => {
    // Each cycle: 1st upload succeeds, 2nd throws → generation error path fires.
    // storage.remove() throws every time → orphan_cleanup_error fires each cycle.
    //
    // After two cycles the DB column must hold paths from BOTH cycles combined,
    // not just the most recent one.
    let storedCleanupPaths: string[] | null = null;
    let uploadCallTotal = 0;

    const { sc, storageCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCallTotal++;
        // Fail the 2nd upload of every pair so exactly one path is orphaned per cycle.
        if (uploadCallTotal % 2 === 0) throw new Error("Storage upload failed: quota exceeded");
      },
      onRemove(_paths) {
        throw new Error("Storage remove failed: bucket unreachable");
      },
    });

    // Patch sc.from to be stateful for cleanup_error_paths:
    //   - select("cleanup_error_paths")…maybeSingle() returns the current stored state
    //   - update({ cleanup_error_paths })  updates the stored state
    // This lets persistCleanupError read what a previous cycle wrote.
    const originalFrom = sc.from.bind(sc);
    sc.from = function (table: string) {
      const proxy = originalFrom(table);
      if (table === "stamp_generation_queue") {
        const originalSelect = proxy.select.bind(proxy);
        proxy.select = function (cols: string) {
          if (cols === "cleanup_error_paths") {
            const b: any = {
              eq() { return b; },
              maybeSingle() {
                return Promise.resolve({
                  data:  { cleanup_error_paths: storedCleanupPaths },
                  error: null,
                });
              },
            };
            return b;
          }
          return originalSelect(cols);
        };

        const originalUpdate = proxy.update.bind(proxy);
        proxy.update = function (payload: any) {
          if ("cleanup_error_paths" in payload) {
            storedCleanupPaths = payload.cleanup_error_paths;
          }
          return originalUpdate(payload);
        };
      }
      return proxy;
    };

    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    // Cycle 1: orphaned path written → [pathA]
    const result1 = await runGenerationCycle();
    // Cycle 2: reads [pathA], merges with pathB → [pathA, pathB]
    const result2 = await runGenerationCycle();

    assert.equal(result1.processed, false, "cycle 1 must report failure");
    assert.equal(result2.processed, false, "cycle 2 must report failure");

    // Each cycle uploaded exactly one file before the batch failed.
    assert.equal(storageCalls.length, 2, "exactly one upload must have succeeded per cycle");

    // The DB column must hold both paths, not just the last cycle's.
    assert.ok(storedCleanupPaths !== null, "cleanup_error_paths must be persisted on the queue row");
    assert.equal(
      storedCleanupPaths!.length,
      2,
      "cleanup_error_paths must accumulate paths from both cycles (not overwrite)",
    );
    assert.ok(
      storedCleanupPaths!.includes(storageCalls[0].path),
      `must include cycle 1 path (${storageCalls[0].path}), got: ${JSON.stringify(storedCleanupPaths)}`,
    );
    assert.ok(
      storedCleanupPaths!.includes(storageCalls[1].path),
      `must include cycle 2 path (${storageCalls[1].path}), got: ${JSON.stringify(storedCleanupPaths)}`,
    );
  });
});

describe("runGenerationCycle — removeErr path persists cleanup_error_paths to the DB", () => {
  it("writes cleanup_error_paths when remove() resolves with an error object (not just when it throws)", async () => {
    // remove() resolves with { error: { message: "..." } } — the silent-error path.
    // The worker must persist cleanup_error_paths to the queue row, not just log.
    let storedCleanupPaths: string[] | null = null;
    let uploadCall = 0;
    const removeErrorMessage = "bucket not found";

    const { sc, storageCalls } = makeFakeClientWithStorage({
      onUpload(_path, _buf) {
        uploadCall++;
        if (uploadCall === 2) throw new Error("Storage upload failed: server error");
      },
      removeError: { message: removeErrorMessage },
    });

    // Patch sc.from to track cleanup_error_paths writes.
    const originalFrom = sc.from.bind(sc);
    sc.from = function (table: string) {
      const proxy = originalFrom(table);
      if (table === "stamp_generation_queue") {
        const originalSelect = proxy.select.bind(proxy);
        proxy.select = function (cols: string) {
          if (cols === "cleanup_error_paths") {
            const b: any = {
              eq() { return b; },
              maybeSingle() {
                return Promise.resolve({
                  data:  { cleanup_error_paths: storedCleanupPaths },
                  error: null,
                });
              },
            };
            return b;
          }
          return originalSelect(cols);
        };

        const originalUpdate = proxy.update.bind(proxy);
        proxy.update = function (payload: any) {
          if ("cleanup_error_paths" in payload) {
            storedCleanupPaths = payload.cleanup_error_paths;
          }
          return originalUpdate(payload);
        };
      }
      return proxy;
    };

    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, false, "cycle must report failure");
    assert.equal(storageCalls.length, 1, "first upload must have succeeded before the second failed");

    // cleanup_error_paths must have been written to the DB even though remove()
    // resolved (did not throw).
    assert.ok(storedCleanupPaths !== null, "cleanup_error_paths must be persisted even when remove() resolves with an error");
    assert.equal(storedCleanupPaths!.length, 1, "must record exactly one orphaned path");
    assert.equal(
      storedCleanupPaths![0],
      storageCalls[0].path,
      "persisted path must match the orphaned upload",
    );
  });
});

// ── Null city in catalog row ───────────────────────────────────────────────────

describe("runGenerationCycle — catalog row with null city", () => {
  it("completes successfully and produces a prompt without literal 'null' or 'undefined' for the city", async () => {
    // Capture the prompt that the provider receives so we can inspect it.
    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        // Return CANDIDATE_COUNT data-URL placeholders so the cycle succeeds.
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc, updates, inserts } = makeFakeClient({
      catalogOverride: { ...CATALOG_ROW, city: null },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    const result = await runGenerationCycle();

    // The worker must report success — a null city must not cause a crash or
    // silent failure.
    assert.equal(result.processed, true, "a null city must not prevent the cycle from completing");
    assert.equal(result.catalogId, "cat-1");

    // Version rows must be inserted — the run is not aborted.
    assert.equal(inserts.length, 1, "must insert exactly one batch of version rows");
    assert.equal(inserts[0].rows.length, CANDIDATE_COUNT, "must insert all candidate rows");

    // Queue row must be marked review_required.
    const review = updates.find((u) => u.payload.status === "review_required");
    assert.ok(review, "must mark the job review_required on success");
    assert.equal(review!.payload.last_error, null, "last_error must be null on a clean run");

    // The prompt must have been built (provider was called).
    assert.ok(
      typeof capturedPrompt === "string" && capturedPrompt.length > 0,
      "provider must be called with a non-empty prompt",
    );

    // The prompt must NOT contain the literal strings "null" or "undefined"
    // that would result from naively interpolating a null city value.
    assert.equal(
      capturedPrompt!.includes("City: null"),
      false,
      `prompt must not contain "City: null"; got prompt snippet: ${capturedPrompt!.slice(0, 200)}`,
    );
    assert.equal(
      capturedPrompt!.includes("City: undefined"),
      false,
      `prompt must not contain "City: undefined"; got prompt snippet: ${capturedPrompt!.slice(0, 200)}`,
    );

    // The prompt must still contain the destination's display name and country.
    assert.ok(
      capturedPrompt!.includes("Tokyo"),
      "prompt must still include the display_name even when city is null",
    );
    assert.ok(
      capturedPrompt!.includes("Japan"),
      "prompt must still include the country even when city is null",
    );
  });

  it("does not insert a garbled City line when city is null", async () => {
    // Separate check: confirm the prompt contains no "City:" line at all when
    // city is null (the guard in destinationInstruction skips it entirely).
    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc } = makeFakeClient({
      catalogOverride: { ...CATALOG_ROW, city: null },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    await runGenerationCycle();

    assert.ok(
      typeof capturedPrompt === "string",
      "provider must be called",
    );
    // When city is null the entire "City: ..." line must be absent.
    assert.equal(
      /^City:/m.test(capturedPrompt!),
      false,
      `prompt must not contain any "City:" line when city is null; got: ${capturedPrompt!.slice(0, 300)}`,
    );
  });
});

// ── STYLE_VERSION stamped on inserted version rows ────────────────────────────

describe("runGenerationCycle — STYLE_VERSION stamped on every inserted version row", () => {
  it("sets prompt_template_version to STYLE_VERSION on each candidate row (data-URL path)", async () => {
    const { sc, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeProvider(CANDIDATE_COUNT));

    const result = await runGenerationCycle();

    assert.equal(result.processed, true);
    assert.equal(inserts.length, 1);
    const { rows } = inserts[0];
    assert.equal(rows.length, CANDIDATE_COUNT);
    for (const row of rows) {
      assert.equal(
        row.prompt_template_version,
        STYLE_VERSION,
        `prompt_template_version must equal STYLE_VERSION ("${STYLE_VERSION}"), got: ${row.prompt_template_version}`,
      );
    }
  });

  it("sets prompt_template_version to STYLE_VERSION on each candidate row (real http path)", async () => {
    const { sc, inserts } = makeFakeClientWithStorage();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeHttpProvider(CANDIDATE_COUNT));
    installFetch(successFetch());

    const result = await runGenerationCycle();

    assert.equal(result.processed, true);
    assert.equal(inserts.length, 1);
    const { rows } = inserts[0];
    assert.equal(rows.length, CANDIDATE_COUNT);
    for (const row of rows) {
      assert.equal(
        row.prompt_template_version,
        STYLE_VERSION,
        `prompt_template_version must equal STYLE_VERSION ("${STYLE_VERSION}") on real-http rows, got: ${row.prompt_template_version}`,
      );
    }
  });

  it("sets prompt_template_version on every candidate row in a degraded (shortfall) run", async () => {
    // STAMP_MIN_CANDIDATES=2, so 2 candidates is below CANDIDATE_COUNT but still reviewable.
    const { sc, inserts } = makeFakeClient();
    _setTestServiceClient(sc);
    _setTestStampImageProvider(makeFakeProvider(2));

    const result = await runGenerationCycle();

    assert.equal(result.processed, true);
    assert.equal(inserts.length, 1);
    const { rows } = inserts[0];
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(
        row.prompt_template_version,
        STYLE_VERSION,
        `prompt_template_version must equal STYLE_VERSION even in a degraded run, got: ${row.prompt_template_version}`,
      );
    }
  });
});

// ── isArtworkStale — stale-version detection ──────────────────────────────────

describe("isArtworkStale — detects rows generated with an outdated STYLE_VERSION", () => {
  it("returns false when prompt_template_version matches STYLE_VERSION", () => {
    assert.equal(
      isArtworkStale({ prompt_template_version: STYLE_VERSION }),
      false,
      "a row stamped with the current version is not stale",
    );
  });

  it("returns true when prompt_template_version is an older version string", () => {
    assert.equal(
      isArtworkStale({ prompt_template_version: "v0.9" }),
      true,
      "a row with an older version string must be flagged as stale",
    );
  });

  it("returns true when prompt_template_version is null (pre-versioning row)", () => {
    assert.equal(
      isArtworkStale({ prompt_template_version: null }),
      true,
      "a null version must be treated as stale (pre-dates versioning)",
    );
  });

  it("returns true when prompt_template_version is absent (pre-versioning row)", () => {
    assert.equal(
      isArtworkStale({}),
      true,
      "a missing version field must be treated as stale",
    );
  });

  it("returns true when an explicit currentVersion is supplied and the row differs", () => {
    assert.equal(
      isArtworkStale({ prompt_template_version: "v1.0" }, "v2.0"),
      true,
      "a row at v1.0 is stale relative to a bumped v2.0",
    );
  });

  it("returns false when an explicit currentVersion is supplied and the row matches", () => {
    assert.equal(
      isArtworkStale({ prompt_template_version: "v2.0" }, "v2.0"),
      false,
      "a row matching the supplied currentVersion is not stale",
    );
  });

  it("returns true for every row that does not carry STYLE_VERSION — simulating a version bump", () => {
    // Simulate what a downstream check would do after bumping STYLE_VERSION:
    // any existing row whose prompt_template_version != new version is stale.
    const bumpedVersion = "v2.0";
    const rows = [
      { prompt_template_version: "v1.0" },      // old version
      { prompt_template_version: null },          // pre-versioning
      { prompt_template_version: bumpedVersion }, // already up-to-date
      { prompt_template_version: undefined },     // missing field
    ] as Array<{ prompt_template_version?: string | null }>;

    const staleRows = rows.filter((r) => isArtworkStale(r, bumpedVersion));

    assert.equal(
      staleRows.length,
      3,
      "exactly 3 of 4 rows must be stale after a version bump (old, null, missing)",
    );
    // The up-to-date row must not appear in the stale list.
    assert.equal(
      staleRows.some((r) => r.prompt_template_version === bumpedVersion),
      false,
      "the row already at the new version must not be flagged as stale",
    );
  });
});

// ── Null country guard ────────────────────────────────────────────────────────

describe("buildStampPrompt — null country guard", () => {
  it("omits the Country line entirely when both country and country_code are null", () => {
    const entry = {
      ...CATALOG_ROW,
      country: null,
      country_code: null,
    } as any;

    const prompt = buildStampPrompt(entry);

    // No "Country:" line must appear — both fields are null so the branch
    // must be skipped entirely, not produce "Country: null" or "Country: ".
    assert.equal(
      prompt.includes("Country:"),
      false,
      `prompt must not contain "Country:" when both country and country_code are null; got:\n${prompt.slice(0, 400)}`,
    );

    // The word "null" must not appear anywhere in the prompt.
    assert.equal(
      prompt.includes("null"),
      false,
      `prompt must not contain the literal string "null" when both country fields are null; got:\n${prompt.slice(0, 400)}`,
    );
  });

  it("does not produce the literal string 'null' in the prompt when country is null", async () => {
    const catalogWithNullCountry = { ...CATALOG_ROW, country: null } as any;
    const { sc } = makeFakeClient({ catalogOverride: catalogWithNullCountry });

    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    await runGenerationCycle();

    assert.ok(
      typeof capturedPrompt === "string",
      "provider must be called",
    );
    // A null country must not produce the literal string "null" anywhere in the
    // Country line — e.g. "Country: null (JP)" is garbled and must be guarded.
    assert.equal(
      capturedPrompt!.includes("null"),
      false,
      `prompt must not contain literal "null" when country is null; got:\n${capturedPrompt!.slice(0, 400)}`,
    );
  });
});

// ── Unrecognized stamp_type routes to defined defaults ────────────────────────

describe("runGenerationCycle — unrecognized stamp_type routes to defaults", () => {
  it("completes successfully and uses the default shape instruction for an unknown stamp_type", async () => {
    // Capture the prompt so we can inspect the shape and type-hint sections.
    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc, updates, inserts } = makeFakeClient({
      catalogOverride: { ...CATALOG_ROW, stamp_type: "XX_TYPE" },
    });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    const result = await runGenerationCycle();

    // The cycle must not crash — an unrecognized stamp_type must be handled silently.
    assert.equal(result.processed, true, "an unrecognized stamp_type must not prevent the cycle from completing");
    assert.equal(result.catalogId, "cat-1");

    // Version rows must be inserted — the run is not aborted.
    assert.equal(inserts.length, 1, "must insert exactly one batch of version rows");
    assert.equal(inserts[0].rows.length, CANDIDATE_COUNT, "must insert all candidate rows");

    // Queue row must be marked review_required, not an error status.
    const review = updates.find((u) => u.payload.status === "review_required");
    assert.ok(review, "must mark the job review_required on success");
    assert.equal(review!.payload.last_error, null, "last_error must be null on a clean run");

    // Provider must be called with a non-empty prompt.
    assert.ok(
      typeof capturedPrompt === "string" && capturedPrompt.length > 0,
      "provider must be called with a non-empty prompt",
    );

    // The prompt must contain the default shape instruction from shapeInstruction()'s
    // default branch — not an empty string or an unknown-type fallback.
    assert.ok(
      capturedPrompt!.includes("classic circular stamp"),
      `prompt must contain the default shape instruction ("classic circular stamp"); ` +
        `got prompt snippet: ${capturedPrompt!.slice(0, 400)}`,
    );

    // The prompt must contain a non-empty type hint — the ?? typeHints.city fallback
    // must have fired, producing the city hint text rather than an empty string.
    assert.ok(
      capturedPrompt!.includes("iconic city skyline"),
      `prompt must contain the city-fallback type hint ("iconic city skyline") for an unrecognized stamp_type; ` +
        `got prompt snippet: ${capturedPrompt!.slice(0, 400)}`,
    );
  });

  it("uses buildStampPrompt directly to confirm both default branches fire for an unrecognized stamp_type", () => {
    // Unit-level check: call buildStampPrompt directly so neither branch is
    // hidden behind the generation cycle machinery.
    const prompt = buildStampPrompt({
      id: "cat-99",
      display_name: "Mystery Place",
      country: "Testland",
      country_code: "TS",
      region: null,
      city: null,
      neighborhood: null,
      stamp_type: "XX_TYPE",
      canonical_location_key: "ts/mystery",
    });

    // shapeInstruction() default branch must fire.
    assert.ok(
      prompt.includes("classic circular stamp"),
      `buildStampPrompt must include the default shape instruction for stamp_type "XX_TYPE"; ` +
        `got prompt snippet: ${prompt.slice(0, 400)}`,
    );

    // typeHints ?? fallback must fire — the city hint must appear.
    assert.ok(
      prompt.includes("iconic city skyline"),
      `buildStampPrompt must include the city-fallback type hint for stamp_type "XX_TYPE"; ` +
        `got prompt snippet: ${prompt.slice(0, 400)}`,
    );

    // Prompt must be non-empty and contain the destination name.
    assert.ok(prompt.includes("Mystery Place"), "prompt must include the display_name");
    assert.ok(prompt.length > 0, "prompt must not be empty");
  });
});

// ── Null display_name guard ───────────────────────────────────────────────────

describe("runGenerationCycle — null display_name in catalog row", () => {
  it("produces a prompt with a fallback label — not the literal string 'null'", async () => {
    // display_name is null; city is available as the fallback.
    const nullNameCatalog = { ...CATALOG_ROW, display_name: null };

    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc } = makeFakeClient({ catalogOverride: nullNameCatalog as any });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    await runGenerationCycle();

    assert.ok(
      typeof capturedPrompt === "string",
      "provider must be called with a prompt",
    );

    // The literal string "null" must never appear in the prompt — neither as
    // 'Destination: null' nor as 'Typography: destination name "null"'.
    assert.equal(
      capturedPrompt!.includes("null"),
      false,
      `prompt must not contain the literal string "null"; got snippet: ${capturedPrompt!.slice(0, 400)}`,
    );

    // The fallback label (city: "Tokyo") must appear instead.
    assert.ok(
      capturedPrompt!.includes("Tokyo"),
      `prompt must use the city as the fallback destination label; got snippet: ${capturedPrompt!.slice(0, 400)}`,
    );
  });

  it("falls back to region when both display_name and city are null", async () => {
    const nullNameAndCity = { ...CATALOG_ROW, display_name: null, city: null, region: "Kanto" };

    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc } = makeFakeClient({ catalogOverride: nullNameAndCity as any });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    await runGenerationCycle();

    assert.ok(typeof capturedPrompt === "string", "provider must be called");
    assert.equal(
      capturedPrompt!.includes("null"),
      false,
      `prompt must not contain the literal string "null"; got: ${capturedPrompt!.slice(0, 400)}`,
    );
    assert.ok(
      capturedPrompt!.includes("Kanto"),
      `prompt must use the region as the fallback label; got: ${capturedPrompt!.slice(0, 400)}`,
    );
  });

  it("falls back to 'Unknown Destination' when display_name, city, and region are all null", async () => {
    const allNullCatalog = {
      ...CATALOG_ROW,
      display_name: null,
      city: null,
      region: null,
    };

    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc } = makeFakeClient({ catalogOverride: allNullCatalog as any });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    await runGenerationCycle();

    assert.ok(typeof capturedPrompt === "string", "provider must be called");
    assert.equal(
      capturedPrompt!.includes("null"),
      false,
      `prompt must not contain the literal string "null"; got: ${capturedPrompt!.slice(0, 400)}`,
    );
    assert.ok(
      capturedPrompt!.includes("Unknown Destination"),
      `prompt must use "Unknown Destination" as the last-resort fallback; got: ${capturedPrompt!.slice(0, 400)}`,
    );
  });

  it("completes without throwing and prompt avoids 'null' for a country stamp when country_code is null", async () => {
    // This exercises the landmarkHint branch: stamp_type === "country" but
    // country_code is null, so the function must return the generic fallback
    // string rather than ever interpolating the literal "null" into the prompt.
    const nullCountryCodeCountryStamp = {
      ...CATALOG_ROW,
      stamp_type: "country",
      country_code: null,
    };

    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc } = makeFakeClient({ catalogOverride: nullCountryCodeCountryStamp as any });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    // Must not throw — landmarkHint must degrade gracefully when country_code is null.
    const result = await runGenerationCycle();

    assert.equal(result.processed, true, "cycle must complete successfully with a country stamp and null country_code");
    assert.ok(typeof capturedPrompt === "string", "provider must be called");
    assert.equal(
      capturedPrompt!.includes("null"),
      false,
      `prompt must not contain the literal string "null" for a country stamp with null country_code; got: ${capturedPrompt!.slice(0, 500)}`,
    );
    // landmarkHint must have returned the generic fallback text — not an empty string.
    assert.ok(
      capturedPrompt!.includes("generalized destination motif"),
      `prompt must contain the generic landmark fallback for a country stamp with null country_code; got: ${capturedPrompt!.slice(0, 500)}`,
    );
  });

  it("completes without throwing and Typography line avoids 'null' when country_code is null", async () => {
    const nullCountryCodeCatalog = {
      ...CATALOG_ROW,
      country_code: null,
    };

    let capturedPrompt: string | undefined;
    const capturingProvider = {
      async generate(prompt: string, _n?: number) {
        capturedPrompt = prompt;
        return Array.from({ length: CANDIDATE_COUNT }, (_, i) => ({
          url: `data:image/svg+xml,fake-${i}`,
          metadata: { model: "fake-provider", candidate_index: i },
        }));
      },
    };

    const { sc } = makeFakeClient({ catalogOverride: nullCountryCodeCatalog as any });
    _setTestServiceClient(sc);
    _setTestStampImageProvider(capturingProvider);

    // Must not throw a TypeError from country_code.toUpperCase().
    const result = await runGenerationCycle();

    assert.equal(result.processed, true, "cycle must complete successfully with a null country_code");
    assert.ok(typeof capturedPrompt === "string", "provider must be called");
    assert.equal(
      capturedPrompt!.includes("null"),
      false,
      `prompt must not contain the literal string "null" when country_code is null; got: ${capturedPrompt!.slice(0, 500)}`,
    );
  });
});

// ── Recognized stamp_type → type-specific shape instruction ───────────────────

describe("buildStampPrompt — every recognized stamp_type produces its own shape instruction", () => {
  /**
   * Map every recognized stamp_type to the unique text that must appear in the
   * shape instruction returned by shapeInstruction(). These strings come
   * directly from artDirection.ts so a case-label typo will cause the switch
   * to fall through to the default and the assertion will fail.
   */
  const RECOGNIZED_TYPES: Array<{ stampType: string; expectedFragment: string }> = [
    { stampType: "city",          expectedFragment: "bold circular badge with concentric ring border detail" },
    { stampType: "check_in",      expectedFragment: "bold circular badge with concentric ring border detail" },
    { stampType: "country",       expectedFragment: "rectangular passport-visa frame with ornate corner flourishes" },
    { stampType: "region",        expectedFragment: "large oval with decorative border featuring regional motifs" },
    { stampType: "neighborhood",  expectedFragment: "compact hexagonal badge with clean single-line border" },
    { stampType: "landmark",      expectedFragment: "irregular organic silhouette echoing the landmark's form, with ink-splatter edge" },
    { stampType: "hidden_gem",    expectedFragment: "diamond or irregular star with rough hand-carved edge" },
    { stampType: "special_event", expectedFragment: "festive pennant or ribbon-banner shape with dynamic edge" },
  ];

  const DEFAULT_SHAPE_TEXT = "classic circular stamp";

  for (const { stampType, expectedFragment } of RECOGNIZED_TYPES) {
    it(`stamp_type "${stampType}" includes its own shape instruction and not the default fallback`, () => {
      const prompt = buildStampPrompt({
        id: "cat-shape-test",
        display_name: "Test Place",
        country: "Testland",
        country_code: "TS",
        region: null,
        city: null,
        neighborhood: null,
        stamp_type: stampType,
        canonical_location_key: "ts/test-place",
      });

      // Must be non-empty.
      assert.ok(
        prompt.length > 0,
        `buildStampPrompt must return a non-empty prompt for stamp_type "${stampType}"`,
      );

      // Must contain the type-specific shape text.
      assert.ok(
        prompt.includes(expectedFragment),
        `buildStampPrompt for stamp_type "${stampType}" must include "${expectedFragment}"; ` +
          `got prompt snippet: ${prompt.slice(0, 400)}`,
      );

      // Must NOT fall through to the default shape instruction.
      assert.equal(
        prompt.includes(DEFAULT_SHAPE_TEXT),
        false,
        `buildStampPrompt for stamp_type "${stampType}" must NOT include the default shape text ` +
          `"${DEFAULT_SHAPE_TEXT}" — it should be using the type-specific shape; ` +
          `got prompt snippet: ${prompt.slice(0, 400)}`,
      );
    });
  }
});

// ── landmarkHint suppressed for every non-country stamp_type ─────────────────

describe("buildStampPrompt — landmarkHint is suppressed for every non-country stamp_type", () => {
  // "JP" maps to "Mount Fuji silhouette and cherry blossom" in COUNTRY_LANDMARK_HINTS.
  // A well-known, unique substring that must be absent from any non-country prompt.
  const LANDMARK_FRAGMENT = "Mount Fuji";

  const BASE_ENTRY = {
    id: "cat-jp",
    display_name: "Tokyo",
    country: "Japan",
    country_code: "JP",
    region: "Kanto",
    city: "Tokyo",
    neighborhood: null,
    canonical_location_key: "jp/tokyo",
  };

  const NON_COUNTRY_TYPES = [
    "city",
    "region",
    "neighborhood",
    "landmark",
    "hidden_gem",
    "check_in",
    "special_event",
  ] as const;

  for (const stampType of NON_COUNTRY_TYPES) {
    it(`stamp_type "${stampType}" does NOT include landmark hint text ("${LANDMARK_FRAGMENT}")`, () => {
      const prompt = buildStampPrompt({ ...BASE_ENTRY, stamp_type: stampType });

      assert.equal(
        prompt.includes(LANDMARK_FRAGMENT),
        false,
        `buildStampPrompt for stamp_type "${stampType}" must NOT include the landmark hint ` +
          `"${LANDMARK_FRAGMENT}" — landmarkHint() must return "" for non-country stamps; ` +
          `got prompt snippet: ${prompt.slice(0, 400)}`,
      );
    });
  }

  it('stamp_type "country" with country_code "JP" DOES include the landmark hint text', () => {
    const prompt = buildStampPrompt({ ...BASE_ENTRY, stamp_type: "country" });

    assert.ok(
      prompt.includes(LANDMARK_FRAGMENT),
      `buildStampPrompt for stamp_type "country" with country_code "JP" must include ` +
        `"${LANDMARK_FRAGMENT}"; got prompt snippet: ${prompt.slice(0, 400)}`,
    );
  });
});

// ── Recognized stamp_type → type-specific typeHint text ──────────────────────

describe("buildStampPrompt — every recognized stamp_type produces its own type hint", () => {
  /**
   * Map every stamp_type that has an explicit entry in the typeHints record to
   * the unique substring that must appear in its hint.  These strings are copied
   * verbatim from artDirection.ts so a missing key (or a typo in the key) will
   * cause typeHints[entry.stamp_type] to be undefined, the ?? fallback to fire,
   * and the wrong hint to appear — which the assertion will catch.
   */
  const RECOGNIZED_HINT_TYPES: Array<{
    stampType: string;
    expectedFragment: string;
  }> = [
    { stampType: "city",          expectedFragment: "iconic city skyline or landmark silhouette" },
    { stampType: "country",       expectedFragment: "national symbol, flag colors as accent palette" },
    { stampType: "region",        expectedFragment: "regional landscape or natural feature" },
    { stampType: "neighborhood",  expectedFragment: "street-level scene or local architectural detail" },
    { stampType: "landmark",      expectedFragment: "dominant illustration filling most of the stamp area" },
    { stampType: "hidden_gem",    expectedFragment: "Mysterious, intimate illustration" },
    { stampType: "special_event", expectedFragment: "Dynamic, celebratory imagery" },
  ];

  /** Unique text from the city fallback — must NOT appear for non-city types. */
  const CITY_FALLBACK_FRAGMENT = "iconic city skyline";

  for (const { stampType, expectedFragment } of RECOGNIZED_HINT_TYPES) {
    it(`stamp_type "${stampType}" includes its own type hint and not the city-fallback`, () => {
      const prompt = buildStampPrompt({
        id:                    "cat-hint-test",
        display_name:          "Test Place",
        country:               "Testland",
        country_code:          "TS",
        region:                null,
        city:                  null,
        neighborhood:          null,
        stamp_type:            stampType,
        canonical_location_key: "ts/test-place",
      });

      // Must be non-empty.
      assert.ok(
        prompt.length > 0,
        `buildStampPrompt must return a non-empty prompt for stamp_type "${stampType}"`,
      );

      // Must contain the type-specific hint text.
      assert.ok(
        prompt.includes(expectedFragment),
        `buildStampPrompt for stamp_type "${stampType}" must include the type hint ` +
          `"${expectedFragment}"; got prompt snippet: ${prompt.slice(0, 400)}`,
      );

      // For non-city types the ?? fallback must NOT have fired.
      if (stampType !== "city") {
        assert.equal(
          prompt.includes(CITY_FALLBACK_FRAGMENT),
          false,
          `buildStampPrompt for stamp_type "${stampType}" must NOT include the city-fallback ` +
            `hint text "${CITY_FALLBACK_FRAGMENT}" — each type must resolve to its own hint; ` +
            `got prompt snippet: ${prompt.slice(0, 400)}`,
        );
      }
    });
  }
});

// ── sweepStaleArtwork ─────────────────────────────────────────────────────────

/**
 * Minimal fake client for sweepStaleArtwork. The sweep performs three
 * operations in order:
 *
 *  1. stamp_artwork_versions SELECT with .or() — returns staleVersionRows
 *  2. stamp_generation_queue  SELECT with .in() — returns activeJobRows
 *  3. stamp_generation_queue  INSERT            — records enqueued jobs
 *
 * All other table names resolve to empty arrays so unrelated code paths
 * don't interfere.
 */
interface SweepFakeClientConfig {
  /** Rows returned by the stamp_artwork_versions stale-version query (Pass 2). */
  staleVersionRows: Array<{ catalog_id: string }>;
  /**
   * Rows returned by the stamp_artwork_versions current-version query (Pass 1).
   * Defaults to [] (no catalog has a current-version row).
   */
  currentVersionRows?: Array<{ catalog_id: string }>;
  /** Rows returned by the stamp_generation_queue active-jobs query. */
  activeJobRows: Array<{ catalog_id: string }>;
  /** When true, the current-version artwork select (Pass 1) resolves with an error. */
  currentQueryError?: boolean;
  /** When true, the stale-version artwork select (Pass 2) resolves with an error. */
  artworkQueryError?: boolean;
  /** When true, the active-jobs select resolves with an error. */
  activeJobsQueryError?: boolean;
  /** When true, the queue insert resolves with an error. */
  insertError?: boolean;
}

function makeSweepFakeClient(config: SweepFakeClientConfig) {
  const inserts: Array<{ table: string; rows: any[] }> = [];

  const sc: any = {
    from(table: string) {
      // ── stamp_artwork_versions ──────────────────────────────────────────────
      // The sweep now issues two queries against this table in this order:
      //   Pass 1 (stale): .select().or(filter).limit()  → staleVersionRows
      //   Pass 2 (current scoped): .select().eq().in()  → currentVersionRows
      //                            (no .limit(); resolved via .then())
      // We distinguish them by whether .or() or .in() was called.
      if (table === "stamp_artwork_versions") {
        let usedOr = false;
        let usedIn = false;
        const b: any = {
          select(_cols: string) { return b; },
          or(_filter: string)   { usedOr = true; return b; },   // Pass 1
          eq(_col: string, _val: string) { return b; },          // Pass 2 prefix
          in(_col: string, _vals: any[]) { usedIn = true; return b; }, // Pass 2
          limit(_n: number) {
            // Pass 1: stale-version query (reached via .or().limit())
            if (config.artworkQueryError) {
              return Promise.resolve({ data: null, error: { message: "artwork query error" } });
            }
            return Promise.resolve({ data: config.staleVersionRows, error: null });
          },
          then(resolve: any, reject: any) {
            // Pass 2: current-version scoped query (reached via .eq().in(), awaited directly)
            if (usedIn) {
              if (config.currentQueryError) {
                return Promise.resolve({ data: null, error: { message: "current query error" } }).then(resolve, reject);
              }
              return Promise.resolve({ data: config.currentVersionRows ?? [], error: null }).then(resolve, reject);
            }
            // Fallback (should not be reached in normal sweep flow)
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          },
        };
        return b;
      }

      // ── stamp_generation_queue ──────────────────────────────────────────────
      if (table === "stamp_generation_queue") {
        return {
          select(_cols: string) {
            const b: any = {
              in(_col: string, _vals: any[]) { return b; },
              // Second .in() call resolves with the active-jobs result.
              // We chain two .in() calls in the sweep, so we need to return
              // the data on the second one. We do it lazily: any .then()
              // resolves with the active-jobs rows, which covers the awaited
              // chain regardless of how many .in() calls precede it.
              then(resolve: any, reject: any) {
                if (config.activeJobsQueryError) {
                  return Promise.resolve({ data: null, error: { message: "active jobs query error" } }).then(resolve, reject);
                }
                return Promise.resolve({ data: config.activeJobRows, error: null }).then(resolve, reject);
              },
            };
            return b;
          },
          insert(rows: any[]) {
            inserts.push({ table, rows });
            if (config.insertError) {
              return Promise.resolve({ data: null, error: { message: "insert error" } });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      }

      // Fallback for any other table.
      return {
        select() {
          return {
            or() {
              return {
                limit() {
                  return Promise.resolve({ data: [], error: null });
                },
              };
            },
          };
        },
        insert(rows: any[]) {
          inserts.push({ table, rows });
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  };

  return { sc, inserts };
}

describe("sweepStaleArtwork — enqueues catalog entries with stale versions", () => {
  it("inserts a generation job for each catalog entry with an outdated prompt_template_version", async () => {
    const { sc, inserts } = makeSweepFakeClient({
      currentVersionRows: [],                 // no catalog has a current-version row
      staleVersionRows: [
        { catalog_id: "cat-stale-1" },
        { catalog_id: "cat-stale-2" },
        { catalog_id: "cat-stale-3" },
      ],
      activeJobRows: [], // no active jobs blocking re-enqueue
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 3, "must return the number of jobs enqueued");

    // One insert call containing all three new jobs.
    assert.equal(inserts.length, 1, "must issue exactly one batch insert");
    const { table, rows } = inserts[0];
    assert.equal(table, "stamp_generation_queue");
    assert.equal(rows.length, 3, "must insert one job per stale catalog entry");

    const enqueuedIds = new Set(rows.map((r: any) => r.catalog_id));
    assert.ok(enqueuedIds.has("cat-stale-1"), "cat-stale-1 must be enqueued");
    assert.ok(enqueuedIds.has("cat-stale-2"), "cat-stale-2 must be enqueued");
    assert.ok(enqueuedIds.has("cat-stale-3"), "cat-stale-3 must be enqueued");

    // Every inserted job must be in the queued status and carry the sweep trigger.
    for (const row of rows) {
      assert.equal(row.status, "queued", `job for ${row.catalog_id} must have status=queued`);
      assert.equal(
        row.triggered_by_action,
        "style_version_sweep",
        `job for ${row.catalog_id} must record triggered_by_action=style_version_sweep`,
      );
    }
  });

  it("also enqueues entries that have null prompt_template_version (pre-versioning rows)", async () => {
    // The .or() filter covers both null and neq cases; the fake client returns
    // whatever staleVersionRows we give it, simulating PostgREST returning null
    // rows in the same query.
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [{ catalog_id: "cat-null-version" }],
      activeJobRows: [],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 1);
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].rows[0].catalog_id, "cat-null-version");
    assert.equal(inserts[0].rows[0].status, "queued");
  });

  it("deduplicates catalog IDs when multiple stale rows share the same catalog entry", async () => {
    // Multiple artwork rows for the same catalog entry — only one job must be enqueued.
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [
        { catalog_id: "cat-dup" },
        { catalog_id: "cat-dup" },
        { catalog_id: "cat-dup" },
        { catalog_id: "cat-other" },
      ],
      activeJobRows: [],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 2, "must deduplicate catalog IDs and enqueue each catalog entry once");
    assert.equal(inserts.length, 1);
    const { rows } = inserts[0];
    assert.equal(rows.length, 2, "must insert exactly 2 jobs (one per unique catalog entry)");
    const ids = rows.map((r: any) => r.catalog_id).sort();
    assert.deepEqual(ids, ["cat-dup", "cat-other"]);
  });
});

describe("sweepStaleArtwork — does not re-enqueue catalogs that already have a current-version row (mixed-history and scale)", () => {
  it("skips a catalog that has both old and current rows — old rows are history, not a reason to re-generate", async () => {
    // cat-mixed has one old-version row (shows up in staleVersionRows) AND one
    // current-version row (shows up in currentVersionRows).  The sweep must NOT
    // enqueue it because regeneration already produced a current candidate.
    const { sc, inserts } = makeSweepFakeClient({
      currentVersionRows: [{ catalog_id: "cat-mixed" }],
      staleVersionRows:   [{ catalog_id: "cat-mixed" }, { catalog_id: "cat-new-stale" }],
      activeJobRows:      [],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 1, "must only enqueue the catalog with no current-version row");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].rows.length, 1);
    assert.equal(inserts[0].rows[0].catalog_id, "cat-new-stale",
      "must not enqueue cat-mixed which already has a current-version row");
  });

  it("enqueues no jobs when all stale catalogs already have a current-version row", async () => {
    const { sc, inserts } = makeSweepFakeClient({
      currentVersionRows: [{ catalog_id: "cat-a" }, { catalog_id: "cat-b" }],
      staleVersionRows:   [{ catalog_id: "cat-a" }, { catalog_id: "cat-b" }],
      activeJobRows:      [],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 0, "must return 0 when all stale catalogs already have current-version artwork");
    assert.equal(inserts.length, 0, "must not insert any jobs");
  });

  it("never enqueues a mixed-history catalog even when the stale page is full (>500 rows simulated)", async () => {
    // Simulate a large catalog: the stale query returns a full page of 500
    // rows, some of which belong to catalogs that already have a current-version
    // row.  The scoped current-version check (Pass 2) receives only those
    // catalog_ids, so it can never be truncated by the page limit regardless of
    // total catalog size.  Catalogs with current-version rows must be excluded.
    const PAGE_SIZE = 500;

    // Build 500 stale rows: 400 truly stale + 100 mixed-history (also have current rows).
    const trulyStaleIds = Array.from({ length: 400 }, (_, i) => `cat-stale-${i}`);
    const mixedIds      = Array.from({ length: 100 }, (_, i) => `cat-mixed-${i}`);
    const staleVersionRows = [...trulyStaleIds, ...mixedIds].map((id) => ({ catalog_id: id }));

    // The scoped current-version query returns rows for the 100 mixed catalogs.
    const currentVersionRows = mixedIds.map((id) => ({ catalog_id: id }));

    assert.equal(staleVersionRows.length, PAGE_SIZE,
      "stale page must be exactly 500 rows to simulate a full page");

    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows,
      currentVersionRows,
      activeJobRows: [],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 400, "must enqueue exactly the 400 truly-stale catalogs");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].rows.length, 400);

    const enqueuedIds = new Set(inserts[0].rows.map((r: any) => r.catalog_id));
    for (const id of trulyStaleIds) {
      assert.ok(enqueuedIds.has(id), `truly-stale catalog ${id} must be enqueued`);
    }
    for (const id of mixedIds) {
      assert.equal(enqueuedIds.has(id), false,
        `mixed-history catalog ${id} must NOT be enqueued — it already has a current-version row`);
    }
  });
});

describe("sweepStaleArtwork — skips entries with already-active jobs", () => {
  it("does not insert a new job when a queued job already exists for the stale catalog entry", async () => {
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [{ catalog_id: "cat-a" }, { catalog_id: "cat-b" }],
      // cat-a already has a queued job; cat-b does not.
      activeJobRows: [{ catalog_id: "cat-a" }],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 1, "must only enqueue the catalog entry without an active job");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].rows.length, 1);
    assert.equal(inserts[0].rows[0].catalog_id, "cat-b");
  });

  it("inserts no jobs when all stale catalog entries already have active jobs", async () => {
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [{ catalog_id: "cat-x" }, { catalog_id: "cat-y" }],
      activeJobRows:    [{ catalog_id: "cat-x" }, { catalog_id: "cat-y" }],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 0, "must return 0 when all stale entries already have active jobs");
    assert.equal(inserts.length, 0, "must not insert any jobs");
  });
});

describe("sweepStaleArtwork — re-enqueues entries whose only existing jobs are terminal", () => {
  // The active-jobs filter in sweepStaleArtwork only matches
  // queued | generating | review_required.  Terminal statuses
  // (permanently_failed, retryable_failed) are deliberately excluded so a
  // catalog that failed to generate still gets a fresh attempt after a
  // STYLE_VERSION bump.

  it("inserts a new job when the catalog entry only has a permanently_failed job", async () => {
    // Simulate: the DB active-jobs query returns nothing for cat-perm-failed
    // because the only queue row has status=permanently_failed, which is not
    // in the [queued, generating, review_required] filter.
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [{ catalog_id: "cat-perm-failed" }],
      activeJobRows:    [], // permanently_failed is not an active status
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 1, "must enqueue a new job even when the only existing job is permanently_failed");
    assert.equal(inserts.length, 1, "must issue exactly one batch insert");
    assert.equal(inserts[0].rows.length, 1);
    const job = inserts[0].rows[0];
    assert.equal(job.catalog_id, "cat-perm-failed");
    assert.equal(job.status, "queued", "new job must have status=queued");
    assert.equal(job.triggered_by_action, "style_version_sweep");
  });

  it("inserts a new job when the catalog entry only has a retryable_failed job", async () => {
    // Simulate: the DB active-jobs query returns nothing for cat-retry-failed
    // because the only queue row has status=retryable_failed, which is not
    // in the [queued, generating, review_required] filter.
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [{ catalog_id: "cat-retry-failed" }],
      activeJobRows:    [], // retryable_failed is not an active status
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 1, "must enqueue a new job even when the only existing job is retryable_failed");
    assert.equal(inserts.length, 1, "must issue exactly one batch insert");
    assert.equal(inserts[0].rows.length, 1);
    const job = inserts[0].rows[0];
    assert.equal(job.catalog_id, "cat-retry-failed");
    assert.equal(job.status, "queued", "new job must have status=queued");
    assert.equal(job.triggered_by_action, "style_version_sweep");
  });

  it("enqueues the terminal-only entry while still skipping the entry that has an active job", async () => {
    // Mixed scenario: cat-perm-failed has only a permanently_failed job
    // (not in activeJobRows), cat-active has a live queued job (in activeJobRows).
    // Only cat-perm-failed must be re-enqueued.
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [
        { catalog_id: "cat-perm-failed" },
        { catalog_id: "cat-active" },
      ],
      activeJobRows: [{ catalog_id: "cat-active" }],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 1, "must enqueue only the terminal-only entry");
    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].rows.length, 1);
    assert.equal(inserts[0].rows[0].catalog_id, "cat-perm-failed",
      "permanently_failed-only entry must be enqueued; active-job entry must be skipped");
  });
});

describe("sweepStaleArtwork — produces no jobs when all artwork is current", () => {
  it("returns 0 and issues no insert when the stale-version query returns no rows", async () => {
    // All artwork rows have the current STYLE_VERSION, so the .or() filter
    // returns an empty result set.
    const { sc, inserts } = makeSweepFakeClient({
      staleVersionRows: [], // nothing stale
      activeJobRows:    [],
    });

    const count = await sweepStaleArtwork(sc);

    assert.equal(count, 0, "must return 0 when no stale artwork exists");
    assert.equal(inserts.length, 0, "must not insert any jobs when all artwork is current");
  });
});

describe("sweepStaleArtwork — logs a warning when the stale page hits the size limit", () => {
  function captureWarn(): { get: () => string[]; restore: () => void } {
    const captured: string[] = [];
    const orig = console.warn;
    console.warn = (...args: any[]) => { captured.push(...args.map(String)); };
    return { get: () => captured, restore: () => { console.warn = orig; } };
  }
  function parseWarnEvents(captured: string[]) {
    return captured
      .map((a) => { try { return JSON.parse(a); } catch { return null; } })
      .filter(Boolean);
  }

  it("emits a stamp.sweep.page_limit_reached warning when the stale query returns exactly 500 rows and jobs are enqueued", async () => {
    const PAGE_SIZE = 500;
    const staleVersionRows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ catalog_id: `cat-limit-${i}` }));

    const { sc } = makeSweepFakeClient({
      staleVersionRows,
      currentVersionRows: [],
      activeJobRows: [],
    });

    const { get, restore } = captureWarn();
    try {
      await sweepStaleArtwork(sc);
    } finally {
      restore();
    }

    const limitWarn = parseWarnEvents(get()).find((e: any) => e.event === "stamp.sweep.page_limit_reached");
    assert.ok(limitWarn, "must emit a stamp.sweep.page_limit_reached warning when the stale query hits the page limit");
    assert.equal(limitWarn.page_size, PAGE_SIZE, "warning must include the page_size");
  });

  it("emits a page_limit_reached warning even when all 500 stale rows already have active jobs (toEnqueue=0)", async () => {
    const PAGE_SIZE = 500;
    const staleVersionRows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ catalog_id: `cat-active-${i}` }));
    // All stale catalog IDs already have active jobs — nothing is enqueued.
    const activeJobRows = staleVersionRows.map((r) => ({ catalog_id: r.catalog_id }));

    const { sc } = makeSweepFakeClient({
      staleVersionRows,
      currentVersionRows: [],
      activeJobRows,
    });

    const { get, restore } = captureWarn();
    try {
      await sweepStaleArtwork(sc);
    } finally {
      restore();
    }

    const limitWarn = parseWarnEvents(get()).find((e: any) => e.event === "stamp.sweep.page_limit_reached");
    assert.ok(limitWarn, "must emit a page_limit_reached warning even when no new jobs are enqueued (all rows already active)");
    assert.equal(limitWarn.page_size, PAGE_SIZE, "warning must include the page_size");
  });

  it("emits a page_limit_reached warning even when all 500 stale rows are actually current-version (trulyStale=0)", async () => {
    const PAGE_SIZE = 500;
    const staleVersionRows = Array.from({ length: PAGE_SIZE }, (_, i) => ({ catalog_id: `cat-current-${i}` }));
    // All entries in the stale page also have a current-version row — truly stale set is empty.
    const currentVersionRows = staleVersionRows.map((r) => ({ catalog_id: r.catalog_id }));

    const { sc } = makeSweepFakeClient({
      staleVersionRows,
      currentVersionRows,
      activeJobRows: [],
    });

    const { get, restore } = captureWarn();
    try {
      await sweepStaleArtwork(sc);
    } finally {
      restore();
    }

    const limitWarn = parseWarnEvents(get()).find((e: any) => e.event === "stamp.sweep.page_limit_reached");
    assert.ok(limitWarn, "must emit a page_limit_reached warning even when no catalogs are truly stale (all have current-version rows)");
    assert.equal(limitWarn.page_size, PAGE_SIZE, "warning must include the page_size");
  });

  it("does not emit a page_limit_reached warning when fewer rows than the page size are returned", async () => {
    const { sc } = makeSweepFakeClient({
      staleVersionRows: [{ catalog_id: "cat-a" }, { catalog_id: "cat-b" }],
      currentVersionRows: [],
      activeJobRows: [],
    });

    const { get, restore } = captureWarn();
    try {
      await sweepStaleArtwork(sc);
    } finally {
      restore();
    }

    const limitWarn = parseWarnEvents(get()).find((e: any) => e.event === "stamp.sweep.page_limit_reached");
    assert.equal(limitWarn, undefined, "must NOT emit a page_limit_reached warning when the page is not full");
  });
});

// ── sweepStaleArtwork wired into runGenerationCycle ────────────────────────────

describe("runGenerationCycle — calls sweepStaleArtwork when the sweep interval has elapsed", () => {
  it("enqueues stale catalog entries found during a cycle even when there is no job to process", async () => {
    // Build a fake client that:
    //  - returns null for the queue claim (no job to process)
    //  - returns one stale artwork row so the sweep has work to do
    //  - records any inserts so the test can assert on them
    const cycleInserts: Array<{ table: string; rows: any[] }> = [];

    const sc: any = {
      from(table: string) {
        // ── stamp_artwork_versions — two-pass sweep queries ──────────────────
        // Pass 1 (.or().limit()): stale-version rows → one stale catalog
        // Pass 2 (.eq().in(), awaited directly): current-version scoped check → empty
        if (table === "stamp_artwork_versions") {
          let usedIn = false;
          const b: any = {
            select() { return b; },
            or()     { return b; },
            eq()     { return b; },
            in()     { usedIn = true; return b; },
            limit()  {
              // Pass 1: stale rows — one catalog needs regeneration
              return Promise.resolve({
                data: [{ catalog_id: "cat-sweep-from-cycle" }],
                error: null,
              });
            },
            then(resolve: any, reject: any) {
              // Pass 2: current-version scoped check — no catalog is current yet
              if (usedIn) {
                return Promise.resolve({ data: [], error: null }).then(resolve, reject);
              }
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            },
          };
          return b;
        }

        // ── stamp_generation_queue ───────────────────────────────────────────
        if (table === "stamp_generation_queue") {
          return {
            select(_cols: string) {
              const b: any = {
                // eq / or / lt / order / limit chains used for the job claim.
                eq()    { return b; },
                or()    { return b; },
                lt()    { return b; },
                order() { return b; },
                // in() chains used by the active-jobs check inside the sweep.
                in()    { return b; },
                limit() {
                  return {
                    maybeSingle() {
                      // No queued job — the cycle exits early after the sweep.
                      return Promise.resolve({ data: null, error: null });
                    },
                  };
                },
                then(resolve: any, reject: any) {
                  // Active-jobs query inside sweepStaleArtwork: no active jobs.
                  return Promise.resolve({ data: [], error: null }).then(resolve, reject);
                },
              };
              return b;
            },
            insert(rows: any[]) {
              cycleInserts.push({ table, rows });
              return Promise.resolve({ data: null, error: null });
            },
          };
        }

        // Fallback — should not be reached in this test.
        return {
          select() {
            return {
              eq()    { return this; },
              order() { return this; },
              limit() {
                return { maybeSingle() { return Promise.resolve({ data: null, error: null }); } };
              },
            };
          },
        };
      },
    };

    // Reset sweep timer so the interval check passes immediately.
    resetStaleArtworkSweepState();
    _setTestServiceClient(sc);

    const result = await runGenerationCycle();

    // The cycle found no queued job, so processed is false.
    assert.equal(result.processed, false, "cycle must report no job processed");

    // The sweep fired during the cycle and inserted one job for the stale
    // catalog entry discovered in stamp_artwork_versions.
    assert.equal(
      cycleInserts.length,
      1,
      "the sweep must have inserted a generation job during the cycle",
    );
    assert.equal(cycleInserts[0].table, "stamp_generation_queue");
    assert.equal(cycleInserts[0].rows.length, 1);
    assert.equal(cycleInserts[0].rows[0].catalog_id, "cat-sweep-from-cycle");
    assert.equal(cycleInserts[0].rows[0].status, "queued");
    assert.equal(cycleInserts[0].rows[0].triggered_by_action, "style_version_sweep");
  });
});

// ── evaluateCandidateShortfall — zero-produced run ────────────────────────────

describe("evaluateCandidateShortfall — zero produced", () => {
  it("classifies produced=0 as failed, not degraded or ok", () => {
    const result = evaluateCandidateShortfall(0, CANDIDATE_COUNT);

    assert.equal(
      result.outcome,
      "failed",
      `expected outcome "failed" for produced=0, got "${result.outcome}"`,
    );
    assert.ok(
      result.shortfallMessage !== null &&
        result.shortfallMessage.startsWith(CANDIDATE_SHORTFALL_PREFIX),
      `expected shortfallMessage to start with "${CANDIDATE_SHORTFALL_PREFIX}", got: ${result.shortfallMessage}`,
    );
  });
});

// ── landmarkHint null country_code fallback ───────────────────────────────────

describe("buildStampPrompt — country stamp with null country_code", () => {
  it("falls back to the generic landmark motif phrase without emitting 'null'", () => {
    const entry = {
      ...CATALOG_ROW,
      stamp_type: "country",
      country_code: null,
    };

    const prompt = buildStampPrompt(entry);

    assert.ok(
      !prompt.includes("null"),
      `prompt must not contain the literal string "null", got:\n${prompt}`,
    );
    assert.ok(
      prompt.includes(
        "Use a generalized destination motif representing the country's most iconic natural or cultural feature.",
      ),
      `prompt must contain the generic landmark fallback text, got:\n${prompt}`,
    );
  });
});
