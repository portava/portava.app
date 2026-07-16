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

// ── Storage-aware fake client ─────────────────────────────────────────────────

interface StorageConfig {
  /** Called for every upload. Throw to simulate an upload failure. */
  onUpload?: (path: string, buffer: Buffer) => void;
  /** Base URL prepended to the storage path for getPublicUrl. */
  publicUrlBase?: string;
}

interface StorageCall {
  path: string;
  bufferLength: number;
}

/**
 * Extends the base fake client with a `storage` mock so tests can exercise
 * the real downloadImageBuffer + uploadToStorage code paths (http URLs).
 *
 * By default every upload succeeds and returns a public URL of the form
 * `https://storage.fake/<path>`. Pass `onUpload` to inject failures.
 */
function makeFakeClientWithStorage(opts: StorageConfig = {}) {
  const base = makeFakeClient();
  const storageCalls: StorageCall[] = [];
  const publicUrlBase = opts.publicUrlBase ?? "https://storage.fake";

  base.sc.storage = {
    from(_bucket: string) {
      return {
        upload(path: string, buffer: Buffer) {
          storageCalls.push({ path, bufferLength: buffer.length });
          if (opts.onUpload) opts.onUpload(path, buffer);
          return Promise.resolve({ error: null });
        },
        getPublicUrl(path: string) {
          return { data: { publicUrl: `${publicUrlBase}/${path}` } };
        },
      };
    },
  };

  return { ...base, storageCalls };
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
