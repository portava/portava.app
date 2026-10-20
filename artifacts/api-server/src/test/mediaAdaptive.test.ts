import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { makeFeedDb } from "./helpers/fakeFeedDb.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { AdaptiveArtifacts } from "../lib/media/adaptive/artifacts.js";
import { canonicalSource } from "../lib/media/adaptive/canonical.js";
import { createSelfHostedAdaptive, downloadAdaptiveSource } from "../lib/media/adaptive/service.js";
import { createAdaptiveJobHandler } from "../lib/media/adaptive/handler.js";
import { decodeAdaptiveOutput } from "../lib/media/adaptive/descriptor.js";
import { adaptiveByteRange, createMediaAdaptiveRouter } from "../routes/mediaAdaptive.js";
import type { AdaptiveJobs, AdaptiveLease } from "../lib/media/adaptive/jobs.js";
import type { AdaptiveConfig, AdaptiveOutput, AdaptiveSource } from "../lib/media/adaptive/types.js";

const ASSET = "aa000000-0000-4000-8000-000000000001";
const OWNER = "bb000000-0000-4000-8000-000000000001";
const VIEWER = "cc000000-0000-4000-8000-000000000001";
const source: AdaptiveSource = { assetId: ASSET, sourceVersion: 7, bucket: "post-media", path: `${OWNER}/movie.mp4`, sizeBytes: 16 };
const folders: string[] = [];

afterEach(async () => {
  _clearTestClient();
  _setTestServiceClient(null);
  _resetRateLimit();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "adaptive-state-"));
  folders.push(root);
  const asset = { id: ASSET, version: 7, owner_user_id: OWNER, storage_bucket: source.bucket, storage_path: source.path,
    size_bytes: 16, media_type: "video", processing_status: "ready", moderation_status: "active", deleted_at: null, purge_status: "not_requested" };
  const failReads: Record<string, true> = {};
  const db = makeFeedDb({ tables: {
    media_assets: [asset], feature_flags: [{ flag: "media_transcoder_enabled", enabled: true }],
    posts: [{ id: "post", author_id: OWNER, visibility: "public", status: "active", post_status: "published" }],
    post_media: [{ post_id: "post", storage_path: source.path, moderation_status: "approved", processing_status: "ready" }],
    profiles: [{ id: OWNER, account_status: "active" }, { id: VIEWER, account_status: "active" }],
  }, users: { owner: OWNER, viewer: VIEWER }, failReads });
  const config: AdaptiveConfig = { enabled: true, root, apiBaseUrl: "https://api.example.test/api",
    storageOrigin: "https://storage.example.test", ffmpeg: "/synthetic-fixture-only/ffmpeg", ffprobe: "/synthetic-fixture-only/ffprobe" };
  const state = { output: null as AdaptiveOutput | null, queued: 0, published: 0, cancelled: false, current: true, losePublish: false,
    downloads: 0, encodes: 0, beforePublish: () => {}, afterReady: () => {}, afterDownload: () => {}, afterEncode: () => {} };
  const jobs: AdaptiveJobs & { publish(job: AdaptiveLease, output: AdaptiveOutput): Promise<boolean> } = {
    async enqueue(actual) { assert.deepEqual(actual, source); state.queued++; return { id: "job" }; },
    async ready(assetId, generation) {
      assert.equal(assetId, ASSET); assert.equal(generation, 7);
      state.afterReady();
      return decodeAdaptiveOutput(state.output, source);
    },
    async publish(job, output) {
      state.beforePublish();
      if (state.losePublish || !state.current || state.cancelled || asset.version !== job.source.sourceVersion) return false;
      state.published++; state.output = output; state.current = false; return true;
    },
    async cancelAsset(assetId) { assert.equal(assetId, ASSET); state.cancelled = true; state.current = false; state.output = null; },
  };
  const controller = new AbortController();
  const job: AdaptiveLease = { id: "job", source: { ...source }, token: "lease-1", signal: controller.signal,
    async isCurrent() { return state.current && !state.cancelled; } };
  const download = async (_sc: unknown, _config: AdaptiveConfig, actual: AdaptiveSource, destination: string, signal: AbortSignal) => {
    assert.deepEqual(actual, source); signal.throwIfAborted(); state.downloads++;
    await writeFile(destination, Buffer.alloc(16)); state.afterDownload();
  };
  const encode = async (_config: AdaptiveConfig, input: string, directory: string, signal?: AbortSignal) => {
    signal?.throwIfAborted(); assert.equal((await readFile(input)).length, 16); state.encodes++;
    const files: AdaptiveOutput["files"] = {};
    for (const [name, contents] of Object.entries({ "master.m3u8": "#EXTM3U\nv0.m3u8\nv1.m3u8\n",
      "v0.m3u8": "#EXTM3U\nv0-00000.ts\n", "v1.m3u8": "#EXTM3U\nv1-00000.ts\n",
      "v0-00000.ts": "0123456789", "v1-00000.ts": "abcdefghij", "preview.jpg": "synthetic-preview" })) {
      await writeFile(join(directory, name), contents);
      files[name] = { bytes: Buffer.byteLength(contents), sha256: createHash("sha256").update(contents).digest("hex") };
    }
    state.afterEncode();
    return { files, probe: { width: 1280, height: 720, duration: 4, fps: 30, codec: "h264" },
      preview: { file: "preview.jpg" as const, width: 320, height: 180, atSeconds: 1 },
      renditions: [360, 720].map(height => ({ height, width: height * 16 / 9, bitrateKbps: height,
      peakBitrateKbps: height, durationSeconds: 4, playlist: height === 360 ? "v0.m3u8" : "v1.m3u8" })) };
  };
  const processor = createSelfHostedAdaptive(db.client, config, jobs, { download, encode });
  const runtime = { ...processor, async processJob(input: AdaptiveLease) {
    const workerModule = process.env.ADAPTIVE_SHARED_WORKER_PATH ?? "../lib/media/jobs/worker.js";
    const { runMediaWorkerPass } = await import(workerModule);
    const handler = createAdaptiveJobHandler(db.client, config, jobs, { download, encode });
    let failure: unknown;
    const wrapped = { ...handler, async handle(context: Parameters<typeof handler.handle>[0]) {
      try { return await handler.handle(context); } catch (error) { failure = error; throw error; }
    } };
    const summary = await runMediaWorkerPass({
      async recover() { return 0; },
      async claim() { return [{ ...input.source, id: input.id, token: input.token, ownerUserId: OWNER,
        kind: "adaptive_video", modelVersion: "hls-v1", attempt: 1, leaseUntil: new Date(Date.now() + 900_000).toISOString() }]; },
      async renew() { return input.isCurrent(); },
      async finish(_job: unknown, completion: { success: boolean; output?: { result: AdaptiveOutput } }) {
        if (!completion.success) return false;
        try { return await jobs.publish(input, completion.output!.result); } catch (error) { failure = error; throw error; }
      },
    }, wrapped, { enabled: true, concurrency: 1, leaseSeconds: 900, signal: input.signal });
    if (summary.completed !== 1) throw failure ?? new Error("adaptive publication lost generation/lease CAS");
    return state.output;
  } };
  return { db, asset, failReads, root, config, jobs, job, state, runtime, processor, controller, download, encode };
}

