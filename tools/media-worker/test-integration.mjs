import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw new Error("Pass an installed PGlite package directory; no database server or account is contacted");
const { PGlite } = await import(pathToFileURL(join(process.argv[2], "dist/index.js")).href);
const { vector } = await import(pathToFileURL(join(process.argv[2], "dist/vector/index.js")).href);
const database = new PGlite({ extensions: { vector } });
const directory = new URL("../../artifacts/api-server/src/migrations/", import.meta.url);
const migrations = (await readdir(directory)).filter(name => /^398[0-7]_.*\.sql$/.test(name) || name === '3995_media_caption_translation_retained_outputs.sql').sort();
const ownerId = "11111111-1111-4111-8111-111111111111";
const assetId = "22222222-2222-4222-8222-222222222222";
const zeroRevision = "0".repeat(64);
const initialCaptionRevision = "c".repeat(64);
const captionRevision = "a".repeat(64);
const visionRevision = "7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed";
const visionModel = `google/siglip-base-patch16-224@${visionRevision}/travel-scene-v1`;
const indexModel = "openai/clip-vit-base-patch32@d44250afa9f05af7eca021052567539406661018:clip-rgb224-v1";
const mutation = process.env.MEDIA_INTEGRATION_MUTATION ?? "";
const mutations = {
  "vision-consent": "DROP TRIGGER media_image_understanding_consent_invalidation ON media_image_understanding_consents",
  "index-consent": "DROP TRIGGER media_visual_index_consent_changed ON media_visual_index_consents",
  "asr-revoke": "CREATE OR REPLACE FUNCTION media_caption_asr_revoke(p_asset_id uuid,p_owner_id uuid) RETURNS boolean LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM public.media_assets WHERE id=p_asset_id AND owner_user_id=p_owner_id)'",
  "dubbing-revoke": "CREATE OR REPLACE FUNCTION media_dubbing_revoke(p_asset uuid,p_owner uuid) RETURNS boolean LANGUAGE sql AS 'SELECT EXISTS(SELECT 1 FROM public.media_assets WHERE id=p_asset AND owner_user_id=p_owner)'",
  "queue-source": "DROP TRIGGER media_derivative_source_invalidation ON media_assets",
  "vision-source": "DROP TRIGGER media_image_understanding_asset_invalidation ON media_assets",
  "index-source": "DROP TRIGGER media_visual_index_source_changed ON media_assets",
  "asr-revision": "DROP TRIGGER media_caption_asr_revision_invalidation ON media_caption_manifests",
  "dubbing-source": "DROP TRIGGER media_dubbing_invalidate_source ON media_assets",
  "dubbing-captions": "DROP TRIGGER media_dubbing_invalidate_captions ON media_caption_manifests",
  "translation-captions": "DROP TRIGGER media_caption_translation_revision_invalidation ON media_caption_manifests",
  "dubbing-epoch": "CREATE FUNCTION fixture_suppress_dubbing_epoch() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NULL; END'; CREATE TRIGGER fixture_suppress_dubbing_epoch BEFORE INSERT OR UPDATE ON media_dubbing_epochs FOR EACH ROW EXECUTE FUNCTION fixture_suppress_dubbing_epoch()",
  "dubbing-publication": `CREATE OR REPLACE VIEW media_dubbing_readable WITH (security_invoker=true) AS
    SELECT artifact.* FROM media_dubbing_artifacts artifact JOIN media_derivative_jobs job ON job.id=artifact.job_id
    WHERE artifact.write_state='uploaded' AND NOT artifact.cleanup_requested AND job.state='completed'
      AND job.result->>'artifactId'=artifact.id::text
      AND media_dubbing_current(artifact.asset_id,artifact.owner_user_id,job.source_version,job.target_language,
        artifact.manifest->>'captionRevision',artifact.manifest->>'translationRevision',artifact.manifest->>'consentRevision')`,
};
if (mutation && !Object.hasOwn(mutations, mutation)) throw new Error(`Unknown offline mutation: ${mutation}`);
const migrationHashes = {};
const findings = [];
let assertions = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions++; }
async function scalar(sql, parameters = []) { return Object.values((await database.query(sql, parameters)).rows[0] ?? {})[0]; }
async function rejects(operation, expected, message) { await assert.rejects(operation, expected, message); assertions++; }
async function audit(label, run) {
  try { await run(); }
  catch (error) {
    if (error.code !== "ERR_ASSERTION") throw error;
    findings.push({ label, message: error.message });
  }
}
async function finish(job, result) {
  return scalar("SELECT media_derivative_finish($1,$2,true,false,NULL,1,100,100,$3)", [job.id, job.lease_token, result]);
}
async function claim(kind, model, id) {
  const rows = (await database.query("SELECT * FROM media_derivative_claim($1,$2,1,120)", [kind, model])).rows;
  equal(rows.length, 1, `${kind} has one real claim`);
  equal(rows[0].id, id, `${kind} claims the enqueued identity`);
  return rows[0];
}
async function ready(job) {
  return scalar("SELECT media_derivative_ready($1,$2,$3,$4,$5,$6)", [job.asset_id, job.source_version, job.kind, job.model_version, job.target_language, job.revision_key]);
}
async function seedSources() {
  await database.exec("RESET ROLE; TRUNCATE profiles,posts,post_media,media_assets,user_account_states,media_attachments,media_dubbing_artifacts,media_caption_translation_artifacts CASCADE");
  await database.query("INSERT INTO profiles VALUES($1,'active')", [ownerId]);
  const sources = {};
  for (const mediaType of ["image", "video"]) {
    const id = randomUUID();
    const postId = randomUUID();
    const postMediaId = randomUUID();
    const storagePath = `${ownerId}/synthetic-${mediaType}.${mediaType === "image" ? "png" : "mp4"}`;
    const publicUrl = `https://synthetic.invalid/${mediaType}`;
    await database.query("INSERT INTO posts(id,author_id,status,post_status,visibility) VALUES($1,$2,'active','published','public')", [postId, ownerId]);
    await database.query(`INSERT INTO post_media(id,post_id,user_id,storage_bucket,storage_path,public_url,media_type,processing_status,moderation_status,sort_order)
      VALUES($1,$2,$3,'post-media',$4,$5,$6,'ready','approved',0)`, [postMediaId, postId, ownerId, storagePath, publicUrl, mediaType]);
    await database.query(`INSERT INTO media_assets(id,version,owner_user_id,storage_bucket,storage_path,public_url,size_bytes,media_type,mime_type,thumbnail_path,duration_ms,visibility,processing_status,moderation_status,purge_status)
      VALUES($1,1,$2,'post-media',$3,$4,100,$5,$6,$7,$8,'public','ready','active','not_requested')`,
    [id, ownerId, storagePath, publicUrl, mediaType, mediaType === "image" ? "image/png" : "video/mp4", mediaType === "image" ? null : `${storagePath}.poster.jpg`, mediaType === "image" ? null : 2000]);
    await database.query("INSERT INTO media_attachments VALUES($1,'post',$2)", [id, postId]);
    sources[mediaType] = { assetId: id, ownerId, postId, postMediaId, sourceVersion: 1, bucket: "post-media", path: storagePath, mediaType, framePath: mediaType === "image" ? null : `${storagePath}.poster.jpg` };
  }
  await database.exec("SET ROLE service_role");
  return sources;
}
async function enqueueAsr(fixture, actor = ownerId, consent = true) {
  return scalar("SELECT media_caption_asr_enqueue($1,$2,$3,$4,'en',$5,$6)", [fixture.video.assetId, actor, fixture.videoSnapshot, initialCaptionRevision, consent, fixture.asrEpoch]);
}
async function settledTranslationArtifact(intent, source) {
  const artifactId = randomUUID();
  const token = randomUUID();
  const reserved = await scalar('SELECT media_caption_translation_artifact_reserve($1,$2,$3,$4)', [artifactId, token, intent, source]);
  equal(reserved?.id, artifactId, 'translation output is reserved before its synthetic upload');
  equal((await scalar('SELECT media_caption_translation_artifact_dispatch($1,$2)', [artifactId, token]))?.id, artifactId, 'translation output receives one dispatch capability');
  equal(await scalar('SELECT media_caption_translation_artifact_dispatch($1,$2)', [artifactId, token]), null, 'translation dispatch is not replayable');
  const settled = await scalar('SELECT media_caption_translation_artifact_settle($1,$2,$3)', [artifactId, token, 'uploaded']);
  equal(settled?.write_state, 'uploaded', 'synthetic positive upload completion is durably settled');
  return settled;
}
async function applyCaption(fixture, consentId = fixture.asr.consentId) {
  return scalar("SELECT cas_media_caption_manifest($1,$2,$3,$4,$5,$6,$7)", [fixture.video.assetId, ownerId, fixture.videoSnapshot, initialCaptionRevision, captionRevision,
    `manual-captions/${fixture.video.assetId}/v1-${captionRevision}.json`, consentId]);
}
async function commitIndex(fixture) {
  return scalar("SELECT media_visual_index_commit($1,1,'post-media',$2,$3,$4::extensions.vector,$5,$6,$7,$8,$9,$10)",
    [fixture.image.assetId, fixture.image.path, indexModel, JSON.stringify(Array.from({ length: 512 }, (_, index) => index === 0 ? 1 : 0)), "b".repeat(64),
      fixture.index.expiresAt, fixture.index.consentRevision, fixture.index.job.id, fixture.index.job.lease_token, fixture.index.revisionKey]);
}
async function stageDubbing(fixture) {
  return scalar("SELECT media_dubbing_stage($1,$2,$3,$4,'media-private-fixture')", [fixture.dubbing.job.id, fixture.dubbing.job.lease_token, randomUUID(), fixture.dubbing.manifest]);
}
async function readableState(fixture) {
  return {
    vision: (await scalar("SELECT media_image_understanding_read($1)", [fixture.vision.request.key])) !== null,
    index: await scalar("SELECT count(*)::integer FROM media_visual_index_current WHERE asset_id=$1", [fixture.image.assetId]),
    asr: (await ready(fixture.asr.job)) !== null,
    dubbing: await scalar("SELECT count(*)::integer FROM media_dubbing_readable WHERE asset_id=$1", [fixture.video.assetId]),
  };
}
async function prepare({ completed = true } = {}) {
  const fixture = await seedSources();
  fixture.videoSnapshot = await scalar("SELECT to_jsonb(source) FROM media_assets source WHERE id=$1", [fixture.video.assetId]);
  equal(await scalar("SELECT media_dubbing_grant($1,$2,1,'en',$3,$4,true,'synthetic-dubbing-v1',$5)", [fixture.video.assetId, ownerId, initialCaptionRevision, "b".repeat(64), zeroRevision]), null, "dubbing refuses a missing caption manifest");
  equal(await scalar("SELECT cas_media_caption_manifest($1,$2,$3,$4,$5,$6)", [fixture.video.assetId, ownerId, fixture.videoSnapshot, zeroRevision, initialCaptionRevision,
    `manual-captions/${fixture.video.assetId}/v1-${initialCaptionRevision}.json`]), true, "owned manual caption manifest seeded through real CAS");
  equal(await scalar("SELECT revision_key FROM media_caption_manifests WHERE asset_id=$1", [fixture.video.assetId]), initialCaptionRevision, "initial caption manifest persists");
  const request = { kind: "image_understanding", source: fixture.image,
    key: `vision:${fixture.image.assetId}:1:${visionRevision}:travel-scene-v1:fixture-v1:${fixture.image.postMediaId}`,
    modelId: "google/siglip-base-patch16-224", modelRevision: visionRevision, taxonomyVersion: "travel-scene-v1", consentVersion: "fixture-v1" };
  equal(await scalar("SELECT media_image_understanding_grant($1,$2,'fixture-v1')", [fixture.image, ownerId]), true, "vision grants exact owned source");
  const visionId = await scalar("SELECT media_image_understanding_enqueue($1)", [request]);
  equal(await scalar("SELECT media_image_understanding_enqueue($1)", [request]), visionId, "vision enqueue retries reuse identity");
  fixture.vision = { request, job: await claim("vision", visionModel, visionId), result: {
    source: fixture.image, consentVersion: "fixture-v1", recognition: { modelId: request.modelId, modelRevision: visionRevision, taxonomyVersion: "travel-scene-v1",
      confidence: 0, confidenceKind: "uncalibrated_similarity", inferenceMs: 1, crowdLevel: null, travelCandidates: [] }, candidates: [], pixelScope: "image",
    processedAt: new Date().toISOString(), pixelSha256: "a".repeat(64), metrics: { inputBytes: 100, normalizedBytes: 100, elapsedMs: 1, estimatedExternalCostUsd: 0 } } };
  equal(await scalar("SELECT media_image_understanding_publish($1,$2,$3)", [visionId, fixture.vision.job.lease_token, fixture.vision.result]), true, "vision stages candidate-only fixture");
  const expiresAt = new Date(Date.now() + 600_000).toISOString();
  const consentRevision = await scalar("SELECT media_visual_index_consent($1,$2,1,true,$3)", [fixture.image.assetId, ownerId, expiresAt]);
  const revisionKey = await scalar("SELECT media_visual_index_revision_key($1,1,'post-media',$2,$3,$4)", [fixture.image.assetId, fixture.image.path, indexModel, consentRevision]);
  const indexId = await scalar("SELECT media_derivative_enqueue($1,$2,1,'embedding',$3,'',$4)", [fixture.image.assetId, ownerId, indexModel, revisionKey]);
  fixture.index = { expiresAt, consentRevision, revisionKey, job: await claim("embedding", indexModel, indexId) };
  equal(await commitIndex(fixture), { applied: true }, "index stages real pgvector row");
  fixture.asrEpoch = await scalar("SELECT media_caption_asr_epoch($1,$2)", [fixture.video.assetId, ownerId]);
  equal(/^[a-f0-9]{64}$/.test(fixture.asrEpoch), true, "owner captures explicit ASR consent epoch before enqueue");
  const asrId = await enqueueAsr(fixture);
  equal(await enqueueAsr(fixture), asrId, "ASR consent retries reuse one queue identity");
  fixture.asr = { job: await claim("captions", "fixture-asr-v1", asrId), consentId: await scalar("SELECT id FROM media_caption_asr_consents WHERE job_id=$1", [asrId]) };
  equal(await applyCaption(fixture), false, "ASR cannot promote before queue completion");
  equal(await scalar("SELECT revision_key FROM media_caption_manifests WHERE asset_id=$1", [fixture.video.assetId]), initialCaptionRevision, "incomplete ASR cannot overwrite existing manual captions");
  const dubbingConsent = await scalar("SELECT media_dubbing_grant($1,$2,1,'en',$3,$4,true,'synthetic-dubbing-v1',$5)", [fixture.video.assetId, ownerId, initialCaptionRevision, "b".repeat(64), zeroRevision]);
  equal(typeof dubbingConsent, "string", "current manual captions permit explicit dubbing consent");
  const dubbingRevision = createHash("sha256").update(`fixture:${dubbingConsent}`).digest("hex");
  const dubbingId = await scalar("SELECT media_derivative_enqueue($1,$2,1,'dubbing','fixture-dubbing-v1','en',$3)", [fixture.video.assetId, ownerId, dubbingRevision]);
  const artifactId = randomUUID();
  fixture.dubbing = { consentRevision: dubbingConsent, artifactId, job: await claim("dubbing", "fixture-dubbing-v1", dubbingId), manifest: {
    kind: "synthetic_dubbing", label: "AI-generated translated audio", voiceCloning: false, training: false, originalPreserved: true,
    assetId: fixture.video.assetId, sourceVersion: 1, modelVersion: "fixture-dubbing-v1", revisionKey: dubbingRevision, language: "en",
    captionRevision: initialCaptionRevision, translationRevision: "b".repeat(64), consentRevision: dubbingConsent } };
  equal(await scalar("SELECT media_dubbing_stage($1,$2,$3,$4,'media-private-fixture')", [dubbingId, fixture.dubbing.job.lease_token, artifactId, fixture.dubbing.manifest]), true, "dubbing stages synthetic metadata without storage/provider calls");
  equal(await scalar("SELECT write_state FROM media_dubbing_artifacts WHERE id=$1", [artifactId]), "pending", "dubbing reservation records an unsettled writer");
  equal(await scalar("SELECT media_dubbing_settle($1,$2,$3,true)", [dubbingId, randomUUID(), artifactId]), false, "foreign lease cannot settle a pending dubbing write");
  equal(await scalar("SELECT write_state FROM media_dubbing_artifacts WHERE id=$1", [artifactId]), "pending", "foreign settlement leaves pending state intact");
  equal(await scalar("SELECT media_dubbing_settle($1,$2,$3,true)", [dubbingId, fixture.dubbing.job.lease_token, artifactId]), true, "owned synthetic writer settles without claiming real storage upload");
  equal(await scalar("SELECT write_state FROM media_dubbing_artifacts WHERE id=$1", [artifactId]), "uploaded", "settlement state persists");
  equal(await readableState(fixture), { vision: false, index: 0, asr: false, dubbing: 0 }, "no feature result readable before generic publication");
  equal(await scalar("SELECT count(*)::integer FROM media_derivative_jobs"), 4, "exactly one durable job per feature");
  if (completed) {
    equal(await finish(fixture.vision.job, { artifactKey: request.key, publicationToken: fixture.vision.job.lease_token }), true, "vision generic publication");
    equal(await finish(fixture.index.job, { assetId: fixture.image.assetId, indexLeaseToken: fixture.index.job.lease_token }), true, "index generic publication");
    equal(await finish(fixture.asr.job, { fixture: "synthetic-caption-result-not-inference" }), true, "ASR generic publication");
    equal(await finish(fixture.dubbing.job, { artifactId, ...fixture.dubbing.manifest, publicationToken: fixture.dubbing.job.lease_token }), true, "dubbing generic publication");
    equal(await readableState(fixture), { vision: true, index: 1, asr: true, dubbing: 1 }, "all four completed paths non-vacuously readable");
    equal(await scalar("SELECT count(*)::integer FROM media_derivative_job_events WHERE state='completed'"), 4, "completion audit rows persist");
  }
  return fixture;
}

