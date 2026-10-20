import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DUBBING_DISCLOSURE_VERSION, DUBBING_LABEL, DubbingError, validateDubbingInput, type SyntheticSpeechEngine, type TimedDubbingInput, type DubbingErrorCode } from "../lib/media/dubbing/contracts.js";
import { dubbingRevision, renderDubbing } from "../lib/media/dubbing/render.js";
import { decodeWave, encodeWave } from "../lib/media/dubbing/wav.js";
import { createDubbingHandler } from "../lib/media/dubbing/handler.js";

const owner = "00000000-0000-4000-8000-000000000001";
const asset = "00000000-0000-4000-8000-000000000002";
const artifact = "00000000-0000-4000-8000-000000000003";
const signal = () => new AbortController().signal;
function input(): TimedDubbingInput {
  return { assetId: asset, ownerId: owner, requestedBy: owner, sourceVersion: 1, captionRevision: "a".repeat(64), translationRevision: "b".repeat(64), consentRevision: "c".repeat(64), targetLanguage: "en-US", optedIn: true, disclosureVersion: DUBBING_DISCLOSURE_VERSION, durationMs: 4000, cues: [{ startMs: 500, endMs: 1500, text: "Hello." }, { startMs: 2500, endMs: 3500, text: "Welcome." }] };
}
function engine(): SyntheticSpeechEngine {
  return { id: "test-tone-not-speech", modelVersion: "fixture-1", language: "en-US", async synthesize() { return { sampleRate: 24000, samples: Buffer.alloc(12_000, 20) }; } };
}
const current = async () => {};
const jobError = (code: DubbingErrorCode, retryable: boolean) => Object.assign(new DubbingError(code), { retryable });
const errorCode = (code: string) => (error: unknown) => error instanceof DubbingError && error.code === code;

test("render writes separate labeled PCM with exact timing, silence and preserved input", async () => {
  const source = input();
  const before = structuredClone(source);
  const result = await renderDubbing(source, engine(), { signal: signal(), assertCurrent: current });
  const decoded = decodeWave(result.audio);
  assert.equal(result.audio.length, 192044);
  assert.equal(decoded.samples.length, 192000);
  assert(decoded.samples.subarray(0, 500 * 48).every((byte) => byte === 0));
  assert(decoded.samples.subarray(500 * 48, 750 * 48).every((byte) => byte === 20));
  assert(decoded.samples.subarray(750 * 48, 2500 * 48).every((byte) => byte === 0));
  assert(decoded.samples.subarray(2500 * 48, 2750 * 48).every((byte) => byte === 20));
  assert(decoded.samples.subarray(2750 * 48).every((byte) => byte === 0));
  assert.equal(result.manifest.label, DUBBING_LABEL);
  assert.equal(result.manifest.voiceCloning, false);
  assert.equal(result.manifest.training, false);
  assert.equal(result.manifest.sha256, createHash("sha256").update(result.audio).digest("hex"));
  assert.deepEqual(source, before);
  assert(!JSON.stringify(result.manifest).includes("Hello"));
  assert.equal(result.audio.subarray(36, 40).toString(), "data");
});

for (const [name, mutate] of [
  ["consent omitted", (value: any) => { delete value.optedIn; }],
  ["consent false", (value: any) => { value.optedIn = false; }],
  ["outdated disclosure", (value: any) => { value.disclosureVersion = "old"; }],
  ["another requester", (value: any) => { value.requestedBy = artifact; }],
  ["overlap", (value: any) => { value.cues[1].startMs = 1000; }],
  ["beyond media duration", (value: any) => { value.cues[1].endMs = 4001; }],
  ["reversed timing", (value: any) => { value.cues[0].endMs = 499; }],
  ["fractional timing", (value: any) => { value.cues[0].startMs = 0.01; }],
  ["overlong media", (value: any) => { value.durationMs = 300001; }],
  ["voice cloning extra field", (value: any) => { value.voiceReference = "https://example.invalid/audio"; }],
  ["SSML", (value: any) => { value.cues[0].text = '<audio src="x" />'; }],
  ["raw phonemes", (value: any) => { value.cues[0].text = "[[ private ]]"; }],
  ["oversized cue", (value: any) => { value.cues[0].text = "x".repeat(2049); }],
  ["invalid revision", (value: any) => { value.consentRevision = "latest"; }],
] as const) {
  test(`refuses ${name} before synthesis`, async () => {
    const value = input();
    mutate(value);
    let calls = 0;
    const runtime = engine();
    runtime.synthesize = async () => { calls++; throw new Error("must not execute"); };
    await assert.rejects(renderDubbing(value, runtime, { signal: signal(), assertCurrent: current }));
    assert.equal(calls, 0);
  });
}

