import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captionAsrConfig, createConfiguredWhisperMediaJobHandler } from "../lib/media/captions/runtime.js";
import { makeFeedDb } from "./helpers/fakeFeedDb.js";

const marker = "synthetic marker, not a real model";
const pinnedVersion = `sha256:${createHash("sha256").update(marker).digest("hex")}`;
const settings: NodeJS.ProcessEnv = {
  MEDIA_CAPTION_ASR_ENABLED: "true", MEDIA_CAPTION_ASR_PYTHON_PATH: "/usr/bin/python3", MEDIA_CAPTION_ASR_FFMPEG_PATH: "/usr/bin/python3",
  MEDIA_CAPTION_ASR_MODEL_PATH: "/fixture/model", MEDIA_CAPTION_ASR_MODEL_VERSION: pinnedVersion,
  MEDIA_CAPTION_ASR_CONFIG_VERSION: "reviewed-config-1", MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES: "en,fr",
};
const jobError = (code: string, retryable: boolean) => Object.assign(new Error(code), { retryable });

test("caption runtime is strictly OFF by default and never resolves consent or touches configuration while OFF", () => {
  const fake = makeFeedDb({ users: {}, tables: {} });
  for (const enabled of [undefined, "", "false"]) {
    const env = { MEDIA_CAPTION_ASR_ENABLED: enabled, MEDIA_CAPTION_ASR_MODEL_PATH: "/missing-model" };
    assert.equal(captionAsrConfig(env), null);
    assert.equal(createConfiguredWhisperMediaJobHandler(fake.client, env, jobError), null);
  }
  for (const enabled of ["1", "yes", "TRUE", "false "]) assert.throws(() => captionAsrConfig({ ...settings, MEDIA_CAPTION_ASR_ENABLED: enabled }), /invalid_caption_configuration/);
});

test("caption runtime rejects relative tools, unpinned models, invalid language lists and numeric bounds", () => {
  const invalid = [
    { MEDIA_CAPTION_ASR_PYTHON_PATH: "python3" }, { MEDIA_CAPTION_ASR_FFMPEG_PATH: "https://tools.test/ffmpeg" },
    { MEDIA_CAPTION_ASR_MODEL_PATH: "" }, { MEDIA_CAPTION_ASR_MODEL_VERSION: "latest" }, { MEDIA_CAPTION_ASR_MODEL_VERSION: "small" },
    { MEDIA_CAPTION_ASR_CONFIG_VERSION: "" }, { MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES: "" }, { MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES: "en,en" },
    { MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES: "und" }, { MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES: "auto" }, { MEDIA_CAPTION_ASR_ALLOWED_LANGUAGES: "en-US" },
    { MEDIA_CAPTION_ASR_TIMEOUT_MS: "" }, { MEDIA_CAPTION_ASR_TIMEOUT_MS: "1e4" }, { MEDIA_CAPTION_ASR_TIMEOUT_MS: "NaN" }, { MEDIA_CAPTION_ASR_TIMEOUT_MS: "600001" },
    { MEDIA_CAPTION_ASR_MAX_DURATION_MS: "0" }, { MEDIA_CAPTION_ASR_MAX_DURATION_MS: "900001" }, { MEDIA_CAPTION_ASR_MAX_DURATION_MS: "1.5" },
  ];
  for (const patch of invalid) assert.throws(() => captionAsrConfig({ ...settings, ...patch }), /invalid_caption_configuration/);
  assert.deepEqual(captionAsrConfig(settings)?.allowedLanguages, ["en", "fr"]);
  assert.equal(captionAsrConfig(settings)?.timeoutMs, 600000);
});

test("configured factory verifies real local bytes and uses persisted consent without synthesizing readiness", async () => {
  const directory = await mkdtemp(join(tmpdir(), "caption-runtime-fixture-"));
  try {
    await writeFile(join(directory, "model.bin"), marker);
    const fake = makeFeedDb({ users: {}, tables: { feature_flags: [] } });
    const handler = createConfiguredWhisperMediaJobHandler(fake.client, { ...settings, MEDIA_CAPTION_ASR_MODEL_PATH: directory }, jobError);
    assert.ok(handler);
    assert.equal(handler.kind, "captions");
    assert.equal(handler.modelVersion, pinnedVersion);
    await assert.rejects(handler.handle({ job: { id: "50000000-0000-4000-a000-000000000001", token: "lease", assetId: "20000000-0000-4000-a000-000000000001", ownerUserId: "10000000-0000-4000-a000-000000000001", sourceVersion: 1, kind: "captions", bucket: "post-media", path: "owner/video.mp4", sizeBytes: 20, modelVersion: pinnedVersion, revisionKey: "a".repeat(64) }, signal: new AbortController().signal, isCurrent: async () => true }), /consent_required/);
    assert.deepEqual(fake.tables.feature_flags, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("configured factory refuses replaced model bytes and unavailable tools before returning a handler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "caption-runtime-pin-fixture-"));
  try {
    const fake = makeFeedDb({ users: {}, tables: {} });
    const env = { ...settings, MEDIA_CAPTION_ASR_MODEL_PATH: directory };
    assert.throws(() => createConfiguredWhisperMediaJobHandler(fake.client, env, jobError), /local_model_or_tools_unavailable/);
    await writeFile(join(directory, "model.bin"), "replaced synthetic bytes");
    assert.throws(() => createConfiguredWhisperMediaJobHandler(fake.client, env, jobError), /local_model_pin_mismatch/);
    await writeFile(join(directory, "model.bin"), marker);
    assert.throws(() => createConfiguredWhisperMediaJobHandler(fake.client, { ...env, MEDIA_CAPTION_ASR_FFMPEG_PATH: "/missing/ffmpeg" }, jobError), /local_model_or_tools_unavailable/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