test("queue request requires the exact positive safe source generation and storage key", async () => {
  const context = await fixture();
  for (const version of [undefined, null, 0, -1, 1.5, 8, Number.MAX_SAFE_INTEGER + 1]) {
    const result = await context.runtime.adapter.submit({ assetId: ASSET, bucket: source.bucket, path: source.path,
      sourceVersion: version, durationMs: null } as any);
    assert.equal(result.ok, false);
  }
  assert.equal((await context.runtime.adapter.submit({ assetId: ASSET, bucket: source.bucket, path: "wrong", sourceVersion: 7, durationMs: null } as any)).ok, false);
  assert.equal(context.state.queued, 0);
  assert.equal((await context.runtime.adapter.submit({ assetId: ASSET, bucket: source.bucket, path: source.path, sourceVersion: 7, durationMs: null } as any)).ok, true);
  assert.equal(context.state.queued, 1);
  assert.equal(context.state.encodes, 0);
});

test("config OFF, database OFF, missing flag and failed flag refuse enqueue and playback", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  for (const stop of [() => { context.config.enabled = false; }, () => { context.config.enabled = true; context.db.tables.feature_flags[0].enabled = false; },
    () => { context.db.tables.feature_flags = []; }, () => { context.failReads.feature_flags = true; }]) {
    stop();
    assert.equal((await context.runtime.adapter.submit({ ...source, durationMs: null } as any)).ok, false);
    assert.equal(await context.runtime.playback(OWNER, ASSET), null);
    assert.equal(await context.runtime.readFile(OWNER, ASSET, 7, "master.m3u8"), null);
  }
  assert.equal(context.state.queued, 0);
});

