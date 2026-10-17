import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adaptiveConfig, createAdaptiveQueueBridge } from "../lib/media/adaptive/runtime.js";
import { AdaptiveArtifacts } from "../lib/media/adaptive/artifacts.js";
import { purgeDerivedMedia, type DerivativeErasureSource } from "../services/media/DerivedMediaLifecycleService.js";
import { composeSelfHostedVision } from "../lib/media/vendors/selfHostedVision.js";
import { REFUSING_VISION_PROVIDER, type MediaVisionProvider } from "../lib/media/vendors/mediaVisionProvider.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const source: DerivativeErasureSource = { id: assetId, version: 4, storage_bucket: "post-media", storage_path: `${ownerId}/video.mp4`,
  media_type: "video", deleted_at: new Date().toISOString(), moderation_status: "owner_deleted", purge_status: "pending" };

test("self-hosted composition preserves viewer authorization and both independent ingest paths", async () => {
  const ingested: string[] = [];
  const viewed: string[] = [];
  const understanding: MediaVisionProvider = { ...REFUSING_VISION_PROVIDER, name: "understanding",
    capabilities: { sceneSignals: true, similarMedia: false, ingest: true },
    async sceneSignals(input) { viewed.push(input.viewerId ?? "missing"); return { ok: true, value: [] }; },
    async ingest() { ingested.push("understanding"); throw new Error("unavailable model"); },
  };
  const index: MediaVisionProvider = { ...REFUSING_VISION_PROVIDER, name: "index",
    capabilities: { sceneSignals: false, similarMedia: true, ingest: true },
    async similarMedia(input) { viewed.push(input.viewerId ?? "missing"); return { ok: true, value: [] }; },
    async ingest() { ingested.push("index"); return { ok: true, value: { accepted: true } }; },
  };
  const provider = composeSelfHostedVision(understanding, index);
  await provider.sceneSignals({ viewerId: ownerId, items: [] });
  await provider.similarMedia({ viewerId: ownerId, seed: { mediaId: assetId, storageKey: null }, limit: 2 });
  assert.deepEqual(await provider.ingest({ assetId, sourceVersion: 4, mediaType: "image", bucket: "post-media", path: source.storage_path, framePath: null }), { ok: true, value: { accepted: true } });
  assert.deepEqual(ingested, ["understanding", "index"]);
  assert.deepEqual(viewed, [ownerId, ownerId]);
  assert.equal((await composeSelfHostedVision(REFUSING_VISION_PROVIDER, REFUSING_VISION_PROVIDER).ingest({ assetId, mediaType: "image", bucket: "post-media", path: source.storage_path, framePath: null })).ok, false);
});

function fixture() {
  const calls: { operation: string; args: Record<string, unknown> }[] = [];
  const tables = new Set<string>();
  let tableError: string | null = null;
  let schemaError: string | null = null;
  let cancelAccepted = true;
  let adaptiveJobs = true;
  const client = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters[key] = value; return query; },
        limit: async () => {
          calls.push({ operation: table, args: { ...filters } });
          return tableError ? { data: null, error: { code: tableError } }
            : tables.has(table) ? { data: table === "media_derivative_jobs" && !adaptiveJobs ? [] : [{ asset_id: assetId }], error: null } : { data: null, error: { code: "42P01" } };
        },
        maybeSingle: async () => tableError ? { data: null, error: { code: tableError } }
          : { data: table === "feature_flags" ? (tables.size ? { flag: "media_derivative_jobs_enabled" } : null) : { owner_user_id: ownerId }, error: null },
      };
      return query;
    },
    async rpc(operation: string, args: Record<string, unknown> = {}) {
      calls.push({ operation, args });
      if (operation === "media_derivative_schema_status") return schemaError ? { data: null, error: { code: schemaError } }
        : { data: Object.fromEntries(["media_derivative_jobs", "media_caption_manifests", "media_visual_embeddings", "media_image_understanding_artifacts", "media_dubbing_artifacts"].map(table => [table, tables.has(table)])), error: null };
      return { data: operation === "media_derivative_cancel_asset" ? cancelAccepted
        : operation === "media_visual_index_erase" ? { erased: true, remaining: 0 } : null, error: null };
    },
  };
  return { sc: client as unknown as SupabaseClient, calls, tables,
    failRead: (code: string) => { tableError = code; }, failSchema: (code: string) => { schemaError = code; }, refuseCancel: () => { cancelAccepted = false; },
    withoutAdaptiveJobs: () => { adaptiveJobs = false; } };
}

