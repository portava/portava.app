import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalVisualIndexProvider, handleVisualIndexJob } from "../lib/media/visualIndex/localVisualIndexProvider.js";
import { generationKey, normalizeVector, textQueryKey, VISUAL_MODEL_ID, type IndexedImage, type VisualIndexJob, type VisualSource } from "../lib/media/visualIndex/contracts.js";
import { PostgresVisualIndex } from "../lib/media/visualIndex/postgresVisualIndex.js";
import { createVisualIndexJobHandler } from "../lib/media/visualIndex/visualIndexJobHandler.js";

const assetId = "10000000-0000-4000-8000-000000000001";
const candidateId = "10000000-0000-4000-8000-000000000002";
const postId = "20000000-0000-4000-8000-000000000001";
const otherPostId = "20000000-0000-4000-8000-000000000002";
const viewerId = "30000000-0000-4000-8000-000000000001";
const now = 1_800_000_000_000;
const vector = (offset = 0) => Array.from({ length: 512 }, (_, position) => position === offset ? 1 : 0);
const source = (id = assetId, version = 1): VisualSource => ({
  assetId: id, sourceVersion: version, bucket: "post-media", path: `${viewerId}/${id}.png`,
  ownerId: viewerId, mediaType: "image", publicUrl: `https://synthetic.invalid/${id}.png`, visibility: "public", sizeBytes: 16,
});

function fixture() {
  const entries = new Map<string, IndexedImage>();
  const sources = new Map([[assetId, source()], [candidateId, source(candidateId)]]);
  const bindings = new Map([[assetId, [postId]], [candidateId, [otherPostId]]]);
  const denied = new Set<string>();
  const jobs: VisualIndexJob[] = [];
  let enabled = true;
  let consent = true;
  let lease = true;
  let encoded = 0;
  let afterEncode = () => {};
  let afterVisible = (_post: string) => {};
  const options = {
    now: () => now, enabled: async () => enabled,
    consent: async () => consent ? { allowed: true as const, expiresAtMs: now + 60_000, revision: viewerId } : null,
    enqueue: async (job: VisualIndexJob) => { jobs.push(job); return { accepted: true }; },
    acquireImage: async () => Buffer.from("synthetic-pixels"),
    encoder: { modelId: VISUAL_MODEL_ID, image: async () => { encoded++; afterEncode(); return vector(); }, text: async () => { encoded++; return vector(); } },
    access: {
      read: async (id: string) => sources.get(id) ?? null,
      postIds: async (subject: VisualSource) => bindings.get(subject.assetId) ?? [],
      visible: async (_viewer: string, post: string) => { const allowed = !denied.has(post); afterVisible(post); return allowed; },
    },
    store: {
      commit: async (entry: IndexedImage) => { entries.set(entry.source.assetId, structuredClone(entry)); },
      seed: async (post: string) => [...entries.values()].filter((entry) => bindings.get(entry.source.assetId)?.includes(post)),
      nearest: async () => [...entries.values()].map((entry) => ({ entry, score: 1 })),
      current: async (requested: IndexedImage[]) => requested.map(entry => entries.has(entry.source.assetId)),
      erase: async (subject: any) => { entries.delete(subject.assetId); },
      discard: async (subject: any) => { entries.delete(subject.assetId); },
    },
  };
  const ctx = { sc: {} as any, env: {} };
  const provider = createLocalVisualIndexProvider(ctx, options);
  const jobContext = { jobId: assetId, leaseToken: viewerId, signal: new AbortController().signal, assertLease: async () => { if (!lease) throw new Error("lease lost"); } };
  const ingest = (id = assetId, version = 1) => provider.ingest({ assetId: id, sourceVersion: version, mediaType: "image", bucket: "post-media", path: source(id).path, framePath: null });
  const run = () => handleVisualIndexJob(ctx, jobs[jobs.length - 1]!, jobContext, options);
  const search = () => provider.similarMedia({ seed: { mediaId: postId, storageKey: "https://untrusted.invalid/not-a-bucket" }, viewerId, limit: 10 });
  return { entries, sources, bindings, denied, jobs, options, ctx, provider, ingest, run, search,
    disable: () => { enabled = false; }, revoke: () => { consent = false; }, loseLease: () => { lease = false; },
    onEncode: (callback: () => void) => { afterEncode = callback; }, onVisible: (callback: (post: string) => void) => { afterVisible = callback; },
    encoded: () => encoded,
  };
}

