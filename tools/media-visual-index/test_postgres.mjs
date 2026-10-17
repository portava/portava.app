import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { test } from "node:test";
import { createHash } from "node:crypto";

const fixtureQueue = process.env.VISUAL_QUEUE_FIXTURE === "1";
if (!process.env.PGLITE_ROOT || (!fixtureQueue && !process.env.MEDIA_QUEUE_MIGRATION)) throw new Error("Provide existing PGLITE_ROOT and parent MEDIA_QUEUE_MIGRATION; no installation or live DB is used");
const parentQueueMigration = fixtureQueue ? null : await readFile(process.env.MEDIA_QUEUE_MIGRATION, "utf8");
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_ROOT, "dist/index.js")).href);
const { vector } = await import(pathToFileURL(join(process.env.PGLITE_ROOT, "dist/vector/index.js")).href);
const migrationPath = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/api-server/src/migrations/3982_media_visual_index.sql");
let migration = await readFile(migrationPath, "utf8");
if (process.env.VISUAL_SQL_MUTATION) {
  const guards = { lease: "job.lease_token IS DISTINCT FROM p_lease_token", generation: "source.version IS DISTINCT FROM p_source_version OR source.storage_bucket" };
  const target = guards[process.env.VISUAL_SQL_MUTATION];
  if (!target || migration.split(target).length !== 2) throw new Error("mutation guard not uniquely located");
  migration = migration.replace(target, process.env.VISUAL_SQL_MUTATION === "lease" ? "false" : "false OR source.storage_bucket");
}

const assetId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const ownerId = "30000000-0000-4000-8000-000000000001";
const postId = "20000000-0000-4000-8000-000000000001";
const otherPostId = "20000000-0000-4000-8000-000000000002";
const modelId = "openai/clip-vit-base-patch32@d44250afa9f05af7eca021052567539406661018:clip-rgb224-v1";
const embedding = (offset = 0) => JSON.stringify(Array.from({ length: 512 }, (_, position) => position === offset ? 1 : 0));
const directory = await mkdtemp(join(tmpdir(), "visual-pg-state-"));
let database;