try {
  await database.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean NOT NULL, description text);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, account_status text);
    CREATE TABLE public.user_account_states(user_id uuid REFERENCES public.profiles(id), state text, expires_at timestamptz);
    CREATE TABLE public.posts(id uuid PRIMARY KEY, author_id uuid REFERENCES public.profiles(id), status text, post_status text,
      deleted_at timestamptz, visibility text, trip_id uuid, like_count integer DEFAULT 0);
    CREATE TABLE public.post_media(id uuid PRIMARY KEY, post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE, user_id uuid,
      storage_bucket text, storage_path text, public_url text, media_type text, processing_status text, moderation_status text, sort_order integer);
    CREATE TABLE public.media_assets(id uuid PRIMARY KEY, version integer, owner_user_id uuid REFERENCES public.profiles(id),
      storage_bucket text, storage_path text, public_url text, size_bytes bigint, media_type text, mime_type text,
      thumbnail_path text, duration_ms integer, visibility text, processing_status text, moderation_status text,
      deleted_at timestamptz, purge_status text);
    CREATE TABLE public.media_attachments(media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE CASCADE, entity_type text, entity_id uuid);
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO service_role;
    GRANT SELECT, UPDATE(like_count,visibility) ON posts TO authenticated;
    INSERT INTO feature_flags VALUES('media_vision_provider_enabled',false,'existing fixture flag'),('media_captions_enabled',false,'existing fixture flag');
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,authenticated;
  `);
  const canonical = await readFile(new URL("3320_media_canonical_contract_constraints.sql", directory), "utf8");
  const start = canonical.indexOf("CREATE OR REPLACE FUNCTION public.media_assets_bump_version()");
  const end = canonical.indexOf("FOR EACH ROW EXECUTE FUNCTION public.media_assets_bump_version();", start);
  assert.ok(start >= 0 && end > start);
  await database.exec(canonical.slice(start, end + "FOR EACH ROW EXECUTE FUNCTION public.media_assets_bump_version();".length));
  const baselineFunctions = new Set((await database.query("SELECT oid::text AS id FROM pg_proc WHERE pronamespace='public'::regnamespace")).rows.map(row => row.id));
  const baselineTables = new Set((await database.query("SELECT oid::text AS id FROM pg_class WHERE relnamespace='public'::regnamespace")).rows.map(row => row.id));
  for (const filename of migrations) {
    const sql = await readFile(new URL(filename, directory), "utf8");
    migrationHashes[filename] = createHash("sha256").update(sql).digest("hex");
    try { await database.exec(sql); }
    catch (error) { throw new Error(`Integrated migration ${filename} failed: ${error.message}`, { cause: error }); }
  }
  for (const prefix of ["3980_", "3981_", "3982_", "3983_", "3986_", "3987_", "3995_"]) equal(migrations.some(filename => filename.startsWith(prefix)), true, `${prefix} present in combined chain`);
  equal(await scalar("SELECT count(*)::integer FROM feature_flags WHERE enabled"), 0, "fresh schema does not activate features");
  const featureFunctions = (await database.query("SELECT oid::text AS id, proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND (proname LIKE 'media_%' OR proname LIKE 'cas_media_%')")).rows.filter(row => !baselineFunctions.has(row.id));
  const featureTables = (await database.query("SELECT oid::text AS id, relname, relkind, relrowsecurity, reloptions FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','v') AND relname LIKE 'media_%'")).rows.filter(row => !baselineTables.has(row.id));
  for (const name of ["media_derivative_finish", "media_image_understanding_revoke", "media_visual_index_consent", "media_caption_asr_revoke", "media_dubbing_revoke"]) equal(featureFunctions.some(row => row.proname === name), true, `${name} privilege audit is not vacuous`);
  equal(featureTables.length >= 14, true, "all five feature table/view sets audited");
  for (const table of featureTables) {
    if (table.relkind === "r") equal(table.relrowsecurity, true, `${table.relname} enables RLS`);
    else equal(table.reloptions?.includes("security_invoker=true"), true, `${table.relname} uses invoker privileges`);
  }
  for (const role of ["anon", "authenticated"]) {
    for (const functionRow of featureFunctions) equal(await scalar("SELECT has_function_privilege($1,$2::oid,'EXECUTE')", [role, functionRow.id]), false, `${role} cannot execute ${functionRow.proname}`);
    for (const table of featureTables) for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      equal(await scalar("SELECT has_table_privilege($1,$2::oid,$3)", [role, table.id, privilege]), false, `${role} cannot ${privilege} ${table.relname}`);
    }
    await database.exec(`SET ROLE ${role}`);
    for (const table of featureTables) await rejects(() => database.query(`SELECT * FROM public.${table.relname} LIMIT 1`), { code: "42501" }, `${role} real read denied for ${table.relname}`);
    await rejects(() => database.query("SELECT media_caption_asr_revoke($1,$2)", [assetId, ownerId]), { code: "42501" }, `${role} cannot call revocation RPC`);
    await database.exec("RESET ROLE");
  }
  if (mutation) await database.exec(mutations[mutation]);
  await database.query("INSERT INTO profiles VALUES($1,'active')", [ownerId]);
  await database.query(`INSERT INTO media_assets(id,version,owner_user_id,storage_bucket,storage_path,size_bytes,media_type,mime_type,duration_ms,visibility,processing_status,moderation_status,purge_status)
    VALUES($1,1,$2,'post-media',$3,100,'video','video/mp4',2000,'public','ready','active','not_requested')`, [assetId, ownerId, `${ownerId}/synthetic.mp4`]);
  await database.exec("SET ROLE service_role");
  const schema = await scalar("SELECT public.media_derivative_schema_status()");
  for (const table of ["media_derivative_jobs", "media_caption_manifests", "media_visual_embeddings", "media_image_understanding_artifacts", "media_dubbing_artifacts"]) equal(schema[table], true, `${table} present in combined schema`);
  equal(await scalar("SELECT media_derivative_enqueue($1,$2,1,'adaptive_video','hls-v1')", [assetId, ownerId]), null, "OFF still refuses queued work after full chain");
  await database.exec("UPDATE feature_flags SET enabled=true WHERE flag='media_derivative_jobs_enabled'");
  const jobId = await scalar("SELECT media_derivative_enqueue($1,$2,1,'adaptive_video','hls-v1')", [assetId, ownerId]);
  assert.ok(jobId);
  const claimed = (await database.query("SELECT * FROM media_derivative_claim('adaptive_video','hls-v1',1,120)")).rows[0];
  equal(claimed.id, jobId, "full-chain worker can claim");
  await database.query("UPDATE media_assets SET visibility='private' WHERE id=$1", [assetId]);
  equal(await scalar("SELECT version FROM media_assets WHERE id=$1", [assetId]), 2, "real canonical BEFORE trigger bumps implicit generation");
  equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [jobId]), "cancelled", "all installed triggers preserve invalidation");
  equal(await scalar("SELECT media_derivative_finish($1,$2,true,false,NULL,1,1,1,'{}')", [jobId, claimed.lease_token]), false, "old generation cannot finish");
  await database.query("DELETE FROM media_assets WHERE id=$1", [assetId]);
  equal(await scalar("SELECT count(*)::integer FROM media_derivative_jobs"), 0, "source hard deletion cascades jobs");
  await database.exec(`UPDATE feature_flags SET enabled=true WHERE flag IN ('media_vision_provider_enabled','media_captions_enabled','media_caption_asr_enabled','media_dubbing_enabled');
    INSERT INTO media_caption_asr_config(singleton,enabled,model_version,config_version,allowed_languages,runtime_verified_at)
      VALUES(true,true,'fixture-asr-v1','synthetic-config-v1',ARRAY['en'],now())`);
  for (const completed of [false, true]) {
    let fixture = await prepare({ completed });
    await scalar("SELECT media_image_understanding_revoke($1,$2)", [fixture.image.postMediaId, ownerId]);
    equal(await scalar("SELECT count(*)::integer FROM media_image_understanding_consents WHERE revoked_at IS NULL"), 0, "vision consent actually revoked");
    equal(await scalar("SELECT count(*)::integer FROM media_image_understanding_artifacts"), 0, "vision revocation erases candidate artifacts");
    equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [fixture.vision.job.id]), "cancelled", "vision revocation cancels claimed/completed job");
    equal(await scalar("SELECT media_image_understanding_publish($1,$2,$3)", [fixture.vision.job.id, fixture.vision.job.lease_token, fixture.vision.result]), false, "revoked vision cannot republish");
    equal(await scalar("SELECT media_image_understanding_grant($1,$2,'fixture-v1')", [fixture.image, ownerId]), false, "old vision consent cannot resurrect");
    equal(await readableState(fixture), { vision: false, index: completed ? 1 : 0, asr: completed, dubbing: completed ? 1 : 0 }, "vision-only revocation leaves other features alone");

    fixture = await prepare({ completed });
    await database.query("UPDATE media_visual_index_consents SET revoked_at=now() WHERE asset_id=$1", [fixture.image.assetId]);
    equal(await scalar("SELECT count(*)::integer FROM media_visual_embeddings"), 0, "direct index consent revocation trigger erases vectors");
    await rejects(() => commitIndex(fixture), /visual_consent_revoked/, "revoked index consent cannot republish");
    equal(await readableState(fixture), { vision: completed, index: 0, asr: completed, dubbing: completed ? 1 : 0 }, "index-only revocation leaves other features alone");

    fixture = await prepare({ completed });
    equal(await scalar("SELECT media_caption_asr_revoke($1,$2)", [fixture.video.assetId, randomUUID()]), false, "foreign owner cannot revoke ASR");
    equal(await scalar("SELECT count(*)::integer FROM media_caption_asr_consents WHERE revoked_at IS NULL"), 1, "foreign revoke leaves original ASR grant intact");
    equal(await scalar("SELECT media_caption_asr_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "owner revokes ASR");
    equal((await database.query("SELECT state,lease_token,result FROM media_derivative_jobs WHERE id=$1", [fixture.asr.job.id])).rows[0], { state: "cancelled", lease_token: null, result: null }, "ASR revocation cancels and erases persisted output");
    equal(await scalar("SELECT count(*)::integer FROM media_caption_asr_consents WHERE revoked_at IS NULL"), 0, "ASR grant really revoked");
    equal(await applyCaption(fixture), false, "revoked ASR cannot create caption manifest");
    equal(await finish(fixture.asr.job, { fixture: true }), false, "revoked ASR lease cannot finish");
    equal(await readableState(fixture), { vision: completed, index: completed ? 1 : 0, asr: false, dubbing: completed ? 1 : 0 }, "ASR-only revocation leaves other features alone");
    equal(await enqueueAsr(fixture), null, "captured pre-revocation epoch cannot silently regrant ASR");
    equal(await scalar("SELECT count(*)::integer FROM media_caption_asr_consents WHERE revoked_at IS NULL"), 0, "replayed ASR request leaves consent revoked");
    const replacementEpoch = await scalar("SELECT media_caption_asr_epoch($1,$2)", [fixture.video.assetId, ownerId]);
    equal(replacementEpoch === fixture.asrEpoch, false, "revocation rotates the durable consent epoch");
    fixture.asrEpoch = replacementEpoch;
    const replacementId = await enqueueAsr(fixture);
    equal(typeof replacementId, "string", "fresh explicit ASR consent can regrant");
    equal(replacementId === fixture.asr.job.id, false, "ASR regrant owns a distinct job");
    equal(await applyCaption(fixture), false, "new consent cannot revive stale ASR result");

    fixture = await prepare({ completed });
    equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [fixture.video.assetId, randomUUID()]), false, "foreign owner cannot revoke dubbing");
    equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "owner revokes dubbing");
    equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, "dubbing consent actually withdrawn");
    equal((await database.query("SELECT state,lease_token,result FROM media_derivative_jobs WHERE id=$1", [fixture.dubbing.job.id])).rows[0], { state: "cancelled", lease_token: null, result: null }, "dubbing revocation cancels and erases queue receipt");
    equal(await stageDubbing(fixture), false, "revoked dubbing cannot restage");
    equal(await readableState(fixture), { vision: completed, index: completed ? 1 : 0, asr: completed, dubbing: 0 }, "dubbing-only revocation leaves other features alone");
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_artifacts"), 1, "dubbing removal ledger retained for separate storage cleanup");
  }
  for (const change of ["visibility='private'", "public_url='https://synthetic.invalid/replaced'", "visibility=visibility", "moderation_status='limited'", "deleted_at=now()", "storage_path=storage_path || '.changed'", "size_bytes=size_bytes+1"]) {
    const fixture = await prepare();
    await database.exec(`UPDATE media_assets SET ${change}`);
    equal(await scalar("SELECT count(*)::integer FROM media_assets WHERE version=2"), 2, `${change}: canonical BEFORE version bump runs for both sources`);
    equal(await scalar("SELECT count(*)::integer FROM media_derivative_jobs WHERE state='cancelled'"), 4, `${change}: all derivative generations cancelled`);
    equal(await readableState(fixture), { vision: false, index: 0, asr: false, dubbing: 0 }, `${change}: all combined read paths fail closed`);
    equal(await scalar("SELECT count(*)::integer FROM media_image_understanding_consents WHERE revoked_at IS NULL"), 0, `${change}: vision consent revoked, not merely hidden by queue state`);
    equal(await scalar("SELECT count(*)::integer FROM media_image_understanding_artifacts"), 0, `${change}: vision artifact erased`);
    equal(await scalar("SELECT count(*)::integer FROM media_visual_embeddings"), 0, `${change}: vector erased, not merely filtered from view`);
    equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, `${change}: dubbing consent invalidated`);
    equal(await scalar("SELECT count(*)::integer FROM media_caption_asr_consents consent JOIN media_assets source ON source.id=consent.asset_id WHERE consent.revoked_at IS NULL AND consent.source_version=source.version"), 0, `${change}: no current-generation ASR grant`);
    equal(await applyCaption(fixture), false, `${change}: old ASR cannot promote`);
    equal(await enqueueAsr(fixture), null, `${change}: old ASR snapshot cannot enqueue`);
    equal(await stageDubbing(fixture), false, `${change}: old dubbing cannot stage`);
    await rejects(() => commitIndex(fixture), /visual_source_stale/, `${change}: old index generation cannot commit`);
    for (const feature of [fixture.vision, fixture.index, fixture.asr, fixture.dubbing]) equal(await finish(feature.job, {}), false, `${change}: old lease cannot finish`);
  }
  let fixture = await prepare();
  equal(await applyCaption(fixture), true, "completed ASR can promote to current caption manifest");
  equal(await scalar("SELECT revision_key FROM media_caption_manifests WHERE asset_id=$1", [fixture.video.assetId]), captionRevision, "caption CAS side effect persists");
  equal(await scalar("SELECT count(*)::integer FROM media_caption_asr_consents WHERE revoked_at IS NULL"), 0, "caption revision change revokes old ASR consent");
  equal(await ready(fixture.asr.job), null, "caption revision trigger removes old queued ASR output");
  equal(await scalar("SELECT count(*)::integer FROM media_dubbing_readable"), 0, "caption revision change hides completed dubbing");
  equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, "caption revision change durably withdraws dubbing consent");
  equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [fixture.dubbing.job.id]), "cancelled", "caption revision trigger cancels the old dubbing job");
  equal(await applyCaption(fixture), false, "completed ASR cannot overwrite later caption revision");

  fixture = await prepare();
  await database.exec("RESET ROLE; SET ROLE authenticated");
  await database.query("UPDATE posts SET like_count=like_count+1 WHERE id=$1", [fixture.image.postId]);
  await database.exec("RESET ROLE; SET ROLE service_role");
  equal(await readableState(fixture), { vision: true, index: 1, asr: true, dubbing: 1 }, "ordinary authenticated post edit does not touch service-only artifacts");
  await database.exec("RESET ROLE; SET ROLE authenticated");
  await database.query("UPDATE posts SET visibility='private' WHERE id=$1", [fixture.image.postId]);
  await database.exec("RESET ROLE; SET ROLE service_role");
  equal(await scalar("SELECT count(*)::integer FROM media_image_understanding_artifacts"), 0, "authenticated post privacy update triggers privileged vision cleanup without granting artifact access");
  equal(await scalar("SELECT count(*)::integer FROM media_image_understanding_consents WHERE revoked_at IS NULL"), 0, "post privacy update durably revokes vision consent");

  fixture = await prepare();
  await database.exec("UPDATE feature_flags SET enabled=false");
  await scalar("SELECT media_image_understanding_revoke($1,$2)", [fixture.image.postMediaId, ownerId]);
  equal(await scalar("SELECT media_visual_index_consent($1,$2,1,false,NULL)", [fixture.image.assetId, ownerId]), null, "index revocation RPC works while features OFF");
  equal(await scalar("SELECT media_caption_asr_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "ASR revocation works while features OFF");
  equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "dubbing revocation works while features OFF");
  for (const table of ["media_image_understanding_consents", "media_visual_index_consents", "media_caption_asr_consents"]) equal(await scalar(`SELECT count(*)::integer FROM ${table} WHERE revoked_at IS NULL`), 0, `${table} durably revoked even while OFF`);
  equal(await scalar("SELECT count(*)::integer FROM media_image_understanding_artifacts"), 0, "OFF revocation actually erases vision data");
  equal(await scalar("SELECT count(*)::integer FROM media_visual_embeddings"), 0, "OFF revocation actually erases vectors");
  equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, "OFF revocation actually withdraws dubbing consent");
  await database.exec("UPDATE feature_flags SET enabled=true");
  equal(await readableState(fixture), { vision: false, index: 0, asr: false, dubbing: 0 }, "turning fixtures back ON cannot resurrect revoked results");

  fixture = await prepare();
  await database.exec("DELETE FROM media_assets");
  for (const table of ["media_derivative_jobs", "media_derivative_job_events", "media_image_understanding_consents", "media_image_understanding_artifacts", "media_visual_index_consents", "media_visual_embeddings", "media_caption_asr_consents", "media_caption_asr_epochs", "media_caption_manifests", "media_dubbing_consents"]) {
    equal(await scalar(`SELECT count(*)::integer FROM ${table}`), 0, `hard deletion removes ${table}`);
  }
  equal(await readableState(fixture), { vision: false, index: 0, asr: false, dubbing: 0 }, "hard deletion leaves no readable derivative");
  equal(await scalar("SELECT count(*)::integer FROM media_dubbing_artifacts"), 1, "hard deletion preserves inaccessible dubbing storage-erasure ledger");

  await database.exec(`UPDATE feature_flags SET enabled=true WHERE flag='media_caption_translation_enabled';
    INSERT INTO media_caption_translation_config(singleton,enabled,model_version,config_version,allowed_pairs,runtime_verified_at)
    VALUES(true,true,'fixture-translation-v1','synthetic-config-v1','[{"source":"en","target":"fr"}]',now())`);
  for (const operation of ["publish", "delete", "revoke"]) {
    fixture = await prepare();
    const enqueue = (epoch = 0) => scalar("SELECT media_caption_translation_enqueue($1,$2,$3,$4,'en','fr',true,$5)",
      [fixture.video.assetId, ownerId, fixture.videoSnapshot, initialCaptionRevision, epoch]);
    const translationId = await enqueue();
    equal(typeof translationId, "string", "3987 creates a distinct durable translation job");
    equal(await enqueue(), translationId, "3987 identical request reuses consent and queue identity");
    const consentId = await scalar("SELECT id FROM media_caption_translation_consents WHERE job_id=$1", [translationId]);
    const translationJob = await claim("subtitle_translation", "fixture-translation-v1", translationId);
    const draftId = "e".repeat(64);
    const draftIntent = { asset_id: fixture.video.assetId, owner_user_id: ownerId, source_version: 1,
      consent_id: consentId, job_id: translationId, lease_token: translationJob.lease_token,
      kind: 'draft', draft_id: draftId, caption_revision: initialCaptionRevision, output_revision: draftId };
    const draftArtifact = await settledTranslationArtifact(draftIntent, fixture.videoSnapshot);
    equal(await finish(translationJob, { state: "draft_ready", consentId, draftId,
      artifactKey: draftArtifact.storage_path, sourceVersion: 1,
      revisionKey: initialCaptionRevision, modelVersion: "fixture-translation-v1", sourceLanguage: "en", targetLanguage: "fr" }), true, "3987 synthetic draft receipt completes through real queue");
    equal((await ready(translationJob))?.draftId, draftId, "completed translation receipt actually readable before withdrawal");
    if (operation === "publish") {
      const publish = reviewed => scalar("SELECT cas_media_caption_translation($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [fixture.video.assetId, ownerId, fixture.videoSnapshot, initialCaptionRevision, captionRevision,
          `manual-captions/${fixture.video.assetId}/v1-${captionRevision}.json`, consentId, draftId, reviewed]);
      equal(await publish(false), false, "3987 refuses unreviewed translation publication");
      equal(await scalar("SELECT revision_key FROM media_caption_manifests"), initialCaptionRevision, "unreviewed draft leaves original caption revision unchanged");
      equal(await publish(true), false, "3995 refuses an unreserved publication even after creator review");
      await settledTranslationArtifact({ ...draftIntent, kind: 'publication', output_revision: captionRevision }, fixture.videoSnapshot);
      equal(await publish(true), true, "reviewed settled publication executes the shared 3983 caption CAS");
      equal(await scalar("SELECT revision_key FROM media_caption_manifests"), captionRevision, "translated caption revision persists");
      equal(await scalar("SELECT count(*)::integer FROM media_caption_asr_consents WHERE revoked_at IS NULL"), 0, "3987 publication also revokes stale ASR grant through 3983 trigger");
      equal(await ready(fixture.asr.job), null, "3987 publication clears old ASR result");
    } else if (operation === "delete") {
      await database.query("DELETE FROM media_caption_manifests WHERE asset_id=$1", [fixture.video.assetId]);
      equal(await scalar("SELECT count(*)::integer FROM media_caption_manifests"), 0, "caption manifest deletion persists");
    } else {
      equal(await scalar("SELECT media_caption_translation_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "3987 explicit revocation succeeds");
      equal(await enqueue(), null, "3987 captured pre-revocation epoch cannot regrant");
      equal(await scalar("SELECT epoch FROM media_caption_translation_epochs WHERE asset_id=$1", [fixture.video.assetId]), 1, "3987 revocation advances persisted epoch");
      equal(await readableState(fixture), { vision: true, index: 1, asr: true, dubbing: 1 }, "translation-only withdrawal leaves other feature consents unchanged");
    }
    equal(await scalar("SELECT count(*)::integer FROM media_caption_translation_consents WHERE revoked_at IS NULL"), 0, `${operation}: translation grant durably withdrawn`);
    equal((await database.query("SELECT state,result FROM media_derivative_jobs WHERE id=$1", [translationId])).rows[0], { state: "cancelled", result: null }, `${operation}: translation queue result erased`);
    equal(await ready(translationJob), null, `${operation}: translation result no longer readable`);
    if (operation !== "revoke") {
      equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false, `${operation}: 3986 withdraws dubbing consent with 3987 installed`);
      equal(await scalar("SELECT count(*)::integer FROM media_dubbing_readable"), 0, `${operation}: caption change suppresses completed dubbing`);
      equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [fixture.dubbing.job.id]), "cancelled", `${operation}: 3986 cancels the prior dubbing generation`);
      equal(await scalar("SELECT count(*)::integer FROM media_dubbing_artifacts"), 1, `${operation}: storage erasure ledger survives caption invalidation`);
    }
    const retainedCount = operation === 'publish' ? 2 : 1;
    equal(await scalar('SELECT count(*)::integer FROM media_caption_translation_artifacts WHERE asset_id=$1', [fixture.video.assetId]), retainedCount, `${operation}: translation output identities survive grant invalidation`);
    await database.query('DELETE FROM media_assets WHERE id=$1', [fixture.video.assetId]);
    equal(await scalar('SELECT count(*)::integer FROM media_caption_translation_artifacts WHERE asset_id=$1 AND source_deleted AND cleanup_requested', [fixture.video.assetId]), retainedCount, `${operation}: hard deletion retains every exact output for cleanup`);
    equal(await scalar('SELECT count(*)::integer FROM media_derivative_jobs WHERE id=$1', [translationId]), 0, `${operation}: source queue deletion does not erase output receipts`);
  }

  await audit("dubbing initial revocation epoch", async () => {
    fixture = await seedSources();
    const snapshot = await scalar("SELECT to_jsonb(source) FROM media_assets source WHERE id=$1", [fixture.video.assetId]);
    equal(await scalar("SELECT cas_media_caption_manifest($1,$2,$3,$4,$5,$6)", [fixture.video.assetId, ownerId, snapshot, zeroRevision, initialCaptionRevision,
      `manual-captions/${fixture.video.assetId}/v1-${initialCaptionRevision}.json`]), true, "initial revocation race has legitimate source captions");
    const state = (language, owner = ownerId) => scalar("SELECT media_dubbing_consent_state($1,$2,$3)", [fixture.video.assetId, owner, language]);
    const grant = (language, expected) => scalar("SELECT media_dubbing_grant($1,$2,1,$3,$4,$5,true,'synthetic-dubbing-v1',$6)", [fixture.video.assetId, ownerId, language, initialCaptionRevision, "b".repeat(64), expected]);
    const captured = (await state("en")).consentRevision;
    const unseenCaptured = (await state("fr")).consentRevision;
    equal(captured, zeroRevision, "first-grant request captures the initial epoch");
    equal(await state("en", randomUUID()), null, "non-owner cannot read dubbing compare tokens");
    await database.exec("UPDATE feature_flags SET enabled=false WHERE flag='media_dubbing_enabled'");
    equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "owner withdraws before any dubbing grant exists");
    await database.exec("UPDATE feature_flags SET enabled=true WHERE flag='media_dubbing_enabled'");
    await grant("en", captured);
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_consents WHERE opted_in"), 0, "delayed pre-withdrawal initial request must not establish dubbing consent");
    equal(await grant("fr", unseenCaptured), null, "withdrawal fences a previously unseen language too");
    const firstEpoch = (await state("fr")).consentRevision;
    equal(firstEpoch !== unseenCaptured, true, "empty withdrawal persists a fresh asset-wide epoch");
    equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [fixture.video.assetId, randomUUID()]), false, "foreign withdrawal cannot advance the epoch");
    equal((await state("fr")).consentRevision, firstEpoch, "foreign withdrawal preserves the captured epoch");
    equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "repeated empty withdrawal still succeeds");
    equal(await grant("fr", firstEpoch), null, "second empty withdrawal fences a token read after the first");
    const fresh = (await state("en")).consentRevision;
    const accepted = await grant("en", fresh);
    equal(typeof accepted, "string", "fresh deliberate consent succeeds after status reread");
    equal(await grant("en", fresh), accepted, "same explicit request remains idempotent inside its epoch");
    const nextLanguage = (await state("de")).consentRevision;
    equal(await scalar("SELECT media_dubbing_revoke($1,$2)", [fixture.video.assetId, ownerId]), true, "asset-wide withdrawal also rotates existing grants");
    equal(await grant("en", fresh), null, "pre-withdrawal idempotency token cannot reactivate existing language");
    equal(await grant("en", accepted), null, "pre-withdrawal accepted revision cannot reactivate existing language");
    equal(await grant("de", nextLanguage), null, "existing-language withdrawal also fences a never-granted language");
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_consents WHERE opted_in"), 0, "all stale replay attempts preserve zero active grants");
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_epochs"), 1, "one durable epoch covers all languages for the source");
  });

  for (const invalidation of ["captions", "source"]) await audit(`dubbing ungranted ${invalidation} epoch`, async () => {
    fixture = await seedSources();
    const snapshot = () => scalar("SELECT to_jsonb(source) FROM media_assets source WHERE id=$1", [fixture.video.assetId]);
    equal(await scalar("SELECT cas_media_caption_manifest($1,$2,$3,$4,$5,$6)", [fixture.video.assetId, ownerId, await snapshot(), zeroRevision, initialCaptionRevision,
      `manual-captions/${fixture.video.assetId}/v1-${initialCaptionRevision}.json`]), true, "ungranted source has real current captions");
    const captured = (await scalar("SELECT media_dubbing_consent_state($1,$2,'fr')", [fixture.video.assetId, ownerId])).consentRevision;
    if (invalidation === "source") {
      await database.query("UPDATE media_assets SET visibility='private' WHERE id=$1", [fixture.video.assetId]);
      equal((await scalar("SELECT media_dubbing_consent_state($1,$2,'fr')", [fixture.video.assetId, ownerId])).consentRevision !== captured,
        true, "source change alone advances the ungranted epoch before captions change");
    }
    const currentSource = await snapshot();
    equal(await scalar("SELECT cas_media_caption_manifest($1,$2,$3,$4,$5,$6)", [fixture.video.assetId, ownerId, currentSource, initialCaptionRevision, captionRevision,
      `manual-captions/${fixture.video.assetId}/v${currentSource.version}-${captionRevision}.json`]), true, "replacement caption manifest matches the current source generation");
    const grant = expected => scalar("SELECT media_dubbing_grant($1,$2,$3,'fr',$4,$5,true,'synthetic-dubbing-v1',$6)",
      [fixture.video.assetId, ownerId, currentSource.version, captionRevision, "b".repeat(64), expected]);
    equal(await grant(captured), null, `${invalidation}: a stale unseen-language request cannot rebase to current captions`);
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_consents"), 0, "stale rebase writes no language grant");
    const fresh = (await scalar("SELECT media_dubbing_consent_state($1,$2,'fr')", [fixture.video.assetId, ownerId])).consentRevision;
    equal(fresh !== captured, true, `${invalidation}: invalidation advances the asset epoch without language rows`);
    equal(typeof await grant(fresh), "string", `${invalidation}: fresh explicit re-consent works for replacement captions`);
  });

  await audit("dubbing publication lease", async () => {
    fixture = await prepare({ completed: false });
    await database.query("UPDATE media_derivative_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [fixture.dubbing.job.id]);
    equal(await scalar("SELECT media_derivative_recover(10)"), 1, "one expired dubbing lease recovered sequentially");
    equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [fixture.dubbing.job.id]), "retrying", "expired lease enters retry state");
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_readable"), 0, "expired lease artifact hidden before retry completion");
    await database.query("UPDATE media_derivative_jobs SET available_at=clock_timestamp() WHERE id=$1", [fixture.dubbing.job.id]);
    const retry = await claim("dubbing", "fixture-dubbing-v1", fixture.dubbing.job.id);
    equal(retry.lease_token === fixture.dubbing.job.lease_token, false, "retry owns a distinct publication token");
    equal(await finish(fixture.dubbing.job, { artifactId: fixture.dubbing.artifactId, ...fixture.dubbing.manifest, publicationToken: fixture.dubbing.job.lease_token }), false, "old lease cannot finish after replacement");
    equal(await finish(retry, { artifactId: fixture.dubbing.artifactId, ...fixture.dubbing.manifest, publicationToken: retry.lease_token }), true, "generic queue accepts bounded JSON, feature must validate receipt lease");
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_readable"), 0, "new lease receipt must not publish artifact staged by an expired lease");
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_artifacts"), 1, "unreadable old-lease output remains in the durable cleanup ledger");
  });
  await audit("dubbing publication token required", async () => {
    fixture = await prepare({ completed: false });
    equal(await finish(fixture.dubbing.job, { artifactId: fixture.dubbing.artifactId, ...fixture.dubbing.manifest }), true, "generic queue does not interpret a feature receipt");
    equal(await scalar("SELECT count(*)::integer FROM media_dubbing_readable"), 0, "missing publication token cannot make a settled artifact readable");
  });
  if (findings.length) throw new Error("Combined SQL integration has unresolved state assertions");
  process.stdout.write(JSON.stringify({ engine: "in-memory PGlite, not multi-session PostgreSQL", migrations, migrationHashes, assertions, mutation: mutation || null,
    scope: "main app only; synthetic SQL fixtures, no model/storage/runtime proof", result: "passed" }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ engine: "in-memory PGlite, not multi-session PostgreSQL", migrationHashes, assertions, mutation: mutation || null,
    result: "failed", errorCode: error.code, failedAssertion: error.message, findings }) + "\n");
  process.exitCode = 1;
} finally { await database.close(); }