test("API only enqueues; background handler encodes and writes the exact generation", async () => {
  const env = fixture();
  assert.deepEqual(await env.ingest(), { ok: true, value: { accepted: true } });
  assert.equal(env.encoded(), 0);
  assert.equal(env.entries.size, 0);
  assert.equal(env.jobs[0]?.key, generationKey(source(), `${VISUAL_MODEL_ID}:${viewerId}`));
  await env.run();
  assert.equal(env.encoded(), 1);
  assert.equal(env.entries.get(assetId)?.source.sourceVersion, 1);
  assert.equal(env.entries.get(assetId)?.vector.length, 512);
});

test("image search returns mapped post IDs, never guessed asset IDs or untrusted seed URLs", async () => {
  const env = fixture();
  await env.ingest(); await env.run(); await env.ingest(candidateId); await env.run();
  assert.deepEqual(await env.search(), { ok: true, value: [{ mediaId: otherPostId, score: 1 }] });
});

test("missing version, stale generation and wrong storage cannot enqueue", async () => {
  const env = fixture();
  for (const patch of [{ sourceVersion: undefined }, { sourceVersion: 2 }, { path: "wrong.png" }, { mediaType: "video" }]) {
    assert.equal((await env.provider.ingest({ assetId, sourceVersion: 1, bucket: "post-media", path: source().path, mediaType: "image", framePath: null, ...patch } as any)).ok, false);
  }
  assert.equal(env.jobs.length, 0);
  assert.equal(env.encoded(), 0);
});

test("generation change, consent withdrawal, OFF and lost lease during encoding prevent commit", async () => {
  for (const action of ["version", "consent", "lease", "off"] as const) {
    const env = fixture(); await env.ingest();
    env.onEncode(() => {
      if (action === "version") env.sources.set(assetId, source(assetId, 2));
      if (action === "consent") env.revoke();
      if (action === "lease") env.loseLease();
      if (action === "off") env.disable();
    });
    await assert.rejects(env.run());
    assert.equal(env.entries.size, 0, action);
  }
});

test("seed and every candidate require authorization, consent and current canonical mapping", async () => {
  const env = fixture();
  await env.ingest(); await env.run(); await env.ingest(candidateId); await env.run();
  assert.equal((await env.provider.similarMedia({ seed: { mediaId: postId, storageKey: null }, limit: 2 })).ok, false);
  env.denied.add(otherPostId);
  assert.deepEqual(await env.search(), { ok: true, value: [] });
  env.denied.clear(); env.bindings.set(candidateId, []);
  assert.deepEqual(await env.search(), { ok: true, value: [] });
  env.bindings.set(candidateId, [otherPostId]); env.denied.add(postId);
  assert.equal((await env.search()).ok, false);
  env.denied.clear(); env.sources.delete(candidateId);
  assert.deepEqual(await env.search(), { ok: true, value: [] });
  env.revoke(); assert.equal((await env.search()).ok, false);
});

test("seed revocation during candidate checks prevents disclosure", async () => {
  const env = fixture();
  await env.ingest(); await env.run(); await env.ingest(candidateId); await env.run();
  env.onVisible((post) => { if (post === otherPostId) env.denied.add(postId); });
  assert.equal((await env.search()).ok, false);
});

