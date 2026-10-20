import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const { PGlite } = await import(pathToFileURL(process.env.MEDIA_VISION_PGLITE_MODULE).href);
const queueSql = await readFile(process.env.MEDIA_QUEUE_MIGRATION ?? new URL("../../artifacts/api-server/src/migrations/3980_media_derivative_jobs.sql", import.meta.url), "utf8");
const artifactSql = await readFile(new URL("../../artifacts/api-server/src/migrations/3981_media_image_understanding_artifacts.sql", import.meta.url), "utf8");
const ownerId = "11111111-1111-4111-8111-111111111111";
const postId = "22222222-2222-4222-8222-222222222222";
const postMediaId = "33333333-3333-4333-8333-333333333333";
const assetId = "44444444-4444-4444-8444-444444444444";
const source = { ownerId, postId, postMediaId, assetId, sourceVersion: 7, bucket: "post-media", path: `${ownerId}/${postId}/photo.png`, mediaType: "image", framePath: null };
const revision = "7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed";
const model = `google/siglip-base-patch16-224@${revision}/travel-scene-v1`;
const key = `vision:${assetId}:7:${revision}:travel-scene-v1:synthetic-policy-v1:${postMediaId}`;
const request = { kind: "image_understanding", key, source, modelId: "google/siglip-base-patch16-224", modelRevision: revision, taxonomyVersion: "travel-scene-v1", consentVersion: "synthetic-policy-v1" };
const travelCandidates = [{ tag: "beach", category: "scene", confidence: 0.7, basis: "visual_inference", verified: false, eligibleAsObservation: false }];
const result = () => ({ source, consentVersion: request.consentVersion, recognition: { modelId: request.modelId, modelRevision: revision, taxonomyVersion: request.taxonomyVersion, crowdLevel: "busy", confidence: 0.8, confidenceKind: "uncalibrated_similarity", inferenceMs: 10, travelCandidates }, candidates: [{ mediaId: postId, kind: "crowd_level", value: "busy", confidence: 0.8, provider: "self_hosted_siglip", basis: "visual_inference", verified: false, eligibleAsObservation: false }], pixelScope: "image", processedAt: new Date().toISOString(), pixelSha256: "a".repeat(64), metrics: { inputBytes: 100, normalizedBytes: 100, elapsedMs: 10, estimatedExternalCostUsd: 0 } });

