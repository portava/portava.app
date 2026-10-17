import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import express from "express";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { createMediaImageUnderstandingRouter } from "../routes/mediaImageUnderstanding.js";
import { createImageUnderstandingJobHandler } from "../lib/media/vendors/imageUnderstandingHandler.js";
import { IMAGE_UNDERSTANDING_QUEUE_MODEL, imageUnderstandingRevisionKey } from "../lib/media/vendors/imageUnderstandingStore.js";
import { createImageUnderstandingProvider } from "../lib/media/vendors/imageUnderstandingProvider.js";
import { runImageUnderstandingJob } from "../lib/media/vendors/imageUnderstandingJob.js";
import { createLocalImageUnderstandingRunner } from "../lib/media/vendors/imageUnderstandingLocal.js";
import { imageUnderstandingJob, IMAGE_UNDERSTANDING_MODEL, IMAGE_UNDERSTANDING_REVISION, IMAGE_UNDERSTANDING_TAXONOMY, type ImageUnderstandingResult, type ImageUnderstandingSource } from "../lib/media/vendors/imageUnderstandingContract.js";
import { prepareImageUnderstandingPixels, readBoundedImageUnderstandingBody, readImageUnderstandingStorageBytes } from "../lib/media/vendors/imageUnderstandingPixels.js";
import { assertImageUnderstandingSource } from "../lib/media/vendors/imageUnderstandingSource.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const postId = "22222222-2222-4222-8222-222222222222";
const postMediaId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const storagePath = `${ownerId}/${postId}/photo.png`;
const source: ImageUnderstandingSource = { ownerId, postId, postMediaId, assetId, sourceVersion: 7, bucket: "post-media", path: storagePath, mediaType: "image", framePath: null };
const env = {
  MEDIA_IMAGE_UNDERSTANDING_ENABLED: "true",
  MEDIA_IMAGE_UNDERSTANDING_PROVIDER: "self_hosted_siglip",
  MEDIA_IMAGE_UNDERSTANDING_ALLOWED_OWNER_IDS: ownerId,
  MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY: "synthetic-policy-v1",
  SUPABASE_URL: "https://synthetic.supabase.co",
};
const recognition = () => ({ modelId: IMAGE_UNDERSTANDING_MODEL, modelRevision: IMAGE_UNDERSTANDING_REVISION, taxonomyVersion: IMAGE_UNDERSTANDING_TAXONOMY, crowdLevel: "busy", confidence: 0.8, confidenceKind: "uncalibrated_similarity", inferenceMs: 10, travelCandidates: [{ tag: "beach", category: "scene", confidence: 0.7, basis: "visual_inference", verified: false, eligibleAsObservation: false }] });