test("OFF and unconfigured defaults do not enqueue or encode", async () => {
  const env = fixture(); env.disable();
  assert.equal((await env.ingest()).ok, false);
  assert.equal((await env.search()).ok, false);
  assert.equal(env.jobs.length, 0);
  assert.equal(env.encoded(), 0);
  const provider = createLocalVisualIndexProvider(env.ctx);
  assert.equal((await provider.ingest({ assetId, sourceVersion: 1, bucket: "post-media", path: source().path, mediaType: "image", framePath: null })).ok, false);
});

test("text-to-image jobs are viewer/model/language bound; unvalidated languages refuse", async () => {
  const env = fixture();
  assert.equal((await env.provider.textSearch({ viewerId, text: "a red wooden bridge", language: "en", limit: 5 })).state, "queued");
  assert.equal(env.encoded(), 0);
  assert.equal(env.jobs[0]?.key, textQueryKey(viewerId, "a red wooden bridge", "en"));
  assert.equal((await env.run()).kind, "text");
  assert.equal(env.encoded(), 1);
  assert.equal((await env.provider.textSearch({ viewerId, text: "pont", language: "fr", limit: 5 })).state, "refused");
  assert.notEqual(textQueryKey(viewerId, "bridge", "en"), textQueryKey(candidateId, "bridge", "en"));
});

test("bad vectors, identities and cross-model jobs cannot write", async () => {
  assert.throws(() => normalizeVector(Array(512).fill(0)), /vector/);
  assert.throws(() => normalizeVector([NaN]), /vector/);
  assert.deepEqual(normalizeVector(vector().map((value) => value * 3)), vector());
  assert.throws(() => generationKey({ ...source(), path: "../image.jpg" }));
  const env = fixture(); await env.ingest(); env.jobs[0]!.modelId = "other-model";
  await assert.rejects(env.run(), /model/);
  assert.equal(env.entries.size, 0);
});

test("Postgres adapter rejects resolved errors and absent or false persistence/erasure acknowledgments", async () => {
  const calls: any[] = [];
  let response: any = { data: { applied: true }, error: null };
  const store = new PostgresVisualIndex({ rpc: async (name: string, args: any) => { calls.push({ name, args }); return response; } } as any);
  const entry = { source: source(), modelId: VISUAL_MODEL_ID, vector: vector(), contentSha256: "a".repeat(64), expiresAtMs: now + 60_000, consentRevision: viewerId };
  const lease = { jobId: assetId, leaseToken: viewerId };
  await store.commit(entry, lease);
  assert.equal(calls[0]?.args.p_source_version, 1);
  assert.equal(calls[0]?.args.p_asset_id, assetId);
  response = { data: null, error: null }; await assert.rejects(store.commit(entry, lease)); await assert.rejects(store.erase(source()));
  response = { data: { applied: true }, error: { code: "42501" } }; await assert.rejects(store.commit(entry, lease));
  response = { data: { erased: true, remaining: 0 }, error: null }; await store.erase(source());
  response = { data: { erased: true, remaining: 1 }, error: null }; await assert.rejects(store.erase(source()));
});

test("claimed byte size must match the retrieved canonical object before encoding", async () => {
  const env = fixture(); await env.ingest();
  env.options.acquireImage = async () => Buffer.from("truncated");
  await assert.rejects(env.run(), /image bytes/);
  assert.equal(env.encoded(), 0);
  assert.equal(env.entries.size, 0);
});

