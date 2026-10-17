import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink, symlink, realpath, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { purgeDerivedMedia } from "../services/media/DerivedMediaLifecycleService.js";
import * as lifecycle from "../services/media/MediaLifecycleService.js";
import { AdaptiveArtifacts } from "../lib/media/adaptive/artifacts.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const old = "2025-01-01T00:00:00.000Z";
const source = () => ({ id: assetId, owner_user_id: ownerId, version: 4, storage_bucket: "post-media", storage_path: `${ownerId}/original.mp4`, thumbnail_path: null,
  media_type: "video", deleted_at: old, moderation_status: "owner_deleted", purge_status: "failed", updated_at: old });

function fixture(root: string) {
  const state = { assets: [source()] as Record<string, any>[], dubbing: [] as Record<string, any>[], jobs: [] as Record<string, any>[],
    schema: true, installed: new Set(["media_derivative_jobs", "media_dubbing_artifacts"]), failTable: "", failRpc: "", failStorage: false, loseCompletion: false, ambiguousCompletion: false, cancelAccepted: true,
    hangTable: "", hangStorage: false, signals: [] as AbortSignal[], calls: [] as string[], removed: [] as string[], beforeRemove: () => {},
    audits: [] as Record<string, any>[] };
  const client = {
    from(table: string) {
      const filters: ((row: Record<string, any>) => boolean)[] = [];
      let single = false;
      let limit = Infinity;
      let update: Record<string, any> | undefined;
      let removing = false;
      let inserted: Record<string, any> | undefined;
      const query = {
        select() { return query; }, eq(key: string, value: unknown) { filters.push(row => row[key] === value); return query; },
        in(key: string, values: unknown[]) { filters.push(row => values.includes(row[key])); return query; },
        lte(key: string, value: string) { filters.push(row => row[key] <= value); return query; },
        not(key: string, _operator: string, value: unknown) { filters.push(row => row[key] !== value); return query; },
        order() { return query; }, limit(value: number) { limit = value; return query; },
        maybeSingle() { single = true; return query; }, update(value: Record<string, any>) { update = value; return query; },
        delete() { removing = true; return query; }, insert(value: Record<string, any>) { inserted = value; return query; },
        abortSignal(signal: AbortSignal) { state.signals.push(signal); return query; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return (async () => {
            state.calls.push(table);
            if (state.hangTable === table) return await new Promise(() => {});
            if (state.failTable === table) return { data: null, error: new Error("fixture read unavailable") };
            const collection = table === "media_assets" ? state.assets : table === "media_dubbing_artifacts" ? state.dubbing : table === "media_derivative_jobs" ? state.jobs
              : table === "feature_flags" ? (state.schema ? [{ flag: "media_derivative_jobs_enabled", enabled: false }] : []) : [];
            let rows = collection.filter(row => filters.every(filter => filter(row))).slice(0, limit);
            if (update) {
              if (state.loseCompletion && update.purge_status === "completed") rows = [];
              for (const row of rows) Object.assign(row, update, { version: row.version + 1 });
              if (state.ambiguousCompletion && update.purge_status === "completed") return { data: null, error: new Error("ambiguous completion transport") };
            }
            if (removing) for (const row of rows) collection.splice(collection.indexOf(row), 1);
            if (inserted) state.audits.push(inserted);
            return { data: single ? (rows[0] ? { ...rows[0] } : null) : rows.map(row => ({ ...row })), error: null };
          })().then(resolve, reject);
        },
      };
      return query;
    },
    rpc(name: string, parameters: Record<string, unknown> = {}) {
      state.calls.push(name);
      let data: unknown = name === "media_derivative_schema_status" ? Object.fromEntries([
        "media_derivative_jobs", "media_caption_manifests", "media_visual_embeddings", "media_image_understanding_artifacts", "media_dubbing_artifacts",
      ].map(table => [table, state.installed.has(table)])) : state.cancelAccepted;
      const row = state.dubbing.find(row => row.id === parameters.p_id);
      const fenced = row && row.owner_user_id === parameters.p_owner && parameters.p_job === null && parameters.p_token === null;
      if (name === "media_dubbing_retire" && state.failRpc !== name) {
        if (fenced) row.cleanup_requested = true;
        data = fenced ? { ...row } : null;
      }
      if (name === "media_dubbing_forget" && state.failRpc !== name) {
        data = !row || Boolean(fenced && row.cleanup_requested && row.write_state !== "pending");
        if (row && data) state.dubbing.splice(state.dubbing.indexOf(row), 1);
      }
      const result = Promise.resolve(state.failRpc === name ? { error: new Error("fixture RPC unavailable"), data: null } : { error: null, data });
      return { then: result.then.bind(result), abortSignal(signal: AbortSignal) { state.signals.push(signal); return this; } };
    },
    storage: {
      from(bucket: string) { return { async remove(paths: string[]) {
        state.calls.push(`remove:${bucket}`);
        state.beforeRemove();
        if (state.hangStorage) return await new Promise(() => {});
        if (state.failStorage) return { error: new Error("fixture remove failed") };
        for (const path of paths) { await unlink(join(root, bucket, path)).catch(error => { if (error.code !== "ENOENT") throw error; }); state.removed.push(`${bucket}/${path}`); }
        return { error: null };
      } }; },
    },
  };
  return { state, sc: client as unknown as SupabaseClient };
}