async function fixture() {
  const pixels = await sharp({ create: { width: 48, height: 32, channels: 3, background: "#da7d31" } }).png().toBuffer();
  const rows: Record<string, any[]> = {
    feature_flags: [{ flag: "media_vision_provider_enabled", enabled: true }],
    profiles: [{ id: ownerId, account_status: "active", user_account_states: [] }],
    posts: [{ id: postId, author_id: ownerId, status: "active", post_status: "published", deleted_at: null }],
    post_media: [{ id: postMediaId, post_id: postId, user_id: ownerId, storage_bucket: "post-media", storage_path: storagePath, media_type: "image", processing_status: "ready", moderation_status: "approved", sort_order: 0 }],
    media_assets: [{ id: assetId, version: 7, owner_user_id: ownerId, storage_bucket: "post-media", storage_path: storagePath, media_type: "image", mime_type: "image/png", processing_status: "ready", moderation_status: "active", deleted_at: null, purge_status: "not_requested", thumbnail_path: null, updated_at: "2026-10-15T12:00:00Z" }],
  };
  const state = { consent: true, lease: true, failedTable: "", signed: [] as string[], requests: [] as { url: string; init?: RequestInit }[], queued: new Map<string, any>(), cached: new Map<string, ImageUnderstandingResult>(), inferences: [] as Buffer[], afterSigning: () => {}, afterStorage: () => {}, afterInference: () => {}, afterCache: () => {}, answer: recognition() as any, signedOverride: "", bytes: pixels, contentType: "image/png" };
  const sc: any = {
    from(table: string) {
      const predicates: Array<(row: any) => boolean> = [];
      const result = () => {
        if (table === state.failedTable) return { data: null, error: { message: "unreadable" } };
        const matches = (rows[table] ?? []).filter(row => predicates.every(predicate => predicate(row)));
        return matches.length > 1 ? { data: null, error: { code: "PGRST116" } } : { data: structuredClone(matches[0] ?? null), error: null };
      };
      const query: any = { select: () => query, eq: (column: string, value: unknown) => { predicates.push(row => row[column] === value); return query; }, maybeSingle: async () => result() };
      return query;
    },
    storage: { from: (bucket: string) => ({ createSignedUrl: async (path: string, seconds: number) => {
      assert.equal(bucket, "post-media"); assert.ok(seconds <= 30);
      state.signed.push(path);
      state.afterSigning();
      return { data: { signedUrl: state.signedOverride || `${env.SUPABASE_URL}/storage/v1/object/sign/${bucket}/${path}?token=synthetic` }, error: null };
    } }) },
  };
  const transport: typeof fetch = async (url, init) => {
    assert.ok(String(url).startsWith(env.SUPABASE_URL));
    state.requests.push({ url: String(url), init }); state.afterStorage();
    return new Response(new Uint8Array(state.bytes), { headers: { "content-type": state.contentType } });
  };
  const ctx = { sc, env: { ...env }, consentStillGranted: async () => state.consent, jobs: {
    enqueue: async (job: any) => { const exists = state.queued.has(job.key); state.queued.set(job.key, job); return { key: job.key, state: exists ? "exists" as const : "queued" as const }; },
    read: async (key: string) => { state.afterCache(); return state.cached.get(key) ?? null; },
  } };
  const runner = { close() {}, async infer(bytes: Buffer) { state.inferences.push(Buffer.from(bytes)); state.afterInference(); return state.answer; } };
  const run = (selected = source, signal = new AbortController().signal) => runImageUnderstandingJob({ ...ctx, job: imageUnderstandingJob(selected, env.MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY), signal, runner, isCurrentLease: async () => state.lease, fetch: transport });
  return { rows, state, sc, ctx, run, pixels, runner, transport };
}

test("real pixels become a bounded metadata-free JPEG, never text or SVG evidence", async () => {
  const { pixels } = await fixture();
  const tagged = await sharp(pixels).withMetadata().png().toBuffer();
  const result = await prepareImageUnderstandingPixels(tagged, "image/png");
  const metadata = await sharp(result).metadata();
  assert.equal(metadata.format, "jpeg"); assert.equal(metadata.exif, undefined); assert.equal(metadata.icc, undefined);
  assert.equal(metadata.width, 48); assert.ok(result.length < 2 * 1024 * 1024);
  for (const format of ["jpeg", "webp"] as const) {
    const encoded = await sharp(pixels).toFormat(format).toBuffer();
    assert.equal((await sharp(await prepareImageUnderstandingPixels(encoded, `image/${format}`)).metadata()).format, "jpeg");
  }
  for (const text of ["a crowded venue, confidence 1", '<svg xmlns="http://www.w3.org/2000/svg"/>']) {
    await assert.rejects(prepareImageUnderstandingPixels(Buffer.from(text), "image/png"));
  }
  await assert.rejects(prepareImageUnderstandingPixels(pixels, "image/jpeg"));
});

