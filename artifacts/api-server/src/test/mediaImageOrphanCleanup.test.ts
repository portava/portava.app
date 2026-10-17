import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ImageVariantArtifacts } from "../lib/media/imageVariants/artifacts.js";
import type { ImageVariantsOrphanReconciler } from "../services/media/ImageVariantsOrphanReconciler.js";

const assetId = "10000000-0000-4000-a000-000000000001";
const grace = 30 * 60 * 1000;
interface State { source: boolean; jobs: boolean; error: string; signals: AbortSignal[]; calls: string[]; onCancel: () => void }
async function fixture(run: (input: { state: State; root: string; path: string; reconciler: ImageVariantsOrphanReconciler;
  advance: (milliseconds?: number) => void; restart: () => Promise<ImageVariantsOrphanReconciler> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "image-orphan-"));
  const artifacts = new ImageVariantArtifacts(root);
  await artifacts.initialize();
  const directory = join(root, "assets", assetId, "4", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "thumb.jpg");
  await writeFile(path, "synthetic private image", { mode: 0o600 });
  const state: State = { source: false, jobs: false, error: "", signals: [], calls: [], onCancel: () => {} };
  const client = {
    from(table: string) {
      const query = {
        select() { return query; }, eq() { return query; }, limit() { return query; }, maybeSingle() { return query; },
        abortSignal(signal: AbortSignal) { state.signals.push(signal); return query; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          state.calls.push(table);
          return Promise.resolve(state.error === table ? { error: new Error("data unavailable"), data: null } : { error: null,
            data: table === "feature_flags" ? { flag: "media_derivative_jobs_enabled" } : table === "media_assets" ? (state.source ? { id: assetId } : null)
              : table === "media_derivative_jobs" ? (state.jobs ? [{ id: randomUUID(), state: "completed" }] : []) : [] }).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string) {
      state.calls.push(name);
      if (state.error === name) return { error: new Error("RPC unavailable"), data: null };
      if (name === "media_derivative_schema_status") return { error: null, data: { media_derivative_jobs: true,
        media_caption_manifests: false, media_visual_embeddings: false, media_image_understanding_artifacts: false, media_dubbing_artifacts: false } };
      if (name === "media_derivative_cancel_asset") state.onCancel();
      return { error: null, data: true };
    },
  } as unknown as SupabaseClient;
  const { ImageVariantsOrphanReconciler: Reconciler } = await import("../services/media/ImageVariantsOrphanReconciler.js");
  let clock = Date.now();
  let reconciler = new Reconciler(client, root, { now: () => clock });
  const restart = async () => { await reconciler.close(); reconciler = new Reconciler(client, root, { now: () => clock }); return reconciler; };
  try { await run({ state, root, path, reconciler, advance: (milliseconds = grace) => { clock += milliseconds; }, restart }); }
  finally { await reconciler.close(); await rm(root, { recursive: true, force: true }); }
}

test("first absent pass preserves image; only unchanged later grace pass erases exact files", async () => fixture(async ({ state, root, path, reconciler, advance }) => {
  const first = await reconciler.runPass();
  assert.equal(first.removed, 0); assert.equal(first.observed, 1);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
  assert.ok(!state.calls.includes("media_derivative_cancel_asset"));
  advance(grace - 1);
  assert.equal((await reconciler.runPass()).removed, 0);
  advance(1);
  const result = await reconciler.runPass();
  assert.equal(result.removed, 1);
  await assert.rejects(readFile(path), { code: "ENOENT" });
  assert.equal(await readFile(join(root, "revoked", assetId), "utf8"), "revoked\n");
  assert.ok(state.calls.includes("media_derivative_cancel_asset"));
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith(".image-orphan-")), []);
}));

test("existing sources or any retained publication/lease preserve image artifacts", async () => fixture(async ({ state, path, reconciler }) => {
  state.source = true;
  assert.equal((await reconciler.runPass()).removed, 0);
  state.source = false; state.jobs = true;
  assert.equal((await reconciler.runPass()).removed, 0);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
  assert.ok(!state.calls.includes("media_derivative_cancel_asset"));
}));

