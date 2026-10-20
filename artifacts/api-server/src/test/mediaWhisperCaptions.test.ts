import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { makeFeedDb } from "./helpers/fakeFeedDb.js";
import { createWhisperCaptionHandler, createWhisperMediaJobHandler, runCaptionTool, whisperSegmentsToVtt, type WhisperCaptionConfig, type CaptionQueueContext, type CaptionProcessingConsent } from "../lib/media/captions/whisperCaptionHandler.js";
import { captionDraftId, captionDraftPath, type CaptionJob } from "../services/media/CaptionDraftService.js";
import { EMPTY_CAPTION_REVISION } from "../services/media/AuthoredCaptionsService.js";

const OWNER = "10000000-0000-4000-a000-000000000001";
const ASSET = "20000000-0000-4000-a000-000000000001";
const answer = { language: "en", languageProbability: 0.98, segments: [{ start: 0.2, end: 1.5, text: "Synthetic test speech" }] };
const job: CaptionJob = { assetId: ASSET, sourceVersion: 2, kind: "captions", consentId: "40000000-0000-4000-a000-000000000001", jobId: "50000000-0000-4000-a000-000000000001", revisionKey: EMPTY_CAPTION_REVISION, modelVersion: "fixture-model-1", configVersion: "fixture-config-1", targetLanguage: null, requestedBy: OWNER, consent: { ownerId: OWNER, transcription: true, recordedAt: "2026-10-15T10:00:00Z" } };
let model: string;
let config: WhisperCaptionConfig;
let fake: ReturnType<typeof makeFeedDb>;
let objects: Map<string, string>;
let calls: string[][];
let scratch: string;
let onUpload: (() => void) | undefined;

beforeEach(async () => {
  model = await mkdtemp(join(tmpdir(), "caption-model-fixture-"));
  await writeFile(join(model, "model.bin"), "synthetic marker, not a model");
  config = { enabled: true, pythonPath: "/usr/bin/python3", ffmpegPath: "/usr/bin/python3", modelPath: model, modelVersion: job.modelVersion, configVersion: job.configVersion, allowedLanguages: ["en"] };
  calls = [];
  scratch = "";
  onUpload = undefined;
  objects = new Map();
  fake = makeFeedDb({ users: {}, tables: {
    feature_flags: [{ flag: "media_captions_enabled", enabled: true }],
    media_assets: [{ id: ASSET, owner_user_id: OWNER, storage_bucket: "post-media", storage_path: `${OWNER}/video.mp4`, media_type: "video", duration_ms: 2000, version: 2, deleted_at: null, purge_status: "not_requested", processing_status: "ready", moderation_status: "approved" }],
    media_attachments: [{ media_asset_id: ASSET, entity_type: "post", entity_id: "post" }],
    posts: [{ id: "post", author_id: OWNER, status: "active", post_status: "published" }],
  } });
  fake.client.storage = { async getBucket() { return { data: { public: false, allowed_mime_types: null }, error: null }; }, from() { return {
    async list(prefix: string) { return { error: null, data: [...objects.keys()].filter((path) => path.startsWith(prefix)).map((path) => ({ name: path.slice(prefix.length + 1) })) }; },
    async download(path: string) { return { data: new Blob([objects.get(path) ?? "synthetic video bytes"]), error: null }; },
    async upload(path: string, bytes: Buffer, options: { upsert: boolean }) { assert.equal(options.upsert, false); if (objects.has(path)) return { error: {} }; objects.set(path, bytes.toString()); onUpload?.(); return { error: null }; },
    async remove(paths: string[]) { paths.forEach((path) => objects.delete(path)); return { error: null }; },
  }; } };
});
afterEach(async () => { await rm(model, { recursive: true, force: true }); });

async function fixtureTool(_executable: string, args: string[]) {
  calls.push(args);
  if (args.includes("-i")) { scratch = dirname(args[args.indexOf("-i") + 1]); return ""; }
  return JSON.stringify(answer);
}

test("Whisper segment conversion produces strict timed WebVTT, rejects unsupported language/timing/output", () => {
  const result = whisperSegmentsToVtt(answer, 2000, ["en"]);
  assert.match(result.vtt, /00:00:00.200 --> 00:00:01.500\nSynthetic test speech/);
  for (const invalid of [{ ...answer, language: "xx" }, { ...answer, languageProbability: 0.1 }, { ...answer, segments: [] }, { ...answer, segments: [{ start: 1, end: 0, text: "bad" }] }, { ...answer, segments: [{ start: 0, end: 8, text: "too long" }] }]) assert.throws(() => whisperSegmentsToVtt(invalid, 2000, ["en"]));
});