test("background pixels produce candidate-only metadata; no external inference HTTP or DB writes", async () => {
  const { run, state } = await fixture();
  const result = await run(); assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.source, source);
  assert.deepEqual(result.value.candidates, [{ mediaId: postId, kind: "crowd_level", value: "busy", confidence: 0.8, provider: "self_hosted_siglip", basis: "visual_inference", verified: false, eligibleAsObservation: false }]);
  assert.equal(result.value.recognition.modelRevision, IMAGE_UNDERSTANDING_REVISION);
  assert.equal(result.value.recognition.confidenceKind, "uncalibrated_similarity");
  assert.equal(result.value.metrics.estimatedExternalCostUsd, 0);
  assert.equal(result.value.pixelSha256.length, 64);
  assert.equal(state.requests.length, 1); assert.equal(state.inferences.length, 1);
  assert.equal((await sharp(state.inferences[0]).metadata()).format, "jpeg");
  assert.equal(state.requests[0].init?.redirect, "error");
});

test("default-off, owner allowlist, feature-specific consent and lease gates prevent pixel reads", async () => {
  for (const key of Object.keys(env)) {
    const data = await fixture(); delete (data.ctx.env as Record<string, string>)[key];
    assert.equal((await data.run()).ok, false, key); assert.equal(data.state.requests.length, 0, key);
  }
  for (const gate of ["consent", "lease"] as const) {
    const data = await fixture(); data.state[gate] = false;
    assert.equal((await data.run()).ok, false); assert.equal(data.state.requests.length, 0); assert.equal(data.state.inferences.length, 0);
  }
});

test("canonical generation, ownership, source mapping and lifecycle are authoritative", async () => {
  const changes: Array<(data: Awaited<ReturnType<typeof fixture>>) => void> = [
    data => { data.rows.media_assets[0].version = 8; },
    data => { data.rows.media_assets[0].owner_user_id = otherId; },
    data => { data.rows.media_assets[0].id = otherId; },
    data => { data.rows.media_assets[0].storage_path = `${ownerId}/other.png`; },
    data => { data.rows.media_assets[0].storage_bucket = "profile-media"; },
    data => { data.rows.media_assets[0].moderation_status = "owner_deleted"; },
    data => { data.rows.media_assets[0].moderation_status = "limited"; },
    data => { data.rows.media_assets[0].processing_status = "processing"; },
    data => { data.rows.media_assets[0].deleted_at = "2026-10-15"; },
    data => { data.rows.media_assets[0].purge_status = "failed"; },
    data => { data.rows.posts[0].author_id = otherId; },
    data => { data.rows.posts[0].deleted_at = "2026-10-15"; },
    data => { data.rows.post_media[0].post_id = otherId; },
    data => { data.rows.post_media[0].moderation_status = "rejected"; },
    data => { data.rows.feature_flags[0].enabled = false; },
    data => { data.rows.profiles[0].account_status = "deleted"; },
    ...["posts", "post_media", "media_assets", "feature_flags", "profiles"].map(table => (data: Awaited<ReturnType<typeof fixture>>) => { data.state.failedTable = table; }),
  ];
  for (const change of changes) {
    const data = await fixture(); change(data);
    assert.equal((await data.run()).ok, false); assert.equal(data.state.requests.length, 0); assert.equal(data.state.signed.length, 0);
  }
});

test("source deletion, replacement, consent or lease loss during work prevents inference/publication", async () => {
  for (const phase of ["afterSigning", "afterStorage", "afterInference"] as const) {
    for (const field of ["version", "moderation_status", "consent", "lease"]) {
      const data = await fixture();
      data.state[phase] = () => {
        if (field === "consent" || field === "lease") data.state[field] = false;
        else data.rows.media_assets[0][field] = field === "version" ? 8 : "owner_deleted";
      };
      assert.equal((await data.run()).ok, false, `${phase}:${field}`);
      assert.equal(data.state.inferences.length, phase === "afterInference" ? 1 : 0);
      if (phase === "afterSigning") assert.equal(data.state.requests.length, 0);
    }
  }
});

