import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clearL1Cache,
  captureCacheBuild,
  getCachedFeed,
  invalidate,
  setCachedFeed,
} from "../compass/CompassCacheEngine.js";

function deferred<Value = void>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

type CacheRow = Record<string, unknown>;

function cacheDatabase(options: {
  rows?: CacheRow[];
  readGate?: ReturnType<typeof deferred>;
  writeGate?: ReturnType<typeof deferred>;
  deleteGate?: ReturnType<typeof deferred>;
  readError?: boolean;
  deleteError?: boolean;
} = {}) {
  let rows = options.rows ?? [];
  const calls: string[] = [];
  const readStarted = deferred();
  const writeStarted = deferred();
  const deleteStarted = deferred();
  const database = {
    from(table: string) {
      const filters = new Map<string, unknown>();
      const matches = (row: CacheRow) => [...filters].every(([column, value]) => row[column] === value);
      const query = {
        select() { return query; },
        eq(column: string, value: unknown) { filters.set(column, value); return query; },
        gt() { return query; },
        async maybeSingle() {
          calls.push("read");
          const snapshot = rows.find(matches) ?? null;
          readStarted.resolve();
          await options.readGate?.promise;
          return { data: snapshot, error: options.readError ? { message: "read failed" } : null };
        },
        then(accept: (value: unknown) => unknown, refuse?: (error: unknown) => unknown) {
          assert.equal(table, "compass_feed_cache");
          return Promise.resolve({ data: rows.filter(matches), error: null }).then(accept, refuse);
        },
        async upsert(row: CacheRow) {
          calls.push("write-start");
          writeStarted.resolve();
          await options.writeGate?.promise;
          rows = rows.filter((existing) => existing.user_id !== row.user_id || existing.cache_key !== row.cache_key);
          rows.push(row);
          calls.push("write-end");
          return { error: null };
        },
        delete() {
          return {
            async eq(column: string, value: unknown) {
              calls.push("delete-start");
              deleteStarted.resolve();
              await options.deleteGate?.promise;
              if (options.deleteError) return { error: { message: "delete failed" } };
              rows = rows.filter((row) => row[column] !== value);
              calls.push("delete-end");
              return { error: null };
            },
          };
        },
        async insert() { calls.push("audit"); return { error: null }; },
      };
      return query;
    },
  };
  return {
    db: database as unknown as NonNullable<Parameters<typeof getCachedFeed>[0]>,
    calls, readStarted, writeStarted, deleteStarted,
    rows: () => rows,
  };
}

function cacheRow(viewer: string, expiry: unknown = new Date(Date.now() + 60_000).toISOString()): CacheRow {
  return { user_id: viewer, cache_key: "feed", payload: { source: viewer }, expires_at: expiry };
}

