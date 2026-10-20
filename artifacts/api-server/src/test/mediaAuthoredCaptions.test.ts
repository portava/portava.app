import { before, after, beforeEach, afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import express from "express";
import router from "../routes/mediaCaptions.js";
import { _setTestClient, _clearTestClient } from "../lib/http.js";
import { _setTestServiceClient } from "../lib/supabase.js";
import { _resetRateLimit } from "../lib/rateLimit.js";
import { makeFeedDb } from "./helpers/fakeFeedDb.js";
import { captionArtifactPath, purgeAuthoredCaptionTracks, EMPTY_CAPTION_REVISION } from "../services/media/AuthoredCaptionsService.js";
import { authorizeMediaAccess } from "../lib/mediaAccess.js";
import { captionDraftId, captionDraftPath, type CaptionJob } from "../services/media/CaptionDraftService.js";
import { findPreviouslyConsentedCaptionJob } from "../services/media/CaptionAsrService.js";

const OWNER = "10000000-0000-4000-a000-000000000001";
const VIEWER = "10000000-0000-4000-a000-000000000002";
const ASSET = "20000000-0000-4000-a000-000000000001";
const POST = "30000000-0000-4000-a000-000000000001";
const PATH = `${OWNER}/clip.mp4`;
const VTT = "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n\n00:01.000 --> 00:02.000\nWorld";
let server: http.Server;
let port: number;
let fake: ReturnType<typeof makeFeedDb>;
let objects: Map<string, string>;
let afterUpload: (() => void | Promise<void>) | undefined;
let afterDownload: (() => void) | undefined;
let removeFails: boolean;
let uploadFails: boolean;
let listThrows: boolean;

before(async () => {
  const app = express();
  app.use("/api", router);
  await new Promise<void>((resolve, reject) => { server = app.listen(0, "127.0.0.1", (error?: Error) => error ? reject(error) : resolve()); });
  port = (server.address() as { port: number }).port;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

beforeEach(() => {
  mock.method(globalThis, "fetch", async () => { assert.fail("No external requests"); });
  afterUpload = undefined;
  afterDownload = undefined;
  removeFails = false;
  uploadFails = false;
  listThrows = false;
  objects = new Map();
  _resetRateLimit();
  fake = makeFeedDb({
    users: { owner: OWNER, viewer: VIEWER },
    tables: {
      feature_flags: [{ flag: "media_captions_enabled", enabled: true }],
      media_assets: [{ id: ASSET, owner_user_id: OWNER, storage_bucket: "post-media", storage_path: PATH, media_type: "video", duration_ms: 2500, version: 1, deleted_at: null, purge_status: "not_requested", processing_status: "ready", moderation_status: "approved" }],
      post_media: [{ post_id: POST, storage_path: PATH, public_url: `post-media/${PATH}`, processing_status: "ready", moderation_status: "approved" }],
      posts: [{ id: POST, author_id: OWNER, visibility: "public", status: "active", post_status: "published" }],
      profiles: [{ id: OWNER, is_private: false, account_status: "active" }, { id: VIEWER, is_private: false, account_status: "active" }],
      media_caption_manifests: [],
      media_caption_asr_consents: [],
      media_caption_asr_epochs: [],
      media_caption_asr_config: [],
      media_derivative_jobs: [],
    },
  });
  fake.client.rpc = async (name: string, args: any) => {
    if (name === "media_caption_asr_epoch") {
      if (fake.tables.media_assets[0].owner_user_id !== args.p_owner_id) return { data: null, error: null };
      if (!fake.tables.media_caption_asr_epochs.length) fake.tables.media_caption_asr_epochs.push({ asset_id: ASSET, consent_epoch: randomBytes(32).toString("hex") });
      return { data: fake.tables.media_caption_asr_epochs[0].consent_epoch, error: null };
    }
    if (name === "media_caption_asr_revoke") {
      if (fake.tables.media_assets[0].owner_user_id !== args.p_owner_id) return { data: false, error: null };
      fake.tables.media_caption_asr_epochs = [{ asset_id: ASSET, consent_epoch: randomBytes(32).toString("hex") }];
      for (const grant of fake.tables.media_caption_asr_consents) grant.revoked_at = "2026-10-15T12:00:00Z";
      for (const job of fake.tables.media_derivative_jobs) { job.state = "cancelled"; job.lease_token = null; job.lease_until = null; job.result = null; }
      return { data: true, error: null };
    }
    if (name === "media_caption_asr_enqueue") {
      if (args.p_consent !== true || args.p_owner_id !== OWNER || args.p_caption_revision !== currentRevision() || fake.tables.media_assets[0].version !== args.p_source.version) return { data: null, error: null };
      if (!args.p_expected_consent_epoch || args.p_expected_consent_epoch !== fake.tables.media_caption_asr_epochs[0]?.consent_epoch) return { data: null, error: null };
      const active = fake.tables.media_caption_asr_consents.find((grant) => grant.revoked_at === null);
      if (active) return { data: active.job_id, error: null };
      const model = fake.tables.media_caption_asr_config[0];
      const grantId = randomUUID();
      const jobId = randomUUID();
      const jobRevision = randomBytes(32).toString("hex");
      fake.tables.media_caption_asr_consents.push({ id: grantId, asset_id: ASSET, owner_user_id: OWNER, consent_epoch: args.p_expected_consent_epoch, source_version: args.p_source.version, caption_revision_key: args.p_caption_revision, job_revision_key: jobRevision, model_version: model.model_version, config_version: model.config_version, target_language: args.p_target_language, job_id: jobId, granted_at: "2026-10-15T12:00:00Z", revoked_at: null });
      fake.tables.media_derivative_jobs.push({ id: jobId, asset_id: ASSET, owner_user_id: OWNER, source_version: args.p_source.version, source_bucket: "post-media", source_path: PATH, kind: "captions", model_version: model.model_version, target_language: args.p_target_language, revision_key: jobRevision, state: "pending", result: null });
      return { data: jobId, error: null };
    }
    assert.equal(name, "cas_media_caption_manifest");
    const source = fake.tables.media_assets[0];
    const current = fake.tables.media_caption_manifests[0];
    if (source.owner_user_id !== args.p_owner_id || Object.keys(args.p_source).some((key) => source[key] !== args.p_source[key]) || (current?.revision_key ?? EMPTY_CAPTION_REVISION) !== args.p_expected_revision) return { data: false, error: null };
    if (args.p_asr_consent_id && !fake.tables.media_caption_asr_consents.some((grant) => grant.id === args.p_asr_consent_id && grant.revoked_at === null)) return { data: false, error: null };
    fake.tables.media_caption_manifests = [{ asset_id: ASSET, source_version: source.version, revision_key: args.p_revision, object_path: args.p_object_path }];
    return { data: true, error: null };
  };
  fake.client.storage = { async getBucket() { return { data: { public: false, allowed_mime_types: null }, error: null }; }, from(bucket: string) {
    assert.equal(bucket, "post-media");
    return {
      async upload(path: string, body: Buffer, options: { upsert: boolean }) {
        assert.equal(options.upsert, false);
        if (uploadFails || objects.has(path)) return { data: null, error: { statusCode: "409" } };
        objects.set(path, body.toString("utf8"));
        await afterUpload?.();
        return { data: { path }, error: null };
      },
      async download(path: string) {
        const value = objects.get(path);
        afterDownload?.();
        return value === undefined ? { data: null, error: { statusCode: "404" } } : { data: new Blob([value]), error: null };
      },
      async remove(paths: string[]) {
        if (removeFails) return { error: { message: "storage unavailable" } };
        paths.forEach((path) => objects.delete(path));
        return { error: null };
      },
      async list(prefix: string, options: { limit: number; offset?: number }) {
        if (listThrows) throw new Error("storage list unavailable");
        return { data: [...objects.keys()].filter((path) => path.startsWith(`${prefix}/`)).sort().slice(options.offset ?? 0, (options.offset ?? 0) + options.limit).map((path) => ({ name: path.slice(prefix.length + 1) })), error: null };
      },
    };
  } };
  _setTestClient(fake.client, true);
});
afterEach(() => { mock.restoreAll(); _clearTestClient(); _setTestServiceClient(null); });

function request(method: string, path: string, body?: unknown, token: string | null = "owner"): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify({ revisionKey: currentRevision(), ...body as object });
    const call = http.request({ hostname: "127.0.0.1", port, method, agent: false, path: `/api/media/captions${path}`, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, (response) => {
      let data = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { data += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(data), headers: response.headers }));
    });
    call.setTimeout(3000, () => call.destroy(new Error("Caption HTTP test timed out")));
    call.on("error", reject);
    call.end(payload);
  });
}
const save = (version = 1, token = "owner", vtt = VTT) => request("PUT", `/${ASSET}`, { version, vtt, consent: true }, token);
const read = (version: number, token = "owner") => request("GET", `/${ASSET}?version=${version}`, undefined, token);
const currentRevision = () => fake.tables.media_caption_manifests[0]?.revision_key ?? EMPTY_CAPTION_REVISION;
const currentPath = () => fake.tables.media_caption_manifests[0].object_path as string;