test("video analysis reads only the canonical derived poster and labels its limited pixel scope", async () => {
  const data = await fixture(); const videoPath = `${ownerId}/${postId}/clip.mp4`;
  Object.assign(data.rows.post_media[0], { media_type: "video", storage_path: videoPath });
  Object.assign(data.rows.media_assets[0], { media_type: "video", mime_type: "video/mp4", storage_path: videoPath, thumbnail_path: `${videoPath}.poster.jpg` });
  data.state.bytes = await sharp(data.pixels).jpeg().toBuffer(); data.state.contentType = "image/jpeg";
  const selected: ImageUnderstandingSource = { ...source, mediaType: "video", path: videoPath, framePath: `${videoPath}.poster.jpg` };
  const result = await data.run(selected); assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.pixelScope, "stored_poster");
  assert.deepEqual(data.state.signed, [`${videoPath}.poster.jpg`]);
  data.rows.media_assets[0].thumbnail_path = `${ownerId}/other.jpg`;
  assert.equal((await data.run(selected)).ok, false); assert.equal(data.state.requests.length, 1);
});

test("signed URLs cannot redirect acquisition to another origin, object, credentials or port", async () => {
  for (const url of ["http://169.254.169.254/latest/meta-data", "https://evil.example/image.png", `${env.SUPABASE_URL}/storage/v1/object/sign/post-media/${ownerId}/other.png?token=x`, `https://user:pass@synthetic.supabase.co/storage/v1/object/sign/post-media/${storagePath}?token=x`, `${env.SUPABASE_URL}:8443/storage/v1/object/sign/post-media/${storagePath}?token=x`]) {
    const data = await fixture(); data.state.signedOverride = url;
    assert.equal((await data.run()).ok, false); assert.equal(data.state.requests.length, 0);
  }
  const data = await fixture();
  assert.equal((await data.run({ ...source, path: `${ownerId}/../photo.png` })).ok, false);
  assert.equal(data.state.signed.length, 0);
});

test("malformed recognition, invented facts, wrong model or taxonomy and invalid confidence fail closed", async () => {
  for (const extra of [{ verified: true }, { modelRevision: "other" }, { taxonomyVersion: "free-text" }, { crowdLevel: "crowded" }, { confidence: "0.9" }, { confidence: 1.1 }, { travelCandidates: [{ ...recognition().travelCandidates[0], tag: "Paris" }] }, { travelCandidates: [{ ...recognition().travelCandidates[0], category: "object" }] }, { travelCandidates: [...recognition().travelCandidates, ...recognition().travelCandidates] }, { travelCandidates: [{ ...recognition().travelCandidates[0], verified: true }] }]) {
    const data = await fixture(); data.state.answer = { ...recognition(), ...extra };
    assert.equal((await data.run()).ok, false);
  }
  const data = await fixture(); data.state.answer.crowdLevel = null;
  const result = await data.run(); assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.value.candidates, []);
});

test("stream limits and abort cancel acquisition without trusting Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBoundedImageUnderstandingBody(new Response(stream), 10, new AbortController().signal));
  assert.equal(cancelled, true);
  const data = await fixture(); const controller = new AbortController(); controller.abort();
  assert.equal((await data.run(source, controller.signal)).ok, false); assert.equal(data.state.requests.length, 0);
});

test("shared acquisition preserves original bytes and enforces exact claimed size and pre-read canonical checks", async () => {
  const data = await fixture(); const signal = new AbortController().signal;
  const input = { sc: data.sc, origin: env.SUPABASE_URL, path: source.path, mime: "image/png", signal, expectedBytes: data.pixels.length, fetch: data.transport, beforeRead: async () => { await assertImageUnderstandingSource(data.ctx, source, signal); } };
  const raw = await readImageUnderstandingStorageBytes(input);
  assert.deepEqual(raw, data.pixels); assert.equal((await sharp(raw).metadata()).format, "png"); raw.fill(0);
  await assert.rejects(readImageUnderstandingStorageBytes({ ...input, expectedBytes: data.pixels.length + 1 }), /pixel_size_refused/);
  const calls = data.state.requests.length;
  data.state.afterSigning = () => { data.rows.media_assets[0].version = 8; };
  await assert.rejects(readImageUnderstandingStorageBytes(input), /vision_source_refused/);
  assert.equal(data.state.requests.length, calls);
});