test("adaptive runtime requires explicit activation and trusted absolute media tools", () => {
  const env = { MEDIA_ADAPTIVE_ENABLED: "true", MEDIA_ADAPTIVE_ROOT: "/private/adaptive", MEDIA_ADAPTIVE_API_BASE_URL: "https://api.example.test/api",
    SUPABASE_URL: "https://storage.example.test", MEDIA_FFMPEG_BINARY: "/usr/local/bin/ffmpeg", MEDIA_FFPROBE_BINARY: "/usr/local/bin/ffprobe" };
  assert.ok(adaptiveConfig(env));
  assert.equal(adaptiveConfig({ ...env, MEDIA_ADAPTIVE_ENABLED: "false" }), null);
  assert.equal(adaptiveConfig({ ...env, MEDIA_FFMPEG_BINARY: "ffmpeg" }), null);
  assert.equal(adaptiveConfig({ ...env, MEDIA_FFPROBE_BINARY: undefined }), null);
  assert.equal(adaptiveConfig({ ...env, MEDIA_ADAPTIVE_API_BASE_URL: "http://api.example.test" }), null);
  assert.equal(adaptiveConfig({ ...env, SUPABASE_URL: "https://user:secret@storage.example.test" }), null);
});

test("queue bridge never treats an absent ready receipt or refused cancellation as success", async () => {
  const state = fixture();
  assert.equal(await createAdaptiveQueueBridge(state.sc).ready(assetId, 4), null);
  state.refuseCancel();
  await assert.rejects(createAdaptiveQueueBridge(state.sc).cancelAsset(assetId));
});

test("erasure refuses a still-visible original without touching queues or files", async () => {
  const state = fixture();
  await assert.rejects(purgeDerivedMedia(state.sc, { ...source, deleted_at: null, moderation_status: "active", purge_status: "not_requested" }, {}));
  assert.deepEqual(state.calls, []);
});

test("unapplied derivative schema preserves existing original deletion", async () => {
  const state = fixture();
  await purgeDerivedMedia(state.sc, source, {});
  assert.equal(state.calls.some(call => call.operation.startsWith("media_derivative_cancel")), false);
});

test("authorization and transport errors cannot masquerade as an unapplied schema", async () => {
  for (const code of ["42501", "PGRST301", "08006"]) {
    const state = fixture();
    state.failRead(code);
    await assert.rejects(purgeDerivedMedia(state.sc, source, {}), /unavailable/);
  }
});

test("a stale schema cache or missing schema RPC cannot authorize erasure completion", async () => {
  for (const code of ["PGRST205", "PGRST202", "42P01", "42501"]) {
    const state = fixture();
    state.tables.add("media_derivative_jobs");
    state.failSchema(code);
    await assert.rejects(purgeDerivedMedia(state.sc, source, {}), /unavailable/);
    assert.equal(state.calls.some(call => call.operation === "media_derivative_cancel_asset"), false);
  }
});

test("retained adaptive jobs block purge completion when their volume is unavailable", async () => {
  const state = fixture();
  state.tables.add("media_derivative_jobs");
  await assert.rejects(purgeDerivedMedia(state.sc, source, {}), /original private artifact volume/);
  assert.equal(state.calls.filter(call => call.operation === "media_derivative_cancel_asset").length, 1);
});

test("erasure cancels work before removing only the owned generation even when processing is off", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-purge-integration-"));
  const state = fixture();
  state.tables.add("media_derivative_jobs");
  try {
    await new AdaptiveArtifacts(root).workspace({ assetId, sourceVersion: 3, bucket: "post-media", path: source.storage_path, sizeBytes: 1 });
    const owned = join(root, "outputs", `${assetId}-3-lease`);
    const unrelated = join(root, "outputs", `${ownerId}-2-lease`);
    await mkdir(owned);
    await mkdir(unrelated);
    await writeFile(join(owned, "master.m3u8"), "private");
    await writeFile(join(unrelated, "master.m3u8"), "keep");
    await purgeDerivedMedia(state.sc, source, { MEDIA_ADAPTIVE_ROOT: root, MEDIA_ADAPTIVE_ENABLED: "false" });
    await assert.rejects(readFile(join(owned, "master.m3u8")));
    assert.equal(await readFile(join(unrelated, "master.m3u8"), "utf8"), "keep");
    assert.equal(state.calls.find(call => call.operation === "media_derivative_cancel_asset")?.args.p_asset_id, assetId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("embedding erasure runs without its activation flag and binds the canonical identity", async () => {
  const state = fixture();
  state.tables.add("media_derivative_jobs");
  state.tables.add("media_visual_embeddings");
  state.withoutAdaptiveJobs();
  await purgeDerivedMedia(state.sc, { ...source, media_type: "image" }, {});
  assert.deepEqual(state.calls.find(call => call.operation === "media_visual_index_erase")?.args,
    { p_asset_id: assetId, p_source_version: 4, p_bucket: "post-media", p_path: source.storage_path });
});