test("real HTTP owner authoring, protected viewer read, update and delete change stored state", async () => {
  const resolved = await request("GET", `/source?source=${encodeURIComponent(`post-media/${PATH}`)}`);
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body, { assetId: ASSET, version: 1, revisionKey: EMPTY_CAPTION_REVISION, durationMs: 2500, canEdit: true });
  const saved = await save();
  assert.equal(saved.status, 200);
  assert.equal(fake.tables.media_assets[0].version, 1);
  const firstPath = currentPath();
  assert.equal(JSON.parse(objects.get(firstPath)!).tracks[0].vtt, VTT);
  const viewer = await read(1, "viewer");
  assert.equal(viewer.status, 200);
  assert.deepEqual(viewer.body.cues.map((cue: any) => cue.text), ["Hello", "World"]);
  assert.equal(viewer.body.vtt, null);
  assert.match(String(viewer.headers["cache-control"]), /no-store/);
  assert.equal((await read(1)).body.vtt, VTT);
  assert.equal((await save(1, "owner", VTT.replace("Hello", "Edited"))).status, 200);
  assert.equal(objects.has(firstPath), false);
  assert.equal((await read(1)).body.cues[0].text, "Edited");
  assert.equal((await request("DELETE", `/${ASSET}`, { version: 1 })).status, 200);
  assert.equal(fake.tables.media_assets[0].version, 1);
  assert.equal(objects.size, 0);
  assert.deepEqual((await read(1)).body.cues, []);
  assert.equal((await read(2)).status, 409);
});