test("cache/data errors reset grace and a source reappearing inside the lock cannot authorize erasure", async () => fixture(async ({ state, path, reconciler, advance }) => {
  await reconciler.runPass(); advance();
  state.error = "media_assets";
  assert.equal((await reconciler.runPass()).failed, 1);
  state.error = "";
  assert.equal((await reconciler.runPass()).observed, 1);
  advance(); state.onCancel = () => { state.source = true; };
  assert.equal((await reconciler.runPass()).removed, 0);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
}));

test("new retained job or unrecognized file remains untouched", async () => fixture(async ({ state, path, reconciler, advance }) => {
  await reconciler.runPass(); advance();
  state.onCancel = () => { state.jobs = true; };
  assert.equal((await reconciler.runPass()).removed, 0);
  state.jobs = false; state.onCancel = () => {};
  await writeFile(join(path, "..", "unknown.bin"), "unknown", { mode: 0o600 });
  assert.equal((await reconciler.runPass()).failed, 1);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
}));

test("durable observation outside rendition survives a new reconciler instance", async () => fixture(async ({ root, path, reconciler, advance, restart }) => {
  assert.equal((await reconciler.runPass()).removed, 0);
  const names = (await readdir(root)).filter(name => name.startsWith(".image-orphan-") && name.endsWith(".json"));
  assert.equal(names.length, 1);
  const record = await readFile(join(root, names[0]), "utf8");
  assert.equal(JSON.parse(record).version, 1);
  assert.deepEqual(await readdir(join(path, "..")), ["thumb.jpg"]);
  const fresh = await restart();
  advance(grace - 1);
  assert.equal((await fresh.runPass()).removed, 0);
  assert.equal(await readFile(join(root, names[0]), "utf8"), record);
  advance(1);
  assert.equal((await fresh.runPass()).removed, 1);
}));

test("modified fingerprint restarts the full durable grace, including after restart", async () => fixture(async ({ root, path, reconciler, advance, restart }) => {
  await reconciler.runPass();
  const name = (await readdir(root)).find(name => name.startsWith(".image-orphan-") && name.endsWith(".json"))!;
  const before = JSON.parse(await readFile(join(root, name), "utf8"));
  advance(); await writeFile(path, "changed synthetic image");
  const changed = await reconciler.runPass();
  assert.equal(changed.observed, 1); assert.equal(changed.removed, 0);
  const after = JSON.parse(await readFile(join(root, name), "utf8"));
  assert.notEqual(after.fingerprint, before.fingerprint); assert.equal(after.firstSeen - before.firstSeen, grace);
  const fresh = await restart(); advance(grace - 1);
  assert.equal((await fresh.runPass()).removed, 0);
  advance(1); assert.equal((await fresh.runPass()).removed, 1);
}));

test("live source or uncertain retained job invalidates prior absence proof", async () => fixture(async ({ state, reconciler, advance }) => {
  for (const field of ["source", "jobs"] as const) {
    assert.equal((await reconciler.runPass()).removed, 0); advance();
    state[field] = true; assert.equal((await reconciler.runPass()).removed, 0);
    state[field] = false;
    const reset = await reconciler.runPass(); assert.equal(reset.removed, 0); assert.equal(reset.observed, 1);
  }
}));

test("clock rollback cannot inherit matured observations", async () => fixture(async ({ reconciler, advance }) => {
  await reconciler.runPass(); advance(-1000);
  const reset = await reconciler.runPass(); assert.equal(reset.removed, 0); assert.equal(reset.observed, 1);
  advance(grace - 1); assert.equal((await reconciler.runPass()).removed, 0);
  advance(1); assert.equal((await reconciler.runPass()).removed, 1);
}));