async function withFixture(run: (input: ReturnType<typeof fixture> & { root: string }) => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "derivative-cleanup-")));
  try { await run({ ...fixture(root), root }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

async function retained(input: ReturnType<typeof fixture> & { root: string }, count = 1) {
  await mkdir(join(input.root, "dubbing-private", "synthetic-dubbing"), { recursive: true });
  for (let index = 0; index < count; index++) {
    const id = randomUUID();
    const storage_path = `synthetic-dubbing/${id}.wav`;
    input.state.dubbing.push({ id, owner_user_id: ownerId, asset_id: assetId, storage_path, storage_bucket: "dubbing-private",
      job_id: randomUUID(), lease_token: randomUUID(), write_state: "uploaded", write_settled_at: old, cleanup_requested: false });
    await writeFile(join(input.root, "dubbing-private", storage_path), "synthetic voice fixture");
  }
}

test("canonical deletion erases retained dubbing with generation OFF and no engine", async () => withFixture(async input => {
  await retained(input);
  const path = input.state.dubbing[0].storage_path;
  await purgeDerivedMedia(input.sc, source(), { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private", MEDIA_DUBBING_PIPER_CONFIG: "invalid" });
  assert.equal(input.state.dubbing.length, 0);
  await assert.rejects(readFile(join(input.root, "dubbing-private", path)), { code: "ENOENT" });
  assert.ok(input.state.calls.indexOf("media_derivative_cancel_asset") < input.state.calls.indexOf("remove:dubbing-private"));
  assert.ok(input.state.calls.indexOf("media_dubbing_retire") < input.state.calls.indexOf("remove:dubbing-private"));
  assert.ok(input.state.calls.indexOf("remove:dubbing-private") < input.state.calls.indexOf("media_dubbing_forget"));
}));

test("canonical dubbing cleanup retains pending writers and unconfirmed forget receipts", async () => withFixture(async input => {
  await retained(input);
  const row = input.state.dubbing[0];
  row.write_state = "pending"; row.write_settled_at = null;
  await assert.rejects(purgeDerivedMedia(input.sc, source(), { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" }), /cleanup_failed/);
  assert.equal(input.state.dubbing.length, 1);
  assert.equal(row.cleanup_requested, true);
  assert.ok(!input.state.calls.includes("media_dubbing_forget"));
  row.write_state = "aborted"; row.write_settled_at = old;
  input.state.failRpc = "media_dubbing_forget";
  await assert.rejects(purgeDerivedMedia(input.sc, source(), { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" }), /cleanup_failed/);
  assert.equal(input.state.dubbing.length, 1);
  input.state.failRpc = "";
  await purgeDerivedMedia(input.sc, source(), { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" });
  assert.equal(input.state.dubbing.length, 0);
}));

test("missing dubbing bucket and a full page never acknowledge erasure", async () => withFixture(async input => {
  await retained(input, 101);
  await assert.rejects(purgeDerivedMedia(input.sc, source(), {}), /cleanup_failed/);
  assert.equal(input.state.dubbing.length, 101);
  await assert.rejects(purgeDerivedMedia(input.sc, source(), { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" }), /cleanup_failed/);
  assert.equal(input.state.dubbing.length, 1);
  await purgeDerivedMedia(input.sc, source(), { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" });
  assert.equal(input.state.dubbing.length, 0);
}));

test("canonical owner is required and unrelated retained dubbing survives", async () => withFixture(async input => {
  await retained(input);
  await assert.rejects(purgeDerivedMedia(input.sc, { ...source(), owner_user_id: undefined } as any, {}));
  input.state.dubbing[0].owner_user_id = randomUUID();
  await purgeDerivedMedia(input.sc, source(), {});
  assert.equal(input.state.dubbing.length, 1);
}));

test("bounded retry removes synthetic bytes and completes only a returned CAS row", async () => withFixture(async input => {
  input.state.schema = false;
  await mkdir(join(input.root, "post-media", ownerId), { recursive: true });
  await writeFile(join(input.root, "post-media", source().storage_path), "synthetic original");
  const result = await lifecycle.retryFailedMediaPurges(input.sc, { limit: 1, env: {} });
  assert.equal(result.completed, 1);
  assert.equal(input.state.assets[0].purge_status, "completed");
  assert.ok(input.state.assets[0].version > 4);
  assert.equal(input.state.audits.at(-1)?.event_type, "purge_succeeded");
  await assert.rejects(readFile(join(input.root, "post-media", source().storage_path)), { code: "ENOENT" });
}));

test("failed retry stays withdrawn, cools down, and resumes retained dubbing", async () => withFixture(async input => {
  await retained(input);
  const result = await lifecycle.retryFailedMediaPurges(input.sc, { limit: 1, env: {} });
  assert.equal(result.failed, 1);
  assert.equal(input.state.assets[0].purge_status, "failed");
  assert.equal(input.state.assets[0].moderation_status, "owner_deleted");
  assert.equal(input.state.dubbing.length, 1);
  assert.equal((await lifecycle.retryFailedMediaPurges(input.sc, { limit: 1, env: {} })).attempted, 0);
  input.state.assets[0].updated_at = old;
  assert.equal((await lifecycle.retryFailedMediaPurges(input.sc, { limit: 1, env: { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" } })).completed, 1);
  assert.equal(input.state.dubbing.length, 0);
}));

test("lost completion CAS and data errors cannot report purge success", async () => withFixture(async input => {
  input.state.schema = false;
  input.state.loseCompletion = true;
  assert.equal((await lifecycle.retryFailedMediaPurges(input.sc, { env: {} })).completed, 0);
  assert.notEqual(input.state.assets[0].purge_status, "completed");
  input.state.failTable = "media_assets";
  await assert.rejects(lifecycle.retryFailedMediaPurges(input.sc, { env: {} }));
}));

test("bounded cancellation reaches query transport and cannot start followup removal", async () => withFixture(async input => {
  input.state.hangTable = "media_assets";
  await assert.rejects(lifecycle.retryFailedMediaPurges(input.sc, { operationTimeoutMs: 20, env: {} }), /timeout/);
  assert.ok(input.state.signals.some(signal => signal.aborted));
  assert.deepEqual(input.state.removed, []);
}));

test("concurrent retries claim only one generation and stale pending is recoverable", async () => withFixture(async input => {
  input.state.schema = false;
  input.state.assets[0].purge_status = "pending";
  const results = await Promise.all([lifecycle.retryFailedMediaPurges(input.sc, { env: {} }), lifecycle.retryFailedMediaPurges(input.sc, { env: {} })]);
  assert.equal(results.reduce((total, result) => total + result.completed, 0), 1);
  assert.equal(input.state.removed.length, 1);
}));

async function orphan(input: ReturnType<typeof fixture> & { root: string }) {
  const volume = join(input.root, "adaptive");
  await new AdaptiveArtifacts(volume).initialize();
  const directory = join(volume, "outputs", `${assetId}-4-${randomUUID()}`);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "master.m3u8"), "synthetic private playlist");
  input.state.assets = [];
  const { AdaptiveOrphanReconciler } = await import("../services/media/AdaptiveOrphanReconciler.js");
  let clock = Date.now();
  const reconciler = new AdaptiveOrphanReconciler(input.sc, volume, { now: () => clock });
  return { volume, directory, reconciler, advance: () => { clock += 1800001; } };
}

test("hard deletion with cascaded jobs needs two durable missing observations before private erasure", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    assert.equal((await item.reconciler.runPass()).observed, 1);
    assert.equal(await readFile(join(item.directory, "master.m3u8"), "utf8"), "synthetic private playlist");
    await item.reconciler.close();
    item.advance();
    assert.equal((await item.reconciler.runPass()).removed, 1);
    await assert.rejects(readFile(join(item.directory, "master.m3u8")), { code: "ENOENT" });
    assert.ok(input.state.calls.includes("media_derivative_cancel_asset"));
  } finally { await item.reconciler.close(); }
}));

test("existing source, active lease, and uncertain published receipt each preserve private output", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    await item.reconciler.runPass();
    item.advance();
    input.state.assets = [source()];
    assert.equal((await item.reconciler.runPass()).removed, 0);
    input.state.assets = [];
    for (const state of ["processing", "ready", "cancelled"]) {
      input.state.jobs = [{ asset_id: assetId, state }];
      assert.equal((await item.reconciler.runPass()).removed, 0);
      assert.equal(await readFile(join(item.directory, "master.m3u8"), "utf8"), "synthetic private playlist");
    }
  } finally { await item.reconciler.close(); }
}));

test("authoritative read errors cannot become missing-source proof", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    await item.reconciler.runPass(); item.advance();
    for (const table of ["media_assets", "media_derivative_jobs", "feature_flags"]) {
      input.state.failTable = table;
      await assert.rejects(item.reconciler.runPass());
      assert.equal(await readFile(join(item.directory, "master.m3u8"), "utf8"), "synthetic private playlist");
    }
  } finally { await item.reconciler.close(); }
}));

test("changed output resets grace rather than racing a late worker", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    await item.reconciler.runPass(); item.advance();
    await writeFile(join(item.directory, "v0.m3u8"), "late write");
    assert.equal((await item.reconciler.runPass()).removed, 0);
    assert.equal(await readFile(join(item.directory, "v0.m3u8"), "utf8"), "late write");
    item.advance();
    assert.equal((await item.reconciler.runPass()).removed, 1);
  } finally { await item.reconciler.close(); }
}));

test("orphan cleanup refuses unmarked roots, symlinks, and unexpected owned-directory contents", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    await unlink(join(item.volume, ".portava-adaptive-root"));
    await assert.rejects(item.reconciler.runPass());
    await writeFile(join(item.volume, ".portava-adaptive-root"), "portava-adaptive-root:v1\n", { mode: 0o600 });
    const outside = join(input.root, "unrelated");
    await writeFile(outside, "keep");
    await symlink(outside, join(item.directory, "v0.m3u8"));
    assert.equal((await item.reconciler.runPass()).failed, 1);
    item.advance();
    assert.equal((await item.reconciler.runPass()).removed, 0);
    assert.equal(await readFile(outside, "utf8"), "keep");
    await unlink(join(item.directory, "v0.m3u8"));
    await writeFile(join(item.directory, "not-our-file"), "keep");
    assert.equal((await item.reconciler.runPass()).failed, 1);
  } finally { await item.reconciler.close(); }
}));

test("bounded inventory progresses past preserved entries without starving later orphans", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    for (let index = 0; index < 4; index++) await mkdir(join(item.volume, "outputs", `unowned-${index}`));
    let observed = 0;
    for (let index = 0; index < 8; index++) {
      const result = await item.reconciler.runPass({ limit: 1 });
      assert.ok(result.scanned <= 1);
      observed += result.observed;
    }
    assert.ok(observed > 0);
    item.advance();
    let removed = 0;
    for (let index = 0; index < 8; index++) removed += (await item.reconciler.runPass({ limit: 1 })).removed;
    assert.equal(removed, 1);
  } finally { await item.reconciler.close(); }
}));

test("image variant deletion is independent of generation flags and leaves a durable tombstone", async () => withFixture(async input => {
  const { ImageVariantArtifacts } = await import("../lib/media/imageVariants/artifacts.js");
  const volume = join(input.root, "images");
  await new ImageVariantArtifacts(volume).initialize();
  const directory = join(volume, "assets", assetId, "4", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "thumb.jpg"), "synthetic image bytes");
  const image = { ...source(), media_type: "image", size_bytes: 100 };
  input.state.assets = [image];
  await purgeDerivedMedia(input.sc, image, { MEDIA_IMAGE_VARIANTS_ROOT: volume, MEDIA_IMAGE_VARIANTS_ENABLED: "0" });
  await assert.rejects(readFile(join(directory, "thumb.jpg")), { code: "ENOENT" });
  assert.equal(await readFile(join(volume, "revoked", assetId), "utf8"), "revoked\n");
}));

test("retained image jobs without the original private volume remain retryable", async () => withFixture(async input => {
  const image = { ...source(), media_type: "image", size_bytes: 100 };
  input.state.assets = [image];
  input.state.jobs = [{ asset_id: assetId, kind: "image_variants" }];
  await assert.rejects(purgeDerivedMedia(input.sc, image, {}), /image.*volume/i);
}));

test("ambiguous purge completion does not roll back a possibly committed completion", async () => withFixture(async input => {
  input.state.schema = false;
  input.state.ambiguousCompletion = true;
  const result = await lifecycle.retryFailedMediaPurges(input.sc, { env: {} });
  assert.equal(result.completed, 0);
  assert.equal(result.failed, 1);
  assert.equal(input.state.assets[0].purge_status, "completed");
  assert.equal(input.state.audits.some(row => row.event_type === "purge_failed"), false);
}));

test("storage timeout remains retryable and never writes a success audit", async () => withFixture(async input => {
  input.state.schema = false;
  input.state.hangStorage = true;
  const started = Date.now();
  const result = await lifecycle.retryFailedMediaPurges(input.sc, { operationTimeoutMs: 20, env: {} });
  assert.equal(result.failed, 1);
  assert.ok(Date.now() - started < 1000);
  assert.equal(input.state.assets[0].purge_status, "failed");
  assert.equal(input.state.audits.some(row => row.event_type === "purge_succeeded"), false);
}));

test("source generation changed during storage removal cannot be completed or overwritten", async () => withFixture(async input => {
  input.state.schema = false;
  input.state.beforeRemove = () => { input.state.assets[0].version += 1; input.state.assets[0].purge_status = "not_requested"; };
  assert.equal((await lifecycle.retryFailedMediaPurges(input.sc, { env: {} })).completed, 0);
  assert.equal(input.state.assets[0].purge_status, "not_requested");
  assert.equal(input.state.audits.length, 0);
}));

test("old stale-pending rows are not starved by a failed-purge backlog", async () => withFixture(async input => {
  input.state.schema = false;
  input.state.assets.push({ ...source(), id: randomUUID(), purge_status: "pending", updated_at: "2024-01-01T00:00:00.000Z" });
  const pending = input.state.assets[1];
  assert.equal((await lifecycle.retryFailedMediaPurges(input.sc, { limit: 1, env: {} })).completed, 1);
  assert.equal(pending.purge_status, "completed");
  assert.equal(input.state.assets[0].purge_status, "failed");
}));

test("orphan staging deletion is bounded to original and recognized output files", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    const workspace = await new AdaptiveArtifacts(item.volume).workspace({ assetId, sourceVersion: 3, bucket: "post-media", path: source().storage_path, sizeBytes: 10 });
    await writeFile(join(workspace, "original"), "synthetic");
    await writeFile(join(workspace, "out", "v0-00000.ts"), "synthetic segment");
    assert.equal((await item.reconciler.runPass()).observed, 2);
    item.advance();
    assert.equal((await item.reconciler.runPass()).removed, 2);
    await assert.rejects(readFile(join(workspace, "original")), { code: "ENOENT" });
  } finally { await item.reconciler.close(); }
}));

