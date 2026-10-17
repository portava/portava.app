import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocalVisualIndexProvider, handleVisualIndexJob } from "../lib/media/visualIndex/localVisualIndexProvider.js";
import { createVisualIndexJobHandler } from "../lib/media/visualIndex/visualIndexJobHandler.js";
import { generationKey, VISUAL_MODEL_ID, type IndexedImage, type VisualSource } from "../lib/media/visualIndex/contracts.js";
import { runMediaWorkerPass } from "../lib/media/jobs/worker.js";
import type { MediaJob, MediaJobCompletion, MediaJobQueue } from "../lib/media/jobs/queue.js";

const ownerId = "30000000-0000-4000-8000-000000000001";
const assetId = "10000000-0000-4000-8000-000000000001";
const candidateId = "10000000-0000-4000-8000-000000000002";
const postId = "20000000-0000-4000-8000-000000000001";
const candidatePost = "20000000-0000-4000-8000-000000000002";
const vector = () => Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0);
const source = (id = assetId): VisualSource => ({ assetId: id, sourceVersion: 1, ownerId, bucket: "post-media", path: `${ownerId}/${id}.png`,
  publicUrl: `https://synthetic.invalid/${id}.png`, mediaType: "image", sizeBytes: 16, visibility: "public" });

function fixture() {
  let now = 1_800_000_000_000;
  let enabled = true;
  let leased = true;
  let encoded = 0;
  let committed = 0;
  let candidateChecks = 0;
  let acquireEffect = () => {};
  let visibleEffect = (_post: string, _count: number) => {};
  let encodeEffect = () => {};
  const bytes = Buffer.from("synthetic-pixels");
  const sources = new Map([[assetId, source()], [candidateId, source(candidateId)]]);
  const revoked = new Set<string>();
  const entries = new Map<string, IndexedImage>();
  for (const id of [assetId, candidateId]) entries.set(id, { source: source(id), modelId: VISUAL_MODEL_ID, vector: vector(),
    consentRevision: ownerId, expiresAtMs: now + 60_000, contentSha256: "a".repeat(64) });
  const options = {
    now: () => now, enabled: async () => enabled,
    consent: async (current: VisualSource) => revoked.has(current.assetId) ? null : { allowed: true as const, revision: ownerId, expiresAtMs: 1_800_000_060_000 },
    access: { read: async (id: string) => sources.get(id) ?? null,
      postIds: async (current: VisualSource) => [current.assetId === assetId ? postId : candidatePost],
      visible: async (_viewer: string, post: string) => { visibleEffect(post, post === candidatePost ? ++candidateChecks : 0); return true; } },
    acquireImage: async () => { acquireEffect(); return bytes; },
    encoder: { modelId: VISUAL_MODEL_ID, image: async () => { encoded++; encodeEffect(); return vector(); }, text: async () => vector() },
    store: {
      commit: async () => { committed++; }, discard: async () => {}, erase: async () => {},
      seed: async (post: string) => [...entries.values()].filter(entry => entry.source.assetId === (post === postId ? assetId : candidateId)),
      nearest: async () => [...entries.values()].map(entry => ({ entry: structuredClone(entry), score: 1 })),
      current: async (requested: IndexedImage[]) => requested.map(entry => entries.has(entry.source.assetId)),
    },
  };
  const ctx = { sc: {} as any, env: {} };
  const job = { kind: "media_visual_image" as const, source: source(), modelId: VISUAL_MODEL_ID, consentRevision: ownerId,
    expiresAtMs: now + 60_000, key: generationKey(source(), `${VISUAL_MODEL_ID}:${ownerId}`) };
  const lease = { jobId: assetId, leaseToken: ownerId, signal: new AbortController().signal, assertLease: async () => { if (!leased) throw new Error("lease lost"); } };
  return { ctx, options, sources, revoked, entries, bytes, job, lease,
    run: () => handleVisualIndexJob(ctx, job, lease, options),
    search: () => createLocalVisualIndexProvider(ctx, options).similarMedia({ viewerId: ownerId, seed: { mediaId: postId, storageKey: null }, limit: 10 }),
    encoded: () => encoded, committed: () => committed,
    onAcquire: (effect: () => void) => { acquireEffect = effect; }, onVisible: (effect: typeof visibleEffect) => { visibleEffect = effect; },
    onEncode: (effect: () => void) => { encodeEffect = effect; },
    disable: () => { enabled = false; }, loseLease: () => { leased = false; }, expire: () => { now += 60_001; },
  };
}

