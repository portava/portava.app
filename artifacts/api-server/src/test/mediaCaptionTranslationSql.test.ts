import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';

const asset = { id: '20000000-0000-4000-a000-000000000001', owner_user_id: '10000000-0000-4000-a000-000000000001',
  storage_bucket: 'post-media', storage_path: 'owner/video.mp4', media_type: 'video', duration_ms: 2000, version: 5,
  deleted_at: null, purge_status: 'not_requested', processing_status: 'ready', moderation_status: 'approved', size_bytes: 1024 };
const original = 'a'.repeat(64);
const next = 'b'.repeat(64);
const draftId = 'c'.repeat(64);
const publishedPath = `manual-captions/${asset.id}/v5-${next}.json`;
const options = { skip: !process.env.TRANSLATION_PGLITE_MODULE };

test('a delayed old opt-in cannot create a fresh grant after acknowledged revoke', options, async () => {
  const setup = await fixture();
  try {
    await setup.enqueue();
    assert.equal(await setup.revoke(), true);
    assert.equal(await setup.enqueue(), null);
    assert.equal((await setup.database.query('SELECT count(*)::integer AS count FROM public.media_caption_translation_consents WHERE revoked_at IS NULL')).rows[0].count, 0);
  } finally { await setup.database.close(); }
});

test('revoke retains durable cleanup debt for an in-flight writer even before its object exists', options, async () => {
  const setup = await fixture();
  try {
    const jobId = await setup.enqueue();
    await setup.database.query("SELECT * FROM public.media_derivative_claim('subtitle_translation','fixture-model',1,120)");
    assert.equal(await setup.revoke(),true);
    assert.equal((await setup.grantFor(jobId)).cleanup_pending,true);
    assert.equal(await setup.revoke(),true);
    assert.equal((await setup.grantFor(jobId)).cleanup_pending,true);
  } finally { await setup.database.close(); }
});

