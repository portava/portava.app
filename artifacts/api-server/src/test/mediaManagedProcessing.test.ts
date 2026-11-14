import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedMediaJson } from "../lib/media/managedMediaRequest.js";
import { createDeepgramCaptionTranscriber, deepgramSegments } from "../lib/media/captions/deepgramCaptionTranscriber.js";
import { captionAsrConfig } from "../lib/media/captions/runtime.js";
import { createManagedImageUnderstandingRunner } from "../lib/media/vendors/imageUnderstandingManaged.js";
import { imageUnderstandingPolicy, IMAGE_UNDERSTANDING_MODEL, IMAGE_UNDERSTANDING_REVISION, IMAGE_UNDERSTANDING_TAXONOMY } from "../lib/media/vendors/imageUnderstandingContract.js";

const version = "2026-01-01.fixture";
function transcript() {
  return { metadata: { models: ["pinned"], model_info: { pinned: { arch: "nova-3", version } } }, results: { channels: [{ detected_language: "en", language_confidence: .97,
    alternatives: [{ words: [{ word: "hello", punctuated_word: "Hello", start: .2, end: .4, confidence: .8 }, { word: "world", punctuated_word: "world.", start: .5, end: 1, confidence: .9 }] }] }] } };
}
const signal = () => new AbortController().signal;
const recognition = { modelId: IMAGE_UNDERSTANDING_MODEL, modelRevision: IMAGE_UNDERSTANDING_REVISION, taxonomyVersion: IMAGE_UNDERSTANDING_TAXONOMY,
  crowdLevel: null, confidence: .4, confidenceKind: "uncalibrated_similarity", inferenceMs: 20, travelCandidates: [] };
const visionEnv = { MEDIA_VISION_HF_ENDPOINT: "https://fixture.us-east-1.aws.endpoints.huggingface.cloud", MEDIA_VISION_HF_TOKEN: "synthetic-token" };
const jpeg = Buffer.from([255, 216, 255, 0]);

test("managed speech preserves real word timing and rejects fallback models, weak language and malformed timestamps", () => {
  const result = deepgramSegments(transcript(), version, ["en"], 2000);
  assert.deepEqual(result.segments, [{ start: .2, end: 1, text: "Hello world." }]);
  assert.equal(result.languageProbability, .97);
  const variants = [
    (r: any) => { r.metadata.model_info.pinned.arch = "nova-2"; },
    (r: any) => { r.metadata.model_info.pinned.version = "other"; },
    (r: any) => { r.results.channels[0].detected_language = "fr"; },
    (r: any) => { r.results.channels[0].language_confidence = .49; },
    (r: any) => { r.results.channels[0].alternatives[0].words[1].start = .1; },
    (r: any) => { r.results.channels[0].alternatives[0].words[1].end = 99; },
    (r: any) => { r.results.channels[0].alternatives[0].words[0].punctuated_word = "<script>"; },
  ];
  for (const change of variants) { const raw = transcript(); change(raw); assert.throws(() => deepgramSegments(raw, version, ["en"], 2000)); }
});