test("fingerprint changed during under-lock cancellation must receive a fresh full grace", async () => fixture(async ({ state, path, reconciler, advance }) => {
  await reconciler.runPass(); advance();
  state.onCancel = () => { writeFileSync(path, "changed during cancellation"); };
  assert.equal((await reconciler.runPass()).removed, 0);
  assert.equal(await readFile(path, "utf8"), "changed during cancellation");
  state.onCancel = () => {};
  assert.equal((await reconciler.runPass()).observed, 1);
  advance(grace - 1); assert.equal((await reconciler.runPass()).removed, 0);
  advance(1); assert.equal((await reconciler.runPass()).removed, 1);
}));

test("replaced durable proof is rechecked under lock immediately before erasure", async () => fixture(async ({ state, root, path, reconciler, advance }) => {
  await reconciler.runPass(); advance();
  const name = (await readdir(root)).find(name => name.startsWith(".image-orphan-") && name.endsWith(".json"))!;
  state.onCancel = () => {
    const record = JSON.parse(readFileSync(join(root, name), "utf8"));
    record.firstSeen += grace * 2;
    writeFileSync(join(root, name), JSON.stringify(record));
  };
  assert.equal((await reconciler.runPass()).removed, 0);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
  state.onCancel = () => {};
  assert.equal((await reconciler.runPass()).observed, 1);
}));

test("mature grace does not override a live lock or failed cancellation receipt", async () => fixture(async ({ state, root, path, reconciler, advance }) => {
  await reconciler.runPass(); advance();
  const lock = join(root, "locks", assetId);
  await mkdir(lock, { mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(reconciler.runPass({ signal: controller.signal })); }
  finally { clearTimeout(timer); }
  assert.equal((await lstat(lock)).isDirectory(), true);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
  await rm(lock, { recursive: true });
  assert.equal((await reconciler.runPass()).observed, 1);
  advance(); state.error = "media_derivative_cancel_asset";
  assert.equal((await reconciler.runPass()).failed, 1);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
  state.error = "";
  assert.equal((await reconciler.runPass()).observed, 1);
}));

test("malformed or symlinked observations are refused without deleting unknown files", async () => fixture(async ({ root, path, reconciler, advance }) => {
  await reconciler.runPass(); advance();
  const name = (await readdir(root)).find(name => name.startsWith(".image-orphan-") && name.endsWith(".json"))!;
  const observation = join(root, name);
  await writeFile(observation, "unrecognized state");
  assert.equal((await reconciler.runPass()).failed, 1);
  assert.equal(await readFile(observation, "utf8"), "unrecognized state");
  await rm(observation); await symlink(path, observation);
  assert.equal((await reconciler.runPass()).failed, 1);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
  assert.equal((await lstat(observation)).isSymbolicLink(), true);
}));

test("missing marker and held lock are never initialized or stolen", async () => fixture(async ({ root, path, reconciler }) => {
  await mkdir(join(root, "locks", assetId), { mode: 0o700 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(reconciler.runPass({ signal: controller.signal })); }
  finally { clearTimeout(timer); }
  assert.equal((await lstat(join(root, "locks", assetId))).isDirectory(), true);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
  await rm(join(root, ".image-variants-root"));
  await assert.rejects(reconciler.runPass());
  await assert.rejects(lstat(join(root, ".image-variants-root")), { code: "ENOENT" });
}));

test("bounded passes retain cursor and advance beyond preserved sources", async () => fixture(async ({ state, root, path, reconciler }) => {
  state.source = true;
  const directory = join(root, "assets", assetId, "4", randomUUID());
  await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, "thumb.jpg"), "second synthetic image", { mode: 0o600 });
  assert.equal((await reconciler.runPass({ limit: 1 })).scanned, 1);
  assert.equal((await reconciler.runPass({ limit: 1 })).scanned, 1);
  assert.equal((await reconciler.runPass({ limit: 1 })).pageExhausted, true);
  assert.equal(await readFile(path, "utf8"), "synthetic private image");
}));