for (const [field, value] of Object.entries({ version: 0, owner_user_id: VIEWER, storage_bucket: "chat-media", storage_path: "../escape",
  size_bytes: 128 * 1024 * 1024 + 1, media_type: "image", processing_status: "processing", moderation_status: "pending",
  deleted_at: "2026-10-15T00:00:00Z", purge_status: "pending" })) {
  test(`canonical ${field} refuses before downloading`, async () => {
    const context = await fixture();
    (context.asset as any)[field] = value;
    assert.equal(await canonicalSource(context.db.client, ASSET), null);
    await assert.rejects(context.runtime.processJob(context.job));
    assert.equal(context.state.downloads, 0);
  });
}

test("stateful processing publishes actual files only once, and erases after durable cancellation", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  assert.equal(context.state.published, 1);
  assert.equal(context.state.encodes, 1);
  await assert.rejects(context.runtime.processJob(context.job));
  assert.equal(context.state.encodes, 1);
  assert.deepEqual(await readdir(join(context.root, "staging")), []);
  assert.equal((await context.runtime.adapter.ladder({ assetId: ASSET })).ok, true);
  assert.equal((await context.runtime.readFile(OWNER, ASSET, 7, "v0-00000.ts"))?.toString(), "0123456789");
  await context.runtime.eraseAsset(ASSET);
  assert.equal(context.state.cancelled, true);
  assert.deepEqual(await readdir(join(context.root, "outputs")), []);
  await assert.rejects(context.runtime.processJob(context.job));
  assert.equal(await context.runtime.playback(OWNER, ASSET), null);
});

test("eraser never deletes artifacts if durable cancellation fails", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  context.jobs.cancelAsset = async () => { throw new Error("database unavailable"); };
  await assert.rejects(context.runtime.eraseAsset(ASSET));
  assert.equal((await readdir(join(context.root, "outputs"))).length, 1);
});

for (const when of ["beforeStart", "afterDownload", "afterEncode", "beforePublish"] as const) {
  test(`source generation change ${when} prevents publication and cleans artifacts`, async () => {
    const context = await fixture();
    if (when === "beforeStart") context.asset.version++;
    else context.state[when] = () => { context.asset.version++; };
    await assert.rejects(context.runtime.processJob(context.job));
    assert.equal(context.state.published, 0);
    assert.equal(context.state.output, null);
    assert.equal(context.state.downloads, when === "beforeStart" ? 0 : 1);
    assert.equal(context.state.encodes, when === "beforeStart" || when === "afterDownload" ? 0 : 1);
    if (when !== "beforeStart") {
      assert.deepEqual(await readdir(join(context.root, "outputs")), []);
      assert.deepEqual(await readdir(join(context.root, "staging")), []);
    }
  });
}

test("lost lease publication CAS cleans unpublished output, preserves retry capability", async () => {
  const context = await fixture();
  context.state.losePublish = true;
  await assert.rejects(context.runtime.processJob(context.job), /CAS/);
  assert.deepEqual(await readdir(join(context.root, "outputs")), []);
  context.state.losePublish = false;
  context.job.token = "lease-retry";
  await context.runtime.processJob(context.job);
  assert.equal(context.state.published, 1);
});

test("ambiguous finish acknowledgement never destroys a durably published artifact", async () => {
  const context = await fixture();
  const publish = context.jobs.publish;
  context.jobs.publish = async (job, output) => {
    assert.equal(await publish(job, output), true);
    throw new Error("connection lost after transaction committed");
  };
  await assert.rejects(context.runtime.processJob(context.job), /connection lost/);
  assert.equal(context.state.published, 1);
  assert.equal((await context.runtime.readFile(OWNER, ASSET, 7, "v0-00000.ts"))?.toString(), "0123456789");
  await context.runtime.eraseAsset(ASSET);
  assert.deepEqual(await readdir(join(context.root, "outputs")), []);
});

test("cancellation ends a stalled lease read without invoking further canonical reads", async () => {
  const context = await fixture();
  context.job.isCurrent = () => new Promise<boolean>(() => {});
  const pending = context.processor.processJob(context.job);
  context.controller.abort();
  const settled = await Promise.race([pending.then(() => false, () => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))]);
  assert.equal(settled, true);
  assert.equal(context.state.downloads, 0);
});

