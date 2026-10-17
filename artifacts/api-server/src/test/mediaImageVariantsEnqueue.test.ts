import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { enqueueConfiguredImageVariants } from "../lib/media/imageVariants/bridge.js";
import { imageVariantsFixture } from "./helpers/imageVariantsFixture.js";
import { runMediaVendorIngest, MEDIA_MODERATION_STAGE_FLAG, type MediaVendorAdapters } from "../lib/media/vendors/mediaVendorStages.js";
import { REFUSING_MODERATION_CLASSIFIER } from "../lib/media/vendors/mediaModerationClassifier.js";
import { REFUSING_VISION_PROVIDER } from "../lib/media/vendors/mediaVisionProvider.js";
import { REFUSING_TRANSCODER } from "../lib/media/vendors/mediaTranscoder.js";
import { REFUSING_CAPTION_SOURCE } from "../lib/media/vendors/mediaCaptionSource.js";
import { resetCanonicalSchemaMemo } from "../lib/media/mediaSchemaCapability.js";

async function setup(context: TestContext) {
  const fixture = await imageVariantsFixture(); context.after(() => fixture.cleanup());
  const subject = { assetId: fixture.source.assetId, sourceVersion: 4, bucket: fixture.source.bucket, path: fixture.source.path, mediaType: "image" as const };
  const env = { MEDIA_IMAGE_VARIANTS_ENABLED: "1", MEDIA_IMAGE_VARIANTS_ROOT: fixture.config.root, SUPABASE_URL: fixture.config.storageOrigin };
  const calls: Record<string, unknown>[] = [];
  const jobId = randomUUID();
  const rpc = fixture.sc.rpc.bind(fixture.sc);
  fixture.sc.rpc = (name: string, args: Record<string, unknown>) => name !== "media_derivative_enqueue" ? rpc(name, args) : {
    abortSignal() { calls.push(args); return Promise.resolve({ data: jobId, error: null }); },
  };
  return { ...fixture, subject, env, calls, jobId };
}

test("ingest enqueue is OFF without even reading the client or constructing storage", async () => {
  const client = new Proxy({}, { get() { throw new Error("OFF touched client"); } });
  const subject = { assetId: randomUUID(), sourceVersion: 4, bucket: "post-media", path: "unused", mediaType: "image" as const };
  assert.equal(await enqueueConfiguredImageVariants(client, subject, {}), null);
  assert.equal(await enqueueConfiguredImageVariants(client, { ...subject, mediaType: "video" }, { MEDIA_IMAGE_VARIANTS_ENABLED: "1" }), null);
});

test("ingest derives owner and size only from the exact canonical row and queues without CPU or storage IO", async context => {
  const fixture = await setup(context);
  const forgedExtras = { ...fixture.subject, ownerUserId: fixture.viewerId, sizeBytes: 1 };
  assert.equal(await enqueueConfiguredImageVariants(fixture.sc, forgedExtras, fixture.env), fixture.jobId);
  assert.deepEqual(fixture.calls, [{ p_asset_id: fixture.source.assetId, p_owner_user_id: fixture.ownerId, p_source_version: 4,
    p_kind: "image_variants", p_model_version: "sharp-responsive-v1", p_target_language: "", p_revision_key: "" }]);
  assert.equal(fixture.signs.length, 0); assert.equal(fixture.fetches.length, 0);
});

test("ingest refuses stale or invalid generation, mismatched path/type, holds and unreadable canonical state", async context => {
  const fixture = await setup(context);
  for (const change of [{ assetId: null }, { sourceVersion: undefined }, { sourceVersion: 3 }, { sourceVersion: 2147483648 },
    { sourceVersion: 4.5 }, { bucket: "profile-media" }, { path: `${fixture.ownerId}/other.png` }]) {
    assert.equal(await enqueueConfiguredImageVariants(fixture.sc, { ...fixture.subject, ...change }, fixture.env), null);
  }
  const original = { ...fixture.asset };
  for (const change of [{ media_type: "video" }, { owner_user_id: fixture.viewerId }, { size_bytes: 0 },
    { moderation_status: "pending" }, { deleted_at: "2026-10-15T00:00:00Z" }, { version: 5 }]) {
    Object.assign(fixture.asset, original, change);
    assert.equal(await enqueueConfiguredImageVariants(fixture.sc, fixture.subject, fixture.env), null);
  }
  Object.assign(fixture.asset, original); fixture.failures.add("media_assets");
  await assert.rejects(enqueueConfiguredImageVariants(fixture.sc, fixture.subject, fixture.env));
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.signs.length, 0); assert.equal(fixture.fetches.length, 0);
});

