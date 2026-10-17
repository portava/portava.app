import test from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readDubbingPlaybackOptions } from "../lib/media/dubbing/options.js";

const ownerId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const postId = "33333333-3333-4333-8333-333333333333";
const artifactId = "44444444-4444-4444-8444-444444444444";
const captionRevision = "a".repeat(64);

function fixture(change?: "withdraw" | "replace" | "error") {
  let manifestReads = 0;
  let receiptReads = 0;
  const original = { id: artifactId, manifest: { assetId, sourceVersion: 1, language: "en-US", captionRevision,
    consentRevision: "b".repeat(64), revisionKey: "c".repeat(64) } };
  let readable = [original];
  const client = {
    from(table: string) {
      let single = false;
      const query = {
        select() { return query; }, eq() { return query; }, in() { return query; }, limit() { return query; }, order() { return query; },
        maybeSingle() { single = true; return query; },
        then(resolve: (value: unknown) => unknown) {
          let rows: unknown[] = [];
          let error: null | { message: string } = null;
          if (table === "media_assets") rows = [{ id: assetId, version: 1, owner_user_id: ownerId, storage_bucket: "post-media",
            storage_path: `${ownerId}/video.mp4`, media_type: "video", duration_ms: 2000, deleted_at: null,
            purge_status: "not_requested", processing_status: "ready", moderation_status: "approved" }];
          else if (table === "media_attachments") rows = [{ entity_type: "post", entity_id: postId }];
          else if (table === "post_media") rows = [{ post_id: postId, processing_status: "ready", moderation_status: "approved" }];
          else if (table === "posts") rows = [{ id: postId, author_id: ownerId, status: "active", post_status: "published" }];
          else if (table === "stories") rows = [];
          else if (table === "media_caption_manifests") {
            manifestReads++;
            rows = [{ asset_id: assetId, source_version: 1, revision_key: captionRevision, object_path: `manual-captions/${assetId}/v1-${captionRevision}.json` }];
            if (manifestReads === 2 && change === "withdraw") readable = [];
            if (manifestReads === 2 && change === "replace") readable = [{ ...original, manifest: { ...original.manifest, consentRevision: "d".repeat(64) } }];
          } else if (table === "media_dubbing_readable") {
            receiptReads++;
            rows = readable;
            if (receiptReads > 1 && change === "error") error = { message: "read unavailable" };
          } else throw new Error(`Unexpected table ${table}`);
          return Promise.resolve({ data: single ? rows[0] ?? null : structuredClone(rows), error }).then(resolve);
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
  return { client, receiptReads: () => receiptReads };
}

test("options revalidate the publication after final source/caption checks", async () => {
  const state = fixture();
  const result = await readDubbingPlaybackOptions(state.client, assetId, ownerId, true, {});
  assert.deepEqual(result.languages, [{ code: "en-US", label: "en-US", ready: true }]);
  assert.equal(state.receiptReads(), 2);
});

test("withdrawn or replaced receipts cannot remain ready through an in-flight options request", async () => {
  for (const change of ["withdraw", "replace"] as const) {
    const state = fixture(change);
    await assert.rejects(readDubbingPlaybackOptions(state.client, assetId, ownerId, true, {}),
      (error: unknown) => (error as { code?: string }).code === "source_revoked");
    assert.equal(state.receiptReads(), 2);
  }
});

test("an unavailable final receipt read cannot reuse an earlier ready descriptor", async () => {
  const state = fixture("error");
  await assert.rejects(readDubbingPlaybackOptions(state.client, assetId, ownerId, true, {}),
    (error: unknown) => (error as { code?: string }).code === "storage_unavailable");
});
