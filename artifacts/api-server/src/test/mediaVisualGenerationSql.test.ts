import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { VISUAL_MODEL_ID } from "../lib/media/visualIndex/contracts.js";
import { PostgresVisualIndex } from "../lib/media/visualIndex/postgresVisualIndex.js";

const root = process.env.PGLITE_ROOT;
const ownerId = "30000000-0000-4000-8000-000000000001";
const assetId = "10000000-0000-4000-8000-000000000001";
const postId = "20000000-0000-4000-8000-000000000001";
const attachmentId = "40000000-0000-4000-8000-000000000001";
const source = { assetId, ownerId, postId, postMediaId: attachmentId, sourceVersion: 1, bucket: "post-media", path: `${ownerId}/image.png`, mediaType: "image", framePath: null };
const revision = "7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed";
const model = `google/siglip-base-patch16-224@${revision}/travel-scene-v1`;
const key = `vision:${assetId}:1:${revision}:travel-scene-v1:fixture-v1:${attachmentId}`;
const request = { kind: "image_understanding", source, key, modelId: "google/siglip-base-patch16-224", modelRevision: revision, taxonomyVersion: "travel-scene-v1", consentVersion: "fixture-v1" };

test("3981/3982 atomic generation cleanup includes actual 3320 implicit version bumps", { skip: !root }, async suite => {
  const { PGlite } = await import(pathToFileURL(join(root!, "dist/index.js")).href);
  const { vector } = await import(pathToFileURL(join(root!, "dist/vector/index.js")).href);
  const database = new PGlite({ extensions: { vector } });
  const migration = (filename: string) => readFile(new URL(`../migrations/${filename}`, import.meta.url), "utf8");
  try {
    await database.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE feature_flags(flag text PRIMARY KEY,enabled boolean,description text);
      CREATE TABLE profiles(id uuid PRIMARY KEY,account_status text);
      CREATE TABLE user_account_states(user_id uuid REFERENCES profiles(id),state text,expires_at timestamptz);
      CREATE TABLE posts(id uuid PRIMARY KEY,author_id uuid REFERENCES profiles(id),status text,post_status text,deleted_at timestamptz,visibility text,trip_id uuid);
      CREATE TABLE post_media(id uuid PRIMARY KEY,post_id uuid REFERENCES posts(id),user_id uuid,storage_bucket text,storage_path text,public_url text,media_type text,processing_status text,moderation_status text,sort_order integer);
      CREATE TABLE media_assets(id uuid PRIMARY KEY,owner_user_id uuid REFERENCES profiles(id),version integer,storage_bucket text,storage_path text,public_url text,
        media_type text,mime_type text,thumbnail_path text,processing_status text,moderation_status text,deleted_at timestamptz,purge_status text,size_bytes bigint,visibility text);
      CREATE TABLE media_attachments(media_asset_id uuid,entity_type text,entity_id uuid);
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;
      INSERT INTO feature_flags VALUES('media_vision_provider_enabled',true,''),('media_derivative_jobs_enabled',true,'');
    `);
    const baseline = await migration("3320_media_canonical_contract_constraints.sql");
    const bumpFunction = baseline.match(/CREATE OR REPLACE FUNCTION public\.media_assets_bump_version\(\)[\s\S]*?\$fn\$;/)?.[0];
    const bumpTrigger = baseline.match(/CREATE TRIGGER media_assets_version_bump[\s\S]*?EXECUTE FUNCTION public\.media_assets_bump_version\(\);/)?.[0];
    assert.ok(bumpFunction); assert.ok(bumpTrigger);
    await database.exec(`${bumpFunction}\n${bumpTrigger}`);
    for (const filename of ["3980_media_derivative_jobs.sql", "3981_media_image_understanding_artifacts.sql", "3982_media_visual_index.sql"]) {
      let sql = await migration(filename);
      if (process.env.MEDIA_VISUAL_GENERATION_MUTATION === "3981" && filename.startsWith("3981")) {
        sql = sql.replace("media_image_understanding_asset_invalidation BEFORE UPDATE OR DELETE", "media_image_understanding_asset_invalidation BEFORE UPDATE OF version OR DELETE");
      }
      if (process.env.MEDIA_VISUAL_GENERATION_MUTATION === "3982" && filename.startsWith("3982")) {
        sql = sql.replace("media_visual_index_source_changed AFTER UPDATE ON", "media_visual_index_source_changed AFTER UPDATE OF version ON");
      }
      await database.exec(sql);
    }
    const scalar = async (sql: string, values: unknown[] = []) => (await database.query(sql, values)).rows[0]?.value;
    const store = new PostgresVisualIndex({
      rpc: async (_name: string, args: any) => ({ data: (await database.query("SELECT media_visual_index_seed($1,$2) value", [args.p_post_id, args.p_model_id])).rows.map((row: any) => row.value), error: null }),
      from(table: string) {
        assert.equal(table, "media_visual_index_current");
        let ids: string[] = [];
        return { select() { return this; }, in(_column: string, values: string[]) { ids = values; return this; },
          limit: async (limit: number) => ({ data: (await database.query("SELECT to_jsonb(current_row) value FROM media_visual_index_current current_row WHERE asset_id=ANY($1::uuid[]) LIMIT $2", [ids, limit])).rows.map((row: any) => row.value), error: null }) };
      },
    } as any);
    const seed = async () => {
      await database.exec("RESET ROLE; TRUNCATE profiles,posts,post_media,media_assets,user_account_states,media_attachments CASCADE;");
      await database.query("INSERT INTO profiles VALUES($1,'active')", [ownerId]);
      await database.query("INSERT INTO posts VALUES($1,$2,'active','published',NULL,'public',NULL)", [postId, ownerId]);
      await database.query("INSERT INTO post_media VALUES($1,$2,$3,'post-media',$4,'https://synthetic.invalid/image.png','image','ready','approved',0)", [attachmentId, postId, ownerId, source.path]);
      await database.query("INSERT INTO media_assets VALUES($1,$2,1,'post-media',$3,'https://synthetic.invalid/image.png','image','image/png',NULL,'ready','active',NULL,'not_requested',16,'public')", [assetId, ownerId, source.path]);
      await database.exec("SET ROLE service_role");
      assert.equal(await scalar("SELECT media_image_understanding_grant($1,$2,'fixture-v1') value", [source, ownerId]), true);
      await scalar("SELECT media_image_understanding_enqueue($1) value", [request]);
      const visionJob = (await database.query("SELECT * FROM media_derivative_claim('vision',$1,1,120)", [model])).rows[0];
      const result = { source, consentVersion: "fixture-v1", recognition: { modelId: request.modelId, modelRevision: revision, taxonomyVersion: "travel-scene-v1",
        confidence: 0, confidenceKind: "uncalibrated_similarity", inferenceMs: 1, crowdLevel: null, travelCandidates: [] }, candidates: [], pixelScope: "image",
        processedAt: new Date().toISOString(), pixelSha256: "a".repeat(64), metrics: { inputBytes: 16, normalizedBytes: 16, elapsedMs: 1, estimatedExternalCostUsd: 0 } };
      assert.equal(await scalar("SELECT media_image_understanding_publish($1,$2,$3) value", [visionJob.id, visionJob.lease_token, result]), true);
      assert.equal(await scalar("SELECT media_derivative_finish($1,$2,true,false,NULL,1,16,16,$3) value", [visionJob.id, visionJob.lease_token, { artifactKey: key, publicationToken: visionJob.lease_token }]), true);
      const expires = new Date(Date.now() + 60_000).toISOString();
      const consent = await scalar("SELECT media_visual_index_consent($1,$2,1,true,$3) value", [assetId, ownerId, expires]);
      const revisionKey = await scalar("SELECT media_visual_index_revision_key($1,1,'post-media',$2,$3,$4) value", [assetId, source.path, VISUAL_MODEL_ID, consent]);
      await scalar("SELECT media_derivative_enqueue($1,$2,1,'embedding',$3,'',$4) value", [assetId, ownerId, VISUAL_MODEL_ID, revisionKey]);
      const indexJob = (await database.query("SELECT * FROM media_derivative_claim('embedding',$1,1,120)", [VISUAL_MODEL_ID])).rows[0];
      await database.query("SELECT media_visual_index_commit($1,1,'post-media',$2,$3,$4::extensions.vector,$5,$6,$7,$8,$9,$10)", [assetId, source.path, VISUAL_MODEL_ID,
        JSON.stringify(Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0)), "a".repeat(64), expires, consent, indexJob.id, indexJob.lease_token, revisionKey]);
      assert.equal(await scalar("SELECT media_derivative_finish($1,$2,true,false,NULL,1,16,2048,$3) value", [indexJob.id, indexJob.lease_token, { assetId, indexLeaseToken: indexJob.lease_token }]), true);
      assert.ok(await scalar("SELECT media_image_understanding_read($1) value", [key]));
      assert.equal(await scalar("SELECT count(*)::integer value FROM media_visual_index_current"), 1);
    };
    for (const update of ["visibility='private'", "public_url='https://synthetic.invalid/replaced.png'", "visibility=visibility"]) {
      await suite.test(update, async () => {
        await seed();
        const [entry] = await store.seed(postId, VISUAL_MODEL_ID);
        assert.ok(entry); assert.deepEqual(await store.current([entry]), [true]);
        await database.exec(`UPDATE media_assets SET ${update}`);
        assert.equal(await scalar("SELECT version value FROM media_assets"), 2);
        assert.deepEqual({
          vectors: await scalar("SELECT count(*)::integer value FROM media_visual_embeddings"),
          unrevokedConsents: await scalar("SELECT count(*)::integer value FROM media_image_understanding_consents WHERE revoked_at IS NULL"),
          artifactRows: await scalar("SELECT count(*)::integer value FROM media_image_understanding_artifacts"),
        }, { vectors: 0, unrevokedConsents: 0, artifactRows: 0 });
        assert.equal(await scalar("SELECT count(*)::integer value FROM media_derivative_jobs WHERE state='cancelled'"), 2);
        assert.equal(await scalar("SELECT media_image_understanding_read($1) value", [key]), null);
        assert.equal(await scalar("SELECT media_image_understanding_grant($1,$2,'fixture-v1') value", [source, ownerId]), false);
        assert.deepEqual(await store.current([entry]), [false]);
      });
    }
  } finally { await database.close(); }
});