test("bounded worker orchestration stores AI-labelled review draft, never promotes canonical generation", async () => {
  const handler = createWhisperCaptionHandler(config, fixtureTool);
  const result = await handler(fake.client, job, new AbortController().signal);
  assert.equal(result.state, "draft_ready");
  assert.equal(result.cached, false);
  assert.equal(fake.tables.media_assets[0].version, 2);
  const draft = JSON.parse(objects.get(result.artifactKey)!);
  assert.equal(draft.aiLabel, "AI transcription · needs creator review");
  assert.equal(draft.source.version, 2);
  assert.equal(draft.sourceKind, "asr");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("file,pipe"));
  assert.ok(calls[0].includes("16000"));
  assert.equal(calls[1].at(-1), "auto");
  await assert.rejects(access(scratch));
  const cached = await handler(fake.client, job, new AbortController().signal);
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 2);
});

test("job identity includes source generation, model, language and configuration", () => {
  const id = captionDraftId(job);
  for (const patch of [{ sourceVersion: 3 }, { modelVersion: "other" }, { targetLanguage: "fr" }, { configVersion: "other" }, { revisionKey: "a".repeat(64) }, { leaseToken: "second-lease" }]) assert.notEqual(captionDraftId({ ...job, ...patch }), id);
});

test("OFF, missing model, stale generation, unsupported language and absent consent never run tools", async () => {
  for (const [settings, request] of [
    [{ ...config, enabled: false }, job],
    [{ ...config, modelPath: "/nonexistent/caption-model" }, job],
    [config, { ...job, sourceVersion: 1 }],
    [config, { ...job, targetLanguage: "fr" }],
    [config, { ...job, consent: undefined }],
  ] as const) await assert.rejects(createWhisperCaptionHandler(settings, fixtureTool)(fake.client, request as CaptionJob, new AbortController().signal));
  assert.equal(calls.length, 0);
  assert.equal(objects.size, 0);
});

test("post-write generation change removes the draft and the temporary media", async () => {
  onUpload = () => { fake.tables.media_assets[0].version = 3; };
  await assert.rejects(createWhisperCaptionHandler(config, fixtureTool)(fake.client, job, new AbortController().signal));
  assert.equal(objects.size, 0);
  await assert.rejects(access(scratch));
});

test("cancellation after tool execution prevents any durable caption draft", async () => {
  const controller = new AbortController();
  await assert.rejects(createWhisperCaptionHandler(config, async (executable, args) => {
    const result = await fixtureTool(executable, args);
    controller.abort();
    return result;
  })(fake.client, job, controller.signal));
  assert.equal(objects.has(captionDraftPath(ASSET, 2, captionDraftId(job), job.consentId)), false);
  await assert.rejects(access(scratch));
});