test("speech exports only bounded WAV audio with explicit MIP opt-out and a pinned model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "managed-asr-test-"));
  try {
    const audio = Buffer.alloc(44); audio.write("RIFF"); audio.write("WAVE", 8);
    const path = join(dir, "audio.wav"); await writeFile(path, audio);
    let requests = 0;
    const transcribe = createDeepgramCaptionTranscriber({ apiKey: "synthetic-key", version, allowedLanguages: ["en"], fetch: (async (url, init) => {
      requests++;
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://api.deepgram.com");
      assert.equal(parsed.searchParams.get("mip_opt_out"), "true");
      assert.equal(parsed.searchParams.get("version"), version);
      assert.deepEqual(parsed.searchParams.getAll("detect_language"), ["en"]);
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>)["Content-Type"], "audio/wav");
      assert.deepEqual(init?.body, audio);
      return new Response(JSON.stringify(transcript()));
    }) as typeof fetch });
    assert.deepEqual(await transcribe(path, signal(), 1000, 2000), deepgramSegments(transcript(), version, ["en"], 2000));
    await writeFile(path, "not audio");
    await assert.rejects(transcribe(path, signal(), 1000, 2000), /managed_audio_budget/);
    assert.equal(requests, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("managed caption configuration needs no local model and refuses floating versions", () => {
  const env = { MEDIA_CAPTION_ASR_ENABLED: "true", MEDIA_CAPTION_ASR_PROVIDER: "deepgram", MEDIA_CAPTION_ASR_FFMPEG_PATH: "/usr/bin/ffmpeg",
    MEDIA_CAPTION_ASR_MODEL_VERSION: `deepgram:nova-3:${version}`, MEDIA_CAPTION_ASR_CONFIG_VERSION: "reviewed-fixture", MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES: "en" };
  assert.equal(captionAsrConfig(env)?.provider, "deepgram");
  for (const pin of ["latest", "beta", ""]) assert.throws(() => createDeepgramCaptionTranscriber({ apiKey: "synthetic", version: pin, allowedLanguages: ["en"] }));
  assert.throws(() => captionAsrConfig({ ...env, MEDIA_CAPTION_ASR_PROVIDER: "unknown" }));
});

test("provider transport has one deadline covering stalled headers and body and never exposes provider errors", async () => {
  const input = { url: "https://provider.test/", authorization: "secret", body: "synthetic", contentType: "application/json", signal: signal(), timeoutMs: 15, maxResponseBytes: 32 };
  await assert.rejects(managedMediaJson({ ...input, fetch: (() => new Promise(() => {})) as typeof fetch }), /managed_timeout/);
  await assert.rejects(managedMediaJson({ ...input, fetch: (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch }), /managed_timeout/);
  await assert.rejects(managedMediaJson({ ...input, fetch: (async () => new Response("secret transcript", { status: 500 })) as typeof fetch }), /^Error: managed_request_failed$/);
  await assert.rejects(managedMediaJson({ ...input, fetch: (async () => new Response("x".repeat(33))) as typeof fetch }), /managed_response_budget/);
  const redirect = new Response("{}"); Object.defineProperty(redirect, "redirected", { value: true });
  await assert.rejects(managedMediaJson({ ...input, fetch: (async () => redirect) as typeof fetch }), /managed_redirect_refused/);
});

test("managed image execution exports pixels and pinned protocol only; result must match the pinned model", async () => {
  const runner = createManagedImageUnderstandingRunner(visionEnv, (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["imageBase64", "modelId", "modelRevision", "protocol", "taxonomyVersion"]);
    assert.equal(body.imageBase64, jpeg.toString("base64"));
    assert.equal(body.modelRevision, IMAGE_UNDERSTANDING_REVISION);
    return new Response(JSON.stringify({ ok: true, value: recognition }));
  }) as typeof fetch);
  assert.deepEqual(await runner.infer(jpeg, signal()), recognition);
  runner.close(); await assert.rejects(runner.infer(jpeg, signal()), /stopped/);
  const wrong = createManagedImageUnderstandingRunner(visionEnv, (async () => new Response(JSON.stringify({ ok: true, value: { ...recognition, modelRevision: "wrong" } }))) as typeof fetch);
  await assert.rejects(wrong.infer(jpeg, signal())); wrong.close();
});

test("managed vision refuses arbitrary endpoints, legacy consent policies and unknown execution modes", async () => {
  for (const endpoint of ["http://127.0.0.1/", "https://provider.test/", `${visionEnv.MEDIA_VISION_HF_ENDPOINT}?secret=x`, `${visionEnv.MEDIA_VISION_HF_ENDPOINT}@evil.test`]) {
    const runner = createManagedImageUnderstandingRunner({ ...visionEnv, MEDIA_VISION_HF_ENDPOINT: endpoint }, (() => { throw new Error("must not fetch"); }) as typeof fetch);
    await assert.rejects(runner.infer(jpeg, signal()), /vision_runtime_not_configured/); runner.close();
  }
  const env = { MEDIA_IMAGE_UNDERSTANDING_ENABLED: "true", MEDIA_IMAGE_UNDERSTANDING_PROVIDER: "self_hosted_siglip", MEDIA_IMAGE_UNDERSTANDING_ALLOWED_OWNER_IDS: "owner", MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY: "local-policy", MEDIA_VISION_EXECUTION: "huggingface" };
  assert.equal(imageUnderstandingPolicy(env, "owner"), null);
  const managed = { ...env, MEDIA_IMAGE_UNDERSTANDING_APPROVED_POLICY: "hf-siglip-v1-reviewed" };
  assert.equal(imageUnderstandingPolicy(managed, "owner"), "hf-siglip-v1-reviewed");
  assert.equal(imageUnderstandingPolicy({ ...managed, MEDIA_VISION_EXECUTION: "local" }, "owner"), null);
  assert.equal(imageUnderstandingPolicy({ ...managed, MEDIA_VISION_EXECUTION: "unknown" }, "owner"), null);
  assert.equal(imageUnderstandingPolicy(managed, "foreign"), null);
});

test("closing managed vision cancels a pending request and refuses late inference", async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const runner = createManagedImageUnderstandingRunner(visionEnv, (() => { started(); return new Promise(() => {}); }) as typeof fetch);
  const pending = runner.infer(jpeg, signal());
  const rejected = assert.rejects(pending, /managed_cancelled/);
  await ready; runner.close(); await rejected;
});