test("absent and disabled gates refuse source/read/write, never create artifacts", async () => {
  for (const flags of [[], [{ flag: "media_captions_enabled", enabled: false }]]) {
    fake.tables.feature_flags = flags;
    assert.equal((await save()).status, 404);
    assert.equal((await read(1)).status, 404);
    assert.equal((await request("GET", `/source?source=post-media/${PATH}`)).status, 404);
  }
  assert.equal(objects.size, 0);
  assert.equal(fake.tables.media_assets[0].version, 1);
});

test("no token is unauthorized; a permitted viewer still cannot author or delete", async () => {
  assert.equal((await request("GET", `/${ASSET}?version=1`, undefined, null)).status, 401);
  assert.equal((await save(1, "viewer")).status, 403);
  assert.equal((await request("DELETE", `/${ASSET}`, { version: 1 }, "viewer")).status, 403);
  assert.equal(objects.size, 0);
});

test("OFF owner-management lookup is explicit, authenticated and cannot enable captions or transcription", async () => {
  fake.tables.feature_flags = [];
  const path = `/source?source=${encodeURIComponent(`post-media/${PATH}`)}&manageDubbing=1`;
  const owned = await request("GET", path);
  assert.equal(owned.status, 200);
  assert.equal(owned.body.canEdit, true);
  assert.equal((await request("GET", path, undefined, "viewer")).status, 404);
  assert.equal((await request("GET", path, undefined, null)).status, 401);
  assert.equal((await save()).status, 404);
  assert.equal((await read(1)).status, 404);
  assert.equal((await request("POST", `/${ASSET}/asr?manageDubbing=1`, {})).status, 404);
  assert.equal(objects.size, 0);
  assert.equal(fake.tables.media_derivative_jobs.length, 0);
});

test("private source and blocked viewer cannot obtain text even knowing asset and version", async () => {
  await save();
  fake.tables.posts[0].visibility = "private";
  assert.equal((await read(1, "viewer")).status, 404);
  fake.tables.posts[0].visibility = "public";
  fake.tables.blocks = [{ blocker_id: OWNER, blocked_id: VIEWER }];
  assert.equal((await read(1, "viewer")).status, 404);
});

test("manual storage keys cannot be served by the generic media byte route", async () => {
  await save();
  for (const viewer of [OWNER, VIEWER]) assert.equal(await authorizeMediaAccess(fake.client, viewer, "post-media", currentPath()), false);
});

test("exact canonical source only: reject foreign URLs, traversal, derivatives and missing rows", async () => {
  for (const source of ["https://evil.test/post-media/clip.mp4", "post-media/../clip.mp4", `post-media/${PATH}.captions.vtt`, `post-media/${captionArtifactPath(ASSET, 1)}`]) {
    const response = await request("GET", `/source?source=${encodeURIComponent(source)}`);
    assert.ok([400, 404].includes(response.status));
  }
  assert.equal(objects.size, 0);
});

test("consent, malformed, unordered, oversized and beyond-duration tracks fail whole", async () => {
  assert.equal((await request("PUT", `/${ASSET}`, { version: 1, vtt: VTT, consent: false })).status, 400);
  for (const vtt of ["Hello", "WEBVTT\n\n00:01.000 --> 00:00.000\nWrong", VTT.replace("00:02.000", "00:04.000"), `${VTT}\n\n00:00.500 --> 00:01.000\nEarlier`, `WEBVTT\n\n00:00.000 --> 00:01.000\n${"é".repeat(140000)}`]) {
    assert.equal((await save(1, "owner", vtt)).status, 400);
  }
  assert.equal(objects.size, 0);
  assert.equal(fake.tables.media_assets[0].version, 1);
});