test("API adapter enqueues idempotently, never decodes or infers; supplied generation is mandatory", async () => {
  const data = await fixture(); const provider = createImageUnderstandingProvider(data.ctx);
  const subject = { assetId, mediaType: "image" as const, bucket: "post-media", path: storagePath, framePath: null };
  assert.equal((await provider.ingest(subject)).ok, false);
  assert.equal((await provider.ingest({ ...subject, sourceVersion: 8 })).ok, false);
  assert.equal(data.state.queued.size, 0);
  assert.equal((await provider.ingest({ ...subject, sourceVersion: 7 })).ok, true);
  assert.equal((await provider.ingest({ ...subject, sourceVersion: 7 })).ok, true);
  assert.equal(data.state.queued.size, 1); assert.equal(data.state.requests.length, 0); assert.equal(data.state.inferences.length, 0);
});

test("viewer-scoped cached search maps post IDs, ignores supplied URLs and rechecks revocation", async () => {
  const data = await fixture(); const result = await data.run(); assert.ok(result.ok);
  data.state.cached.set(imageUnderstandingJob(source, env.MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY).key, result.value);
  const provider = createImageUnderstandingProvider(data.ctx);
  const scene = await provider.sceneSignals({ viewerId: ownerId, items: [{ mediaId: postId, storageKey: "http://169.254.169.254/" }] });
  assert.equal(scene.ok, true);
  if (scene.ok) assert.equal(scene.value[0].mediaId, postId);
  assert.equal((await provider.sceneSignals({ viewerId: otherId, items: [{ mediaId: postId, storageKey: null }] })).ok, false);
  assert.equal((await provider.sceneSignals({ viewerId: ownerId, items: [{ mediaId: assetId, storageKey: null }] })).ok, false);
  data.state.afterCache = () => { data.state.consent = false; };
  assert.equal((await provider.sceneSignals({ viewerId: ownerId, items: [{ mediaId: postId, storageKey: null }] })).ok, false);
  assert.equal(data.state.requests.length, 1); assert.equal(data.state.inferences.length, 1);
});