test(`actual offline Postgres/pgvector state (${fixtureQueue ? "fixture queue, NOT parent integration" : "parent queue"})`, async (suite) => {
  if (parentQueueMigration) suite.diagnostic(`parent3980_sha256=${createHash("sha256").update(parentQueueMigration).digest("hex")}`);
  database = new PGlite(join(directory, "database"), { extensions: { vector } });
  try {
    await database.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid, version integer, storage_bucket text, storage_path text,
        public_url text, media_type text, processing_status text, moderation_status text, deleted_at timestamptz, purge_status text, size_bytes bigint);
      CREATE TABLE public.posts(id uuid PRIMARY KEY, author_id uuid);
      CREATE TABLE public.media_attachments(media_asset_id uuid, entity_type text, entity_id uuid);
      CREATE TABLE public.post_media(post_id uuid, storage_path text, public_url text, processing_status text);
      GRANT SELECT,UPDATE ON public.media_assets TO service_role;
      GRANT SELECT ON public.feature_flags,public.posts,public.media_attachments,public.post_media TO service_role;
      INSERT INTO public.feature_flags VALUES ('media_vision_provider_enabled',true,'fixture');
    `);
    try { await database.exec(fixtureQueue ? `
      CREATE TABLE public.media_derivative_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), asset_id uuid, owner_user_id uuid,
        source_version integer, source_bucket text, source_path text, source_bytes bigint, kind text, model_version text, revision_key text,
        state text, lease_token uuid, lease_until timestamptz, created_at timestamptz DEFAULT now(), result jsonb);
      GRANT SELECT,UPDATE ON public.media_derivative_jobs TO service_role;
      INSERT INTO public.feature_flags VALUES ('media_derivative_jobs_enabled',false,'fixture');
    ` : parentQueueMigration); }
    catch (error) { throw new Error(`parent queue migration: ${error.message} at ${error.position}`, { cause: error }); }
    try { await database.exec(migration); }
    catch (error) { throw new Error(`visual index migration: ${error.message} at ${error.position}`, { cause: error }); }
    suite.diagnostic(JSON.stringify((await database.query("SELECT current_setting('server_version') postgres, extversion pgvector FROM pg_extension WHERE extname='vector'")).rows[0]));
    await database.exec("UPDATE public.feature_flags SET enabled=true WHERE flag='media_derivative_jobs_enabled'");
    for (const [asset, post] of [[assetId, postId], [otherId, otherPostId]]) {
      await database.query("INSERT INTO public.media_assets VALUES ($1,$2,1,'post-media',$3,$4,'image','ready','active',NULL,'not_requested',16)", [asset, ownerId, `${ownerId}/${asset}.png`, `https://synthetic.invalid/${asset}.png`]);
      await database.query("INSERT INTO public.posts VALUES ($1,$2)", [post, ownerId]);
      await database.query("INSERT INTO public.media_attachments VALUES ($1,'post',$2)", [asset, post]);
    }
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const consent = async (asset, version = 1) => (await database.query("SELECT public.media_visual_index_consent($1,$2,$3,true,$4) revision", [asset, ownerId, version, expires])).rows[0].revision;
    const claim = async (asset, consentRevision, version = 1) => {
      const revisionKey = createHash("sha256").update(JSON.stringify([asset, version, "post-media", `${ownerId}/${asset}.png`, `${modelId}:${consentRevision}`])).digest("hex");
      if (fixtureQueue) return (await database.query(`INSERT INTO public.media_derivative_jobs(asset_id,owner_user_id,source_version,source_bucket,source_path,source_bytes,kind,model_version,revision_key,state,lease_token,lease_until)
        VALUES($1,$2,$3,'post-media',$4,16,'embedding',$5,$6,'processing',gen_random_uuid(),now()+interval '2 minutes') RETURNING *`,
      [asset, ownerId, version, `${ownerId}/${asset}.png`, modelId, revisionKey])).rows[0];
      await database.query("SELECT public.media_derivative_enqueue($1,$2,$3,'embedding',$4,'',$5)", [asset, ownerId, version, modelId, revisionKey]);
      return (await database.query("SELECT * FROM public.media_derivative_claim('embedding',$1,1,120)", [modelId])).rows[0];
    };
    const commit = (asset, revision, job, values = embedding(), version = 1, token = job.lease_token) => database.query(
      "SELECT public.media_visual_index_commit($1,$2,'post-media',$3,$4,$5::extensions.vector,$6,$7,$8,$9,$10,$11)",
      [asset, version, `${ownerId}/${asset}.png`, modelId, values, "b".repeat(64), expires, revision, job.id, token, job.revision_key]);
    const count = async () => Number((await database.query("SELECT count(*) total FROM public.media_visual_embeddings")).rows[0].total);
    const finish = (asset, job) => fixtureQueue
      ? database.query("UPDATE public.media_derivative_jobs SET state='completed',lease_token=NULL,lease_until=NULL,result=$2 WHERE id=$1", [job.id, JSON.stringify({ assetId: asset, indexLeaseToken: job.lease_token })])
      : database.query("SELECT public.media_derivative_finish($1,$2,true,false,NULL,0,16,2048,$3::jsonb)", [job.id, job.lease_token, JSON.stringify({ assetId: asset, indexLeaseToken: job.lease_token })]);
    const revision = await consent(assetId);
    const job = await claim(assetId, revision);
    const otherRevision = await consent(otherId);
    let otherJob = await claim(otherId, otherRevision);

    await suite.test("service-only tables, views and RPCs deny anon/authenticated", async () => {
      for (const role of ["anon", "authenticated"]) {
        await database.exec(`SET ROLE ${role}`);
        await assert.rejects(database.query("SELECT * FROM public.media_visual_embeddings"), /permission denied/);
        await assert.rejects(database.query("SELECT * FROM public.media_visual_index_current"), /permission denied/);
        await assert.rejects(database.query("SELECT * FROM public.media_visual_index_seed($1,$2)", [postId, modelId]), /permission denied/);
        await database.exec("RESET ROLE");
      }
    });
    await suite.test("wrong lease cannot write any row", async () => {
      await assert.rejects(commit(assetId, revision, job, embedding(), 1, ownerId), /visual_lease_lost/);
      assert.equal(await count(), 0);
    });
    await suite.test("commit is durable, cosine is real, and asset IDs map to post IDs", async () => {
      await database.exec("SET ROLE service_role");
      try {
        await commit(assetId, revision, job);
        await commit(otherId, otherRevision, otherJob, embedding(1));
        await database.query("SELECT public.media_visual_index_discard($1,$2,$3)", [assetId, job.id, ownerId]);
        assert.equal(await count(), 2, "an old/unrelated lease must not discard current artifacts");
        assert.equal((await database.query("SELECT * FROM public.media_visual_index_seed($1,$2)", [postId, modelId])).rows.length, 0);
        await finish(assetId, job);
        await finish(otherId, otherJob);
      } finally { await database.exec("RESET ROLE"); }
      assert.equal(await count(), 2);
      const seed = (await database.query("SELECT * FROM public.media_visual_index_seed($1,$2)", [postId, modelId])).rows;
      assert.equal(seed[0].media_visual_index_seed.asset_id, assetId);
      const neighbors = (await database.query("SELECT * FROM public.media_visual_index_match($1,$2::extensions.vector,5)", [modelId, embedding()])).rows.map((row) => row.media_visual_index_match);
      assert.equal(neighbors[0].asset_id, assetId);
      assert.equal(neighbors[0].score, 1);
      assert.equal(neighbors[1].score, 0.5);
      await database.close();
      database = new PGlite(join(directory, "database"), { extensions: { vector } });
      assert.equal(await count(), 2);
    });
    await suite.test("stale generation cannot restore a synchronously invalidated vector", async () => {
      await database.query("UPDATE public.media_assets SET version=2 WHERE id=$1", [assetId]);
      assert.equal(await count(), 1);
      await database.query("UPDATE public.media_derivative_jobs SET state='processing',lease_token=$2,lease_until=now()+interval '2 minutes' WHERE id=$1", [job.id, job.lease_token]);
      await assert.rejects(commit(assetId, revision, job), /visual_source_stale/);
      assert.equal(await count(), 1);
    });
    await suite.test("consent revocation deletes embeddings and old consent cannot retry", async () => {
      await database.query("SELECT public.media_visual_index_consent($1,$2,1,false,NULL)", [otherId, ownerId]);
      assert.equal(await count(), 0);
      await assert.rejects(commit(otherId, otherRevision, otherJob, embedding(1)), /visual_consent_revoked/);
      const replacement = await consent(otherId);
      assert.notEqual(replacement, otherRevision);
      await assert.rejects(commit(otherId, otherRevision, otherJob, embedding(1)), /visual_consent_revoked/);
      await database.query("UPDATE public.media_derivative_jobs SET state='processing',lease_token=$2,lease_until=now()+interval '2 minutes' WHERE id=$1", [otherJob.id, otherJob.lease_token]);
      await assert.rejects(commit(otherId, replacement, otherJob, embedding(1)), /visual_lease_lost/);
      otherJob = await claim(otherId, replacement);
      await commit(otherId, replacement, otherJob, embedding(1));
      await finish(otherId, otherJob);
      assert.equal(await count(), 1);
    });
    await suite.test("expired vectors cannot be read and sweep erases stored vectors", async () => {
      await database.query("UPDATE public.media_visual_embeddings SET expires_at=now()-interval '1 second' WHERE asset_id=$1", [otherId]);
      assert.equal((await database.query("SELECT * FROM public.media_visual_index_match($1,$2::extensions.vector,5)", [modelId, embedding()])).rows.length, 0);
      await database.query("SELECT public.media_visual_index_sweep(100)");
      assert.equal(await count(), 0);
    });
    await suite.test("erase verifies source identity, retains a tombstone, and blocks late jobs", async () => {
      await database.query("UPDATE public.media_assets SET deleted_at=now(),moderation_status='owner_deleted',purge_status='pending' WHERE id=$1", [otherId]);
      await assert.rejects(database.query("SELECT public.media_visual_index_erase($1,1,'post-media','wrong')", [otherId]), /visual_erase_source_mismatch/);
      const result = (await database.query("SELECT public.media_visual_index_erase($1,1,'post-media',$2) result", [otherId, `${ownerId}/${otherId}.png`])).rows[0].result;
      assert.deepEqual(result, { erased: true, remaining: 0 });
      assert.equal((await database.query("SELECT * FROM public.media_visual_index_consents WHERE asset_id=$1", [otherId])).rows.length, 0);
      assert.equal((await database.query("SELECT * FROM public.media_visual_index_tombstones WHERE asset_id=$1", [otherId])).rows.length, 1);
      await assert.rejects(commit(otherId, otherRevision, otherJob), /visual_source_stale/);
      assert.equal(await count(), 0);
    });
    await suite.test("default-off flag blocks index writes and search even for service role", async () => {
      await database.exec("UPDATE public.feature_flags SET enabled=false WHERE flag='media_vision_provider_enabled'");
      await assert.rejects(commit(assetId, revision, job), /visual_index_disabled/);
      assert.equal((await database.query("SELECT * FROM public.media_visual_index_match($1,$2::extensions.vector,5)", [modelId, embedding()])).rows.length, 0);
    });
  } finally {
    if (database) await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
