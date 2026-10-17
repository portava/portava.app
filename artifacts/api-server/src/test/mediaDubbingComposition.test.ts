import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mkdtemp, realpath, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseDubbingEnvironment, describePiperRuntime } from "../lib/media/dubbing/config.js";
import { createConfiguredMediaDubbingRouter, createMediaDubbingWorker, createMediaDubbingCleanup, createConfiguredDubbingHandler, eraseDubbingSource } from "../lib/media/dubbing/composition.js";
import { createPiperSpeech } from "../lib/media/dubbing/piper.js";
import type { DubbingPlaybackOptions } from "../lib/media/dubbing/options.js";

const owner = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const runtime = { executable: "/absent/piper", executableSha256: "a".repeat(64), modelPath: "/absent/voice.onnx", modelSha256: "b".repeat(64), configSha256: "c".repeat(64), language: "en-US", stockVoiceApproved: true, offlineSandboxAttested: true };
const environment = () => ({ MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private", MEDIA_DUBBING_PIPER_CONFIG: JSON.stringify(runtime) });
const body = { targetLanguage: "en-US", explicitOptIn: true, disclosureVersion: "synthetic-dubbing-v1", expectedConsentRevision: "0".repeat(64) };
const retainedArtifact = (id = artifactId) => ({ id, asset_id: assetId, storage_bucket: "dubbing-private", storage_path: `synthetic-dubbing/${id}.wav`, owner_user_id: owner, write_state: "uploaded", cleanup_requested: false });

function fixture() {
  const asset = { id: assetId, owner_user_id: owner, storage_bucket: "post-media", storage_path: `${owner}/video.mp4`, media_type: "video", duration_ms: 2000, version: 1, deleted_at: null, purge_status: "not_requested", processing_status: "ready", moderation_status: "approved" };
  const captionRevision = "d".repeat(64);
  const path = `manual-captions/${assetId}/v1-${captionRevision}.json`;
  const state = { asset, flags: true, consent: null as Record<string, unknown> | null, jobs: [] as Record<string, unknown>[], artifacts: [] as ReturnType<typeof retainedArtifact>[], removed: [] as string[], rpcCalls: [] as string[], rateKeys: [] as string[], actor: owner as string | null, throttled: false, downloads: 0, failCleanup: false };
  const client = {
    from(name: string) {
      const filters: Record<string, unknown> = {};
      let single = false;
      let removing = false;
      const query = {
        select() { return query; }, eq(key: string, value: unknown) { filters[key] = value; return query; },
        in() { return query; }, limit() { return query; }, or() { return query; }, order() { return query; },
        maybeSingle() { single = true; return query; }, delete() { removing = true; return query; },
        then(resolve: (answer: unknown) => unknown) {
          let rows: unknown[];
          if (name === "feature_flags") rows = [{ enabled: state.flags }];
          else if (name === "media_assets") rows = [state.asset];
          else if (name === "media_attachments") rows = [{ entity_type: "post", entity_id: jobId }];
          else if (name === "post_media") rows = [{ post_id: jobId, processing_status: "ready", moderation_status: "approved" }];
          else if (name === "posts") rows = [{ id: jobId, author_id: owner, status: "active", post_status: "published" }];
          else if (name === "stories") rows = [];
          else if (name === "media_caption_manifests") rows = [{ asset_id: assetId, source_version: 1, revision_key: captionRevision, object_path: path }];
          else if (name === "media_dubbing_consents") rows = state.consent ? [state.consent] : [];
          else if (name === "media_dubbing_readable") rows = [];
          else if (name === "media_dubbing_artifacts") {
            rows = state.artifacts.filter((row) => Object.entries(filters).every(([key, value]) => row[key as keyof typeof row] === value)).slice(0, 100);
            if (removing) state.artifacts = state.artifacts.filter((row) => !rows.includes(row));
          } else throw new Error(`Unexpected table ${name}`);
          return Promise.resolve({ data: single ? rows[0] ?? null : structuredClone(rows), error: null }).then(resolve);
        },
      };
      return query;
    },
    rpc(name: string, parameters: Record<string, unknown>) {
      const execute = async () => {
        state.rpcCalls.push(name);
        if (name === "media_dubbing_consent_state") {
          return { data: parameters.p_owner === owner ? { consentRevision: state.consent?.consent_revision ?? "0".repeat(64), optedIn: state.consent?.opted_in === true } : null, error: null };
        }
        if (name === "media_dubbing_grant") {
          state.consent = { owner_user_id: owner, opted_in: true, consent_revision: "e".repeat(64), source_version: 1, caption_revision: parameters.p_caption, translation_revision: parameters.p_translation, disclosure_version: body.disclosureVersion };
          return { data: state.consent.consent_revision, error: null };
        }
        if (name === "media_dubbing_current") return { data: state.consent?.opted_in === true, error: null };
        if (name === "media_dubbing_revoke") {
          if (parameters.p_owner !== owner) return { data: false, error: null };
          state.consent = { ...state.consent, opted_in: false, consent_revision: "f".repeat(64) }; state.jobs = [];
          return { data: true, error: null };
        }
        if (name === "media_dubbing_retire") {
          const artifact = state.artifacts.find((row) => row.id === parameters.p_id && row.owner_user_id === parameters.p_owner);
          if (artifact) artifact.cleanup_requested = true;
          return { data: artifact ? structuredClone(artifact) : null, error: null };
        }
        if (name === "media_dubbing_forget") {
          const artifact = state.artifacts.find((row) => row.id === parameters.p_id);
          if (!artifact) return { data: true, error: null };
          if (artifact.owner_user_id !== parameters.p_owner || !artifact.cleanup_requested || artifact.write_state === "pending") return { data: false, error: null };
          state.artifacts = state.artifacts.filter((row) => row !== artifact);
          return { data: true, error: null };
        }
        if (name === "media_derivative_enqueue") { state.jobs.push(parameters); return { data: jobId, error: null }; }
        if (name === "media_derivative_recover") return { data: 0, error: null };
        if (name === "media_derivative_claim") return { data: [], error: null };
        throw new Error(`Unexpected RPC ${name}`);
      };
      return { then: (resolve: (answer: unknown) => unknown, reject?: (error: unknown) => unknown) => execute().then(resolve, reject), abortSignal: () => execute() };
    },
    storage: {
      async getBucket() { return { data: { public: false }, error: null }; },
      from(bucket: string) {
        return {
          async download(filename: string) {
            assert.equal(bucket, "post-media"); assert.equal(filename, path); state.downloads++;
            return { data: new Blob([JSON.stringify({ source: asset, consent: true, tracks: [{ language: "en-US", sourceKind: "translation", aiLabel: "AI translation", modelVersion: "local-translator-v1", revision: 1, vtt: "WEBVTT\n\n00:00:00.500 --> 00:00:01.500\nInvented sentence.\n" }] })]), error: null };
          },
          async remove(paths: string[]) {
            assert.equal(bucket, "dubbing-private");
            if (state.failCleanup) return { error: new Error("fixture cleanup failure") };
            state.removed.push(...paths); return { error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  const options = { client, env: environment(), authenticate: async () => state.actor, rateLimit: (key: string) => { state.rateKeys.push(key); return { allowed: !state.throttled, retryAfterMs: 1000 }; } };
  return { state, options };
}

async function server(router: express.Router, run: (url: string) => Promise<void>) {
  const app = express(); app.use(router);
  const http = createServer(app);
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  try { await run(`http://127.0.0.1:${(http.address() as AddressInfo).port}/media/${assetId}/dubbing`); }
  finally { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); }
}

test("environment validation is pure and creates a descriptor without synthesis or filesystem access", () => {
  const config = parseDubbingEnvironment(environment());
  assert.equal(config.status, "configured");
  assert.deepEqual(config.descriptor, describePiperRuntime(runtime));
  assert.deepEqual(Object.keys(config.descriptor!).sort(), ["id", "language", "modelVersion"]);
  assert(Object.isFrozen(config.descriptor));
  assert(Object.isFrozen(config.runtime));
});

test("authorized playback options contain no model paths or audio and never mark queued output ready", async () => {
  const { state, options } = fixture();
  await server(createConfiguredMediaDubbingRouter(options), async url => {
    const response = await fetch(`${url}/options`);
    assert.equal(response.status, 200);
    const value = await response.json() as DubbingPlaybackOptions;
    assert.equal(value.assetId, assetId);
    assert.equal(value.sourceVersion, 1);
    assert.equal(value.canEdit, true);
    assert.equal(value.enabled, true);
    assert.deepEqual(value.languages, [{ code: "en-US", label: "en-US", ready: false }]);
    assert.match(value.sourceKey, /^[a-f0-9]{64}$/);
    assert.equal(value.disclosure, undefined);
    assert.equal(JSON.stringify(value).includes("/absent"), false);
    assert.equal(state.downloads, 0);
    assert.deepEqual(state.jobs, []);
    state.flags = false;
    const disabled = await (await fetch(`${url}/options`)).json() as DubbingPlaybackOptions;
    assert.equal(disabled.enabled, false);
    assert.notEqual(disabled.sourceKey, value.sourceKey);
  });
});

test("held or unauthenticated sources cannot expose dubbing options", async () => {
  const { state, options } = fixture();
  await server(createConfiguredMediaDubbingRouter(options), async url => {
    state.actor = null;
    assert.equal((await fetch(`${url}/options`)).status, 401);
    state.actor = owner;
    state.asset.processing_status = "pending";
    const response = await fetch(`${url}/options`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "dubbing_unavailable" });
  });
});

test("missing or malformed runtime retains independently validated cleanup bucket", () => {
  for (const value of [undefined, "", "{", "{}", "x".repeat(8193), JSON.stringify({ ...runtime, offlineSandboxAttested: false }), JSON.stringify({ ...runtime, stockVoiceApproved: "true" }), JSON.stringify({ ...runtime, voiceReference: "forbidden" })]) {
    const config = parseDubbingEnvironment({ MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private", MEDIA_DUBBING_PIPER_CONFIG: value });
    assert.notEqual(config.status, "configured"); assert.equal(config.bucketName, "dubbing-private"); assert.equal(config.descriptor, undefined);
  }
});

test("bucket and local runtime path validators never invent defaults", () => {
  for (const bucket of [undefined, "", "post-media", "https://bucket", "../bucket", " bucket "]) {
    const config = parseDubbingEnvironment({ ...environment(), MEDIA_DUBBING_STORAGE_BUCKET: bucket });
    assert.notEqual(config.status, "configured"); assert.equal(config.bucketName, undefined); assert.equal(config.descriptor, undefined);
  }
  for (const executable of ["relative", "/a/../b", "https://provider", "/a\u0000b"]) assert.throws(() => describePiperRuntime({ ...runtime, executable }));
  assert.throws(() => describePiperRuntime({ ...runtime, modelSha256: "BAD" }));
  assert.throws(() => describePiperRuntime({ ...runtime, language: "not_a_locale" }));
});

test("descriptor identity changes with all pinned runtime and approval inputs", () => {
  const expected = describePiperRuntime(runtime);
  assert.deepEqual(describePiperRuntime(Object.fromEntries(Object.entries(runtime).reverse())), expected);
  for (const patch of [{ modelSha256: "d".repeat(64) }, { configSha256: "d".repeat(64) }, { executableSha256: "d".repeat(64) }, { language: "fr-FR" }]) assert.notEqual(describePiperRuntime({ ...runtime, ...patch }).modelVersion, expected.modelVersion);
});

test("configured API enqueues with nonexistent model files using actual caption/store/queue composition", async () => {
  const { state, options } = fixture();
  await server(createConfiguredMediaDubbingRouter(options), async (url) => {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 202, await response.text());
    assert.equal(state.consent?.opted_in, true); assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0]?.p_model_version, describePiperRuntime(runtime).modelVersion);
    assert.equal(state.jobs[0]?.p_target_language, "en-US");
    assert.match(String(state.jobs[0]?.p_revision_key), /^[a-f0-9]{64}$/);
    assert(state.downloads > 0); assert(state.rateKeys.includes("media_dubbing_generate"));
  });
});

test("parent authentication and rate limits block before consent or enqueue", async () => {
  const { state, options } = fixture();
  await server(createConfiguredMediaDubbingRouter(options), async (url) => {
    state.actor = null;
    assert.equal((await fetch(url, { method: "POST" })).status, 401);
    state.actor = owner; state.throttled = true;
    assert.equal((await fetch(url, { method: "POST" })).status, 429);
    assert.equal(state.jobs.length, 0); assert.equal(state.consent, null); assert.equal(state.downloads, 0);
  });
});

test("API caches only immutable descriptor configuration while flags are rechecked per request", async () => {
  const { state, options } = fixture();
  const expected = describePiperRuntime(runtime).modelVersion;
  const router = createConfiguredMediaDubbingRouter(options);
  options.env.MEDIA_DUBBING_PIPER_CONFIG = JSON.stringify({ ...runtime, modelSha256: "f".repeat(64) });
  await server(router, async (url) => {
    const post = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post()).status, 202); assert.equal(state.jobs[0]?.p_model_version, expected);
    state.flags = false;
    assert.equal((await post()).status, 503); assert.equal(state.jobs.length, 1);
    assert.equal((await fetch(url, { method: "DELETE" })).status, 204); assert.equal(state.jobs.length, 0);
  });
});

test("default parent limiter isolates generation budget from withdrawal", async () => {
  const { state, options } = fixture();
  await server(createConfiguredMediaDubbingRouter({ ...options, rateLimit: undefined }), async (url) => {
    for (let index = 0; index < 120; index++) assert.equal((await fetch(url, { method: "POST" })).status, 400);
    assert.equal((await fetch(url, { method: "POST" })).status, 429);
    assert.equal((await fetch(url, { method: "DELETE" })).status, 204);
    assert.equal(state.consent?.opted_in, false);
  });
});

test("missing bucket API retains withdrawal but never acknowledges retained bytes as erased", async () => {
  const { state, options } = fixture();
  state.artifacts.push(retainedArtifact());
  await server(createConfiguredMediaDubbingRouter({ ...options, env: {} }), async (url) => {
    assert.equal((await fetch(`${url}?language=en-US`)).status, 200);
    const response = await fetch(url, { method: "DELETE" });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "cleanup_failed" });
    assert.equal(state.consent?.opted_in, false); assert.equal(state.artifacts.length, 1);
  });
});

test("real Rawls snapshot rejects held or foreign source before granting consent", async () => {
  for (const change of [{ processing_status: "failed" }, { moderation_status: "rejected" }, { owner_user_id: jobId }]) {
    const { state, options } = fixture(); Object.assign(state.asset, change);
    await server(createConfiguredMediaDubbingRouter(options), async (url) => {
      assert.notEqual((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).status, 202);
      assert.equal(state.jobs.length, 0); assert.equal(state.consent, null);
    });
  }
});

test("flags OFF and invalid runtime preserve consent state and withdrawal with real cleanup", async () => {
  const { state, options } = fixture(); state.flags = false;
  options.env.MEDIA_DUBBING_PIPER_CONFIG = "invalid";
  state.artifacts.push(retainedArtifact());
  await server(createConfiguredMediaDubbingRouter(options), async (url) => {
    assert.equal((await fetch(url, { method: "POST" })).status, 503);
    assert.equal((await fetch(`${url}?language=en-US`)).status, 200);
    assert.equal((await fetch(url, { method: "DELETE" })).status, 204);
    assert.equal(state.consent?.opted_in, false); assert.equal(state.artifacts.length, 0);
    assert.deepEqual(state.removed, [`synthetic-dubbing/${artifactId}.wav`]);
    assert(state.rateKeys.includes("media_dubbing_withdraw"));
  });
});

test("missing bucket still withdraws durably but retains cleanup ledger and reports failure", async () => {
  const { state, options } = fixture();
  state.artifacts.push(retainedArtifact());
  const cleanup = createMediaDubbingCleanup({ client: options.client, env: {} });
  await assert.rejects(cleanup.revoke({ assetId, actorId: owner }), /cleanup_failed/);
  assert.equal(state.consent?.opted_in, false); assert.equal(state.artifacts.length, 1); assert.equal(state.removed.length, 0);
  await assert.rejects(cleanup.eraseOwned(owner), /cleanup_failed/);
  const restored = createMediaDubbingCleanup({ client: options.client, env: { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" } });
  assert.equal(await restored.eraseOwned(owner), 1); assert.equal(state.artifacts.length, 0);
});

test("cleanup failure retains owned keys and cleanup factory never requires model or flags", async () => {
  const { state, options } = fixture(); state.flags = false; state.failCleanup = true;
  state.artifacts.push(retainedArtifact());
  const cleanup = createMediaDubbingCleanup({ client: options.client, env: { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" } });
  await assert.rejects(cleanup.revoke({ assetId, actorId: owner }), /cleanup_failed/);
  assert.equal(state.consent?.opted_in, false); assert.equal(state.artifacts.length, 1);
  state.failCleanup = false;
  assert.equal(await cleanup.eraseOwned(owner), 1); assert.equal(await cleanup.eraseOwned(owner), 0);
});

test("worker stays disabled for missing config, flags OFF and nonexistent runtime", async () => {
  const { state, options } = fixture();
  assert.equal((await createMediaDubbingWorker({ client: options.client, env: {} })).status, "disabled");
  state.flags = false;
  assert.deepEqual(await createMediaDubbingWorker(options), { status: "disabled", reason: "flags_off" });
  state.flags = true;
  assert.deepEqual(await createMediaDubbingWorker(options), { status: "disabled", reason: "runtime_unavailable" });
  assert.equal(state.rpcCalls.length, 0);
  assert.equal(await createConfiguredDubbingHandler(options.client, {}), null);
  assert.equal(await createConfiguredDubbingHandler(options.client, options.env), null);
});

test("canonical source erasure is independent of flags and model and refuses missing bucket with retained records", async () => {
  const { state, options } = fixture(); state.flags = false;
  state.artifacts.push(retainedArtifact());
  await assert.rejects(eraseDubbingSource(options.client, owner, assetId, {}), /cleanup_failed/);
  assert.equal(state.artifacts.length, 1); assert.equal(state.removed.length, 0);
  await eraseDubbingSource(options.client, owner, assetId, { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" });
  assert.equal(state.artifacts.length, 0); assert.equal(state.removed.length, 1);
  await eraseDubbingSource(options.client, owner, assetId, {});
  assert.deepEqual(state.rpcCalls, ["media_dubbing_retire", "media_dubbing_retire", "media_dubbing_forget"]);
});

test("pending writes stay retryable and retained while OFF without physical removal", async () => {
  const { state, options } = fixture(); state.flags = false;
  state.artifacts.push({ ...retainedArtifact(), write_state: "pending" });
  await assert.rejects(eraseDubbingSource(options.client, owner, assetId, { MEDIA_DUBBING_STORAGE_BUCKET: "dubbing-private" }), /cleanup_failed/);
  assert.equal(state.artifacts.length, 1); assert.equal(state.artifacts[0]!.cleanup_requested, true);
  assert.equal(state.removed.length, 0); assert.deepEqual(state.rpcCalls, ["media_dubbing_retire"]);
});

test("source erasure requires retry after full bounded page rather than acknowledging incomplete deletion", async () => {
  const { state, options } = fixture();
  for (let index = 0; index < 101; index++) {
    const id = `44444444-4444-4444-8444-${String(index).padStart(12, "0")}`;
    state.artifacts.push(retainedArtifact(id));
  }
  await assert.rejects(eraseDubbingSource(options.client, owner, assetId, options.env), /cleanup_failed/);
  assert.equal(state.artifacts.length, 1); assert.equal(state.removed.length, 100);
  await eraseDubbingSource(options.client, owner, assetId, options.env);
  assert.equal(state.artifacts.length, 0); assert.equal(state.removed.length, 101);
});

test("independent worker verifies actual pinned fixture files, shares descriptor and rechecks flags per pass", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "dubbing-composition-")));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const executable = join(directory, "protocol-fixture");
  const modelPath = join(directory, "not-real-model.onnx");
  const marker = join(directory, "invocations");
  const script = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)},"called");\n`;
  const model = "NOT AN INFERENCE MODEL";
  const config = JSON.stringify({ num_speakers: 1, language: { code: "en_US" }, audio: { sample_rate: 24000 } });
  try {
    await writeFile(executable, script, { mode: 0o700 }); await writeFile(modelPath, model); await writeFile(`${modelPath}.json`, config);
    const settings = { ...runtime, executable, executableSha256: digest(script), modelPath, modelSha256: digest(model), configSha256: digest(config) };
    const { state, options } = fixture(); options.env.MEDIA_DUBBING_PIPER_CONFIG = JSON.stringify(settings);
    const worker = await createMediaDubbingWorker(options);
    assert.equal(worker.status, "ready");
    if (worker.status !== "ready") throw new Error("Worker did not initialize");
    assert.equal(worker.handler.modelVersion, describePiperRuntime(settings).modelVersion);
    assert.equal((await createPiperSpeech(settings)).modelVersion, worker.handler.modelVersion);
    assert.equal((await createConfiguredDubbingHandler(options.client, options.env))?.modelVersion, worker.handler.modelVersion);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    state.flags = false;
    assert.equal(await createConfiguredDubbingHandler(options.client, options.env), null);
    assert.equal((await worker.runPass(new AbortController().signal)).claimed, 0); assert.equal(state.rpcCalls.length, 0);
    state.flags = true;
    await worker.runPass(new AbortController().signal);
    assert.deepEqual(state.rpcCalls, ["media_derivative_recover", "media_derivative_claim"]);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
