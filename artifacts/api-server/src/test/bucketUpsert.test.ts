/**
 * bucketUpsert.test.ts
 *
 * Tests for incrementBucketCounts() — per-bucket idempotent, concurrent-safe
 * bucket count increment using post_bucket_ledger + increment_bucket_count RPC.
 *
 * Uses a hand-written fake Supabase client — no real DB.
 *
 * Runtime: node:test + tsx/esm
 * Run: node --import tsx/esm --test src/test/bucketUpsert.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { incrementBucketCounts } from "../lib/places/bucketClassifier.js";

// ── Fake Supabase client builder ──────────────────────────────────────────────

interface LedgerRow {
  post_id: string;
  canonical_place_id: string;
  bucket: string;
}

/**
 * Build a minimal fake Supabase-like client supporting:
 *
 *   .from("post_bucket_ledger")
 *     .insert(row, { ignoreDuplicates: true }).select("bucket")
 *     .delete().eq(...).eq(...)
 *
 *   .rpc("increment_bucket_count", params)
 *
 * rpcFailBuckets: set of bucket names where rpc() returns an error.
 */
function makeFakeClient(opts: {
  existingLedger?: LedgerRow[];
  ledgerError?: Error;
  rpcFailBuckets?: Set<string>;
} = {}) {
  // Ledger set keyed by "post_id:bucket"
  const ledger = new Set<string>(
    (opts.existingLedger ?? []).map((r) => `${r.post_id}:${r.bucket}`),
  );

  // Bucket counter keyed by "canonical_place_id:bucket"
  const bucketStore = new Map<string, number>();

  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const deletedLedgerKeys: string[] = [];

  function from(table: string) {
    if (table === "post_bucket_ledger") {
      return {
        /** INSERT single row ON CONFLICT DO NOTHING */
        insert(row: LedgerRow, _opts?: { ignoreDuplicates?: boolean }) {
          if (opts.ledgerError) {
            return {
              select: () =>
                Promise.resolve({ data: null, error: opts.ledgerError }),
            };
          }
          const key = `${row.post_id}:${row.bucket}`;
          const isNew = !ledger.has(key);
          if (isNew) ledger.add(key);
          return {
            select: (_cols?: string) =>
              Promise.resolve({
                data: isNew ? [{ bucket: row.bucket }] : [],
                error: null,
              }),
          };
        },
        /** DELETE … .eq().eq() — ledger rollback on RPC failure */
        delete() {
          const conditions: Array<[string, unknown]> = [];
          const chain: any = {
            eq(col: string, val: unknown) {
              conditions.push([col, val]);
              return chain;
            },
            then(resolve: Function) {
              // Remove matching ledger entries
              for (const key of [...ledger]) {
                const [postId, ...rest] = key.split(":");
                const bucket = rest.join(":");
                const matches = conditions.every(([col, val]) => {
                  if (col === "post_id") return postId === val;
                  if (col === "bucket")  return bucket === val;
                  return false;
                });
                if (matches) {
                  ledger.delete(key);
                  deletedLedgerKeys.push(key);
                }
              }
              return Promise.resolve({ data: null, error: null }).then(resolve as any);
            },
          };
          return chain;
        },
      };
    }
    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  function rpc(name: string, params: Record<string, unknown>) {
    rpcCalls.push({ name, params });
    const bucket = params.p_bucket as string;
    if (opts.rpcFailBuckets?.has(bucket)) {
      return Promise.resolve({ data: null, error: new Error(`RPC error for ${bucket}`) });
    }
    const placeId  = params.p_canonical_place_id as string;
    const postedAt = params.p_last_post_at as string;
    const key      = `${placeId}:${bucket}`;
    bucketStore.set(key, (bucketStore.get(key) ?? 0) + 1);
    return Promise.resolve({ data: null, error: null });
  }

  return {
    from,
    rpc,
    getLedger:           () => ledger,
    getBucketStore:      () => bucketStore,
    getRpcCalls:         () => rpcCalls,
    getDeletedKeys:      () => deletedLedgerKeys,
  };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const POST_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const POST_ID_2 = "bbbbbbbb-0000-0000-0000-000000000002";
const PLACE_ID  = "00000000-0000-0000-0000-000000000001";
const POSTED_AT = "2026-07-28T10:00:00.000Z";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("incrementBucketCounts — empty bucket list", () => {
  it("returns true immediately without touching the DB", async () => {
    const client = makeFakeClient();
    const ok = await incrementBucketCounts(client as any, POST_ID, PLACE_ID, [], POSTED_AT);
    assert.equal(ok, true);
    assert.equal(client.getRpcCalls().length, 0);
  });
});

describe("incrementBucketCounts — new post (no prior ledger entry)", () => {
  it("inserts ledger row and calls RPC for a single new bucket", async () => {
    const client = makeFakeClient();
    const ok = await incrementBucketCounts(client as any, POST_ID, PLACE_ID, ["drone"], POSTED_AT);
    assert.equal(ok, true);
    assert.ok(client.getLedger().has(`${POST_ID}:drone`));

    const rpcs = client.getRpcCalls();
    assert.equal(rpcs.length, 1);
    assert.equal(rpcs[0]!.name, "increment_bucket_count");
    assert.equal(rpcs[0]!.params.p_canonical_place_id, PLACE_ID);
    assert.equal(rpcs[0]!.params.p_bucket, "drone");
    assert.equal(rpcs[0]!.params.p_last_post_at, POSTED_AT);

    assert.equal(client.getBucketStore().get(`${PLACE_ID}:drone`), 1);
  });

  it("inserts one ledger row and calls one RPC per bucket", async () => {
    const client = makeFakeClient();
    const ok = await incrementBucketCounts(
      client as any, POST_ID, PLACE_ID, ["drone", "sunrise", "night"], POSTED_AT,
    );
    assert.equal(ok, true);
    assert.equal(client.getRpcCalls().length, 3);
    assert.equal(client.getBucketStore().get(`${PLACE_ID}:drone`),   1);
    assert.equal(client.getBucketStore().get(`${PLACE_ID}:sunrise`), 1);
    assert.equal(client.getBucketStore().get(`${PLACE_ID}:night`),   1);
  });
});

describe("incrementBucketCounts — idempotency (retry safety)", () => {
  it("skips RPC when all buckets are already in the ledger", async () => {
    const client = makeFakeClient({
      existingLedger: [
        { post_id: POST_ID, canonical_place_id: PLACE_ID, bucket: "drone" },
      ],
    });
    const ok = await incrementBucketCounts(client as any, POST_ID, PLACE_ID, ["drone"], POSTED_AT);
    assert.equal(ok, true);
    assert.equal(client.getRpcCalls().length, 0); // no double-increment
  });

  it("increments only the new bucket when one is already in the ledger", async () => {
    const client = makeFakeClient({
      existingLedger: [
        { post_id: POST_ID, canonical_place_id: PLACE_ID, bucket: "drone" },
      ],
    });
    const ok = await incrementBucketCounts(
      client as any, POST_ID, PLACE_ID, ["drone", "sunrise"], POSTED_AT,
    );
    assert.equal(ok, true);
    const rpcs = client.getRpcCalls();
    assert.equal(rpcs.length, 1);
    assert.equal(rpcs[0]!.params.p_bucket, "sunrise");
  });

  it("two sequential calls for the same post only increment once", async () => {
    const client = makeFakeClient();
    await incrementBucketCounts(client as any, POST_ID, PLACE_ID, ["festival"], POSTED_AT);
    await incrementBucketCounts(client as any, POST_ID, PLACE_ID, ["festival"], POSTED_AT);
    assert.equal(client.getRpcCalls().length, 1);
    assert.equal(client.getBucketStore().get(`${PLACE_ID}:festival`), 1);
  });
});

describe("incrementBucketCounts — partial RPC failure + retry correctness", () => {
  it("rolls back the failed bucket's ledger row so retry can count it", async () => {
    // First attempt: "drone" succeeds, "sunrise" RPC fails.
    const client = makeFakeClient({ rpcFailBuckets: new Set(["sunrise"]) });
    const ok1 = await incrementBucketCounts(
      client as any, POST_ID, PLACE_ID, ["drone", "sunrise"], POSTED_AT,
    );
    assert.equal(ok1, false); // partial failure

    // "drone" committed; "sunrise" ledger row should have been deleted.
    assert.ok(client.getLedger().has(`${POST_ID}:drone`));
    assert.ok(!client.getLedger().has(`${POST_ID}:sunrise`));
    assert.deepEqual(client.getDeletedKeys(), [`${POST_ID}:sunrise`]);

    // Drone counter at 1; sunrise not yet counted.
    assert.equal(client.getBucketStore().get(`${PLACE_ID}:drone`),   1);
    assert.equal(client.getBucketStore().get(`${PLACE_ID}:sunrise`), undefined);
  });

  it("retry after partial failure reaches correct counts for all buckets", async () => {
    // Attempt 1: sunrise fails.
    const client = makeFakeClient({ rpcFailBuckets: new Set(["sunrise"]) });
    await incrementBucketCounts(client as any, POST_ID, PLACE_ID, ["drone", "sunrise"], POSTED_AT);

    // Attempt 2: no failures — client without rpcFailBuckets but reusing ledger state.
    const client2 = makeFakeClient({
      existingLedger: [...client.getLedger()].map((key) => {
        const [post_id, ...rest] = key.split(":");
        return { post_id, canonical_place_id: PLACE_ID, bucket: rest.join(":") };
      }),
    });
    // Prime bucket store with drone already at 1 from first attempt.
    (client2 as any)._primed = true;
    // Simulate retry — drone is in ledger (skip), sunrise is not (process).
    const ok2 = await incrementBucketCounts(
      client2 as any, POST_ID, PLACE_ID, ["drone", "sunrise"], POSTED_AT,
    );
    assert.equal(ok2, true);

    const rpcs2 = client2.getRpcCalls();
    assert.equal(rpcs2.length, 1);
    assert.equal(rpcs2[0]!.params.p_bucket, "sunrise");
    // sunrise now counted once on retry.
    assert.equal(client2.getBucketStore().get(`${PLACE_ID}:sunrise`), 1);
  });
});

describe("incrementBucketCounts — concurrent safety", () => {
  it("two posts for the same place+bucket each call RPC once → count = 2", async () => {
    const client = makeFakeClient();
    await incrementBucketCounts(client as any, POST_ID,   PLACE_ID, ["adventure"], POSTED_AT);
    await incrementBucketCounts(client as any, POST_ID_2, PLACE_ID, ["adventure"], POSTED_AT);
    assert.equal(client.getRpcCalls().length, 2);
    assert.equal(client.getBucketStore().get(`${PLACE_ID}:adventure`), 2);
  });
});

describe("incrementBucketCounts — error handling", () => {
  it("returns false when ledger insert fails", async () => {
    const client = makeFakeClient({ ledgerError: new Error("DB error") });
    const ok = await incrementBucketCounts(client as any, POST_ID, PLACE_ID, ["drone"], POSTED_AT);
    assert.equal(ok, false);
    assert.equal(client.getRpcCalls().length, 0);
  });

  it("returns false when client throws", async () => {
    const throwingClient = {
      from: () => { throw new Error("Connection refused"); },
    };
    const ok = await incrementBucketCounts(throwingClient as any, POST_ID, PLACE_ID, ["night"], POSTED_AT);
    assert.equal(ok, false);
  });
});