test("unmeasured, non-video, deleted, purging or held sources cannot serve or accept captions", async () => {
  for (const patch of [{ duration_ms: null }, { media_type: "image" }, { deleted_at: "2026-10-15" }, { purge_status: "pending" }, { moderation_status: "limited" }, { processing_status: "failed" }]) {
    const previous = { ...fake.tables.media_assets[0] };
    Object.assign(fake.tables.media_assets[0], patch);
    assert.ok([404, 409].includes((await save()).status));
    assert.ok([404, 409].includes((await read(1)).status));
    fake.tables.media_assets[0] = previous;
  }
  assert.equal(objects.size, 0);
});

test("stale writer and stale reader never rebase to a newer generation", async () => {
  await save();
  assert.equal((await request("PUT", `/${ASSET}`, { version: 1, vtt: VTT, consent: true, revisionKey: EMPTY_CAPTION_REVISION })).status, 409);
  fake.tables.media_assets[0].version = 3;
  assert.equal((await save()).status, 409);
  assert.equal((await read(1)).status, 409);
  assert.equal((await read(2)).status, 409);
  assert.deepEqual((await read(3)).body.cues, []);
});

test("source change during storage write refuses publication and removes the staged track", async () => {
  afterUpload = () => { fake.tables.media_assets[0].version = 5; fake.tables.media_assets[0].storage_path = `${OWNER}/replacement.mp4`; };
  assert.equal((await save()).status, 409);
  assert.equal(objects.size, 0);
  assert.equal(fake.tables.media_assets[0].version, 5);
});

test("full snapshot recheck catches same-version path changes during storage write", async () => {
  afterUpload = () => { fake.tables.media_assets[0].storage_path = `${OWNER}/replacement.mp4`; };
  assert.equal((await save()).status, 409);
  assert.equal(objects.size, 0);
});

test("deletion or authorization change during download refuses every cue", async () => {
  await save();
  afterDownload = () => { fake.tables.media_assets[0].deleted_at = "2026-10-15"; };
  const result = await read(1);
  assert.equal(result.status, 404);
  assert.equal(result.body.cues, undefined);
});

test("foreign snapshot substitution is refused even at the expected storage key", async () => {
  await save();
  const path = currentPath();
  const document = JSON.parse(objects.get(path)!);
  document.source.storage_path = `${OWNER}/other.mp4`;
  objects.set(path, JSON.stringify(document));
  assert.equal((await read(1)).status, 409);
});