test("renewed source or lease evidence resets the orphan observation grace", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    await item.reconciler.runPass(); item.advance();
    input.state.jobs = [{ asset_id: assetId, state: "processing" }];
    await item.reconciler.runPass();
    input.state.jobs = [];
    const observed = await item.reconciler.runPass();
    assert.equal(observed.observed, 1);
    assert.equal(observed.removed, 0);
    item.advance();
    assert.equal((await item.reconciler.runPass()).removed, 1);
  } finally { await item.reconciler.close(); }
}));

test("corrupt orphan observations never authorize byte removal", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    await item.reconciler.runPass(); item.advance();
    await writeFile(join(item.directory, ".portava-orphan-observation"), "invalid");
    assert.equal((await item.reconciler.runPass()).failed, 1);
    assert.equal(await readFile(join(item.directory, "master.m3u8"), "utf8"), "synthetic private playlist");
  } finally { await item.reconciler.close(); }
}));

test("orphan grace and confirmed cancellation are mandatory, not inferred from age or absence", async () => withFixture(async input => {
  const item = await orphan(input);
  try {
    await item.reconciler.runPass();
    assert.equal((await item.reconciler.runPass()).removed, 0);
    item.advance(); input.state.cancelAccepted = false;
    await assert.rejects(item.reconciler.runPass(), /cancellation unconfirmed/);
    assert.equal(await readFile(join(item.directory, "master.m3u8"), "utf8"), "synthetic private playlist");
  } finally { await item.reconciler.close(); }
}));

test("generation-only races fence completion even when deletion status stays pending", async () => withFixture(async input => {
  input.state.schema = false;
  input.state.beforeRemove = () => { input.state.assets[0].version += 1; };
  assert.equal((await lifecycle.retryFailedMediaPurges(input.sc, { env: {} })).completed, 0);
  assert.equal(input.state.assets[0].purge_status, "pending");
  assert.equal(input.state.audits.length, 0);
}));

test("missing original adaptive or image volumes cannot be created empty and acknowledged erased", async () => withFixture(async input => {
  const missingAdaptive = join(input.root, "missing-adaptive");
  await assert.rejects(purgeDerivedMedia(input.sc, source(), { MEDIA_ADAPTIVE_ROOT: missingAdaptive }));
  await assert.rejects(lstat(missingAdaptive), { code: "ENOENT" });
  const missingImages = join(input.root, "missing-images");
  const image = { ...source(), media_type: "image", size_bytes: 100 };
  input.state.assets = [image];
  await assert.rejects(purgeDerivedMedia(input.sc, image, { MEDIA_IMAGE_VARIANTS_ROOT: missingImages }));
  await assert.rejects(lstat(missingImages), { code: "ENOENT" });
}));
