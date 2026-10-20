import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("caption edits atomically withdraw completed dubbing and reject stale caption grants", { skip: !process.env.CAPTION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.CAPTION_PGLITE_MODULE!);
  const database = new PGlite();
  const assetId = "20000000-0000-4000-a000-000000000001";
  const ownerId = "10000000-0000-4000-a000-000000000001";
  const artifactId = "30000000-0000-4000-a000-000000000001";
  const asset = { id: assetId, owner_user_id: ownerId, storage_bucket: "post-media", storage_path: `${ownerId}/video.mp4`,
    media_type: "video", duration_ms: 2000, version: 1, deleted_at: null, purge_status: "not_requested",
    processing_status: "ready", moderation_status: "approved", size_bytes: 1024 };
  const revision = (letter: string) => letter.repeat(64);
  const path = (letter: string) => `manual-captions/${assetId}/v1-${revision(letter)}.json`;
  const scalar = async (sql: string, parameters: unknown[] = []) => Object.values((await database.query(sql, parameters)).rows[0] ?? {})[0];
  try {
    await database.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, storage_bucket text NOT NULL,
      storage_path text NOT NULL, media_type text NOT NULL, duration_ms integer, version integer NOT NULL,
      deleted_at timestamptz, purge_status text NOT NULL, processing_status text NOT NULL, moderation_status text NOT NULL, size_bytes bigint);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
      GRANT SELECT ON public.feature_flags TO service_role; GRANT SELECT, UPDATE ON public.media_assets TO service_role;`);
    await database.query("INSERT INTO media_assets SELECT * FROM jsonb_populate_record(NULL::media_assets,$1::jsonb)", [JSON.stringify(asset)]);
    for (const file of ["3980_media_derivative_jobs.sql", "3983_media_caption_manifest.sql", "3986_media_synthetic_dubbing.sql"]) {
      await database.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
    await database.exec("UPDATE feature_flags SET enabled=true; SET ROLE service_role");
    assert.equal(await scalar("SELECT media_dubbing_grant($1,$2,1,'en',$3,$4,true,'synthetic-dubbing-v1',$5)", [assetId, ownerId, revision("a"), revision("b"), revision("0")]), null);
    assert.equal(await scalar("SELECT cas_media_caption_manifest($1,$2,$3::jsonb,$4,$5,$6)", [assetId, ownerId, JSON.stringify(asset), revision("0"), revision("a"), path("a")]), true);
    const consent = await scalar("SELECT media_dubbing_grant($1,$2,1,'en',$3,$4,true,'synthetic-dubbing-v1',$5)", [assetId, ownerId, revision("a"), revision("b"), revision("0")]);
    assert.equal(typeof consent, "string");
    const current = () => scalar("SELECT media_dubbing_current($1,$2,1,'en',$3,$4,$5)", [assetId, ownerId, revision("a"), revision("b"), consent]);
    assert.equal(await current(), true);
    await database.exec("UPDATE media_caption_manifests SET updated_at=now()");
    assert.equal(await current(), true);
    const jobId = await scalar("SELECT media_derivative_enqueue($1,$2,1,'dubbing','synthetic-test-model','en',$3)", [assetId, ownerId, revision("c")]);
    const claim = (await database.query("SELECT * FROM media_derivative_claim('dubbing','synthetic-test-model',1,120)")).rows[0];
    assert.equal(claim.id, jobId);
    const manifest = { kind: "synthetic_dubbing", label: "AI-generated translated audio", voiceCloning: false, training: false, originalPreserved: true,
      assetId, sourceVersion: 1, modelVersion: "synthetic-test-model", revisionKey: revision("c"), language: "en",
      captionRevision: revision("a"), translationRevision: revision("b"), consentRevision: consent };
    assert.equal(await scalar("SELECT media_dubbing_stage($1,$2,$3,$4::jsonb,'dubbing-private-fixture')", [jobId, claim.lease_token, artifactId, JSON.stringify(manifest)]), true);
    assert.equal(await scalar("SELECT media_dubbing_settle($1,$2,$3,true)", [jobId, claim.lease_token, artifactId]), true);
    assert.equal(await scalar("SELECT media_derivative_finish($1,$2,true,false,NULL,1,1,1,$3::jsonb)", [jobId, claim.lease_token, JSON.stringify({ artifactId, publicationToken: claim.lease_token })]), true);
    assert.equal(await scalar("SELECT count(*)::integer FROM media_dubbing_readable"), 1);
    assert.equal(await scalar("SELECT cas_media_caption_manifest($1,$2,$3::jsonb,$4,$5,$6)", [assetId, ownerId, JSON.stringify(asset), revision("a"), revision("d"), path("d")]), true);
    assert.equal(await current(), false);
    assert.equal(await scalar("SELECT count(*)::integer FROM media_dubbing_readable"), 0);
    assert.equal(await scalar("SELECT state FROM media_derivative_jobs WHERE id=$1", [jobId]), "cancelled");
    assert.equal(await scalar("SELECT opted_in FROM media_dubbing_consents"), false);
    assert.equal(await scalar("SELECT count(*)::integer FROM media_dubbing_artifacts"), 1);
    assert.equal(await scalar("SELECT cleanup_requested FROM media_dubbing_artifacts WHERE id=$1", [artifactId]), true);
    const newConsentEpoch = await scalar("SELECT consent_revision FROM media_dubbing_consents");
    assert.notEqual(newConsentEpoch, consent);
    assert.equal(await scalar("SELECT media_dubbing_grant($1,$2,1,'en',$3,$4,true,'synthetic-dubbing-v1',$5)", [assetId, ownerId, revision("a"), revision("b"), newConsentEpoch]), null);
    await database.exec("DELETE FROM media_caption_manifests");
    assert.equal(await current(), false);
    for (const role of ["anon", "authenticated"]) {
      assert.equal(await scalar("SELECT has_function_privilege($1,'media_dubbing_invalidate_captions()','EXECUTE')", [role]), false);
    }
  } finally { await database.close(); }
});