test("delete remains available with rollout off and revokes reads despite failed physical cleanup", async () => {
  await save();
  const oldPath = currentPath();
  fake.tables.feature_flags[0].enabled = false;
  removeFails = true;
  const result = await request("DELETE", `/${ASSET}`, { version: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.cleanupPending, true);
  assert.equal(objects.has(oldPath), true);
  fake.tables.feature_flags[0].enabled = true;
  assert.deepEqual((await read(1)).body.cues, []);
  assert.equal(currentPath(), null);
});

test("deletion wins against pending save without publishing the staged object", async () => {
  let deletion: Awaited<ReturnType<typeof request>> | undefined;
  afterUpload = async () => {
    afterUpload = undefined;
    deletion = await request("DELETE", `/${ASSET}`, { version: 1 });
  };
  assert.equal((await save()).status, 409);
  assert.equal(deletion?.status, 200);
  assert.deepEqual((await read(1)).body.cues, []);
  assert.equal(objects.size, 0);
});

test("failed upload never advances canonical version", async () => {
  uploadFails = true;
  assert.equal((await save()).status, 409);
  assert.equal(fake.tables.media_assets[0].version, 1);
});

test("lifecycle purge removes all generations, preserves unrelated assets, reports storage failure", async () => {
  await save();
  objects.set(captionArtifactPath(ASSET, 90), "old-unservable");
  objects.set("manual-captions/other/v1.json", "unrelated");
  fake.tables.media_assets[0].deleted_at = "2026-10-15T12:00:00Z";
  removeFails = true;
  await assert.rejects(purgeAuthoredCaptionTracks(fake.client, ASSET));
  removeFails = false;
  await purgeAuthoredCaptionTracks(fake.client, ASSET);
  assert.deepEqual([...objects.keys()], ["manual-captions/other/v1.json"]);
});

test("multiple manual languages preserve originals and resolve only the requested language", async () => {
  assert.equal((await request("PUT", `/${ASSET}`, { version: 1, vtt: VTT, consent: true, language: "en" })).status, 200);
  assert.equal((await request("PUT", `/${ASSET}`, { version: 1, vtt: VTT.replace("Hello", "Bonjour"), consent: true, language: "fr" })).status, 200);
  const english = await request("GET", `/${ASSET}?version=1&language=en`);
  const french = await request("GET", `/${ASSET}?version=1&language=fr`);
  assert.equal(english.body.cues[0].text, "Hello");
  assert.equal(french.body.cues[0].text, "Bonjour");
  assert.deepEqual(english.body.availableLanguages, ["en", "fr"]);
  assert.equal(english.body.sourceKind, "manual");
  assert.equal((await request("GET", `/${ASSET}?version=1&language=../bad`)).status, 400);
});

test("caption selection matches a requested track but otherwise chooses the first nontranslation original", async () => {
  await request("PUT", `/${ASSET}`, { version: 1, vtt: VTT, consent: true, language: "en" });
  const document = JSON.parse(objects.get(currentPath())!);
  document.tracks.unshift({ language: "fr", sourceKind: "translation", aiLabel: "AI translation", revision: 1, vtt: VTT.replace("Hello", "Bonjour") });
  objects.set(currentPath(), JSON.stringify(document));
  for (const query of ["", "&language=de"]) {
    const selected = await request("GET", `/${ASSET}?version=1${query}`, undefined, "viewer");
    assert.equal(selected.status, 200);
    assert.equal(selected.body.cues[0].text, "Hello");
    assert.equal(selected.body.language, "en");
    assert.equal(selected.body.sourceKind, "manual");
    assert.equal(selected.body.aiLabel, null);
    assert.equal(selected.body.vtt, null);
  }
  const translated = await request("GET", `/${ASSET}?version=1&language=fr`, undefined, "viewer");
  assert.equal(translated.body.cues[0].text, "Bonjour");
  assert.equal(translated.body.aiLabel, "AI translation");
  assert.equal(translated.body.sourceKind, "translation");
  assert.deepEqual(translated.body.availableLanguages, ["fr", "en"]);
  assert.deepEqual(JSON.parse(objects.get(currentPath())!), document);
});

test("caption fallback retains ASR provenance and never substitutes another translation for an absent original", async () => {
  await request("PUT", `/${ASSET}`, { version: 1, vtt: VTT, consent: true, language: "en" });
  const document = JSON.parse(objects.get(currentPath())!);
  document.tracks[0] = { ...document.tracks[0], sourceKind: "asr", aiLabel: "AI transcription · creator reviewed" };
  document.tracks.unshift({ language: "fr", sourceKind: "translation", aiLabel: "AI translation", revision: 1, vtt: VTT.replace("Hello", "Bonjour") });
  objects.set(currentPath(), JSON.stringify(document));
  const fallback = await request("GET", `/${ASSET}?version=1&language=de`);
  assert.equal(fallback.body.cues[0].text, "Hello");
  assert.equal(fallback.body.language, "en");
  assert.equal(fallback.body.sourceKind, "asr");
  assert.equal(fallback.body.aiLabel, "AI transcription · creator reviewed");
  document.tracks.pop();
  objects.set(currentPath(), JSON.stringify(document));
  for (const query of ["", "&language=de"]) {
    const missing = await request("GET", `/${ASSET}?version=1${query}`);
    assert.deepEqual(missing.body.cues, []);
    assert.equal(missing.body.language, "und");
    assert.equal(missing.body.vtt, null);
    assert.equal(missing.body.aiLabel, null);
  }
  assert.equal((await request("GET", `/${ASSET}?version=1&language=fr`)).body.cues[0].text, "Bonjour");
});

test("original-language fallback never bypasses authorization or a revocation during download", async () => {
  await request("PUT", `/${ASSET}`, { version: 1, vtt: VTT, consent: true, language: "en" });
  afterDownload = () => { fake.tables.posts[0].visibility = "private"; };
  assert.equal((await request("GET", `/${ASSET}?version=1&language=de`, undefined, "viewer")).status, 404);
  assert.equal((await request("GET", `/${ASSET}?version=1`, undefined, "viewer")).status, 404);
  assert.equal(JSON.parse(objects.get(currentPath())!).tracks[0].vtt, VTT);
});

test("ASR drafts are creator-only, never served until explicit reviewed publication with AI label", async () => {
  const job: CaptionJob = { assetId: ASSET, sourceVersion: 1, kind: "captions", consentId: "40000000-0000-4000-a000-000000000001", jobId: "50000000-0000-4000-a000-000000000001", revisionKey: EMPTY_CAPTION_REVISION, modelVersion: "synthetic-fixture", configVersion: "fixture", targetLanguage: "en", requestedBy: OWNER, consent: { ownerId: OWNER, transcription: true, recordedAt: "2026-10-15T12:00:00Z" } };
  const draftId = captionDraftId(job);
  const path = captionDraftPath(ASSET, 1, draftId, job.consentId);
  objects.set(path, JSON.stringify({ source: { ...fake.tables.media_assets[0] }, draftId, consentId: job.consentId, jobId: job.jobId, revisionKey: EMPTY_CAPTION_REVISION, vtt: VTT, language: "en", sourceKind: "asr", aiLabel: "AI transcription · needs creator review", modelVersion: job.modelVersion, configVersion: job.configVersion }));
  fake.tables.media_caption_asr_consents.push({ id: job.consentId, asset_id: ASSET, owner_user_id: OWNER, source_version: 1, caption_revision_key: EMPTY_CAPTION_REVISION, job_revision_key: "b".repeat(64), model_version: job.modelVersion, config_version: job.configVersion, target_language: "en", job_id: job.jobId, granted_at: job.consent.recordedAt, revoked_at: null });
  fake.tables.media_derivative_jobs.push({ id: job.jobId, asset_id: ASSET, owner_user_id: OWNER, source_version: 1, kind: "captions", model_version: job.modelVersion, target_language: "en", revision_key: "b".repeat(64), state: "completed", result: { draftId, artifactKey: path } });
  assert.deepEqual((await read(1, "viewer")).body.cues, []);
  assert.equal((await request("GET", `/${ASSET}/draft?version=1`, undefined, "viewer")).status, 403);
  assert.equal((await request("GET", `/${ASSET}/draft?version=1`)).body.vtt, VTT);
  const payload = { version: 1, draftId, vtt: VTT.replace("Hello", "Reviewed"), consent: true };
  assert.equal((await request("POST", `/${ASSET}/draft/publish`, { ...payload, consent: false })).status, 400);
  assert.equal((await request("POST", `/${ASSET}/draft/publish`, payload)).status, 200);
  assert.equal(objects.has(path), false);
  const published = await read(1, "viewer");
  assert.equal(published.body.cues[0].text, "Reviewed");
  assert.equal(published.body.sourceKind, "asr");
  assert.match(published.body.aiLabel, /AI transcription.*creator reviewed/);
});

test("deleted parent posts and encrypted/non-post canonical attachments refuse even owner captions", async () => {
  await save();
  fake.tables.posts[0].status = "deleted";
  assert.equal((await read(1)).status, 404);
  fake.tables.posts[0].status = "active";
  fake.tables.media_attachments = [{ media_asset_id: ASSET, entity_type: "message", entity_id: POST }];
  assert.equal((await read(1)).status, 404);
  assert.equal((await save(1)).status, 404);
});

test("uncommitted artifacts cannot become readable after an unrelated canonical version bump", async () => {
  objects.set(captionArtifactPath(ASSET, 2, "a".repeat(64)), JSON.stringify({ source: { ...fake.tables.media_assets[0], version: 2 }, tracks: [{ language: "en", sourceKind: "manual", aiLabel: null, revision: 1, vtt: VTT }], consent: true }));
  fake.tables.media_assets[0].version = 2;
  assert.deepEqual((await read(2)).body.cues, []);
  assert.equal(fake.tables.media_caption_manifests.length, 0);
});

test("same-generation deletion during download revokes cues by caption revision", async () => {
  await save();
  afterDownload = () => { fake.tables.media_caption_manifests[0].revision_key = "d".repeat(64); fake.tables.media_caption_manifests[0].object_path = null; };
  const result = await read(1);
  assert.equal(result.status, 409);
  assert.equal(result.body.cues, undefined);
});

test("concurrent manual writers compare original revision and preserve winner", async () => {
  let winner: Awaited<ReturnType<typeof request>> | undefined;
  afterUpload = async () => { afterUpload = undefined; winner = await save(1, "owner", VTT.replace("Hello", "Winner")); };
  assert.equal((await save()).status, 409);
  assert.equal(winner?.status, 200);
  assert.equal((await read(1)).body.cues[0].text, "Winner");
  assert.equal(objects.size, 1);
});

test("public, unverifiable or MIME-incompatible buckets never receive caption text", async () => {
  for (const result of [{ data: { public: true }, error: null }, { data: null, error: {} }, { data: { public: false, allowed_mime_types: ["image/*", "video/*"] }, error: null }]) {
    fake.client.storage.getBucket = async () => result;
    assert.equal((await save()).status, 503);
    assert.equal(objects.size, 0);
    assert.equal(fake.tables.media_caption_manifests.length, 0);
  }
});

test("storage listing outage cannot prevent logical caption deletion", async () => {
  await save();
  const before = currentRevision();
  listThrows = true;
  const result = await request("DELETE", `/${ASSET}`, { version: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.cleanupPending, true);
  assert.notEqual(currentRevision(), before);
  assert.equal(objects.size, 1);
  assert.deepEqual((await read(1)).body.cues, []);
});

function enableLocalAsr() {
  fake.tables.feature_flags.push({ flag: "media_caption_asr_enabled", enabled: true }, { flag: "media_derivative_jobs_enabled", enabled: true });
  fake.tables.media_caption_asr_config.push({ singleton: true, enabled: true, model_version: "fixture-model-1", config_version: "fixture-config-1", allowed_languages: ["en"], runtime_verified_at: "2026-10-15T12:00:00Z" });
}

async function freshAsrPayload(targetLanguage = "") {
  const status = await request("GET", `/${ASSET}/asr`);
  assert.equal(status.status, 200);
  assert.match(status.body.consentEpoch, /^[a-f0-9]{64}$/);
  return { version: 1, consent: true, targetLanguage, expectedConsentEpoch: status.body.consentEpoch };
}

test("ASR request defaults OFF, requires explicit consent and rejects model/language overrides", async () => {
  const payload = await freshAsrPayload("en");
  assert.equal((await request("POST", `/${ASSET}/asr`, payload)).status, 404);
  enableLocalAsr();
  assert.equal((await request("POST", `/${ASSET}/asr`, { ...payload, consent: false })).status, 400);
  assert.equal((await request("POST", `/${ASSET}/asr`, { ...payload, modelVersion: "arbitrary-model" })).status, 400);
  assert.equal((await request("POST", `/${ASSET}/asr`, { ...payload, targetLanguage: "xx" })).status, 400);
  assert.equal(fake.tables.media_derivative_jobs.length, 0);
  assert.equal(fake.tables.media_caption_asr_consents.length, 0);
});

test("ASR owner request persists one bound job and consent, nonowner cannot read/enqueue/revoke", async () => {
  enableLocalAsr();
  const payload = await freshAsrPayload("en");
  assert.equal((await request("POST", `/${ASSET}/asr`, payload, "viewer")).status, 403);
  assert.equal((await request("GET", `/${ASSET}/asr`, undefined, "viewer")).status, 403);
  assert.equal((await request("DELETE", `/${ASSET}/asr`, undefined, "viewer")).status, 403);
  const result = await request("POST", `/${ASSET}/asr`, payload);
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "pending");
  assert.equal((await request("POST", `/${ASSET}/asr`, payload)).body.jobId, result.body.jobId);
  assert.equal(fake.tables.media_derivative_jobs.length, 1);
  assert.equal(fake.tables.media_caption_asr_consents[0].job_id, result.body.jobId);
  assert.equal(fake.tables.media_caption_asr_consents[0].caption_revision_key, EMPTY_CAPTION_REVISION);
  assert.equal(fake.tables.media_derivative_jobs[0].model_version, "fixture-model-1");
  assert.equal(objects.size, 0);
});

test("ASR revoke works with flags OFF, cancels lease and erases only revoked drafts, preserving published captions", async () => {
  enableLocalAsr();
  await save();
  const publishedPath = currentPath();
  await request("POST", `/${ASSET}/asr`, await freshAsrPayload("en"));
  const grant = fake.tables.media_caption_asr_consents[0];
  const path = captionDraftPath(ASSET, 1, "a".repeat(64), grant.id);
  objects.set(path, "synthetic review draft");
  fake.tables.media_derivative_jobs[0].state = "processing";
  fake.tables.media_derivative_jobs[0].lease_token = "lease";
  fake.tables.feature_flags.forEach((flag) => { flag.enabled = false; });
  const result = await request("DELETE", `/${ASSET}/asr`);
  assert.equal(result.status, 200);
  assert.equal(result.body.revoked, true);
  assert.equal(result.body.cleanupPending, false);
  assert.equal(fake.tables.media_derivative_jobs[0].state, "cancelled");
  assert.equal(fake.tables.media_derivative_jobs[0].lease_token, null);
  assert.notEqual(grant.revoked_at, null);
  assert.equal(objects.has(path), false);
  assert.equal(objects.has(publishedPath), true);
  assert.equal((await request("GET", `/${ASSET}/asr`)).body.enabled, false);
});

test("ASR re-consent cannot resurrect an old draft when prior physical erasure failed", async () => {
  enableLocalAsr();
  await request("POST", `/${ASSET}/asr`, await freshAsrPayload());
  const oldGrant = fake.tables.media_caption_asr_consents[0];
  const path = captionDraftPath(ASSET, 1, "a".repeat(64), oldGrant.id);
  objects.set(path, "unservable old draft");
  removeFails = true;
  assert.equal((await request("DELETE", `/${ASSET}/asr`)).body.cleanupPending, true);
  const next = await request("POST", `/${ASSET}/asr`, await freshAsrPayload());
  assert.notEqual(next.body.jobId, oldGrant.job_id);
  assert.equal((await request("GET", `/${ASSET}/draft?version=1`)).body, null);
  assert.equal(objects.has(path), true);
});

test("after-upload lookup requires a prior durable exact-generation opt-in and never fabricates consent", async () => {
  enableLocalAsr();
  assert.equal(await findPreviouslyConsentedCaptionJob(fake.client, ASSET, 1, EMPTY_CAPTION_REVISION), null);
  const queued = await request("POST", `/${ASSET}/asr`, await freshAsrPayload());
  assert.equal(await findPreviouslyConsentedCaptionJob(fake.client, ASSET, 1, EMPTY_CAPTION_REVISION), queued.body.jobId);
  assert.equal(await findPreviouslyConsentedCaptionJob(fake.client, ASSET, 2, EMPTY_CAPTION_REVISION), null);
  assert.equal(await findPreviouslyConsentedCaptionJob(fake.client, ASSET, 1, "f".repeat(64)), null);
  await request("DELETE", `/${ASSET}/asr`);
  assert.equal(await findPreviouslyConsentedCaptionJob(fake.client, ASSET, 1, EMPTY_CAPTION_REVISION), null);
  assert.equal(fake.tables.media_derivative_jobs.length, 1);
});

test("revocation during reviewed draft publication wins the atomic manifest guard", async () => {
  enableLocalAsr();
  await request("POST", `/${ASSET}/asr`, await freshAsrPayload("en"));
  const grant = fake.tables.media_caption_asr_consents[0];
  const draftId = "a".repeat(64);
  const path = captionDraftPath(ASSET, 1, draftId, grant.id);
  objects.set(path, JSON.stringify({ source: { ...fake.tables.media_assets[0] }, draftId, consentId: grant.id, jobId: grant.job_id, revisionKey: EMPTY_CAPTION_REVISION, vtt: VTT, language: "en", sourceKind: "asr", aiLabel: "AI transcription · needs creator review", modelVersion: grant.model_version, configVersion: grant.config_version }));
  Object.assign(fake.tables.media_derivative_jobs[0], { state: "completed", result: { draftId, artifactKey: path } });
  afterUpload = async () => { afterUpload = undefined; assert.equal((await request("DELETE", `/${ASSET}/asr`)).status, 200); };
  const result = await request("POST", `/${ASSET}/draft/publish`, { version: 1, draftId, consent: true, vtt: VTT });
  assert.equal(result.status, 409);
  assert.equal(fake.tables.media_caption_manifests.length, 0);
  assert.equal(objects.size, 0);
});

test("ASR stale consent replay conflicts without new jobs; fresh status requires deliberate re-consent", async () => {
  enableLocalAsr();
  const captured = await freshAsrPayload("en");
  const first = await request("POST", `/${ASSET}/asr`, captured);
  assert.equal(first.status, 200);
  assert.equal((await request("POST", `/${ASSET}/asr`, captured)).body.jobId, first.body.jobId);
  assert.equal((await request("DELETE", `/${ASSET}/asr`)).body.revoked, true);
  assert.equal((await request("POST", `/${ASSET}/asr`, captured)).status, 409);
  assert.equal(fake.tables.media_caption_asr_consents.filter((grant) => grant.revoked_at === null).length, 0);
  assert.equal(fake.tables.media_derivative_jobs.length, 1);
  assert.equal(fake.tables.media_derivative_jobs[0].state, "cancelled");
  const refreshed = await freshAsrPayload("en");
  assert.notEqual(refreshed.expectedConsentEpoch, captured.expectedConsentEpoch);
  const second = await request("POST", `/${ASSET}/asr`, refreshed);
  assert.equal(second.status, 200);
  assert.notEqual(second.body.jobId, first.body.jobId);
  assert.equal(fake.tables.media_derivative_jobs.length, 2);
  assert.equal(fake.tables.media_caption_asr_consents.filter((grant) => grant.revoked_at === null).length, 1);
  assert.equal(fake.tables.media_caption_asr_consents[1].consent_epoch, refreshed.expectedConsentEpoch);
});

test("ASR status fails closed on epoch RPC errors and requests reject missing or malformed epochs", async () => {
  enableLocalAsr();
  for (const expectedConsentEpoch of [undefined, null, 1, "", "bad", "a".repeat(65)]) {
    assert.equal((await request("POST", `/${ASSET}/asr`, { version: 1, consent: true, expectedConsentEpoch })).status, 400);
  }
  const savedRpc = fake.client.rpc;
  fake.client.rpc = async (name: string, args: any) => name === "media_caption_asr_epoch" ? { data: null, error: { message: "offline fixture unavailable" } } : savedRpc(name, args);
  assert.equal((await request("GET", `/${ASSET}/asr`)).status, 503);
  assert.equal(fake.tables.media_derivative_jobs.length, 0);
  assert.equal(fake.tables.media_caption_asr_consents.length, 0);
});
