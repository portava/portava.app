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
  /**
   * When set, the `stamp_artwork_versions` insert returns this as an error
   * instead of succeeding. All other inserts are unaffected.
   */
  insertError?: { message: string };
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
  const base = makeFakeClient();
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
          deleteCalls.push({ paths });
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
    assert.equal(paths[0], storageCalls[0].path, "deleted path must match the orphaned upload path");
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

// ── DB insert failure after all uploads succeed ───────────────────────────────

describe("runGenerationCycle — DB insert failure after all uploads succeed", () => {
  it("resets job status to queued, records last_error, and clears the lock", async () => {
    // All uploads succeed; the version-row batch insert returns a DB error.
    const insertErrMsg = "duplicate key value violates unique constraint \"stamp_artwork_versions_pkey\"";
    const { sc, updates, inserts, storageCalls } = makeFakeClientWithStorage({
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
  });

  it("reaches retryable_failed when attempts are exhausted by insert errors", async () => {
    // Simulate a job that has already used max_attempts - 1 attempts.
    const exhaustedJob = { ...JOB, attempts: 2, max_attempts: 3 };

    // Patch the queue select to return an exhausted job.
    const insertErrMsg = "insert failed: FK violation";
    const { sc, updates } = makeFakeClientWithStorage({
      insertError: { message: insertErrMsg },
    });

    // Override maybeSingle for the queue to return the exhausted job.
    const originalFrom = sc.from.bind(sc);
    sc.from = function (table: string) {
      const proxy = originalFrom(table);
      if (table === "stamp_generation_queue") {
        const origSelect = proxy.select.bind(proxy);
        proxy.select = function (cols: string) {
          const b = origSelect(cols);
          b.maybeSingle = function () {
            return Promise.resolve({ data: { ...exhaustedJob }, error: null });
          };
          return b;
        };
      }
      return proxy;
    };

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
});