test("shared worker handler checks claim identity and returns a lease-bound publication receipt", async () => {
  const env = fixture();
  const handler = createVisualIndexJobHandler(env.ctx, env.options);
  let renewals = 0;
  const context = {
    job: { id: postId, token: viewerId, assetId, ownerUserId: viewerId, sourceVersion: 1, bucket: "post-media", path: source().path,
      sizeBytes: 16, modelVersion: VISUAL_MODEL_ID, kind: "embedding", revisionKey: generationKey(source(), `${VISUAL_MODEL_ID}:${viewerId}`) },
    signal: new AbortController().signal, isCurrent: async () => { renewals++; return true; },
  };
  for (const patch of [{ sourceVersion: 2 }, { path: "wrong" }, { ownerUserId: candidateId }, { sizeBytes: 15 }, { revisionKey: "a".repeat(64) }]) {
    await assert.rejects(handler.handle({ ...context, job: { ...context.job, ...patch } }));
  }
  assert.equal(env.encoded(), 0);
  const output = await handler.handle(context);
  assert.equal(env.entries.size, 1);
  assert.equal(output.result.indexLeaseToken, viewerId);
  assert.equal(output.result.assetId, assetId);
  assert.equal(output.inputBytes, 16);
  assert.equal(output.outputBytes, 2048);
  assert.ok(renewals >= 3);
  await handler.discard(context, output);
  assert.equal(env.entries.size, 0);
});

test("losing the shared worker lease immediately after commit removes only that job's artifact", async () => {
  const env = fixture();
  const handler = createVisualIndexJobHandler(env.ctx, env.options);
  const discarded: any[] = [];
  env.options.store.discard = async (...args: any[]) => { discarded.push(args); env.entries.delete(assetId); };
  await assert.rejects(handler.handle({
    job: { id: postId, token: viewerId, assetId, ownerUserId: viewerId, sourceVersion: 1, bucket: "post-media", path: source().path,
      sizeBytes: 16, modelVersion: VISUAL_MODEL_ID, kind: "embedding", revisionKey: generationKey(source(), `${VISUAL_MODEL_ID}:${viewerId}`) },
    signal: new AbortController().signal, isCurrent: async () => !env.entries.has(assetId),
  }), /lease lost/);
  assert.equal(env.encoded(), 1);
  assert.equal(env.entries.size, 0);
  assert.equal(discarded.length, 1);
  assert.equal(discarded[0][0].assetId, assetId);
  assert.equal(discarded[0][1].jobId, postId);
  assert.equal(discarded[0][1].leaseToken, viewerId);
});

test("text cache misses without a query bridge never invoke the asset queue or encoder", async () => {
  const env = fixture();
  let rpcCalls = 0;
  const { enqueue: _enqueue, ...options } = env.options;
  const provider = createLocalVisualIndexProvider({ ...env.ctx, sc: { rpc: async () => { rpcCalls++; throw new Error("must not enqueue arbitrary text"); } } as any }, options);
  assert.equal((await provider.textSearch({ viewerId, text: "red circle", language: "en", limit: 5 })).state, "refused");
  assert.equal(rpcCalls, 0);
  assert.equal(env.encoded(), 0);
  assert.equal(env.jobs.length, 0);
});

test("viewer-bound text cache hits search only live authorized image candidates without inference", async () => {
  const env = fixture(); await env.ingest(candidateId); await env.run();
  let cached = { kind: "text" as const, key: textQueryKey(viewerId, "red circle", "en"), viewerId, modelId: VISUAL_MODEL_ID, vector: vector(), expiresAtMs: now + 60_000 };
  const valid = structuredClone(cached);
  const provider = createLocalVisualIndexProvider(env.ctx, { ...env.options, readTextResult: async () => cached });
  const query = () => provider.textSearch({ viewerId, text: "red circle", language: "en", limit: 5 });
  assert.deepEqual(await query(), { state: "ready", results: [{ mediaId: otherPostId, score: 1 }] });
  assert.equal(env.encoded(), 1);
  assert.equal(env.jobs.length, 1);
  for (const patch of [{ viewerId: candidateId }, { key: "wrong" }, { modelId: "other" }, { expiresAtMs: now }, { expiresAtMs: now + 300_001 }, { vector: [] }]) {
    cached = { ...valid, ...patch };
    assert.equal((await query()).state, "refused");
  }
  cached = valid;
  env.denied.add(otherPostId);
  assert.deepEqual(await query(), { state: "ready", results: [] });
  env.denied.clear(); env.revoke();
  assert.deepEqual(await query(), { state: "ready", results: [] });
});