test("oversized speech refuses rather than truncating or stretching", async () => {
  const runtime = engine();
  runtime.synthesize = async () => ({ sampleRate: 24000, samples: Buffer.alloc(48_002, 20) });
  await assert.rejects(renderDubbing(input(), runtime, { signal: signal(), assertCurrent: current }), errorCode("segment_overflow"));
});

test("resampling retains duration and never overwrites gaps", async () => {
  const runtime = engine();
  runtime.synthesize = async () => ({ sampleRate: 16000, samples: Buffer.alloc(16_000, 20) });
  const result = await renderDubbing(input(), runtime, { signal: signal(), assertCurrent: current });
  assert.equal(result.manifest.segments[0]!.spokenMs, 500);
  const decoded = decodeWave(result.audio);
  assert(decoded.samples.subarray(1000 * 48, 2500 * 48).every((byte) => byte === 0));
});

test("silent and malformed audio are never successful dubs", async () => {
  for (const samples of [Buffer.alloc(12000), Buffer.from([1]), Buffer.alloc(0)]) {
    const runtime = engine();
    runtime.synthesize = async () => ({ sampleRate: 24000, samples });
    await assert.rejects(renderDubbing(input(), runtime, { signal: signal(), assertCurrent: current }), errorCode("invalid_audio"));
  }
});

test("no locale fallback to a different-language voice", async () => {
  const value = input(); value.targetLanguage = "fr-FR";
  await assert.rejects(renderDubbing(value, engine(), { signal: signal(), assertCurrent: current }), errorCode("unsupported_language"));
});

test("revocation between segments prevents later synthesis and output", async () => {
  let revoked = false;
  let calls = 0;
  const runtime = engine();
  runtime.synthesize = async () => { calls++; revoked = true; return { sampleRate: 24000, samples: Buffer.alloc(12000, 20) }; };
  await assert.rejects(renderDubbing(input(), runtime, { signal: signal(), assertCurrent: async () => { if (revoked) throw new DubbingError("source_revoked"); } }), errorCode("source_revoked"));
  assert.equal(calls, 1);
});

test("cancelled admission and in-flight synthesis never return audio", async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(renderDubbing(input(), engine(), { signal: controller.signal, assertCurrent: current }), errorCode("cancelled"));
  const running = new AbortController();
  const runtime = engine();
  runtime.synthesize = async () => { running.abort(); return { sampleRate: 24000, samples: Buffer.alloc(12000, 20) }; };
  await assert.rejects(renderDubbing(input(), runtime, { signal: running.signal, assertCurrent: current }), errorCode("cancelled"));
});

test("every content, source, consent and model change changes the retry identity", () => {
  const baseline = input();
  const originalKey = dubbingRevision(validateDubbingInput(baseline), engine());
  for (const change of [{ sourceVersion: 2 }, { captionRevision: "d".repeat(64) }, { translationRevision: "d".repeat(64) }, { consentRevision: "d".repeat(64) }, { cues: [{ startMs: 0, endMs: 1000, text: "Changed" }] }]) {
    assert.notEqual(dubbingRevision(validateDubbingInput({ ...baseline, ...change }), engine()), originalKey);
  }
  assert.notEqual(dubbingRevision(baseline, { ...engine(), modelVersion: "fixture-2" }), originalKey);
});

