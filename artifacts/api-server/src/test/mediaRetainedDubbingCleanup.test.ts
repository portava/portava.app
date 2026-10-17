import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";

const owner = "10000000-0000-4000-a000-000000000001";
const assetId = "20000000-0000-4000-a000-000000000001";
type Row = Record<string, any>;

async function fixture(run: (input: { state: any; client: SupabaseClient; root: string; artifact: Row; reconciler: any }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "retained-dubbing-"));
  const id = randomUUID();
  const artifact = { id, owner_user_id: owner, asset_id: assetId, job_id: randomUUID(), lease_token: randomUUID(),
    storage_bucket: "historical-dubbing", storage_path: `synthetic-dubbing/${id}.wav`, write_state: "uploaded",
    write_settled_at: "2026-10-15T00:00:00Z", cleanup_requested: false };
  const state = { artifacts: [artifact] as Row[], sources: [] as Row[], profiles: [{ id: owner, account_status: "active" }] as Row[],
    jobs: [] as Row[], calls: [] as string[], removed: [] as string[], failTable: "", failRpc: "", publicBucket: false,
    refuseRevoke: false, refuseForget: false, failRemove: false, marker: true, dubbingInstalled: true, signals: [] as AbortSignal[],
    onRetire: () => {}, onRevoke: () => {}, hangTable: "" };
  const client = {
    from(table: string) {
      const filters: ((row: Row) => boolean)[] = [];
      let maximum = 100;
      let single = false;
      const query = {
        select() { return query; }, eq(key: string, value: unknown) { filters.push(row => row[key] === value); return query; },
        neq(key: string, value: unknown) { filters.push(row => row[key] !== value); return query; },
        gt(key: string, value: string) { filters.push(row => row[key] > value); return query; },
        order() { return query; }, limit(value: number) { maximum = value; return query; }, maybeSingle() { single = true; return query; },
        abortSignal(signal: AbortSignal) { state.signals.push(signal); return query; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return (async () => {
            state.calls.push(table);
            if (state.hangTable === table) return new Promise(() => {});
            if (state.failTable === table) return { data: null, error: new Error("read unavailable") };
            const rows = (table === "media_dubbing_artifacts" ? state.artifacts : table === "media_assets" ? state.sources
              : table === "profiles" ? state.profiles : table === "media_derivative_jobs" ? state.jobs
              : table === "feature_flags" ? (state.marker ? [{ flag: "media_derivative_jobs_enabled", enabled: false }] : []) : [])
              .filter(row => filters.every(filter => filter(row))).sort((left, right) => left.id?.localeCompare(right.id ?? "") ?? 0).slice(0, maximum);
            return { data: single ? rows[0] ? { ...rows[0] } : null : rows.map(row => ({ ...row })), error: null };
          })().then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, parameters: Row = {}) {
      state.calls.push(name);
      if (state.failRpc === name) return { data: null, error: new Error("RPC unavailable") };
      if (name === "media_derivative_schema_status") return { data: { media_derivative_jobs: true, media_caption_manifests: false,
        media_visual_embeddings: false, media_image_understanding_artifacts: false, media_dubbing_artifacts: state.dubbingInstalled }, error: null };
      if (name === "media_dubbing_revoke") {
        state.onRevoke();
        if (state.refuseRevoke) return { data: false, error: null };
        for (const job of state.jobs) if (job.asset_id === parameters.p_asset && job.owner_user_id === parameters.p_owner && job.kind === "dubbing") job.state = "cancelled";
        return { data: true, error: null };
      }
      const row = state.artifacts.find(row => row.id === parameters.p_id && row.owner_user_id === parameters.p_owner);
      if (name === "media_dubbing_retire") {
        state.onRetire();
        if (row) row.cleanup_requested = true;
        return { data: row ? { ...row } : null, error: null };
      }
      if (name === "media_dubbing_forget") {
        if (!row) return { data: true, error: null };
        if (state.refuseForget || row.write_state === "pending") return { data: false, error: null };
        state.artifacts.splice(state.artifacts.indexOf(row), 1);
        return { data: true, error: null };
      }
      return { data: true, error: null };
    },
    storage: {
      async getBucket(id: string) { return { data: { id, name: id, public: state.publicBucket }, error: null }; },
      from(bucket: string) { return { async remove(paths: string[]) {
        state.calls.push("remove");
        if (state.failRemove) return { error: new Error("remove unavailable") };
        for (const path of paths) { await unlink(join(root, bucket, path)).catch(error => { if (error.code !== "ENOENT") throw error; }); state.removed.push(`${bucket}/${path}`); }
        return { error: null };
      } }; },
    },
  } as unknown as SupabaseClient;
  await mkdir(join(root, artifact.storage_bucket, "synthetic-dubbing"), { recursive: true });
  await writeFile(join(root, artifact.storage_bucket, artifact.storage_path), "synthetic audio fixture");
  try {
    const { RetainedDubbingReconciler } = await import("../services/media/RetainedDubbingReconciler.js");
    await run({ state, client, root, artifact, reconciler: new RetainedDubbingReconciler(client) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("hard-deleted source erases only settled retained dubbing in its historical bucket with generation OFF", async () => fixture(async ({ state, root, artifact, reconciler }) => {
  const result = await reconciler.runPass();
  assert.equal(result.removed, 1); assert.equal(state.artifacts.length, 0);
  assert.deepEqual(state.removed, [`${artifact.storage_bucket}/${artifact.storage_path}`]);
  await assert.rejects(readFile(join(root, artifact.storage_bucket, artifact.storage_path)), { code: "ENOENT" });
  assert.ok(state.calls.indexOf("media_dubbing_retire") < state.calls.indexOf("remove"));
  assert.ok(state.calls.indexOf("remove") < state.calls.indexOf("media_dubbing_forget"));
}));

test("pending uploads and unknown settlement retain both ledger and bytes after source/job loss", async () => fixture(async ({ state, artifact, root, reconciler }) => {
  artifact.write_state = "pending"; artifact.write_settled_at = null;
  const result = await reconciler.runPass();
  assert.equal(result.unsettled, 1); assert.equal(result.removed, 0); assert.equal(state.artifacts.length, 1);
  assert.equal(await readFile(join(root, artifact.storage_bucket, artifact.storage_path), "utf8"), "synthetic audio fixture");
  assert.equal(state.calls.includes("media_dubbing_retire"), false);
}));

test("active, deactivated, pending-deletion, missing and changed-owner profiles cannot authorize account erasure", async () => fixture(async ({ state, artifact, reconciler }) => {
  state.sources = [{ id: assetId, owner_user_id: owner, version: 4 }];
  for (const status of ["active", "deactivated", "pending_deletion", null]) {
    state.profiles = status ? [{ id: owner, account_status: status }] : [];
    assert.equal((await reconciler.runPass()).removed, 0);
  }
  state.profiles = [{ id: owner, account_status: "deleted" }];
  state.sources[0].owner_user_id = randomUUID();
  assert.equal((await reconciler.runPass()).removed, 0);
  assert.equal(state.artifacts[0], artifact); assert.deepEqual(state.removed, []);
}));

test("terminal account tombstone revokes matching source consent/jobs before settled artifact erasure", async () => fixture(async ({ state, artifact, reconciler }) => {
  state.sources = [{ id: assetId, owner_user_id: owner, version: 4 }];
  state.profiles[0].account_status = "deleted";
  state.jobs = [{ id: artifact.job_id, asset_id: assetId, owner_user_id: owner, kind: "dubbing", state: "processing" }];
  const result = await reconciler.runPass({ ownerUserId: owner });
  assert.equal(result.removed, 1); assert.equal(result.ownerLedgerEmpty, true);
  assert.equal(state.jobs[0].state, "cancelled");
  assert.ok(state.calls.indexOf("media_dubbing_revoke") < state.calls.indexOf("media_dubbing_retire"));
}));

test("orphan cleanup preserves any retained job or ambiguous publication", async () => fixture(async ({ state, artifact, reconciler }) => {
  for (const status of ["processing", "completed", "cancelled"]) {
    state.jobs = [{ id: artifact.job_id, asset_id: assetId, state: status }];
    assert.equal((await reconciler.runPass()).removed, 0);
  }
  assert.deepEqual(state.removed, []);
}));

test("data/cache errors never stand in for authoritative absence", async () => fixture(async ({ state, reconciler }) => {
  state.failTable = "feature_flags";
  await assert.rejects(reconciler.runPass());
  for (const table of ["media_assets", "media_derivative_jobs"]) {
    state.failTable = table;
    const result = await reconciler.runPass(); assert.equal(result.removed, 0); assert.equal(result.failed, 1);
    assert.deepEqual(state.removed, []); assert.equal(state.artifacts.length, 1);
  }
  state.failTable = ""; state.failRpc = "media_derivative_schema_status";
  await assert.rejects(reconciler.runPass());
}));

test("reappeared source and reactivated account are rechecked before physical removal", async () => fixture(async ({ state, reconciler }) => {
  state.onRetire = () => { state.sources = [{ id: assetId, owner_user_id: owner, version: 4 }]; };
  assert.equal((await reconciler.runPass()).removed, 0); assert.deepEqual(state.removed, []);
  state.profiles[0].account_status = "deleted";
  state.onRetire = () => { state.profiles[0].account_status = "active"; };
  assert.equal((await reconciler.runPass()).removed, 0); assert.deepEqual(state.removed, []);
}));

test("refused retirement, cancellation, storage or forget remains retryable", async () => fixture(async ({ state, reconciler }) => {
  for (const name of ["media_derivative_cancel_asset", "media_dubbing_retire"]) {
    state.failRpc = name;
    assert.equal((await reconciler.runPass()).failed, 1); assert.equal(state.artifacts.length, 1);
    assert.deepEqual(state.removed, []);
  }
  state.failRpc = "";
  state.failRemove = true;
  assert.equal((await reconciler.runPass()).failed, 1); assert.equal(state.artifacts.length, 1);
  state.failRemove = false; state.refuseForget = true;
  assert.equal((await reconciler.runPass()).failed, 1); assert.equal(state.artifacts.length, 1);
  state.refuseForget = false;
  assert.equal((await reconciler.runPass()).removed, 1); assert.equal(state.artifacts.length, 0);
}));

test("unconfirmed account revocation preserves retained artifact and bytes", async () => fixture(async ({ state, reconciler }) => {
  state.sources = [{ id: assetId, owner_user_id: owner, version: 4 }];
  state.profiles[0].account_status = "deleted"; state.refuseRevoke = true;
  assert.equal((await reconciler.runPass()).failed, 1);
  assert.equal(state.artifacts.length, 1); assert.deepEqual(state.removed, []);
  assert.ok(!state.calls.includes("media_dubbing_retire"));
}));

test("public bucket or forged retained path cannot redirect deletion", async () => fixture(async ({ state, artifact, reconciler }) => {
  state.publicBucket = true;
  assert.equal((await reconciler.runPass()).failed, 1); assert.deepEqual(state.removed, []);
  state.publicBucket = false; artifact.storage_path = "../unrelated.wav";
  assert.equal((await reconciler.runPass()).failed, 1); assert.deepEqual(state.removed, []);
}));

test("bounded keyset pagination progresses past active/unknown writers without claiming owner completion", async () => fixture(async ({ state, artifact, reconciler }) => {
  artifact.id = "00000000-0000-4000-a000-000000000001";
  artifact.storage_path = `synthetic-dubbing/${artifact.id}.wav`; artifact.write_state = "pending"; artifact.write_settled_at = null;
  const nextId = "ffffffff-ffff-4fff-afff-ffffffffffff";
  const next = { ...artifact, id: nextId, storage_path: `synthetic-dubbing/${nextId}.wav`, write_state: "aborted", write_settled_at: "2026-10-15T00:00:00Z" };
  state.artifacts.push(next);
  assert.equal((await reconciler.runPass({ limit: 1, ownerUserId: owner })).unsettled, 1);
  const result = await reconciler.runPass({ limit: 1, ownerUserId: owner });
  assert.equal(result.removed, 1); assert.equal(result.ownerLedgerEmpty, false); assert.equal(state.artifacts.length, 1);
}));

test("cancelled/hung queries are bounded and reach actual transport signal", async () => fixture(async ({ state, reconciler }) => {
  state.hangTable = "media_dubbing_artifacts";
  await assert.rejects(reconciler.runPass({ operationTimeoutMs: 20 }), /timeout/);
  assert.ok(state.signals.some((signal: AbortSignal) => signal.aborted)); assert.deepEqual(state.removed, []);
}));