test("cancelled work never invokes download or encoder", async () => {
  const context = await fixture();
  context.controller.abort();
  await assert.rejects(context.runtime.processJob(context.job));
  assert.equal(context.state.downloads, 0);
});

test("shared handler is single-concurrency and aborts in-flight encoding without publication", async () => {
  const context = await fixture();
  let began: () => void = () => {};
  const started = new Promise<void>(resolve => { began = resolve; });
  const handler = createAdaptiveJobHandler(context.db.client, context.config, context.jobs, { download: context.download,
    encode: async (_config, _input, _directory, signal) => {
      began();
      await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => reject(new Error("cancelled encode")), { once: true }));
      throw new Error("unreachable");
    } });
  const workerContext = { job: { ...context.job.source, id: context.job.id, token: context.job.token, kind: "adaptive_video", modelVersion: "hls-v1" },
    signal: context.controller.signal, isCurrent: context.job.isCurrent };
  const pending = handler.handle(workerContext);
  await started;
  await assert.rejects(handler.handle(workerContext), /concurrency/);
  context.controller.abort();
  await assert.rejects(pending, /cancelled encode/);
  assert.equal(context.state.published, 0);
  assert.deepEqual(await readdir(join(context.root, "staging")), []);
});

test("a telemetry failure cannot turn a successful durable publication into a retry", async () => {
  const context = await fixture();
  const runtime = createSelfHostedAdaptive(context.db.client, context.config, context.jobs, { download: context.download,
    encode: context.encode, metric: () => { throw new Error("metrics offline"); } });
  const output = await runtime.processJob(context.job);
  await context.jobs.publish(context.job, output);
  assert.equal(context.state.published, 1);
  assert.ok(await runtime.readFile(OWNER, ASSET, 7, "master.m3u8"));
});

test("a descriptor for another asset/generation cannot authorize its bytes", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  for (const directory of [`${VIEWER}-7-lease`, `${ASSET}-8-lease`]) {
    context.state.output!.directory = directory;
    assert.equal(await context.runtime.readFile(OWNER, ASSET, 7, "master.m3u8"), null);
    assert.equal(await context.runtime.playback(OWNER, ASSET), null);
    assert.equal((await context.runtime.adapter.ladder({ assetId: ASSET })).ok, false);
  }
});

test("ready descriptor decoding bounds identities, filenames, digests, sizes, renditions and preview metadata", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  const original = context.state.output!;
  assert.deepEqual(decodeAdaptiveOutput(original, source), original);
  const mutations: Array<(output: AdaptiveOutput) => void> = [
    output => { output.directory += "/../escape"; },
    output => { output.files["../escape"] = output.files["master.m3u8"]; },
    output => { output.files["v0-00000.ts"].sha256 = "unverified"; },
    output => { output.files["v0-00000.ts"].bytes = 9 * 1024 * 1024; },
    output => { delete output.files["preview.jpg"]; },
    output => { output.renditions.pop(); },
    output => { output.renditions[1].height = output.renditions[0].height; },
    output => { output.renditions[0].playlist = "https://public.example.test/segments.m3u8"; },
    output => { output.probe.duration = 121; },
    output => { output.preview.width = 321; },
    output => { (output as any).extra = "x".repeat(60_000); },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.equal(decodeAdaptiveOutput(changed, source), null);
  }
  assert.equal(decodeAdaptiveOutput(original, { ...source, sourceVersion: 8 }), null);
});

test("discard can erase only its own lease directory, never another attempt or asset", async () => {
  const context = await fixture();
  const output = await context.processor.processJob(context.job);
  await assert.rejects(context.processor.discard({ source, token: "other-lease" }, output));
  await assert.rejects(context.processor.discard({ source: { ...source, assetId: VIEWER }, token: context.job.token }, output));
  assert.equal((await readdir(join(context.root, "outputs"))).length, 1);
  assert.equal(context.state.published, 0, "handler never publishes");
  await context.processor.discard(context.job, output);
  assert.deepEqual(await readdir(join(context.root, "outputs")), []);
});

test("replaced storage key after download never reaches encoder", async () => {
  const context = await fixture();
  context.state.afterDownload = () => { context.asset.storage_path = `${OWNER}/replacement.mp4`; };
  await assert.rejects(context.runtime.processJob(context.job));
  assert.equal(context.state.encodes, 0);
});