test("offline PostgreSQL vision artifacts and the real shared queue SQL", async context => {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
    CREATE TABLE profiles(id uuid PRIMARY KEY, account_status text);
    CREATE TABLE user_account_states(user_id uuid REFERENCES profiles(id), state text, expires_at timestamptz);
    CREATE TABLE posts(id uuid PRIMARY KEY, author_id uuid REFERENCES profiles(id), status text, post_status text, deleted_at timestamptz, visibility text, trip_id uuid, like_count integer DEFAULT 0);
    CREATE TABLE post_media(id uuid PRIMARY KEY, post_id uuid REFERENCES posts(id) ON DELETE CASCADE, user_id uuid, storage_bucket text, storage_path text, media_type text, processing_status text, moderation_status text, sort_order integer);
    CREATE TABLE media_assets(id uuid PRIMARY KEY, version integer, owner_user_id uuid REFERENCES profiles(id), storage_bucket text, storage_path text, size_bytes bigint, media_type text, mime_type text, thumbnail_path text, processing_status text, moderation_status text, deleted_at timestamptz, purge_status text);
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT SELECT, UPDATE ON posts TO authenticated;
    INSERT INTO feature_flags VALUES ('media_vision_provider_enabled', true, ''), ('media_derivative_jobs_enabled', true, '');
  `);
  try { await db.exec(queueSql); } catch (error) { throw new Error(`queue SQL: ${error.message} at ${error.position}`); }
  try { await db.exec(artifactSql); } catch (error) { throw new Error(`artifact SQL: ${error.message} at ${error.position}`); }
  const scalar = async (sql, parameters = []) => (await db.query(sql, parameters)).rows[0]?.value;
  const reset = async () => {
    await db.exec("RESET ROLE; TRUNCATE profiles, posts, post_media, media_assets, user_account_states CASCADE;");
    await db.query("INSERT INTO profiles VALUES ($1,'active');", [ownerId]);
    await db.query("INSERT INTO posts(id,author_id,status,post_status,visibility) VALUES ($1,$2,'active','published','private')", [postId, ownerId]);
    await db.query("INSERT INTO post_media VALUES ($1,$2,$3,'post-media',$4,'image','ready','approved',0)", [postMediaId, postId, ownerId, source.path]);
    await db.query("INSERT INTO media_assets VALUES ($1,7,$2,'post-media',$3,100,'image','image/png',NULL,'ready','active',NULL,'not_requested')", [assetId, ownerId, source.path]);
    await db.exec("SET ROLE service_role");
  };
  const grant = () => scalar("SELECT media_image_understanding_grant($1,$2,$3) AS value", [source, ownerId, request.consentVersion]);
  const enqueue = (value = request) => scalar("SELECT media_image_understanding_enqueue($1) AS value", [value]);
  const claim = async () => (await db.query("SELECT * FROM media_derivative_claim('vision',$1,1,120)", [model])).rows[0];
  const publish = (job, value = result()) => scalar("SELECT media_image_understanding_publish($1,$2,$3) AS value", [job.id, job.lease_token, value]);
  const read = () => scalar("SELECT media_image_understanding_read($1) AS value", [key]);
  const finish = job => scalar("SELECT media_derivative_finish($1,$2,true,false,NULL,10,100,100,$3) AS value", [job.id, job.lease_token, { artifactKey: key, publicationToken: job.lease_token }]);
  const staged = async () => { await reset(); assert.equal(await grant(), true); const id = await enqueue(); const job = await claim(); assert.equal(job.id, id); assert.equal(await publish(job), true); return job; };
  try {
    await context.test("consent, persistent idempotency, exact queue revision and atomic visibility", async () => {
      await reset(); assert.equal(await enqueue(), null); assert.equal(await grant(), true);
      const id = await enqueue(); assert.ok(id); assert.equal(await enqueue(), id);
      assert.equal(await scalar("SELECT count(*)::integer AS value FROM media_derivative_jobs"), 1);
      const job = await claim(); assert.equal(job.revision_key, createHash("sha256").update(key).digest("hex"));
      assert.equal(await publish(job), true); assert.equal(await read(), null);
      assert.equal(await finish(job), true); assert.deepEqual(await read(), resultWithTime(await read()));
      assert.equal((await read()).candidates[0].verified, false);
      assert.equal(await publish(job), false);
    });
    await context.test("wrong generation, attachment, owner, state and model refuse enqueue", async () => {
      for (const patch of [{ source: { ...source, sourceVersion: 8 } }, { source: { ...source, postId: assetId } }, { source: { ...source, ownerId: assetId } }, { modelRevision: "wrong" }, { source: { ...source, path: `${ownerId}/../photo.png` } }]) {
        await reset(); assert.equal(await grant(), true); assert.equal(await enqueue({ ...request, ...patch }), null);
        assert.equal(await scalar("SELECT count(*)::integer AS value FROM media_derivative_jobs"), 0);
      }
    });
    await context.test("publication rejects expired/replaced leases and factual promotion", async () => {
      const job = await staged();
      assert.equal(await publish({ ...job, lease_token: assetId }), false);
      const invalid = result(); invalid.candidates[0].verified = true;
      assert.equal(await publish(job, invalid), false);
      for (const candidate of [{ ...travelCandidates[0], tag: "Paris" }, { ...travelCandidates[0], verified: true }, { ...travelCandidates[0], confidence: 2 }, { ...travelCandidates[0], category: "object" }]) {
        const wrong = result(); wrong.recognition.travelCandidates = [candidate]; assert.equal(await publish(job, wrong), false);
      }
      const duplicates = result(); duplicates.recognition.travelCandidates = [...travelCandidates, ...travelCandidates]; assert.equal(await publish(job, duplicates), false);
      const missing = result(); delete missing.recognition.crowdLevel; missing.recognition.city = "Paris"; assert.equal(await publish(job, missing), false);
      await db.query("UPDATE media_derivative_jobs SET lease_until=now()-interval '1 second' WHERE id=$1", [job.id]);
      assert.equal(await publish(job), false); assert.equal(await finish(job), false); assert.equal(await read(), null);
    });
    await context.test("old lease discard cannot erase a newer attempt; failure clears staged pixels metadata", async () => {
      const job = await staged();
      await db.query("UPDATE media_derivative_jobs SET lease_token=$1 WHERE id=$2", [assetId, job.id]);
      const replacement = { ...job, lease_token: assetId };
      assert.equal(await publish(replacement), true);
      await db.query("SELECT media_image_understanding_discard($1,$2)", [job.id, job.lease_token]);
      assert.equal(await finish(replacement), true); assert.ok(await read());
      await db.query("SELECT media_image_understanding_discard($1,$2)", [job.id, replacement.lease_token]);
      assert.ok(await read(), "ambiguous finish cleanup must retain the already-committed artifact");
      await db.query("UPDATE media_derivative_jobs SET state='failed' WHERE id=$1", [job.id]);
      assert.equal(await read(), null);
      assert.equal(await scalar("SELECT result AS value FROM media_image_understanding_artifacts WHERE job_id=$1", [job.id]), null);
    });
    await context.test("revocation erases, cancels, cannot be undone for this policy/generation", async () => {
      const job = await staged(); await finish(job);
      await db.query("SELECT media_image_understanding_revoke($1,$2)", [postMediaId, assetId]); assert.ok(await read());
      await db.query("SELECT media_image_understanding_revoke($1,$2)", [postMediaId, ownerId]);
      assert.equal(await read(), null); assert.equal(await grant(), false);
      assert.equal(await scalar("SELECT count(*)::integer AS value FROM media_image_understanding_artifacts"), 0);
      assert.equal(await scalar("SELECT state AS value FROM media_derivative_jobs WHERE id=$1", [job.id]), "cancelled");
      await assert.rejects(db.exec("UPDATE media_image_understanding_consents SET revoked_at=NULL"), /vision_consent_immutable/);
    });
    await context.test("source, attachment, post and owner revocation erase and deny stale publication", async () => {
      for (const sql of ["UPDATE media_assets SET version=8", "UPDATE media_assets SET moderation_status='limited'", "UPDATE media_assets SET deleted_at=now()", "UPDATE post_media SET moderation_status='rejected'", "UPDATE posts SET deleted_at=now()", "UPDATE posts SET visibility='only_me'", "UPDATE profiles SET account_status='pending_deletion'", `INSERT INTO user_account_states VALUES ('${ownerId}','banned',NULL)`]) {
        const job = await staged(); assert.equal(await finish(job), true); await db.exec(sql);
        assert.equal(await read(), null, sql); assert.equal(await publish(job), false, sql);
        assert.equal(await scalar("SELECT count(*)::integer AS value FROM media_image_understanding_artifacts"), 0, sql);
      }
    });
    await context.test("hard deletion cascades, ordinary client post edits remain usable, client artifacts remain denied", async () => {
      let job = await staged(); await finish(job);
      await db.exec("SET ROLE authenticated; UPDATE posts SET like_count=1; RESET ROLE; SET ROLE service_role;");
      assert.ok(await read());
      await db.exec("SET ROLE authenticated; UPDATE posts SET visibility='only_me'; RESET ROLE; SET ROLE service_role;");
      assert.equal(await read(), null);
      for (const table of ["media_assets", "post_media", "posts"]) {
        job = await staged(); await finish(job); await db.exec(`DELETE FROM ${table}`);
        assert.equal(await read(), null); assert.equal(await scalar("SELECT count(*)::integer AS value FROM media_image_understanding_artifacts"), 0);
      }
      await db.exec("SET ROLE authenticated");
      await assert.rejects(read(), /permission denied/);
      await assert.rejects(db.exec("SELECT * FROM media_image_understanding_artifacts"), /permission denied/);
      await assert.rejects(grant(), /permission denied/);
    });
  } finally { await db.close(); }
});

function resultWithTime(actual) {
  return { ...result(), processedAt: actual.processedAt };
}