test("canonical generation changing between lookup and enqueue is not rebased", async context => {
  const fixture = await setup(context);
  const from = fixture.sc.from.bind(fixture.sc);
  let reads = 0;
  fixture.sc.from = (table: string) => {
    const builder = from(table);
    if (table === "media_assets") {
      const single = builder.maybeSingle.bind(builder);
      builder.maybeSingle = async () => {
        const reply = await single(); if (++reads === 1) fixture.asset.version++;
        return reply;
      };
    }
    return builder;
  };
  assert.equal(await enqueueConfiguredImageVariants(fixture.sc, fixture.subject, fixture.env), null);
  assert.ok(reads >= 2); assert.equal(fixture.calls.length, 0); assert.equal(fixture.fetches.length, 0);
});

for (const outcome of ["approve", "hold", "queue_unavailable"] as const) {
  test(`shared ingest ${outcome}: exact moderation generation, original preserved, optional failure isolated`, async context => {
    const fixture = await setup(context);
    const previous = Object.fromEntries(Object.keys(fixture.env).map(key => [key, process.env[key]]));
    Object.assign(process.env, fixture.env);
    resetCanonicalSchemaMemo();
    context.after(() => {
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      resetCanonicalSchemaMemo();
    });
    fixture.tables.feature_flags.push({ flag: MEDIA_MODERATION_STAGE_FLAG, enabled: true });
    fixture.asset.moderation_status = "limited";
    const original = Buffer.from(fixture.bytes);
    const writes: Record<string, unknown>[] = [];
    const from = fixture.sc.from.bind(fixture.sc);
    interface CasBuilder {
      eq(column: string, value: unknown): CasBuilder;
      select(): Promise<{ data: Array<{ id: string; version: number }>; error: null }>;
    }
    fixture.sc.from = (table: string) => {
      const builder = from(table);
      if (table === "media_assets") builder.update = (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const update: CasBuilder = {
          eq(column, value) { filters.push([column, value]); return update; },
          async select() {
            if (!filters.every(([column, value]) => fixture.asset[column] === value)) return { data: [], error: null };
            writes.push(structuredClone(patch)); Object.assign(fixture.asset, patch);
            return { data: [{ id: fixture.source.assetId, version: Number(fixture.asset.version) }], error: null };
          },
        };
        return update;
      };
      return builder;
    };
    if (outcome === "queue_unavailable") {
      const rpc = fixture.sc.rpc.bind(fixture.sc);
      fixture.sc.rpc = (name: string, args: Record<string, unknown>) => name !== "media_derivative_enqueue" ? rpc(name, args) : {
        abortSignal() { fixture.calls.push(args); return Promise.resolve({ data: null, error: { code: "synthetic_queue_unavailable" } }); },
      };
    }
    const adapters: MediaVendorAdapters = {
      classifier: outcome === "hold" ? REFUSING_MODERATION_CLASSIFIER : {
        name: "synthetic-test-classifier", capabilities: { image: true, video: false, videoFrame: false },
        async classify() {
          assert.equal(fixture.asset.moderation_status, "limited"); assert.equal(fixture.asset.version, 5);
          return { ok: true, value: { verdict: "allow", labels: [], confidence: 0.99 } };
        },
      },
      vision: REFUSING_VISION_PROVIDER, transcoder: REFUSING_TRANSCODER, captions: REFUSING_CAPTION_SOURCE,
    };
    const report = await runMediaVendorIngest(fixture.sc, { ...fixture.subject, durationMs: null }, adapters);
    assert.equal(report.moderation.state, "ran");
    assert.ok(report.moderation.state === "ran");
    assert.equal(report.moderation.result.recorded, "applied");
    assert.ok(report.moderation.result.decision.stage === "on");
    assert.equal(report.moderation.result.decision.decision, outcome === "hold" ? "flag" : "approve");
    assert.equal(fixture.asset.moderation_status, outcome === "hold" ? "limited" : "active");
    assert.deepEqual(writes.map(write => write.version), outcome === "hold" ? [5] : [5, 6]);
    assert.equal(fixture.calls.length, outcome === "hold" ? 0 : 1);
    if (outcome !== "hold") assert.equal(fixture.calls[0].p_source_version, 6);
    assert.deepEqual(report.vision, { state: "off" }); assert.deepEqual(report.transcode, { state: "off" }); assert.deepEqual(report.captions, { state: "off" });
    assert.deepEqual(fixture.bytes, original); assert.equal(fixture.asset.storage_path, fixture.subject.path);
    assert.equal(fixture.asset.size_bytes, original.length); assert.equal(fixture.asset.owner_user_id, fixture.ownerId);
    assert.equal(fixture.subject.sourceVersion, 4); assert.equal(fixture.signs.length, 0); assert.equal(fixture.fetches.length, 0);
    for (const write of writes) assert.deepEqual(Object.keys(write).sort(), ["moderation_status", "updated_at", "version"]);
  });
}