for (const change of ["consent", "generation", "owner", "size", "flag", "lease", "expiry"] as const) {
  test(`F1 ${change} changes during acquisition prevent inference and clear owned bytes`, async () => {
    const state = fixture();
    state.onAcquire(() => {
      if (change === "consent") state.revoked.add(assetId);
      if (change === "generation") state.sources.get(assetId)!.sourceVersion++;
      if (change === "owner") state.sources.get(assetId)!.ownerId = candidateId;
      if (change === "size") state.sources.get(assetId)!.sizeBytes++;
      if (change === "flag") state.disable();
      if (change === "lease") state.loseLease();
      if (change === "expiry") state.expire();
    });
    await assert.rejects(state.run());
    assert.equal(state.encoded(), 0); assert.equal(state.committed(), 0);
    assert.deepEqual(state.bytes, Buffer.alloc(16));
  });
}

test("F1 valid inference and encoder failure both release owned bytes", async () => {
  const valid = fixture();
  const result = await valid.run();
  assert.equal(valid.encoded(), 1); assert.equal(valid.committed(), 1);
  assert.equal(result.kind === "image" && result.inputBytes, 16);
  assert.deepEqual(valid.bytes, Buffer.alloc(16));
  const broken = fixture(); broken.onEncode(() => { throw new Error("transient encoder failure"); });
  await assert.rejects(broken.run(), /transient/);
  assert.equal(broken.committed(), 0); assert.deepEqual(broken.bytes, Buffer.alloc(16));
});

for (const change of ["consent", "generation", "receipt"] as const) {
  test(`F2 candidate ${change} invalidated during final visibility is withheld`, async () => {
    const state = fixture();
    state.onVisible((post, count) => {
      if (post !== candidatePost || count !== 2) return;
      if (change === "consent") state.revoked.add(candidateId);
      if (change === "generation") state.sources.get(candidateId)!.sourceVersion++;
      if (change === "receipt") state.entries.delete(candidateId);
    });
    assert.deepEqual(await state.search(), { ok: true, value: [] });
  });
}

test("F2 final artifact snapshot follows seed authorization and fails closed on read errors", async () => {
  const state = fixture();
  let seedChecks = 0;
  state.onVisible(post => { if (post === postId && ++seedChecks === 2) state.entries.delete(candidateId); });
  assert.deepEqual(await state.search(), { ok: true, value: [] });
  const broken = fixture(); broken.options.store.current = async () => { throw new Error("view unavailable"); };
  assert.equal((await broken.search()).ok, false);
});

for (const change of ["consent", "generation", "claim", "flag", "transient", "consent_read_error"] as const) {
  test(`F4 shared worker classifies ${change} without changing retry policy`, async () => {
    const state = fixture();
    const job: MediaJob = { id: postId, token: ownerId, assetId, ownerUserId: ownerId, sourceVersion: 1, kind: "embedding", bucket: "post-media",
      path: source().path, sizeBytes: 16, modelVersion: VISUAL_MODEL_ID, revisionKey: state.job.key, attempt: 1, leaseUntil: new Date(Date.now() + 60_000).toISOString() };
    if (change === "consent") state.revoked.add(assetId);
    if (change === "generation") job.sourceVersion = 2;
    if (change === "claim") job.token = "invalid";
    if (change === "flag") state.disable();
    if (change === "transient") state.options.access.read = async () => { throw new Error("connection lost"); };
    const handlerOptions = { ...state.options };
    if (change === "consent_read_error") {
      state.ctx.sc = { from() { return { select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null, error: { code: "08006" } }) }; } };
      delete (handlerOptions as Partial<typeof handlerOptions>).consent;
    }
    const completions: MediaJobCompletion[] = [];
    const queue: MediaJobQueue = { enqueue: async () => null, claim: async () => [job], recover: async () => 0, renew: async () => true,
      finish: async (_job, completion) => { completions.push(completion); return true; } };
    await runMediaWorkerPass(queue, createVisualIndexJobHandler(state.ctx, handlerOptions), {
      enabled: true, concurrency: 1, leaseSeconds: 120, signal: new AbortController().signal,
    });
    assert.equal(completions.length, 1); assert.equal(completions[0]!.success, false);
    assert.equal(completions[0]!.retryable, change === "transient" || change === "consent_read_error");
    const codes = { consent: "visual_consent_revoked", generation: "visual_source_stale", claim: "visual_claim_invalid", flag: "visual_index_disabled", transient: "processing_failed", consent_read_error: "processing_failed" };
    assert.equal(completions[0]!.errorCode, codes[change]); assert.equal(state.encoded(), 0); assert.equal(state.committed(), 0);
  });
}