test("mutating a caller-owned job cannot rebase downloaded bytes onto a newer generation", async () => {
  const context = await fixture();
  context.state.afterDownload = () => {
    context.asset.version++;
    context.job.source.sourceVersion++;
  };
  await assert.rejects(context.processor.processJob(context.job));
  assert.equal(context.state.encodes, 0);
  assert.equal(context.state.published, 0);
});

test("download signs only the canonical original and streams exact bounded bytes without redirects", async (context) => {
  const fixtureState = await fixture();
  let calls = 0;
  const client = { storage: { from(bucket: string) {
    assert.equal(bucket, source.bucket);
    return { async createSignedUrl(storagePath: string, seconds: number) {
      assert.equal(storagePath, source.path); assert.equal(seconds, 60);
      return { data: { signedUrl: "https://storage.example.test/storage/v1/object/sign/synthetic?token=synthetic" }, error: null };
    } };
  } } } as any;
  const fetchMock = context.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assert.equal(new URL(String(url)).origin, fixtureState.config.storageOrigin);
    assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
    calls++;
    return new Response(Buffer.alloc(16), { headers: { "content-length": "16" } });
  });
  const destination = join(fixtureState.root, "source");
  await downloadAdaptiveSource(client, fixtureState.config, source, destination, fixtureState.controller.signal);
  assert.equal((await readFile(destination)).length, 16); assert.equal(calls, 1);
  for (const size of [15, 17]) {
    fetchMock.mock.mockImplementation(async () => new Response(Buffer.alloc(size)));
    await assert.rejects(downloadAdaptiveSource(client, fixtureState.config, source, join(fixtureState.root, `source-${size}`), fixtureState.controller.signal));
  }
  fetchMock.mock.mockImplementation(async () => new Response(Buffer.alloc(16), { headers: { "content-length": "17" } }));
  await assert.rejects(downloadAdaptiveSource(client, fixtureState.config, source, join(fixtureState.root, "declared-wrong"), fixtureState.controller.signal));
  const wrongOrigin = { ...fixtureState.config, storageOrigin: "https://other.example.test" };
  const requestsBefore = fetchMock.mock.callCount();
  await assert.rejects(downloadAdaptiveSource(client, wrongOrigin, source, join(fixtureState.root, "external"), fixtureState.controller.signal));
  assert.equal(fetchMock.mock.callCount(), requestsBefore);
});

test("every master, variant and segment read reevaluates visibility; no previous allow is cached", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  for (const filename of ["master.m3u8", "v0.m3u8", "v1.m3u8", "v0-00000.ts", "v1-00000.ts", "preview.jpg"]) {
    context.db.tables.posts[0].visibility = "public";
    assert.ok(await context.runtime.readFile(VIEWER, ASSET, 7, filename), `${filename} should be authorized before revocation`);
    context.db.tables.posts[0].visibility = "private";
    assert.equal(await context.runtime.readFile(VIEWER, ASSET, 7, filename), null, filename);
    assert.ok(await context.runtime.readFile(OWNER, ASSET, 7, filename));
  }
});

test("revocation during ready lookup is rechecked before response bytes", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  context.state.afterReady = () => { context.asset.deleted_at = "now" as any; };
  assert.equal(await context.runtime.readFile(OWNER, ASSET, 7, "v0-00000.ts"), null);
});

test("block, canonical read error, source replacement and deletion refuse retained output", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  context.db.tables.blocks = [{ blocker_id: OWNER, blocked_id: VIEWER }];
  assert.equal(await context.runtime.readFile(VIEWER, ASSET, 7, "v0-00000.ts"), null);
  context.failReads.media_assets = true;
  await assert.rejects(context.runtime.readFile(OWNER, ASSET, 7, "v0-00000.ts"));
  delete context.failReads.media_assets;
  context.asset.version++;
  assert.equal(await context.runtime.readFile(OWNER, ASSET, 7, "v0-00000.ts"), null);
  context.asset.version--;
  context.asset.deleted_at = "now" as any;
  assert.equal(await context.runtime.readFile(OWNER, ASSET, 7, "v0-00000.ts"), null);
});