test("loopback HTTP exercises the real bounded storage protocol with native decoding", async () => {
  const data = await fixture(); let requests = 0;
  const server = createServer((_req, res) => { requests++; res.setHeader("content-type", "image/png"); res.end(data.pixels); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  try {
    const transport: typeof fetch = (_url, init) => fetch(`http://127.0.0.1:${address.port}/pixels`, init);
    const result = await runImageUnderstandingJob({ ...data.ctx, job: imageUnderstandingJob(source, env.MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY), signal: new AbortController().signal, runner: data.runner, isCurrentLease: async () => true, fetch: transport });
    assert.equal(result.ok, true); assert.equal(requests, 1);
    assert.equal((await sharp(data.state.inferences[0]).metadata()).format, "jpeg");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("actual Python worker protocol refuses text/URLs and missing weights without downloading", async () => {
  const script = fileURLToPath(new URL("../../../../tools/media-vision/worker.py", import.meta.url));
  for (const message of [{ imageUrl: "http://169.254.169.254/" }, { protocol: "portava-vision-v1", modelId: IMAGE_UNDERSTANDING_MODEL, modelRevision: IMAGE_UNDERSTANDING_REVISION, taxonomyVersion: IMAGE_UNDERSTANDING_TAXONOMY, imageBase64: Buffer.from("busy crowd").toString("base64") }]) {
    const result = spawnSync("/usr/bin/python3", ["-I", "-B", script, "--model-dir", "/nonexistent-synthetic-model"], { input: JSON.stringify(message) + "\n", encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, reason: "invalid_request" });
  }
  const { pixels } = await fixture();
  const jpeg = await prepareImageUnderstandingPixels(pixels, "image/png");
  const runner = createLocalImageUnderstandingRunner({ MEDIA_VISION_PYTHON: "/usr/bin/python3", MEDIA_VISION_MODEL_DIR: "/nonexistent-synthetic-model" });
  try { await assert.rejects(runner.infer(jpeg, AbortSignal.timeout(5000))); } finally { runner.close(); }
});

test("shared-worker handle stages bounded output and discard is scoped to its own lease", async () => {
  const data = await fixture();
  const job = imageUnderstandingJob(source, env.MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY);
  const leaseId = "66666666-6666-4666-8666-666666666666";
  const token = "77777777-7777-4777-8777-777777777777";
  data.rows.media_image_understanding_artifacts = [{ job_id: leaseId, request: job }];
  data.rows.media_image_understanding_consents = [{ id: otherId, asset_id: assetId, source_version: 7, post_media_id: postMediaId, owner_user_id: ownerId, policy_version: job.consentVersion, revoked_at: null }];
  const calls: Array<{ name: string; args: any }> = [];
  data.sc.rpc = async (name: string, args: any) => { calls.push({ name, args }); return { data: true, error: null }; };
  class TestJobError extends Error { constructor(readonly code: string, readonly retryable: boolean) { super(code); } }
  const handler = createImageUnderstandingJobHandler({ sc: data.sc, env, runner: data.runner, fetch: data.transport, createJobError: (code, retryable) => new TestJobError(code, retryable) });
  const context = { job: { id: leaseId, token, assetId, ownerUserId: ownerId, sourceVersion: 7, bucket: source.bucket, path: source.path, sizeBytes: 100, attempt: 1, leaseUntil: new Date(Date.now() + 120000).toISOString(), kind: "vision", modelVersion: IMAGE_UNDERSTANDING_QUEUE_MODEL, targetLanguage: "", revisionKey: imageUnderstandingRevisionKey(job) }, signal: new AbortController().signal, isCurrent: async () => true };
  const output = await handler.handle(context);
  assert.deepEqual(output.result, { artifactKey: job.key, publicationToken: token });
  assert.equal(calls[0].name, "media_image_understanding_publish");
  assert.equal(calls[0].args.p_result.candidates[0].eligibleAsObservation, false);
  assert.ok(output.inputBytes! > 0); assert.ok(output.outputBytes! < 8192);
  await handler.discard(context, output);
  assert.deepEqual(calls.at(-1), { name: "media_image_understanding_discard", args: { p_job_id: leaseId, p_lease_token: token } });
  const count = data.state.inferences.length;
  await assert.rejects(handler.handle({ ...context, job: { ...context.job, sourceVersion: 8 } }), error => error instanceof TestJobError && error.retryable === false);
  assert.equal(data.state.inferences.length, count);
  data.rows.media_image_understanding_consents[0].revoked_at = new Date().toISOString();
  await assert.rejects(handler.handle(context), error => error instanceof TestJobError && error.retryable === false); assert.equal(data.state.inferences.length, count);
  data.state.failedTable = "media_image_understanding_consents";
  await assert.rejects(handler.handle(context), error => error instanceof TestJobError && error.retryable === true); assert.equal(data.state.inferences.length, count);
  handler.close();
});

test("abort while inference is pending returns no artifact and clears normalized bytes", async () => {
  const data = await fixture(); const controller = new AbortController();
  let received: Buffer | undefined;
  const task = runImageUnderstandingJob({ ...data.ctx, job: imageUnderstandingJob(source, env.MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY), signal: controller.signal, isCurrentLease: async () => true, fetch: data.transport, runner: { close() {}, async infer(bytes) { received = bytes; controller.abort(); return new Promise(() => {}); } } });
  assert.equal((await task).ok, false); assert.ok(received); assert.equal(received.every(value => value === 0), true);
});

test("real HTTP consent route authenticates ownership, queues once, rejects URL/identity injection and revokes when OFF", async () => {
  const data = await fixture(); const settings = { ...env };
  const analyzed = await (await fixture()).run(); assert.ok(analyzed.ok);
  let viewerId = ownerId;
  const calls: Array<{ name: string; args: any }> = [];
  data.rows.media_image_understanding_consents = [];
  data.sc.auth = { getUser: async () => ({ data: { user: { id: viewerId } }, error: null }) };
  data.sc.rpc = async (name: string, args: any) => {
    calls.push({ name, args });
    if (name === "media_image_understanding_grant") {
      data.rows.media_image_understanding_consents = [{ id: otherId, asset_id: assetId, source_version: 7, post_media_id: postMediaId, owner_user_id: ownerId, policy_version: args.p_policy_version, revoked_at: null }];
      return { data: true, error: null };
    }
    if (name === "media_image_understanding_enqueue") { data.state.queued.set(args.p_job.key, args.p_job); return { data: otherId, error: null }; }
    if (name === "media_image_understanding_read") { data.state.afterCache(); return { data: data.state.cached.get(args.p_artifact_key) ?? null, error: null }; }
    if (name === "media_image_understanding_revoke") { data.rows.media_image_understanding_consents[0].revoked_at = new Date().toISOString(); return { data: null, error: null }; }
    throw new Error("unexpected_rpc");
  };
  _setTestClient(data.sc, true);
  const app = express(); app.use(express.json()); app.use("/api", createMediaImageUnderstandingRouter(settings));
  const server = createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/media/image-understanding/${postMediaId}/consent`;
  const body = { sourceVersion: 7, policyVersion: env.MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY, scope: "media_image_understanding" };
  const send = (value: any, authenticated = true) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { Authorization: "Bearer synthetic" } : {}) }, body: JSON.stringify(value) });
  try {
    assert.equal((await send(body, false)).status, 401); assert.equal(calls.length, 0);
    assert.equal((await send({ ...body, ownerId: otherId })).status, 400);
    assert.equal((await send({ ...body, imageUrl: "http://169.254.169.254/" })).status, 400);
    assert.equal((await send({ ...body, sourceVersion: 8 })).status, 404); assert.equal(calls.length, 0);
    data.rows.post_media[0].user_id = otherId;
    assert.equal((await send(body)).status, 404); assert.equal(calls.length, 0);
    data.rows.post_media[0].user_id = ownerId;
    assert.equal((await send(body)).status, 202); assert.equal((await send(body)).status, 202);
    assert.equal(data.state.queued.size, 1); assert.equal(data.state.requests.length, 0); assert.equal(data.state.inferences.length, 0);
    const artifactUrl = url.replace(/\/consent$/, "");
    const get = () => fetch(artifactUrl, { headers: { Authorization: "Bearer synthetic" } });
    assert.equal((await fetch(artifactUrl)).status, 401); assert.equal((await get()).status, 404);
    data.state.cached.set(imageUnderstandingJob(source, body.policyVersion).key, analyzed.value);
    const visible = await get(); assert.equal(visible.status, 200); assert.equal(visible.headers.get("cache-control"), "private, no-store");
    const metadata: any = await visible.json(); assert.equal(metadata.model.taxonomyVersion, "travel-scene-v1");
    assert.equal(metadata.candidates[0].tag, "beach"); assert.equal(metadata.candidates[0].verified, false);
    assert.equal(metadata.confidenceKind, "uncalibrated_similarity"); assert.ok(metadata.unsupported.includes("specific_landmark"));
    assert.equal(JSON.stringify(metadata).includes(storagePath), false);
    viewerId = otherId; settings.MEDIA_IMAGE_UNDERSTANDING_ALLOWED_OWNER_IDS = `${ownerId},${otherId}`;
    assert.equal((await get()).status, 404); viewerId = ownerId;
    data.state.afterCache = () => { data.rows.media_image_understanding_consents[0].revoked_at = new Date().toISOString(); };
    assert.equal((await get()).status, 404); data.state.afterCache = () => {};
    settings.MEDIA_IMAGE_UNDERSTANDING_ENABLED = "false";
    assert.equal((await send(body)).status, 404);
    assert.equal((await fetch(url, { method: "DELETE", headers: { Authorization: "Bearer synthetic" } })).status, 204);
    assert.deepEqual(calls.at(-1), { name: "media_image_understanding_revoke", args: { p_post_media_id: postMediaId, p_owner_user_id: ownerId } });
  } finally { _clearTestClient(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
