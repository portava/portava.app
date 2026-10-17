import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("real offline queue/consent transaction: explicit grant, idempotency, revoke, regrant isolation and atomic rollback", { skip: !process.env.CAPTION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.CAPTION_PGLITE_MODULE!);
  const database = new PGlite();
  const asset = { id: "20000000-0000-4000-a000-000000000001", owner_user_id: "10000000-0000-4000-a000-000000000001", storage_bucket: "post-media", storage_path: "owner/video.mp4", media_type: "video", duration_ms: 2000, version: 5, deleted_at: null, purge_status: "not_requested", processing_status: "ready", moderation_status: "approved", size_bytes: 1024 };
  try {
    await database.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY, owner_user_id uuid NOT NULL, storage_bucket text NOT NULL, storage_path text NOT NULL,
      media_type text NOT NULL, duration_ms integer, version integer NOT NULL, deleted_at timestamptz, purge_status text NOT NULL,
      processing_status text NOT NULL, moderation_status text NOT NULL, size_bytes bigint);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY, enabled boolean, description text);
      GRANT SELECT ON public.feature_flags TO service_role; GRANT SELECT, UPDATE ON public.media_assets TO service_role;`);
    await database.query("INSERT INTO public.media_assets SELECT * FROM jsonb_populate_record(NULL::public.media_assets,$1::jsonb)", [JSON.stringify(asset)]);
    await database.exec(await readFile(process.env.CAPTION_QUEUE_MIGRATION ?? new URL("../migrations/3980_media_derivative_jobs.sql", import.meta.url), "utf8"));
    await database.exec(await readFile(new URL("../migrations/3983_media_caption_manifest.sql", import.meta.url), "utf8"));
    const readEpoch = async (owner = asset.owner_user_id) => (await database.query("SELECT public.media_caption_asr_epoch($1,$2) AS epoch", [asset.id, owner])).rows[0].epoch;
    assert.equal(await readEpoch("10000000-0000-4000-a000-000000000099"), null);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM public.media_caption_asr_epochs")).rows[0].count, 0);
    let expectedConsentEpoch = await readEpoch();
    assert.match(expectedConsentEpoch, /^[a-f0-9]{64}$/);
    assert.equal(await readEpoch(), expectedConsentEpoch);
    const enqueue = async (consent = true, language = "en", revision = "0".repeat(64), owner = asset.owner_user_id, snapshot = asset, epoch: string | null = expectedConsentEpoch) => (await database.query("SELECT public.media_caption_asr_enqueue($1,$2,$3::jsonb,$4,$5,$6,$7) AS id", [asset.id, owner, JSON.stringify(snapshot), revision, language, consent, epoch])).rows[0].id;
    assert.equal(await enqueue(), null);
    await database.exec(`INSERT INTO public.feature_flags VALUES ('media_captions_enabled',true,'fixture') ON CONFLICT(flag) DO UPDATE SET enabled=true;
      UPDATE public.feature_flags SET enabled=true;
      INSERT INTO public.media_caption_asr_config(singleton,enabled,model_version,config_version,allowed_languages,runtime_verified_at)
      VALUES(true,true,'fixture-model-1','fixture-config-1',ARRAY['en','fr'],now()); SET ROLE service_role;`);
    for (const result of [await enqueue(false), await enqueue(true,"xx"), await enqueue(true,"en","a".repeat(64)), await enqueue(true,"en","0".repeat(64),"10000000-0000-4000-a000-000000000099"), await enqueue(true,"en","0".repeat(64),asset.owner_user_id,{...asset,version:4})]) assert.equal(result,null);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM public.media_derivative_jobs")).rows[0].count,0);
    for (const epoch of [null, "", "bad", "0".repeat(64)]) assert.equal(await enqueue(true, "en", "0".repeat(64), asset.owner_user_id, asset, epoch), null);
    const first = await enqueue();
    assert.equal(typeof first,"string");
    assert.equal(await enqueue(),first);
    const firstGrant = (await database.query("SELECT * FROM public.media_caption_asr_consents WHERE job_id=$1",[first])).rows[0];
    assert.equal(firstGrant.caption_revision_key,"0".repeat(64));
    assert.equal(firstGrant.consent_epoch, expectedConsentEpoch);
    assert.notEqual(firstGrant.job_revision_key,firstGrant.caption_revision_key);
    const claimed = (await database.query("SELECT * FROM public.media_derivative_claim('captions','fixture-model-1',1,120)")).rows[0];
    assert.equal(claimed.id,first);
    await database.exec("RESET ROLE; UPDATE public.feature_flags SET enabled=false; SET ROLE service_role");
    assert.equal((await database.query("SELECT public.media_caption_asr_revoke($1,$2) AS revoked",[asset.id,asset.owner_user_id])).rows[0].revoked,true);
    const stopped = (await database.query("SELECT * FROM public.media_derivative_jobs WHERE id=$1",[first])).rows[0];
    assert.equal(stopped.state,"cancelled");
    assert.equal(stopped.lease_token,null);
    assert.equal(stopped.result,null);
    assert.equal((await database.query("SELECT public.media_derivative_finish($1,$2,true) AS written",[first,claimed.lease_token])).rows[0].written,false);
    const deniedPublish = await database.query("SELECT public.cas_media_caption_manifest($1,$2,$3::jsonb,$4,$5,$6,$7) AS written",[asset.id,asset.owner_user_id,JSON.stringify(asset),"0".repeat(64),"a".repeat(64),`manual-captions/${asset.id}/v5-${"a".repeat(64)}.json`,firstGrant.id]);
    assert.equal(deniedPublish.rows[0].written,false);
    await database.exec("RESET ROLE; UPDATE public.feature_flags SET enabled=true; SET ROLE service_role");
    assert.equal(await enqueue(), null, "a captured pre-revoke opt-in must not mint a fresh grant");
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM public.media_caption_asr_consents WHERE revoked_at IS NULL")).rows[0].count, 0);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM public.media_derivative_jobs")).rows[0].count, 1);
    const priorEpoch = expectedConsentEpoch;
    expectedConsentEpoch = await readEpoch();
    assert.notEqual(expectedConsentEpoch, priorEpoch);
    const second = await enqueue();
    assert.equal(await enqueue(), second);
    assert.equal(await enqueue(true, "en", "0".repeat(64), asset.owner_user_id, asset, priorEpoch), null);
    assert.notEqual(second,first);
    const secondGrant = (await database.query("SELECT * FROM public.media_caption_asr_consents WHERE job_id=$1",[second])).rows[0];
    assert.notEqual(secondGrant.id,firstGrant.id);
    assert.equal(secondGrant.consent_epoch, expectedConsentEpoch);
    assert.notEqual(secondGrant.job_revision_key,firstGrant.job_revision_key);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM public.media_caption_asr_consents WHERE revoked_at IS NULL")).rows[0].count,1);
    await database.exec(`RESET ROLE; CREATE FUNCTION public.fixture_refuse_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_language='fr' THEN RAISE EXCEPTION 'fixture_grant_insert_failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER fixture_refuse BEFORE INSERT ON public.media_caption_asr_consents FOR EACH ROW EXECUTE FUNCTION public.fixture_refuse_grant(); SET ROLE service_role;`);
    await assert.rejects(enqueue(true,"fr"),/fixture_grant_insert_failure/);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM public.media_derivative_jobs")).rows[0].count,2);
    assert.equal((await database.query("SELECT revoked_at FROM public.media_caption_asr_consents WHERE job_id=$1",[second])).rows[0].revoked_at,null);
    assert.equal((await database.query("SELECT state FROM public.media_derivative_jobs WHERE id=$1",[second])).rows[0].state,"pending");
    const secondClaim = (await database.query("SELECT * FROM public.media_derivative_claim('captions','fixture-model-1',1,120)")).rows[0];
    assert.equal((await database.query("SELECT public.media_derivative_finish($1,$2,true) AS written",[second,secondClaim.lease_token])).rows[0].written,true);
    assert.equal((await database.query("SELECT public.cas_media_caption_manifest($1,$2,$3::jsonb,$4,$5,$6,$7) AS written",[asset.id,asset.owner_user_id,JSON.stringify(asset),"0".repeat(64),"a".repeat(64),`manual-captions/${asset.id}/v5-${"a".repeat(64)}.json`,secondGrant.id])).rows[0].written,true);
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM public.media_caption_asr_consents WHERE revoked_at IS NULL")).rows[0].count,0);
    const beforeEmptyRevoke = await readEpoch();
    assert.equal((await database.query("SELECT public.media_caption_asr_revoke($1,$2) AS revoked",[asset.id,asset.owner_user_id])).rows[0].revoked,true);
    assert.notEqual(await readEpoch(), beforeEmptyRevoke);
    const afterEmptyRevoke = await readEpoch();
    assert.equal((await database.query("SELECT public.media_caption_asr_revoke($1,$2) AS revoked",[asset.id,asset.owner_user_id])).rows[0].revoked,true);
    assert.notEqual(await readEpoch(), afterEmptyRevoke);
    assert.equal((await database.query("SELECT to_regprocedure('public.media_caption_asr_enqueue(uuid,uuid,jsonb,text,text,boolean)') AS legacy")).rows[0].legacy, null);
    for (const role of ["anon","authenticated"]) {
      await database.exec(`RESET ROLE; SET ROLE ${role}`);
      await assert.rejects(enqueue(),/permission denied/);
      await assert.rejects(database.query("SELECT public.media_caption_asr_revoke($1,$2)",[asset.id,asset.owner_user_id]),/permission denied/);
      await assert.rejects(database.query("SELECT * FROM public.media_caption_asr_consents"),/permission denied/);
      await assert.rejects(readEpoch(), /permission denied/);
      await assert.rejects(database.query("SELECT * FROM public.media_caption_asr_epochs"), /permission denied/);
    }
  } finally { await database.close(); }
});