test("hard-deleted canonical source denies every retained completed file; read errors are not missing-source evidence", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  assert.ok(await context.runtime.playback(OWNER, ASSET));
  context.db.tables.media_assets = [];
  assert.equal(await context.runtime.playback(OWNER, ASSET), null);
  assert.equal((await context.runtime.adapter.ladder({ assetId: ASSET })).ok, false);
  for (const filename of Object.keys(context.state.output!.files)) {
    assert.equal(await context.runtime.readFile(OWNER, ASSET, 7, filename), null, filename);
  }
  assert.equal((await readdir(join(context.root, "outputs"))).length, 1);
  context.failReads.media_assets = true;
  await assert.rejects(canonicalSource(context.db.client, ASSET), /read unavailable/);
  await assert.rejects(context.runtime.readFile(OWNER, ASSET, 7, "master.m3u8"), /read unavailable/);
  assert.equal((await readdir(join(context.root, "outputs"))).length, 1);
});

test("private artifact store rejects traversal, symlinks, corruption and wrong length", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  const store = new AdaptiveArtifacts(context.root);
  const output = context.state.output!;
  assert.equal(await store.read(output, "../original"), null);
  const segment = join(store.outputPath(output.directory), "v0-00000.ts");
  await writeFile(segment, "9876543210");
  assert.equal(await store.read(output, "v0-00000.ts"), null);
  await writeFile(segment, "short");
  assert.equal(await store.read(output, "v0-00000.ts"), null);
  await rm(segment);
  await symlink(join(store.outputPath(output.directory), "v1-00000.ts"), segment);
  await assert.rejects(store.read(output, "v0-00000.ts"));
});

test("single byte ranges are bounded; multi/overflow/unsatisfiable ranges refuse", () => {
  assert.equal(adaptiveByteRange(undefined, 10), null);
  for (const [header, expected] of [["bytes=0-1", { start: 0, end: 1 }], ["bytes=8-", { start: 8, end: 9 }],
    ["bytes=-3", { start: 7, end: 9 }], ["bytes=8-100", { start: 8, end: 9 }], ["bytes=-100", { start: 0, end: 9 }]] as const) {
    assert.deepEqual(adaptiveByteRange(header, 10), expected);
  }
  for (const header of ["bytes=10-", "bytes=3-2", "bytes=-0", "bytes=0-1,5-8", "bytes=", "bytes=-", "bytes=99999999999999999-", "cats=0-1"]) {
    assert.equal(adaptiveByteRange(header, 10), false, header);
  }
});

test("mounted route serves protected bytes/ranges/HEAD without redirects and denies revoked repeated fetches", async () => {
  const context = await fixture();
  await context.runtime.processJob(context.job);
  _setTestClient(context.db.client, true);
  const app = express();
  app.use("/api", createMediaAdaptiveRouter(() => context.runtime));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/media/adaptive/${ASSET}`;
  const headers = { authorization: "Bearer owner" };
  try {
    const playback = await fetch(`${base}/playback`, { headers });
    assert.equal(playback.status, 200);
    const playbackBody = await playback.json() as Record<string, unknown>;
    assert.equal(playbackBody.manifestUrl, `${context.config.apiBaseUrl}/media/adaptive/${ASSET}/7/master.m3u8`);
    const partial = await fetch(`${base}/7/v0-00000.ts`, { headers: { ...headers, range: "bytes=2-4" } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), "234");
    assert.equal(partial.headers.get("content-range"), "bytes 2-4/10");
    assert.match(partial.headers.get("cache-control")!, /no-store/);
    assert.equal(partial.headers.get("location"), null);
    const head = await fetch(`${base}/7/v0-00000.ts`, { method: "HEAD", headers });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "10"); assert.equal(await head.text(), "");
    assert.equal((await fetch(`${base}/7/v0-00000.ts`, { headers: { ...headers, range: "bytes=10-" } })).status, 416);
    assert.equal((await fetch(`${base}/7/master.m3u8`)).status, 401);
    for (const suffix of ["07/master.m3u8", "8/master.m3u8", "7/secret.txt", "7/%2e%2e%2foriginal"]) {
      assert.equal((await fetch(`${base}/${suffix}`, { headers })).status, 404);
    }
    context.asset.deleted_at = "now" as any;
    for (const filename of ["master.m3u8", "v0.m3u8", "v0-00000.ts"]) {
      assert.equal((await fetch(`${base}/7/${filename}`, { headers })).status, 404);
    }
    assert.equal(context.state.encodes, 1, "API reads never encode");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
