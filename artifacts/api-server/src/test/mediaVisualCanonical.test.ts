import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalVisualSource, createCanonicalVisualAccess, readVisualConsent } from "../lib/media/visualIndex/canonicalVisualSource.js";

const assetId = "10000000-0000-4000-8000-000000000001";
const ownerId = "30000000-0000-4000-8000-000000000001";
const postId = "20000000-0000-4000-8000-000000000001";
const sourceRow = { id: assetId, version: 4, owner_user_id: ownerId, media_type: "image", storage_bucket: "post-media", storage_path: `${ownerId}/image.png`,
  public_url: "https://synthetic.invalid/image.png", visibility: "public", size_bytes: 50, processing_status: "ready", moderation_status: "active", deleted_at: null, purge_status: "not_requested" };

function client(tables: Record<string, any[]>, failing = "") {
  return { from(table: string) {
    const filters: Array<[string, unknown]> = [];
    let cap = Infinity;
    const answer = () => failing === table ? { data: null, error: { code: "42501" } } : {
      data: (tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value)).slice(0, cap), error: null,
    };
    return {
      select() { return this; }, eq(column: string, value: unknown) { filters.push([column, value]); return this; }, limit(limit: number) { cap = limit; return this; },
      async maybeSingle() { const result = answer(); return result.error || (result.data?.length ?? 0) > 1 ? { data: null, error: result.error ?? { code: "PGRST116" } } : { data: result.data?.[0] ?? null, error: null }; },
      then(resolve: any, reject: any) { return Promise.resolve(answer()).then(resolve, reject); },
    };
  } } as any;
}

test("canonical source requires exact generation, ready moderation and explicit undeleted state", () => {
  assert.equal(canonicalVisualSource(sourceRow)?.sourceVersion, 4);
  for (const patch of [{ version: null }, { version: 0 }, { deleted_at: undefined }, { deleted_at: "2026-01-01" }, { purge_status: "failed" },
    { moderation_status: "limited" }, { moderation_status: "owner_deleted" }, { processing_status: "processing" }, { visibility: "unknown" },
    { size_bytes: 9 * 1024 * 1024 }, { storage_bucket: "private-chat" }, { media_type: "video" }]) {
    assert.equal(canonicalVisualSource({ ...sourceRow, ...patch }), null, JSON.stringify(patch));
  }
});

test("canonical lookup distinguishes a missing asset from unreadable or duplicate attribution", async () => {
  assert.equal(await createCanonicalVisualAccess(client({ media_assets: [] })).read(assetId), null);
  await assert.rejects(createCanonicalVisualAccess(client({}, "media_assets")).read(assetId));
  await assert.rejects(createCanonicalVisualAccess(client({ media_assets: [sourceRow, sourceRow] })).read(assetId));
  assert.equal((await createCanonicalVisualAccess(client({ media_assets: [sourceRow] })).read(assetId))?.assetId, assetId);
});

test("post mapping uses canonical attachments or exact storage path plus public URL, never guessed post IDs", async () => {
  const source = canonicalVisualSource(sourceRow)!;
  const tables = {
    media_attachments: [{ media_asset_id: assetId, entity_type: "post", entity_id: postId }, { media_asset_id: assetId, entity_type: "memory", entity_id: ownerId }],
    post_media: [{ post_id: ownerId, storage_path: source.path, public_url: "https://wrong.invalid/image.png", processing_status: "ready" }],
  };
  assert.deepEqual(await createCanonicalVisualAccess(client(tables)).postIds(source), [postId]);
  await assert.rejects(createCanonicalVisualAccess(client(tables, "media_attachments")).postIds(source));
  tables.media_attachments = Array.from({ length: 65 }, () => tables.media_attachments[0]!);
  await assert.rejects(createCanonicalVisualAccess(client(tables)).postIds(source));
});

test("consent is owner-and-generation-bound; unknown, failed and revoked grants deny", async () => {
  const source = canonicalVisualSource(sourceRow)!;
  const grant = { asset_id: assetId, source_version: 4, owner_id: ownerId, revision: postId, expires_at: "2027-01-01T00:00:00Z", revoked_at: null };
  assert.equal((await readVisualConsent(client({ media_visual_index_consents: [grant] }), source))?.revision, postId);
  for (const patch of [{ source_version: 3 }, { owner_id: postId }, { revoked_at: "2026-01-01" }, { revision: undefined }, { expires_at: "invalid" }]) {
    assert.equal(await readVisualConsent(client({ media_visual_index_consents: [{ ...grant, ...patch }] }), source), null);
  }
  assert.equal(await readVisualConsent(client({}, "media_visual_index_consents"), source), null);
  await assert.rejects(readVisualConsent(client({}, "media_visual_index_consents"), source, true), /read unavailable/);
});