test("strict WAV decoder rejects forged size, stereo and truncated frames", () => {
  const wav = encodeWave({ sampleRate: 24000, samples: Buffer.alloc(240, 20) });
  assert.deepEqual(decodeWave(wav).samples, Buffer.alloc(240, 20));
  const stereo = Buffer.from(wav); stereo.writeUInt16LE(2, 22);
  const forged = Buffer.from(wav); forged.writeUInt32LE(9999, 40);
  for (const bytes of [stereo, forged, wav.subarray(0, -1)]) assert.throws(() => decodeWave(bytes), errorCode("invalid_audio"));
});

function context() {
  const value = input();
  return { job: { id: artifact, token: owner, assetId: asset, ownerUserId: owner, sourceVersion: 1, kind: "dubbing" as const, modelVersion: "fixture-1", targetLanguage: "en-US", revisionKey: dubbingRevision(value, engine()), bucket: "post-media" as const, path: `${owner}/original.mp4`, sizeBytes: 123, attempt: 1, leaseUntil: "2099-01-01T00:00:00Z" }, signal: signal(), isCurrent: async () => true };
}

test("handler stages only derived bytes and discard removes the owned artifact", async () => {
  const stored = new Map<string, Buffer>();
  const handler = createDubbingHandler({ jobError, engine: engine(), loadInput: async () => input(), assertCurrent: current,
    stage: async (_context, audio) => { stored.set(artifact, Buffer.from(audio)); return { artifactId: artifact }; },
    remove: async (_context, id) => { stored.delete(id); },
  });
  const ctx = context();
  const output = await handler.handle(ctx);
  assert.equal(stored.size, 1);
  assert.equal(decodeWave(stored.get(artifact)!).samples.length, 192000);
  assert.equal(output.result.label, DUBBING_LABEL);
  assert.equal(output.result.publicationToken, ctx.job.token);
  await handler.discard(ctx, output);
  assert.equal(stored.size, 0);
});

test("handler refuses stale revision before synthesis or staging", async () => {
  let staged = false;
  const handler = createDubbingHandler({ jobError, engine: engine(), loadInput: async () => input(), assertCurrent: current, stage: async () => { staged = true; return { artifactId: artifact }; }, remove: async () => {} });
  const ctx = context(); ctx.job.revisionKey = "d".repeat(64);
  await assert.rejects(handler.handle(ctx), errorCode("source_revoked"));
  assert.equal(staged, false);
});

test("hold arriving during storage staging removes bytes and refuses success", async () => {
  let held = false;
  const stored = new Map<string, Buffer>();
  const handler = createDubbingHandler({ jobError, engine: engine(), loadInput: async () => input(), assertCurrent: async () => { if (held) throw new DubbingError("source_revoked"); }, stage: async (_context, audio) => { stored.set(artifact, Buffer.from(audio)); held = true; return { artifactId: artifact }; }, remove: async (_context, id) => { stored.delete(id); } });
  await assert.rejects(handler.handle(context()), errorCode("source_revoked"));
  assert.equal(stored.size, 0);
});

test("storage cleanup denial is surfaced, not falsely reported as removed", async () => {
  let held = false;
  const stored = new Map<string, Buffer>();
  const handler = createDubbingHandler({ jobError, engine: engine(), loadInput: async () => input(), assertCurrent: async () => { if (held) throw new DubbingError("source_revoked"); }, stage: async (_context, audio) => { stored.set(artifact, Buffer.from(audio)); held = true; return { artifactId: artifact }; }, remove: async () => { throw new Error("cleanup denied"); } });
  await assert.rejects(handler.handle(context()), (error: any) => error.code === "cleanup_failed" && error.retryable === true);
  assert.equal(stored.size, 1);
});

test("handler classifies stale source as permanent and infrastructure failure as retryable", async () => {
  for (const [code, retryable] of [["source_revoked", false], ["storage_unavailable", true]] as const) {
    const handler = createDubbingHandler({ jobError, engine: engine(), loadInput: async () => { throw new DubbingError(code); }, assertCurrent: current, stage: async () => ({ artifactId: artifact }), remove: async () => {} });
    await assert.rejects(handler.handle(context()), (error: any) => error.code === code && error.retryable === retryable);
  }
});
