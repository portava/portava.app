import test from "node:test";
import assert from "node:assert/strict";
import { dubbingSourceFromCaptionSnapshot, translatedDubbingCues } from "../lib/media/dubbing/captionBridge.js";

const asset = { id: "11111111-1111-4111-8111-111111111111", owner_user_id: "22222222-2222-4222-8222-222222222222", storage_bucket: "post-media", storage_path: "owner/original.mp4", media_type: "video", duration_ms: 4000, version: 1, deleted_at: null, purge_status: "none", processing_status: "ready", moderation_status: "approved" };
const snapshot = () => ({ assetId: asset.id, sourceVersion: 1, revisionKey: "a".repeat(64), tracks: [{ language: "en-US", sourceKind: "translation" as const, aiLabel: "AI-translated subtitles", vtt: "WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nWelcome.\n", revision: 1, modelVersion: "local-approved-model-1", sourceLanguage: "es" }] });
const expected = { sourceRevision: "a".repeat(64), targetLanguage: "en-US" };

test("shared translation fields preserve caption timing without running another translator", () => {
  const original = [{ startMs: 500, endMs: 2000, text: "Bienvenido." }];
  const result = translatedDubbingCues(original, { status: "translated", sourceRevision: expected.sourceRevision, sourceLanguage: "es", targetLanguage: "en-US", provider: "self_hosted", providerVersion: "model-sha256", fields: { cue_0: "Welcome." } }, expected);
  assert.deepEqual(result, [{ startMs: 500, endMs: 2000, text: "Welcome." }]);
  assert.equal(original[0]!.text, "Bienvenido.");
});

test("unavailable, incomplete, extra and mock translations are not dubbed", () => {
  const original = [{ startMs: 500, endMs: 2000, text: "Bienvenido." }];
  for (const result of [
    { status: "unavailable", fields: {} },
    { status: "translated", sourceLanguage: "es", targetLanguage: "en-US", provider: "self_hosted", providerVersion: "model-1", fields: {} },
    { status: "translated", sourceLanguage: "es", targetLanguage: "en-US", provider: "self_hosted", providerVersion: "model-1", fields: { cue_0: "Hello", extra: "wrong" } },
    { status: "translated", sourceLanguage: "es", targetLanguage: "en-US", provider: "mock", providerVersion: "mock-1", fields: { cue_0: "Welcome" } },
  ]) assert.throws(() => translatedDubbingCues(original, result as any, expected));
});

test("translated fields from a stale caption revision or wrong locale cannot be reused", () => {
  const cues = [{ startMs: 500, endMs: 2000, text: "Bienvenido." }];
  const result = { status: "translated" as const, sourceRevision: expected.sourceRevision, sourceLanguage: "es", targetLanguage: "en-US", provider: "self_hosted", providerVersion: "model-1", fields: { cue_0: "Welcome." } };
  assert.throws(() => translatedDubbingCues(cues, { ...result, sourceRevision: "b".repeat(64) }, expected));
  assert.throws(() => translatedDubbingCues(cues, { ...result, targetLanguage: "en" }, expected));
});

test("approved translated caption snapshot supplies bounded source and revision identity", () => {
  const source = dubbingSourceFromCaptionSnapshot(asset, snapshot(), "en-US");
  assert.deepEqual(source.cues, [{ startMs: 500, endMs: 2000, text: "Welcome." }]);
  assert.equal(source.captionRevision, "a".repeat(64));
  const changed = snapshot(); changed.tracks[0]!.vtt = changed.tracks[0]!.vtt.replace("Welcome", "Hello");
  assert.notEqual(dubbingSourceFromCaptionSnapshot(asset, changed, "en-US").translationRevision, source.translationRevision);
});

test("held, stale, unlabelled and untranslated caption sources fail closed", () => {
  assert.throws(() => dubbingSourceFromCaptionSnapshot({ ...asset, moderation_status: "limited" }, snapshot(), "en-US"));
  assert.throws(() => dubbingSourceFromCaptionSnapshot(asset, { ...snapshot(), sourceVersion: 2 }, "en-US"));
  assert.throws(() => dubbingSourceFromCaptionSnapshot(asset, snapshot(), "fr-FR"));
  const unlabelled = snapshot(); unlabelled.tracks[0]!.aiLabel = "";
  assert.throws(() => dubbingSourceFromCaptionSnapshot(asset, unlabelled, "en-US"));
  const untranslated = snapshot(); (untranslated.tracks[0] as any).sourceKind = "asr";
  assert.throws(() => dubbingSourceFromCaptionSnapshot(asset, untranslated, "en-US"));
});