async function fixture() {
  const { PGlite } = await import(process.env.TRANSLATION_PGLITE_MODULE!);
  const database = new PGlite();
  await database.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.media_assets(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,storage_bucket text NOT NULL,storage_path text NOT NULL,
      media_type text NOT NULL,duration_ms integer,version integer NOT NULL,deleted_at timestamptz,purge_status text NOT NULL,
      processing_status text NOT NULL,moderation_status text NOT NULL,size_bytes bigint);
    CREATE TABLE public.feature_flags(flag text PRIMARY KEY,enabled boolean,description text);
    GRANT SELECT ON public.feature_flags TO service_role; GRANT SELECT,UPDATE ON public.media_assets TO service_role;`);
  await database.query('INSERT INTO public.media_assets SELECT * FROM jsonb_populate_record(NULL::public.media_assets,$1::jsonb)', [JSON.stringify(asset)]);
  for (const path of [
    process.env.TRANSLATION_QUEUE_MIGRATION ?? new URL('../migrations/3980_media_derivative_jobs.sql', import.meta.url),
    process.env.TRANSLATION_CAPTION_MIGRATION ?? new URL('../migrations/3983_media_caption_manifest.sql', import.meta.url),
    process.env.TRANSLATION_MIGRATION ?? new URL('../migrations/3987_media_caption_translation.sql', import.meta.url),
  ]) await database.exec(await readFile(path, 'utf8'));
  await database.query('INSERT INTO public.media_caption_manifests(asset_id,source_version,revision_key,object_path) VALUES($1,5,$2,$3)',
    [asset.id, original, `manual-captions/${asset.id}/v5-${original}.json`]);
  await database.exec(`INSERT INTO public.feature_flags VALUES('media_captions_enabled',true,'fixture') ON CONFLICT(flag) DO UPDATE SET enabled=true;
    UPDATE public.feature_flags SET enabled=true;
    INSERT INTO public.media_caption_translation_config VALUES(true,true,'fixture-model','fixture-config','[{"source":"es","target":"en"},{"source":"es","target":"fr"}]',now());
    SET ROLE service_role;`);
  const enqueue = async (patch: { consent?: boolean; source?: object; revision?: string; target?: string; owner?: string; epoch?: number | null } = {}) =>
    (await database.query('SELECT public.media_caption_translation_enqueue($1,$2,$3::jsonb,$4,$5,$6,$7,$8) AS value',
      [asset.id, patch.owner ?? asset.owner_user_id, JSON.stringify(patch.source ?? asset), patch.revision ?? original, 'es', patch.target ?? 'en', patch.consent ?? true,
        patch.epoch === undefined ? 0 : patch.epoch])).rows[0].value;
  const revoke = async () => (await database.query('SELECT public.media_caption_translation_revoke($1,$2) AS value', [asset.id,asset.owner_user_id])).rows[0].value;
  const grantFor = async (jobId: string) => (await database.query('SELECT * FROM public.media_caption_translation_consents WHERE job_id=$1', [jobId])).rows[0];
  const complete = async (jobId: string) => {
    const grant = await grantFor(jobId);
    const claim = (await database.query("SELECT * FROM public.media_derivative_claim('subtitle_translation','fixture-model',1,120)")).rows[0];
    assert.equal(claim.id, jobId);
    const result = { state: 'draft_ready', draftId, artifactKey: `manual-captions/${asset.id}/translation-v5-${grant.id}-${draftId}.json`,
      consentId: grant.id, sourceVersion: 5, revisionKey: original, sourceLanguage: 'es', targetLanguage: grant.target_language, modelVersion: 'fixture-model' };
    assert.equal((await database.query('SELECT public.media_derivative_finish($1,$2,true,false,NULL,0,0,0,$3::jsonb) AS value',
      [jobId, claim.lease_token, JSON.stringify(result)])).rows[0].value, true);
    return grant;
  };
  const publish = async (grantId: string, reviewed = true, source: object = asset) => (await database.query(
    'SELECT public.cas_media_caption_translation($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9) AS value',
    [asset.id,asset.owner_user_id,JSON.stringify(source),original,next,publishedPath,grantId,draftId,reviewed])).rows[0].value;
  return { database, enqueue, revoke, grantFor, complete, publish };
}

test('offline translation grant: explicit consent, original generation, idempotency, rollback and fresh identity after revoke', options, async () => {
  const setup = await fixture();
  try {
    for (const input of [{ consent:false },{ epoch:null },{ source:{} },{ source:{...asset,version:4} },{ revision:next },{ target:'xx' },
      { owner:'10000000-0000-4000-a000-000000000099' }]) assert.equal(await setup.enqueue(input),null);
    assert.equal((await setup.database.query('SELECT count(*)::integer AS count FROM public.media_derivative_jobs')).rows[0].count,0);
    const first = await setup.enqueue();
    assert.equal(await setup.enqueue(),first);
    const firstGrant = await setup.grantFor(first);
    assert.notEqual(firstGrant.job_revision_key,original);
    await setup.database.exec(`RESET ROLE; CREATE FUNCTION public.refuse_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.target_language='fr' THEN RAISE EXCEPTION 'fixture_refusal'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER refuse BEFORE INSERT ON public.media_caption_translation_consents FOR EACH ROW EXECUTE FUNCTION public.refuse_fixture(); SET ROLE service_role;`);
    await assert.rejects(setup.enqueue({target:'fr'}),/fixture_refusal/);
    assert.equal((await setup.grantFor(first)).revoked_at,null);
    assert.equal((await setup.database.query('SELECT count(*)::integer AS count FROM public.media_derivative_jobs')).rows[0].count,1);
    assert.equal(await setup.revoke(),true);
    const epoch = (await setup.database.query('SELECT epoch FROM public.media_caption_translation_epochs WHERE asset_id=$1',[asset.id])).rows[0].epoch;
    assert.equal(Number(epoch),1);
    const second = await setup.enqueue({epoch:Number(epoch)});
    assert.notEqual(second,first);
    assert.notEqual((await setup.grantFor(second)).job_revision_key,firstGrant.job_revision_key);
    assert.equal(await setup.publish(firstGrant.id),false);
  } finally { await setup.database.close(); }
});

test('translation publication cannot use missing, revoked, wrong-job or unreviewed consent', options, async () => {
  const setup = await fixture();
  try {
    const jobId = await setup.enqueue();
    const grant = await setup.grantFor(jobId);
    assert.equal(await setup.publish(grant.id),false);
    await setup.complete(jobId);
    assert.equal(await setup.publish(grant.id,false),false);
    assert.equal(await setup.publish('99999999-9999-4999-a999-999999999999'),false);
    await setup.database.query("UPDATE public.media_derivative_jobs SET result = result || '{\"consentId\":\"foreign\"}'::jsonb WHERE id=$1",[jobId]);
    assert.equal(await setup.publish(grant.id),false);
    await setup.database.query("UPDATE public.media_derivative_jobs SET result = jsonb_set(result,'{consentId}',to_jsonb($2::text)) WHERE id=$1",[jobId,grant.id]);
    await setup.database.query("UPDATE public.media_derivative_jobs SET kind='captions' WHERE id=$1",[jobId]);
    assert.equal(await setup.publish(grant.id),false);
    await setup.database.query("UPDATE public.media_derivative_jobs SET kind='subtitle_translation' WHERE id=$1",[jobId]);
    await setup.revoke();
    assert.equal(await setup.publish(grant.id),false);
    assert.equal((await setup.database.query('SELECT revision_key FROM public.media_caption_manifests')).rows[0].revision_key,original);
  } finally { await setup.database.close(); }
});

test('completed reviewed translation commits exact manifest then invalidates grant; manual six-argument CAS remains valid', options, async () => {
  const setup = await fixture();
  try {
    const grant = await setup.complete(await setup.enqueue());
    assert.equal(await setup.publish(grant.id),true);
    assert.equal((await setup.database.query('SELECT object_path FROM public.media_caption_manifests')).rows[0].object_path,publishedPath);
    assert.notEqual((await setup.grantFor(grant.job_id)).revoked_at,null);
    assert.equal((await setup.database.query('SELECT state FROM public.media_derivative_jobs')).rows[0].state,'cancelled');
    assert.equal(await setup.publish(grant.id),false);
    assert.equal((await setup.database.query('SELECT public.cas_media_caption_manifest($1,$2,$3::jsonb,$4,$5,NULL) AS value',
      [asset.id,asset.owner_user_id,JSON.stringify(asset),next,'d'.repeat(64)])).rows[0].value,true);
  } finally { await setup.database.close(); }
});

test('final translation CAS checks the live canonical caption path even if a JS preload was current', options, async () => {
  const setup = await fixture();
  try {
    const grant = await setup.complete(await setup.enqueue());
    await setup.database.query('UPDATE public.media_caption_manifests SET object_path=NULL WHERE asset_id=$1',[asset.id]);
    assert.equal((await setup.grantFor(grant.job_id)).revoked_at,null);
    assert.equal(await setup.publish(grant.id),false);
    assert.equal((await setup.database.query('SELECT object_path FROM public.media_caption_manifests')).rows[0].object_path,null);
  } finally { await setup.database.close(); }
});

test('caption deletion and edit invalidate translation leases without source-version rebasing', options, async () => {
  for (const operation of ['delete','edit']) {
    const setup = await fixture();
    try {
      const jobId = await setup.enqueue();
      const claim = (await setup.database.query("SELECT * FROM public.media_derivative_claim('subtitle_translation','fixture-model',1,120)")).rows[0];
      if (operation === 'delete') await setup.database.query('DELETE FROM public.media_caption_manifests WHERE asset_id=$1',[asset.id]);
      else await setup.database.query("UPDATE public.media_caption_manifests SET revision_key=$1,object_path=NULL WHERE asset_id=$2",[next,asset.id]);
      const job = (await setup.database.query('SELECT * FROM public.media_derivative_jobs WHERE id=$1',[jobId])).rows[0];
      assert.equal(job.state,'cancelled'); assert.equal(job.lease_token,null); assert.equal(job.result,null);
      assert.notEqual((await setup.grantFor(jobId)).revoked_at,null);
      assert.equal((await setup.database.query('SELECT public.media_derivative_finish($1,$2,true) AS value',[jobId,claim.lease_token])).rows[0].value,false);
      assert.equal((await setup.database.query('SELECT version FROM public.media_assets')).rows[0].version,5);
    } finally { await setup.database.close(); }
  }
});

test('OFF and config/source changes deny publication; revoke remains available while OFF and deleted', options, async () => {
  const setup = await fixture();
  try {
    const grant = await setup.complete(await setup.enqueue());
    await setup.database.exec("RESET ROLE; UPDATE public.feature_flags SET enabled=false; SET ROLE service_role;");
    assert.equal(await setup.enqueue(),null); assert.equal(await setup.publish(grant.id),false);
    await setup.database.exec("RESET ROLE; UPDATE public.feature_flags SET enabled=true; SET ROLE service_role;");
    await setup.database.exec("UPDATE public.media_caption_translation_config SET config_version='changed'");
    assert.equal(await setup.publish(grant.id),false);
    await setup.database.exec("UPDATE public.media_caption_translation_config SET config_version='fixture-config'");
    assert.equal(await setup.publish(grant.id,true,{}),false);
    await setup.database.exec("UPDATE public.media_assets SET deleted_at=now()");
    assert.equal(await setup.publish(grant.id),false);
    await setup.database.exec("RESET ROLE; UPDATE public.feature_flags SET enabled=false; SET ROLE service_role;");
    assert.equal(await setup.revoke(),true);
    assert.equal((await setup.database.query('SELECT state FROM public.media_derivative_jobs')).rows[0].state,'cancelled');
  } finally { await setup.database.close(); }
});

test('translation tables and all RPCs reject anon/authenticated roles', options, async () => {
  const setup = await fixture();
  try {
    for (const role of ['anon','authenticated']) {
      await setup.database.exec(`RESET ROLE; SET ROLE ${role}`);
      await assert.rejects(setup.enqueue(),/permission denied/);
      await assert.rejects(setup.revoke(),/permission denied/);
      await assert.rejects(setup.publish('99999999-9999-4999-a999-999999999999'),/permission denied/);
      for (const table of ['media_caption_translation_config','media_caption_translation_consents','media_caption_translation_epochs']) {
        await assert.rejects(setup.database.query(`SELECT * FROM public.${table}`),/permission denied/);
      }
    }
  } finally { await setup.database.close(); }
});

test('additive 3995 preserves OFF flags and requires retained positively-settled draft and publication identities', options, async () => {
  const setup = await fixture();
  try {
    await setup.database.exec('RESET ROLE; UPDATE public.feature_flags SET enabled=false;');
    await setup.database.exec(await readFile(new URL('../migrations/3995_media_caption_translation_retained_outputs.sql', import.meta.url), 'utf8'));
    assert.equal((await setup.database.query('SELECT count(*)::integer AS count FROM public.feature_flags WHERE enabled IS TRUE')).rows[0].count, 0);
    await setup.database.exec('UPDATE public.feature_flags SET enabled=true; SET ROLE service_role;');
    const jobId = await setup.enqueue(), grant = await setup.grantFor(jobId);
    const claim = (await setup.database.query("SELECT * FROM public.media_derivative_claim('subtitle_translation','fixture-model',1,120)")).rows[0];
    const intent = { asset_id: asset.id, owner_user_id: asset.owner_user_id, source_version: 5, consent_id: grant.id, job_id: jobId,
      lease_token: claim.lease_token, kind: 'draft', draft_id: draftId, caption_revision: original, output_revision: draftId };
    const reserve = async (kind: string) => (await setup.database.query('SELECT public.media_caption_translation_artifact_reserve(gen_random_uuid(),gen_random_uuid(),$1::jsonb,$2::jsonb) AS value',
      [JSON.stringify({ ...intent, kind, output_revision: kind === 'draft' ? draftId : next }), JSON.stringify(asset)])).rows[0].value;
    const settle = async (artifact: { id: string; write_token: string }) => {
      assert.ok((await setup.database.query('SELECT public.media_caption_translation_artifact_dispatch($1,$2) AS value', [artifact.id,artifact.write_token])).rows[0].value);
      assert.ok((await setup.database.query("SELECT public.media_caption_translation_artifact_settle($1,$2,'uploaded') AS value", [artifact.id,artifact.write_token])).rows[0].value);
    };
    const draft = await reserve('draft'); assert.ok(draft); await settle(draft);
    const result = { state:'draft_ready',draftId,artifactKey:draft.storage_path,consentId:grant.id,sourceVersion:5,revisionKey:original,
      sourceLanguage:'es',targetLanguage:'en',modelVersion:'fixture-model' };
    assert.equal((await setup.database.query('SELECT public.media_derivative_finish($1,$2,true,false,NULL,0,0,0,$3::jsonb) AS value',
      [jobId,claim.lease_token,JSON.stringify(result)])).rows[0].value,true);
    assert.equal(await setup.publish(grant.id),false);
    const publication = await reserve('publication'); assert.ok(publication);
    assert.equal(await setup.publish(grant.id),false);
    await settle(publication); assert.equal(await setup.publish(grant.id),true);
    assert.equal((await setup.database.query('SELECT object_path FROM public.media_caption_manifests')).rows[0].object_path,publishedPath);
  } finally { await setup.database.close(); }
});