test("real local subprocess transport captures bounded output and enforces abort/timeout without ASR", async () => {
  assert.equal(await runCaptionTool("/usr/bin/python3", ["-c", "print('synthetic tool output')"], new AbortController().signal, 2000), "synthetic tool output\n");
  const previous = process.env.CAPTION_TEST_SECRET;
  process.env.CAPTION_TEST_SECRET = "synthetic-not-a-credential";
  try { assert.equal(await runCaptionTool("/usr/bin/python3", ["-c", "import os; print(os.getenv('CAPTION_TEST_SECRET', 'not inherited'))"], new AbortController().signal, 2000), "not inherited\n"); }
  finally { if (previous === undefined) delete process.env.CAPTION_TEST_SECRET; else process.env.CAPTION_TEST_SECRET = previous; }
  await assert.rejects(runCaptionTool("/usr/bin/python3", ["-c", "import time; time.sleep(10)"], new AbortController().signal, 30), /tool_timeout/);
  const controller = new AbortController();
  const pending = runCaptionTool("/usr/bin/python3", ["-c", "import time; time.sleep(10)"], controller.signal, 2000);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

function queueFixture() {
  let current = true;
  let consent: CaptionProcessingConsent | null = { consentId: job.consentId, jobId: job.jobId, jobRevisionKey: "b".repeat(64), assetId: ASSET, ownerId: OWNER, sourceVersion: 2, revisionKey: job.revisionKey, configVersion: config.configVersion, allowedLanguages: config.allowedLanguages, transcription: true, recordedAt: job.consent.recordedAt };
  fake.tables.media_caption_asr_consents = [{ id: job.consentId, asset_id: ASSET, owner_user_id: OWNER, source_version: 2, job_id: job.jobId, caption_revision_key: job.revisionKey, job_revision_key: consent.jobRevisionKey, config_version: config.configVersion }];
  const context: CaptionQueueContext = { job: { id: job.jobId, token: "lease-1", kind: "captions", assetId: ASSET, ownerUserId: OWNER, sourceVersion: 2, revisionKey: consent.jobRevisionKey, bucket: "post-media", path: `${OWNER}/video.mp4`, sizeBytes: 21, modelVersion: job.modelVersion }, signal: new AbortController().signal, isCurrent: async () => current };
  const handler = createWhisperMediaJobHandler(fake.client, config, { readConsent: async () => consent, jobError: (code, retryable) => Object.assign(new Error(code), { retryable }) }, fixtureTool);
  return { context, handler, revoke: () => { consent = null; }, loseLease: () => { current = false; } };
}

test("shared queue factory emits small metadata and discard only erases its own lease artifact", async () => {
  const { context, handler } = queueFixture();
  assert.equal(handler.kind, "captions");
  const first = await handler.handle(context);
  const secondContext = { ...context, job: { ...context.job, token: "lease-2" } };
  const second = await handler.handle(secondContext);
  assert.notEqual(first.result.artifactKey, second.result.artifactKey);
  assert.ok(Buffer.byteLength(JSON.stringify(first.result)) < 60000);
  assert.equal("vtt" in first.result, false);
  assert.ok(first.inputBytes > 0 && first.outputBytes > 0);
  await assert.rejects(handler.discard(context, second), /foreign_caption_artifact/);
  await handler.discard(context, first);
  assert.equal(objects.has(String(first.result.artifactKey)), false);
  assert.equal(objects.has(String(second.result.artifactKey)), true);
});

test("lease loss or durable consent revocation after upload removes only this draft", async () => {
  for (const lose of ["lease", "consent"]) {
    const fixture = queueFixture();
    onUpload = lose === "lease" ? fixture.loseLease : fixture.revoke;
    await assert.rejects(fixture.handler.handle(fixture.context), /lease_or_consent_lost/);
    assert.equal(objects.size, 0);
  }
});

test("manual revision change cancels ASR instead of overwriting creator captions", async () => {
  const { handler, context } = queueFixture();
  onUpload = () => { fake.tables.media_caption_manifests = [{ asset_id: ASSET, source_version: 2, revision_key: "f".repeat(64), object_path: null }]; };
  await assert.rejects(handler.handle(context), /lease_or_consent_lost/);
  assert.equal(objects.size, 0);
  assert.equal(fake.tables.media_caption_manifests[0].revision_key, "f".repeat(64));
});

test("queue rejects absent durable consent and wrong canonical path before extraction", async () => {
  const fixture = queueFixture();
  fixture.revoke();
  await assert.rejects(fixture.handler.handle(fixture.context), /consent_required/);
  const valid = queueFixture();
  await assert.rejects(valid.handler.handle({ ...valid.context, job: { ...valid.context.job, path: "foreign.mp4" } }), /source_changed/);
  assert.equal(calls.length, 0);
});

test("production factory resolves persisted consent itself and refuses revoked grants without injected resolver", async () => {
  const fixture = queueFixture();
  fake.tables.feature_flags.push({ flag: "media_caption_asr_enabled", enabled: true }, { flag: "media_derivative_jobs_enabled", enabled: true });
  fake.tables.media_caption_asr_config = [{ singleton: true, enabled: true, model_version: config.modelVersion, config_version: config.configVersion, allowed_languages: ["en"], runtime_verified_at: "2026-10-15T12:00:00Z" }];
  Object.assign(fake.tables.media_caption_asr_consents[0], { model_version: config.modelVersion, target_language: "", granted_at: job.consent.recordedAt, revoked_at: null });
  fake.tables.media_derivative_jobs = [{ id: job.jobId, asset_id: ASSET, owner_user_id: OWNER, source_version: 2, source_bucket: "post-media", source_path: `${OWNER}/video.mp4`, kind: "captions", model_version: config.modelVersion, target_language: "", revision_key: fixture.context.job.revisionKey, state: "processing", lease_token: fixture.context.job.token, lease_until: new Date(Date.now() + 60000).toISOString() }];
  const handler = createWhisperMediaJobHandler(fake.client, config, { jobError: (code, retryable) => Object.assign(new Error(code), { retryable }) }, fixtureTool);
  for (const changed of [{ token: "old-lease" }, { sourceVersion: 1 }, { path: "foreign.mp4" }, { revisionKey: job.revisionKey }, { modelVersion: "other-model" }, { targetLanguage: "fr" }]) {
    await assert.rejects(handler.handle({ ...fixture.context, job: { ...fixture.context.job, ...changed } }), /consent_required/);
  }
  const savedLease = fake.tables.media_derivative_jobs[0].lease_until;
  fake.tables.media_derivative_jobs[0].lease_until = "2000-01-01T00:00:00Z";
  await assert.rejects(handler.handle(fixture.context), /consent_required/);
  fake.tables.media_derivative_jobs[0].lease_until = savedLease;
  fake.tables.media_derivative_jobs[0].state = "pending";
  await assert.rejects(handler.handle(fixture.context), /consent_required/);
  fake.tables.media_derivative_jobs[0].state = "processing";
  fake.tables.media_caption_asr_config[0].allowed_languages = ["fr"];
  await assert.rejects(handler.handle(fixture.context), /consent_required/);
  fake.tables.media_caption_asr_config[0].allowed_languages = ["en"];
  assert.equal(calls.length, 0);
  const result = await handler.handle(fixture.context);
  assert.equal(result.result.consentId, job.consentId);
  fake.tables.media_caption_asr_consents[0].revoked_at = "2026-10-15T12:01:00Z";
  await assert.rejects(handler.handle(fixture.context), /consent_required/);
  assert.equal(calls.length, 2);
  await handler.discard(fixture.context, result);
  assert.equal(objects.size, 0);
});