describe("Compass cache revocation and absolute expiry", () => {
  beforeEach(() => clearL1Cache());

  it("refuses a completed build captured before invalidation even after deletion succeeds", async () => {
    const fake = cacheDatabase();
    const build = captureCacheBuild("late-build");
    await invalidate(fake.db, "late-build", "block");
    await setCachedFeed(fake.db, "late-build", build, "feed", "feed", { stale: true });
    assert.equal(fake.calls.includes("write-start"), false);
    assert.equal(await getCachedFeed(null, "late-build", "feed", "feed"), null);
    assert.deepEqual(fake.rows(), []);
  });

  it("does not revive a build begun while invalidation was pending", async () => {
    const deleteGate = deferred();
    const fake = cacheDatabase({ deleteGate });
    const invalidation = invalidate(fake.db, "pending-build", "block");
    await fake.deleteStarted.promise;
    const build = captureCacheBuild("pending-build");
    deleteGate.resolve();
    await invalidation;
    assert.equal(build, null);
    await setCachedFeed(fake.db, "pending-build", build, "feed", "feed", { stale: true });
    assert.equal(fake.calls.includes("write-start"), false);
    assert.equal(await getCachedFeed(null, "pending-build", "feed", "feed"), null);
  });

  it("binds build provenance to the viewer even before either viewer has an invalidation", async () => {
    const fake = cacheDatabase();
    const build = captureCacheBuild("build-owner");
    await setCachedFeed(fake.db, "other-build-owner", build, "feed", "feed", { private: true });
    assert.equal(fake.calls.includes("write-start"), false);
    assert.equal(await getCachedFeed(null, "other-build-owner", "feed", "feed"), null);
  });

  it("allows an unaffected viewer's build to finish across another viewer's invalidation", async () => {
    const fake = cacheDatabase();
    const build = captureCacheBuild("unaffected-builder");
    await invalidate(fake.db, "different-builder", "block");
    await setCachedFeed(fake.db, "unaffected-builder", build, "feed", "feed", { fresh: true });
    assert.deepEqual(await getCachedFeed(null, "unaffected-builder", "feed", "feed"), { fresh: true });
  });

  it("refuses a missing build provenance instead of inventing a fresh generation", async () => {
    const fake = cacheDatabase();
    await setCachedFeed(fake.db, "missing-build", null, "feed", "feed", { stale: true });
    assert.equal(fake.calls.includes("write-start"), false);
    assert.equal(await getCachedFeed(null, "missing-build", "feed", "feed"), null);
  });

  it("withholds an outstanding L2 response and its L1 promotion after viewer invalidation", async () => {
    const readGate = deferred();
    const fake = cacheDatabase({ rows: [cacheRow("late-read")], readGate });
    const read = getCachedFeed(fake.db, "late-read", "feed", "feed");
    await fake.readStarted.promise;
    await invalidate(fake.db, "late-read", "block");
    readGate.resolve();
    assert.equal(await read, null);
    assert.equal(await getCachedFeed(null, "late-read", "feed", "feed"), null);
    assert.deepEqual(fake.rows(), []);
  });

  it("does not invalidate a different viewer's outstanding read", async () => {
    const readGate = deferred();
    const fake = cacheDatabase({ rows: [cacheRow("other-reader")], readGate });
    const read = getCachedFeed(fake.db, "other-reader", "feed", "feed");
    await fake.readStarted.promise;
    await invalidate(fake.db, "different-viewer", "block");
    readGate.resolve();
    assert.deepEqual(await read, { source: "other-reader" });
    assert.deepEqual(await getCachedFeed(null, "other-reader", "feed", "feed"), { source: "other-reader" });
  });

  it("refuses new reads and writes while invalidation deletion is outstanding", async () => {
    const deleteGate = deferred();
    const fake = cacheDatabase({ rows: [cacheRow("deleting")], deleteGate });
    const invalidation = invalidate(fake.db, "deleting", "block");
    await fake.deleteStarted.promise;
    try {
      assert.equal(await getCachedFeed(fake.db, "deleting", "feed", "feed"), null);
      await setCachedFeed(fake.db, "deleting", captureCacheBuild("deleting"), "feed", "feed", { stale: true });
      assert.equal(fake.calls.includes("write-start"), false);
      assert.equal(await getCachedFeed(null, "deleting", "feed", "feed"), null);
    } finally {
      deleteGate.resolve();
      await invalidation;
    }
  });

  it("deletes a write that was already in flight before invalidation", async () => {
    const writeGate = deferred();
    const fake = cacheDatabase({ writeGate });
    const write = setCachedFeed(fake.db, "writing", captureCacheBuild("writing"), "feed", "feed", { stale: true });
    await fake.writeStarted.promise;
    const invalidation = invalidate(fake.db, "writing", "block");
    await new Promise<void>((resolve) => setImmediate(resolve));
    writeGate.resolve();
    await Promise.all([write, invalidation]);
    assert.ok(fake.calls.indexOf("delete-start") > fake.calls.indexOf("write-end"), fake.calls.join(", "));
    assert.deepEqual(fake.rows(), []);
    assert.equal(await getCachedFeed(fake.db, "writing", "feed", "feed"), null);
  });

  it("drops a queued pre-invalidation write rather than installing it after deletion", async () => {
    const writeGate = deferred();
    const fake = cacheDatabase({ writeGate });
    const first = setCachedFeed(fake.db, "queued", captureCacheBuild("queued"), "first", "feed", { stale: 1 });
    await fake.writeStarted.promise;
    const second = setCachedFeed(fake.db, "queued", captureCacheBuild("queued"), "second", "feed", { stale: 2 });
    const invalidation = invalidate(fake.db, "queued", "block");
    writeGate.resolve();
    await Promise.all([first, second, invalidation]);
    assert.equal(fake.calls.filter((call) => call === "write-start").length, 1);
    assert.deepEqual(fake.rows(), []);
    assert.equal(await getCachedFeed(null, "queued", "second", "feed"), null);
  });

  it("allows a newly started write after successful invalidation", async () => {
    const fake = cacheDatabase();
    await invalidate(fake.db, "fresh-write", "block");
    await setCachedFeed(fake.db, "fresh-write", captureCacheBuild("fresh-write"), "feed", "feed", { fresh: true });
    assert.deepEqual(await getCachedFeed(null, "fresh-write", "feed", "feed"), { fresh: true });
    clearL1Cache();
    assert.deepEqual(await getCachedFeed(fake.db, "fresh-write", "feed", "feed"), { fresh: true });
  });

  it("does not release a newer invalidation when an older deletion finishes", async () => {
    const firstGate = deferred();
    const secondGate = deferred();
    const firstDb = cacheDatabase({ deleteGate: firstGate });
    const secondDb = cacheDatabase({ deleteGate: secondGate });
    const first = invalidate(firstDb.db, "overlap", "block");
    await firstDb.deleteStarted.promise;
    const second = invalidate(secondDb.db, "overlap", "block");
    firstGate.resolve();
    await first;
    await secondDb.deleteStarted.promise;
    try {
      await setCachedFeed(null, "overlap", captureCacheBuild("overlap"), "feed", "feed", { stale: true });
      assert.equal(await getCachedFeed(null, "overlap", "feed", "feed"), null);
    } finally {
      secondGate.resolve();
      await second;
    }
    await setCachedFeed(null, "overlap", captureCacheBuild("overlap"), "feed", "feed", { fresh: true });
    assert.deepEqual(await getCachedFeed(null, "overlap", "feed", "feed"), { fresh: true });
  });

  it("a rejected in-flight write cannot prevent the queued invalidation", async () => {
    const writeGate = deferred();
    const fake = cacheDatabase({ writeGate });
    const write = setCachedFeed(fake.db, "rejected-write", captureCacheBuild("rejected-write"), "feed", "feed", { stale: true });
    await fake.writeStarted.promise;
    const invalidation = invalidate(fake.db, "rejected-write", "block");
    writeGate.reject(new Error("write failed"));
    await Promise.all([write, invalidation]);
    assert.ok(fake.calls.includes("delete-end"));
    assert.equal(await getCachedFeed(null, "rejected-write", "feed", "feed"), null);
  });

  it("does not persist a queued write whose original lifetime has elapsed", async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const writeGate = deferred();
    const fake = cacheDatabase({ writeGate });
    const first = setCachedFeed(fake.db, "expired-write", captureCacheBuild("expired-write"), "first", "booking", { first: true });
    await fake.writeStarted.promise;
    const second = setCachedFeed(fake.db, "expired-write", captureCacheBuild("expired-write"), "second", "booking", { stale: true });
    now += 30_000;
    writeGate.resolve();
    await Promise.all([first, second]);
    assert.equal(fake.calls.filter((call) => call === "write-start").length, 1);
    assert.equal(await getCachedFeed(null, "expired-write", "second", "booking"), null);
    assert.equal(fake.rows().some((row) => row.cache_key === "second"), false);
  });

  it("a slow write for another viewer does not delay invalidation", async () => {
    const writeGate = deferred();
    const fake = cacheDatabase({ writeGate });
    const write = setCachedFeed(fake.db, "slow-unrelated", captureCacheBuild("slow-unrelated"), "feed", "feed", { fresh: true });
    await fake.writeStarted.promise;
    try {
      await invalidate(fake.db, "unrelated-delete", "block");
      assert.ok(fake.calls.includes("delete-end"));
      assert.equal(fake.calls.includes("write-end"), false);
    } finally {
      writeGate.resolve();
      await write;
    }
    assert.deepEqual(await getCachedFeed(null, "slow-unrelated", "feed", "feed"), { fresh: true });
  });

  it("keeps a viewer cache withheld after an unsuccessful delete", async () => {
    const fake = cacheDatabase({ rows: [cacheRow("failed-delete")], deleteError: true });
    await invalidate(fake.db, "failed-delete", "block");
    assert.equal(await getCachedFeed(fake.db, "failed-delete", "feed", "feed"), null);
    await setCachedFeed(fake.db, "failed-delete", captureCacheBuild("failed-delete"), "feed", "feed", { stale: true });
    assert.equal(await getCachedFeed(null, "failed-delete", "feed", "feed"), null);
    assert.equal(fake.calls.includes("write-start"), false);
  });

  it("keeps a viewer cache withheld after a thrown delete", async () => {
    const deleteGate = deferred();
    const fake = cacheDatabase({ rows: [cacheRow("thrown-delete")], deleteGate });
    const invalidation = invalidate(fake.db, "thrown-delete", "block");
    await fake.deleteStarted.promise;
    deleteGate.reject(new Error("delete failed"));
    await invalidation;
    assert.equal(await getCachedFeed(fake.db, "thrown-delete", "feed", "feed"), null);
    assert.equal(fake.calls.includes("audit"), false);
  });

  it("recovers cache availability only after a later successful invalidation", async () => {
    const failed = cacheDatabase({ deleteError: true });
    await invalidate(failed.db, "recovered", "block");
    clearL1Cache();
    await setCachedFeed(null, "recovered", captureCacheBuild("recovered"), "feed", "feed", { stale: true });
    assert.equal(await getCachedFeed(null, "recovered", "feed", "feed"), null);
    const healthy = cacheDatabase();
    await invalidate(healthy.db, "recovered", "retry");
    await setCachedFeed(healthy.db, "recovered", captureCacheBuild("recovered"), "feed", "feed", { fresh: true });
    assert.deepEqual(await getCachedFeed(null, "recovered", "feed", "feed"), { fresh: true });
  });

  it("an unavailable database does not authorize reusing a persistent cache row", async () => {
    const fake = cacheDatabase({ rows: [cacheRow("no-database")] });
    await invalidate(null, "no-database", "block");
    assert.equal(await getCachedFeed(fake.db, "no-database", "feed", "feed"), null);
    assert.deepEqual(fake.calls, []);
  });

  it("does not resurrect an older generation after two invalidations", async () => {
    const readGate = deferred();
    const fake = cacheDatabase({ rows: [cacheRow("twice")], readGate });
    const read = getCachedFeed(fake.db, "twice", "feed", "feed");
    await fake.readStarted.promise;
    await invalidate(fake.db, "twice", "block");
    await invalidate(fake.db, "twice", "unblock");
    readGate.resolve();
    assert.equal(await read, null);
    assert.equal(await getCachedFeed(null, "twice", "feed", "feed"), null);
  });

  it("does not renew an L2 record's original expiry on promotion", async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const fake = cacheDatabase({ rows: [cacheRow("absolute", new Date(now + 1000).toISOString())] });
    assert.deepEqual(await getCachedFeed(fake.db, "absolute", "feed", "feed"), { source: "absolute" });
    now += 999;
    assert.deepEqual(await getCachedFeed(null, "absolute", "feed", "feed"), { source: "absolute" });
    now += 1;
    assert.equal(await getCachedFeed(null, "absolute", "feed", "feed"), null);
  });

  it("refuses a record that expires while the L2 read is outstanding", async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const readGate = deferred();
    const fake = cacheDatabase({ rows: [cacheRow("expired-read", new Date(now + 1000).toISOString())], readGate });
    const read = getCachedFeed(fake.db, "expired-read", "feed", "feed");
    await fake.readStarted.promise;
    now += 1000;
    readGate.resolve();
    assert.equal(await read, null);
    assert.equal(await getCachedFeed(null, "expired-read", "feed", "feed"), null);
  });

  for (const expiry of [null, undefined, "", "not-a-date", 9999999999999, {}, "2020-01-01T00:00:00.000Z", "9999", "9999-02-30T12:00:00Z", "9999-01-01T24:00:00Z"]) {
    it(`refuses malformed or expired L2 expiry ${JSON.stringify(expiry)}`, async () => {
      const row = { ...cacheRow("invalid-expiry"), expires_at: expiry };
      const fake = cacheDatabase({ rows: [row] });
      assert.equal(await getCachedFeed(fake.db, "invalid-expiry", "feed", "feed"), null);
      assert.equal(await getCachedFeed(null, "invalid-expiry", "feed", "feed"), null);
    });
  }

  it("accepts a database timestamp with an explicit offset and fractional seconds", async (context) => {
    const now = Date.parse("2026-10-16T00:00:00.000Z");
    context.mock.method(Date, "now", () => now);
    const fake = cacheDatabase({ rows: [cacheRow("offset", "2026-10-16T01:00:01.123456+01:00")] });
    assert.deepEqual(await getCachedFeed(fake.db, "offset", "feed", "feed"), { source: "offset" });
  });

  it("refuses an errored L2 response even when it contains data", async () => {
    const fake = cacheDatabase({ rows: [cacheRow("errored")], readError: true });
    assert.equal(await getCachedFeed(fake.db, "errored", "feed", "feed"), null);
    assert.equal(await getCachedFeed(null, "errored", "feed", "feed"), null);
  });

  it("preserves safety bypass and the normal lifetime of a newly written entry", async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const fake = cacheDatabase();
    await setCachedFeed(fake.db, "safety", captureCacheBuild("safety"), "safety", "safety", { hidden: true });
    assert.equal(await getCachedFeed(fake.db, "safety", "safety", "safety"), null);
    assert.deepEqual(fake.calls, []);
    await setCachedFeed(fake.db, "booking", captureCacheBuild("booking"), "booking", "booking", { fresh: true });
    now += 29_999;
    assert.deepEqual(await getCachedFeed(null, "booking", "booking", "booking"), { fresh: true });
    now += 1;
    assert.equal(await getCachedFeed(null, "booking", "booking", "booking"), null);
  });
});
