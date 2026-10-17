import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, unlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SupabaseClient } from "@supabase/supabase-js";
import { purgeDerivedMedia } from "../services/media/DerivedMediaLifecycleService.js";
import { withMediaCleanup } from "../services/media/MediaCleanupTransport.js";
import { translationArtifactFixture } from './helpers/translationArtifactFixture.js';

const assetId = "10000000-0000-4000-a000-000000000001";
const ownerId = "20000000-0000-4000-a000-000000000001";
const grantId = "30000000-0000-4000-a000-000000000001";
const draft = `translation-v4-${grantId}-${"a".repeat(64)}.json`;
const authored = `v4-${"b".repeat(64)}.json`;
type Row = Record<string, any>;

async function fixture(run: (input: { state: any; source: any; sc: SupabaseClient; directory: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "translation-lifecycle-"));
  const directory = join(root, "manual-captions", assetId);
  await mkdir(directory, { recursive: true });
  const source = { id: assetId, owner_user_id: ownerId, version: 4, storage_bucket: "post-media", storage_path: `${ownerId}/video.mp4`,
    media_type: "video", duration_ms: 2000, deleted_at: "2026-10-15T00:00:00Z", moderation_status: "owner_deleted", purge_status: "pending", processing_status: "ready" };
  const state = { marker: true, malformedMarker: false, failTable: "", failRpc: "", refuseRevoke: false, failList: false, failRemove: false,
    hangTable: "", calls: [] as string[], signals: [] as AbortSignal[], grants: [{ id: grantId, asset_id: assetId, revoked_at: null, cleanup_pending: false }] as Row[],
    afterPurge: () => {}, lists: 0, clearRetained: () => {} };
  const retained = translationArtifactFixture({ canRetire: () => state.grants.some(grant => grant.id === grantId && grant.revoked_at !== null && !grant.cleanup_pending) });
  state.clearRetained = () => { retained.rows.length = 0; };
  const reserved = await retained.rpc('media_caption_translation_artifact_reserve', {
    p_id: '40000000-0000-4000-a000-000000000001', p_token: '50000000-0000-4000-a000-000000000001',
    p_intent: { asset_id: assetId, owner_user_id: ownerId, source_version: 4, consent_id: grantId,
      job_id: '60000000-0000-4000-a000-000000000001', lease_token: '70000000-0000-4000-a000-000000000001', kind: 'draft',
      draft_id: 'a'.repeat(64), caption_revision: 'b'.repeat(64), output_revision: 'a'.repeat(64) },
  });
  assert.ok(reserved.data);
  await retained.rpc('media_caption_translation_artifact_dispatch', { p_id: retained.rows[0]!.id, p_token: retained.rows[0]!.write_token });
  await retained.rpc('media_caption_translation_artifact_settle', { p_id: retained.rows[0]!.id, p_token: retained.rows[0]!.write_token, p_state: 'uploaded' });
  const sc = {
    from(table: string) {
      if (table === 'media_caption_translation_artifacts') return retained.query();
      const filters: ((row: Row) => boolean)[] = [];
      let single = false;
      let maximum = 100;
      const query = {
        select() { return query; }, eq(key: string, value: unknown) { filters.push(row => row[key] === value); return query; },
        in(key: string, values: unknown[]) { filters.push(row => values.includes(row[key])); return query; },
        maybeSingle() { single = true; return query; }, limit(value: number) { maximum = value; return query; },
        abortSignal(signal: AbortSignal) { state.signals.push(signal); return query; },
        then(resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) {
          return (async () => {
            state.calls.push(table);
            if (state.hangTable === table) return new Promise(() => {});
            if (state.failTable === table) return { data: null, error: new Error("cache unavailable") };
            const rows: Row[] = (table === "feature_flags" ? [{ flag: "media_derivative_jobs_enabled", enabled: false },
              ...(state.marker ? [{ flag: "media_caption_translation_enabled", enabled: false }] : [])]
              : table === "media_assets" ? [source] : table === "media_caption_translation_consents" ? state.grants
              : table === "media_caption_translation_epochs" ? [{ asset_id: assetId, epoch: 1 }] : [])
              .filter(row => filters.every(filter => filter(row))).slice(0, maximum);
            if (table === "feature_flags" && rows[0]?.flag === "media_caption_translation_enabled" && state.malformedMarker) return { data: {}, error: null };
            return { data: single ? rows[0] ?? null : rows.map(row => ({ ...row })), error: null };
          })().then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      state.calls.push(name);
      if (state.failRpc === name) return { data: null, error: new Error("RPC unavailable") };
      if (name.startsWith('media_caption_translation_artifact_')) return retained.rpc(name, args);
      if (name === "media_derivative_schema_status") return { data: { media_derivative_jobs: true, media_caption_manifests: true,
        media_dubbing_artifacts: false, media_image_understanding_artifacts: false, media_visual_embeddings: false }, error: null };
      if (name === "media_caption_translation_revoke") {
        if (state.refuseRevoke) return { data: false, error: null };
        for (const grant of state.grants) grant.revoked_at = "2026-10-15T00:00:00Z";
      }
      return { data: true, error: null };
    },
    storage: { async getBucket() { return { data: { id: 'post-media', public: false }, error: null }; }, from(bucket: string) {
      assert.equal(bucket, "post-media");
      return {
        async list(prefix: string, options: { limit: number; offset: number }) {
          assert.equal(prefix, `manual-captions/${assetId}`);
          state.calls.push("list"); state.lists++;
          if (state.failList) return { data: null, error: new Error("list unavailable") };
          const data = (await readdir(directory)).sort().slice(options.offset, options.offset + options.limit).map(name => ({ name }));
          state.afterPurge();
          return { data, error: null };
        },
        async remove(paths: string[]) {
          if (state.failRemove) return { error: new Error("remove unavailable") };
          for (const path of paths) { state.calls.push(`remove:${path.split("/").at(-1)}`); await rm(join(root, path), { force: true }); }
          return { error: null };
        },
      };
    } },
  } as unknown as SupabaseClient;
  await writeFile(join(directory, authored), "synthetic authored captions");
  try { await run({ state, source, sc, directory }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("OFF translation revocation and grant-bound erasure precede generic caption purge", async () => fixture(async ({ state, source, sc, directory }) => {
  await writeFile(join(directory, draft), "synthetic translation draft");
  await purgeDerivedMedia(sc, source, {});
  assert.deepEqual(await readdir(directory), []);
  assert.ok(state.calls.indexOf("media_caption_translation_revoke") < state.calls.indexOf(`remove:${draft}`));
  assert.ok(state.calls.indexOf(`remove:${draft}`) < state.calls.indexOf("cas_media_caption_manifest"));
}));

test("unknown writer cleanup debt blocks completion even with no draft currently visible", async () => fixture(async ({ state, source, sc, directory }) => {
  state.grants[0].cleanup_pending = true;
  await assert.rejects(purgeDerivedMedia(sc, source, {}), /translation.*cleanup|Translation.*cleanup/);
  assert.equal(await readFile(join(directory, authored), "utf8"), "synthetic authored captions");
  assert.ok(!state.calls.includes("cas_media_caption_manifest"));
}));

test("late debt after draft purge is rechecked before generic erasure", async () => fixture(async ({ state, source, sc }) => {
  state.afterPurge = () => { state.grants[0].cleanup_pending = true; };
  await assert.rejects(purgeDerivedMedia(sc, source, {}));
  assert.ok(!state.calls.includes("cas_media_caption_manifest"));
}));

test("unrecognized or unowned translation files remain and never report successful cleanup", async () => fixture(async ({ state, source, sc, directory }) => {
  state.grants = [];
  state.clearRetained();
  await writeFile(join(directory, draft), "unowned draft");
  await writeFile(join(directory, "unknown.bin"), "unrecognized bytes");
  await assert.rejects(purgeDerivedMedia(sc, source, {}), /Unexpected caption artifact/);
  assert.equal(await readFile(join(directory, draft), "utf8"), "unowned draft");
  assert.equal(await readFile(join(directory, "unknown.bin"), "utf8"), "unrecognized bytes");
}));

test("marker absence alone skips unapplied translation, while malformed or unavailable state fails closed", async () => fixture(async ({ state, source, sc }) => {
  state.malformedMarker = true;
  await assert.rejects(purgeDerivedMedia(sc, source, {}));
  state.malformedMarker = false; state.failTable = "media_caption_translation_consents";
  await assert.rejects(purgeDerivedMedia(sc, source, {}));
  state.failTable = ""; state.marker = false;
  state.calls.length = 0;
  await purgeDerivedMedia(sc, source, {});
  assert.ok(!state.calls.includes("media_caption_translation_revoke"));
  assert.ok(state.calls.includes("cas_media_caption_manifest"));
}));

test("revocation refusal, RPC/cache loss, storage failures and missing owner stay retryable", async () => fixture(async ({ state, source, sc, directory }) => {
  await writeFile(join(directory, draft), "synthetic draft");
  for (const key of ["refuseRevoke", "failList", "failRemove"]) {
    state[key] = true; await assert.rejects(purgeDerivedMedia(sc, source, {})); state[key] = false;
  }
  state.failRpc = "media_caption_translation_revoke"; await assert.rejects(purgeDerivedMedia(sc, source, {})); state.failRpc = "";
  await assert.rejects(purgeDerivedMedia(sc, { ...source, owner_user_id: undefined }, {}));
  assert.ok(!state.calls.includes("cas_media_caption_manifest"));
  await purgeDerivedMedia(sc, source, {});
  assert.deepEqual(await readdir(directory), []);
}));

test("translation debt query cancellation reaches transport and cannot continue to caption purge", async () => fixture(async ({ state, source, sc }) => {
  state.hangTable = "media_caption_translation_consents";
  await assert.rejects(withMediaCleanup(sc, client => purgeDerivedMedia(client, source, {}), { operationTimeoutMs: 15, timeoutMs: 100 }));
  assert.ok(state.signals.some((signal: AbortSignal) => signal.aborted));
  assert.ok(!state.calls.includes("cas_media_caption_manifest"));
}));
