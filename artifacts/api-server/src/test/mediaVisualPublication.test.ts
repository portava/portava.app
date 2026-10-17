import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresVisualIndex } from "../lib/media/visualIndex/postgresVisualIndex.js";
import { VISUAL_MODEL_ID } from "../lib/media/visualIndex/contracts.js";
import { MediaJobError } from "../lib/media/jobs/queue.js";

const assetId = "10000000-0000-4000-8000-000000000001";
const jobId = "20000000-0000-4000-8000-000000000001";
const token = "30000000-0000-4000-8000-000000000001";
const replacement = "40000000-0000-4000-8000-000000000001";
const original = { asset_id: assetId, source_version: 1, storage_bucket: "post-media", storage_path: `${token}/image.png`,
  model_id: VISUAL_MODEL_ID, embedding: JSON.stringify(Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0)),
  content_sha256: "a".repeat(64), consent_revision: token, expires_at: new Date(Date.now() + 60_000).toISOString(), job_id: jobId, lease_token: token };

test("F2 production store rechecks exact published receipt in one bounded current-view snapshot", async () => {
  let rows: unknown = [structuredClone(original)];
  let error: unknown = null;
  let reads = 0;
  const store = new PostgresVisualIndex({
    rpc: async () => ({ data: [original], error: null }),
    from(table: string) {
      assert.equal(table, "media_visual_index_current"); reads++;
      return { select() { return this; }, in(column: string, ids: string[]) { assert.equal(column, "asset_id"); assert.deepEqual(ids, [assetId]); return this; },
        limit: async (limit: number) => { assert.equal(limit, 1); return { data: rows, error }; } };
    },
  } as any);
  const [entry] = await store.seed(jobId, VISUAL_MODEL_ID);
  assert.ok(entry);
  assert.deepEqual(entry.publication, { jobId, leaseToken: token });
  assert.deepEqual(await store.current([entry, entry]), [true, true]); assert.equal(reads, 1);
  for (const patch of [{ source_version: 2 }, { consent_revision: replacement }, { job_id: replacement }, { lease_token: replacement },
    { content_sha256: "b".repeat(64) }, { expires_at: new Date(Date.now() - 60_000).toISOString() }]) {
    rows = [{ ...original, ...patch }]; assert.deepEqual(await store.current([entry]), [false]);
  }
  rows = []; assert.deepEqual(await store.current([entry]), [false]);
  rows = [original]; error = { code: "42501" }; await assert.rejects(store.current([entry]));
  error = null;
  for (const invalid of [null, [original, original], [{ ...original, lease_token: null }]]) {
    rows = invalid; await assert.rejects(store.current([entry]));
  }
  const before = reads; await assert.rejects(store.current(Array(62).fill(entry))); assert.equal(reads, before);
});

test("F4 resolved SQL revocation is terminal while transport errors remain retryable", async () => {
  let response: any = { data: [original], error: null };
  const store = new PostgresVisualIndex({ rpc: async () => response } as any);
  const [entry] = await store.seed(jobId, VISUAL_MODEL_ID); assert.ok(entry);
  for (const code of ["visual_consent_revoked", "visual_source_stale", "visual_index_disabled", "visual_lease_lost"]) {
    response = { data: null, error: { message: code, code: "P0001" } };
    await assert.rejects(store.commit(entry, { jobId, leaseToken: token }), error => error instanceof MediaJobError && error.code === code && error.retryable === (code === "visual_lease_lost"));
  }
  response = { data: null, error: { code: "08006", message: "connection unavailable" } };
  await assert.rejects(store.commit(entry, { jobId, leaseToken: token }), error => error instanceof Error && !(error instanceof MediaJobError));
});
