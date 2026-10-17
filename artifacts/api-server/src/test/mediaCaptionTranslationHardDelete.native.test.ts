import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const binary = process.env.PORTAVA_TEST_POSTGRES_BIN;
const assetId = '10000000-0000-4000-a000-000000000001';
const ownerId = '20000000-0000-4000-a000-000000000001';
const revision = 'a'.repeat(64), draftId = 'c'.repeat(64), nextRevision = 'b'.repeat(64);
const source = { id: assetId, owner_user_id: ownerId, storage_bucket: 'post-media', storage_path: `${ownerId}/synthetic.mp4`,
  media_type: 'video', duration_ms: 2000, version: 5, deleted_at: null, purge_status: 'not_requested', processing_status: 'ready', moderation_status: 'approved', size_bytes: 128 };
const quote = (value: unknown) => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const encoded = (value: unknown) => `${quote(JSON.stringify(value))}::jsonb`;
type Artifact = { id: string; write_token: string; storage_path: string; intent: Record<string, unknown>; write_state: string; retirement_token: string | null; source_deleted: boolean };

describe('Caption translation retained hard-delete recovery', { skip: !binary && 'PORTAVA_TEST_POSTGRES_BIN is required for actual PostgreSQL 17.11 execution', concurrency: false }, () => {
  let root: string, socket: string;
  let started = false;
  let args: string[];
  let environment: NodeJS.ProcessEnv;
  const executable = (name: string) => { if (!binary) throw new Error('Native PostgreSQL runtime missing'); return join(binary, name); };
  const command = (name: string, parameters: string[], input?: string) => {
    const result = spawnSync(executable(name), parameters, { env: environment, input, encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
  };
  const sql = (statement: string) => command('psql', args, `SET statement_timeout='8s'; SET lock_timeout='2s'; SET TIME ZONE 'UTC'; ${statement}`);
  const value = <Value = Artifact | null>(statement: string): Value => JSON.parse(sql(`SET ROLE service_role; ${statement}`) || 'null') as Value;
  const reserveSql = (id: string, token: string, intent: object) => `SELECT public.media_caption_translation_artifact_reserve('${id}','${token}',${encoded(intent)},${encoded(source)});`;
  const dispatchSql = (artifact: Artifact) => `SELECT public.media_caption_translation_artifact_dispatch('${artifact.id}','${artifact.write_token}');`;
  const settleSql = (artifact: Artifact, state = 'uploaded') => `SELECT public.media_caption_translation_artifact_settle('${artifact.id}','${artifact.write_token}',${quote(state)});`;
  const read = (artifact: Artifact) => value<Artifact>(`SELECT to_jsonb(found) FROM public.media_caption_translation_artifacts found WHERE id='${artifact.id}';`);
  const retireSql = (artifact: Artifact) => `SELECT public.media_caption_translation_artifact_retire(${encoded(artifact)});`;
  const forgetSql = (artifact: Artifact) => `SELECT to_jsonb(public.media_caption_translation_artifact_forget(${encoded(artifact)}));`;
  const hardDelete = `DELETE FROM public.media_assets WHERE id='${assetId}';`;
  const sessions = new Set<ReturnType<typeof session>>();

  function session() {
    const name = `translation-${randomUUID()}`;
    const child = spawn(executable('psql'), args, { env: { ...environment, PGAPPNAME: name }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    const connection = {
      name,
      async query(statement: string) {
        const marker = randomUUID();
        const offset = output.length;
        child.stdin.write(`${statement}\nSELECT '${marker}';\n`);
        const deadline = Date.now() + 9000;
        while (!output.slice(offset).includes(marker)) {
          if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Native session failed: ${errors}`);
          await delay(5);
        }
        return output.slice(offset).split(marker)[0]!.trim();
      },
      async close() {
        if (child.exitCode !== null) return;
        child.stdin.end('ROLLBACK;\n\\q\n');
        await new Promise<void>(resolve => { const timer = setTimeout(() => child.kill('SIGKILL'), 1000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
      },
    };
    sessions.add(connection);
    return connection;
  }
  async function waiting(name: string) {
    const deadline = Date.now() + 1500;
    while (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name='${name}' AND wait_event_type='Lock';`) !== '1') {
      if (Date.now() > deadline) throw new Error('Second native session did not reach a real lock wait');
      await delay(5);
    }
  }
  async function race(firstSql: string, secondSql: string) {
    const first = session(), second = session();
    try {
      await first.query("SET ROLE service_role; SET statement_timeout='8s'; BEGIN;");
      const firstResult = await first.query(firstSql);
      await second.query("SET ROLE service_role; SET statement_timeout='8s';");
      const pending = second.query(secondSql);
      await waiting(second.name);
      await first.query('COMMIT;');
      return [firstResult, await pending];
    } finally { await first.close(); await second.close(); }
  }
  function draft() {
    const jobId = value<string>(`SELECT to_jsonb(public.media_caption_translation_enqueue('${assetId}','${ownerId}',${encoded(source)},'${revision}','es','en',true,0));`);
    assert.ok(jobId);
    const job = value<{ lease_token: string }>("SELECT to_jsonb(found) FROM public.media_derivative_claim('subtitle_translation','fixture-model',1,120) found;");
    const grant = value<{ id: string }>(`SELECT to_jsonb(found) FROM public.media_caption_translation_consents found WHERE job_id='${jobId}';`);
    const intent = { asset_id: assetId, owner_user_id: ownerId, source_version: 5, consent_id: grant.id, job_id: jobId, lease_token: job.lease_token,
      kind: 'draft', draft_id: draftId, caption_revision: revision, output_revision: draftId };
    return { intent, id: randomUUID(), token: randomUUID(), jobId, lease: job.lease_token, grantId: grant.id };
  }
  function reserved() { const setup = draft(); const artifact = value(reserveSql(setup.id, setup.token, setup.intent)); assert.ok(artifact); return { ...setup, artifact }; }
  function uploaded() { const setup = reserved(); assert.ok(value(dispatchSql(setup.artifact))); const artifact = value(settleSql(setup.artifact)); assert.ok(artifact); return { ...setup, artifact }; }
  function publication() {
    const setup = uploaded();
    const result = { state: 'draft_ready', consentId: setup.grantId, draftId, artifactKey: setup.artifact.storage_path, sourceVersion: 5,
      revisionKey: revision, sourceLanguage: 'es', targetLanguage: 'en', modelVersion: 'fixture-model' };
    assert.equal(value(`SELECT to_jsonb(public.media_derivative_finish('${setup.jobId}','${setup.lease}',true,false,NULL,0,0,0,${encoded(result)}));`), true);
    const intent = { ...setup.intent, kind: 'publication', output_revision: nextRevision };
    const artifact = value(reserveSql(randomUUID(), randomUUID(), intent)); assert.ok(artifact);
    assert.ok(value(dispatchSql(artifact))); assert.ok(value(settleSql(artifact)));
    return { ...setup, artifact: read(artifact) };
  }
  const publishSql = (grant: string, path: string) => `SELECT to_jsonb(public.cas_media_caption_translation('${assetId}','${ownerId}',${encoded(source)},'${revision}','${nextRevision}',${quote(path)},'${grant}','${draftId}',true));`;

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'translation-retained-native-')));
    socket = join(root, 'socket'); mkdirSync(socket, { mode: 0o700 });
    environment = { PATH: `${binary}:/usr/bin:/bin`, HOME: root, TMPDIR: root, LC_ALL: 'C', NODE_ENV: 'test' };
    assert.match(command('postgres', ['--version']), /\b17\.11\b/);
    command('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8']);
    command('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-w', '-t', '10', '-o', `-F -h '' -k '${socket}' -p 55444 -c unix_socket_permissions=0700 -c max_connections=12 -c shared_buffers=16MB`, 'start']);
    started = true;
    args = ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55444', '-U', 'postgres', '-d', 'postgres'];
    assert.equal(sql('SHOW listen_addresses'), ''); assert.equal(sql('SHOW server_version_num'), '170011'); assert.equal(sql('SELECT inet_server_addr() IS NULL'), 't');
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL,storage_bucket text NOT NULL,storage_path text NOT NULL,
      media_type text NOT NULL,duration_ms integer,version integer NOT NULL,deleted_at timestamptz,purge_status text NOT NULL,
      processing_status text NOT NULL,moderation_status text NOT NULL,size_bytes bigint);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY,enabled boolean,description text);
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO service_role;`);
    for (const name of ['3980_media_derivative_jobs.sql','3983_media_caption_manifest.sql','3987_media_caption_translation.sql','3995_media_caption_translation_retained_outputs.sql']) {
      sql(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
    sql(`INSERT INTO public.feature_flags VALUES('media_captions_enabled',true,'synthetic fixture') ON CONFLICT(flag) DO NOTHING;
      UPDATE public.feature_flags SET enabled=true;
      INSERT INTO public.media_caption_translation_config VALUES(true,true,'fixture-model','fixture-config','[{"source":"es","target":"en"}]',now());`);
  });
  beforeEach(() => {
    sql(`TRUNCATE public.media_assets CASCADE; TRUNCATE public.media_caption_translation_artifacts;
      INSERT INTO public.media_assets SELECT * FROM jsonb_populate_record(NULL::public.media_assets,${encoded(source)});
      INSERT INTO public.media_caption_manifests(asset_id,source_version,revision_key,object_path) VALUES('${assetId}',5,'${revision}','manual-captions/${assetId}/v5-${revision}.json');`);
  });
  after(async () => {
    try { await Promise.all([...sessions].map(connection => connection.close())); if (started) command('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', '-t', '10', 'stop']); }
    finally { if (root) rmSync(root, { recursive: true, force: true }); }
  });

  test('service-only ACL, RLS, invoker functions and bounded lock waits', () => {
    assert.equal(sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.media_caption_translation_artifacts'::regclass"), 't');
    for (const role of ['anon', 'authenticated']) {
      for (const action of ["SELECT * FROM public.media_caption_translation_artifacts", "SELECT public.media_caption_translation_artifact_dispatch(NULL,NULL)", "SELECT public.media_caption_translation_artifact_settle(NULL,NULL,NULL)", "SELECT public.media_caption_translation_artifact_retire(NULL)", "SELECT public.media_caption_translation_artifact_forget(NULL)", "SELECT public.media_caption_translation_artifact_reserve(NULL,NULL,NULL,NULL)"]) {
        const denied = spawnSync(executable('psql'), args, { env: environment, input: `SET ROLE ${role}; ${action};`, encoding: 'utf8', timeout: 5000 });
        assert.notEqual(denied.status, 0); assert.match(denied.stderr, /permission denied/);
      }
    }
    assert.equal(sql("SELECT count(*) FROM pg_proc WHERE proname LIKE 'media_caption_translation_artifact_%' AND (prosecdef OR NOT 'lock_timeout=2s'=ANY(proconfig) OR NOT 'search_path=\"\"'=ANY(proconfig) OR NOT 'TimeZone=UTC'=ANY(proconfig))"), '0');
  });
  test('reserve is exact-intent idempotent but dispatch is one-shot', () => {
    const setup = reserved();
    assert.deepEqual(value(reserveSql(setup.id, setup.token, setup.intent)), setup.artifact);
    assert.equal(value(reserveSql(setup.id, setup.token, { ...setup.intent, output_revision: 'd'.repeat(64) })), null);
    assert.equal(value(reserveSql(setup.id, setup.token, { ...setup.intent, draft_id: 'd'.repeat(64), output_revision: 'd'.repeat(64) })), null);
    assert.deepEqual(read(setup.artifact), setup.artifact);
    assert.equal(value(reserveSql(randomUUID(), randomUUID(), setup.intent)), null);
    assert.equal(value(dispatchSql({ ...setup.artifact, write_token: randomUUID() })), null);
    assert.equal(value(settleSql(setup.artifact)), null);
    assert.ok(value(dispatchSql(setup.artifact))); assert.equal(value(dispatchSql(setup.artifact)), null);
    assert.equal(value(settleSql(setup.artifact, 'never_dispatched')), null);
    const settled = value(settleSql(setup.artifact)); assert.ok(settled);
    assert.deepEqual(value(settleSql(setup.artifact)), settled);
    assert.equal(value(settleSql({ ...setup.artifact, write_token: randomUUID() })), null);
  });
  test('never-dispatched settlement prevents future dispatch and transitions', () => {
    const setup = reserved(); assert.ok(value(settleSql(setup.artifact, 'never_dispatched')));
    assert.equal(value(dispatchSql(setup.artifact)), null); assert.equal(value(settleSql(setup.artifact)), null);
  });
  test('wrong owner, generation, grant, job, lease, revision and null intent cannot reserve', () => {
    const setup = draft();
    for (const patch of [{ owner_user_id: randomUUID() }, { asset_id: randomUUID() }, { source_version: 4 },
      { consent_id: randomUUID() }, { job_id: randomUUID() }, { lease_token: randomUUID() }, { lease_token: null },
      { caption_revision: 'd'.repeat(64) }, { kind: null }, { source_version: null }, { draft_id: null }, { kind: 'publication' }]) {
      assert.equal(value(reserveSql(randomUUID(),randomUUID(),{ ...setup.intent,...patch })),null);
    }
    assert.equal(value(reserveSql(randomUUID(),randomUUID(),{})),null);
    assert.equal(sql('SELECT count(*) FROM public.media_caption_translation_artifacts'),'0');
  });
  test('OFF prevents reserve and dispatch but never blocks erasure of positively-settled deleted output', () => {
    const setup = uploaded();
    sql('UPDATE public.feature_flags SET enabled=false;');
    try {
      assert.equal(value(reserveSql(setup.id,setup.token,setup.intent)),null);
      assert.equal(value(dispatchSql(setup.artifact)),null);
      sql(hardDelete); assert.ok(value(retireSql(read(setup.artifact))));
    } finally { sql('UPDATE public.feature_flags SET enabled=true;'); }
  });
  test('hard deletion retains unknown write debt and permits only positive late settlement', () => {
    const setup = reserved(); assert.ok(value(dispatchSql(setup.artifact))); sql(hardDelete);
    let artifact = read(setup.artifact); assert.equal(artifact.source_deleted, true); assert.equal(artifact.write_state, 'dispatched');
    assert.equal(sql('SELECT count(*) FROM public.media_caption_translation_consents'), '0');
    assert.equal(sql('SELECT count(*) FROM public.media_derivative_jobs'), '0');
    assert.equal(value(retireSql(artifact)), null);
    assert.equal(value(settleSql(artifact, 'never_dispatched')), null);
    assert.ok(value(settleSql(artifact))); artifact = read(artifact);
    const receipt = value(retireSql(artifact)); assert.ok(receipt?.retirement_token);
    assert.equal(value(forgetSql({ ...receipt, storage_path: 'foreign' })), false);
    assert.equal(value(forgetSql(receipt)), true); assert.equal(sql('SELECT count(*) FROM public.media_caption_translation_artifacts'), '0');
  });
  test('source deletion rollback restores identity and cleanup authority atomically', () => {
    const setup = uploaded(); sql(`BEGIN; ${hardDelete} ROLLBACK;`);
    assert.deepEqual(read(setup.artifact), setup.artifact); assert.equal(value(retireSql(setup.artifact)), null);
  });
  test('current reviewed manifest containing originals cannot retire, relink after retirement or publish without a receipt', () => {
    const setup = publication(); assert.equal(value(publishSql(setup.grantId, setup.artifact.storage_path)), true);
    assert.equal(value(retireSql(read(setup.artifact))), null);
    assert.equal(sql(`SELECT object_path FROM public.media_caption_manifests`), setup.artifact.storage_path);
    sql(hardDelete); const receipt = value(retireSql(read(setup.artifact))); assert.ok(receipt);
    assert.equal(value(forgetSql(receipt)), true); assert.equal(value(publishSql(setup.grantId, setup.artifact.storage_path)), false);
  });
  test('publication CAS requires positively settled registered output even for a completed valid draft', () => {
    const setup = publication();
    sql(`UPDATE public.media_caption_translation_artifacts SET write_state='dispatched',write_settled_at=NULL WHERE id='${setup.artifact.id}';`);
    assert.equal(value(publishSql(setup.grantId, setup.artifact.storage_path)), false);
    sql(`DELETE FROM public.media_caption_translation_artifacts WHERE id='${setup.artifact.id}';`);
    assert.equal(value(publishSql(setup.grantId, setup.artifact.storage_path)), false);
  });
  for (const deletionFirst of [false, true]) {
    test(`actual concurrent reserve/delete, deletion first=${deletionFirst}`, async () => {
      const setup = draft();
      const reserve = reserveSql(setup.id, setup.token, setup.intent);
      const results = await race(deletionFirst ? hardDelete : reserve, deletionFirst ? reserve : hardDelete);
      assert.equal(sql('SELECT count(*) FROM public.media_caption_translation_artifacts'), deletionFirst ? '0' : '1');
      if (deletionFirst) assert.equal(results[1], '');
      else assert.equal(sql('SELECT source_deleted FROM public.media_caption_translation_artifacts'), 't');
    });
    test(`actual concurrent dispatch/delete, deletion first=${deletionFirst}`, async () => {
      const setup = reserved();
      await race(deletionFirst ? hardDelete : dispatchSql(setup.artifact), deletionFirst ? dispatchSql(setup.artifact) : hardDelete);
      assert.equal(read(setup.artifact).write_state, deletionFirst ? 'reserved' : 'dispatched');
      assert.equal(value(retireSql(read(setup.artifact))), null);
    });
    test(`actual concurrent settle/delete, deletion first=${deletionFirst}`, async () => {
      const setup = reserved(); assert.ok(value(dispatchSql(setup.artifact)));
      await race(deletionFirst ? hardDelete : settleSql(setup.artifact), deletionFirst ? settleSql(setup.artifact) : hardDelete);
      const artifact = read(setup.artifact); assert.equal(artifact.write_state, 'uploaded'); assert.equal(artifact.source_deleted, true);
      assert.ok(value(retireSql(artifact)));
    });
    test(`actual concurrent publish/delete, deletion first=${deletionFirst}`, async () => {
      const setup = publication(), publish = publishSql(setup.grantId, setup.artifact.storage_path);
      const results = await race(deletionFirst ? hardDelete : publish, deletionFirst ? publish : hardDelete);
      assert.equal(results[deletionFirst ? 1 : 0], deletionFirst ? 'false' : 'true');
      assert.ok(value(retireSql(read(setup.artifact))));
    });
  }
  test('actual concurrent duplicate dispatch grants only one capability', async () => {
    const setup = reserved(); const results = await race(dispatchSql(setup.artifact), dispatchSql(setup.artifact));
    assert.equal(JSON.parse(results[0]!).write_state, 'dispatched'); assert.equal(results[1], '');
  });
  for (const retirementFirst of [false, true]) {
    test(`actual concurrent live publish/retire protects current or relinkable originals, retirement first=${retirementFirst}`, async () => {
      const setup = publication(), publish = publishSql(setup.grantId, setup.artifact.storage_path), retire = retireSql(setup.artifact);
      const results = await race(retirementFirst ? retire : publish, retirementFirst ? publish : retire);
      assert.equal(results[retirementFirst ? 0 : 1], ''); assert.equal(results[retirementFirst ? 1 : 0], 'true');
      assert.equal(sql('SELECT object_path FROM public.media_caption_manifests'), setup.artifact.storage_path);
      assert.equal(read(setup.artifact).retirement_token, null);
    });
    test(`actual concurrent revoked publish/retire refuses delayed publication, retirement first=${retirementFirst}`, async () => {
      const setup = publication();
      sql(`SELECT public.media_caption_translation_revoke('${assetId}','${ownerId}');`);
      const publish = publishSql(setup.grantId, setup.artifact.storage_path), retire = retireSql(setup.artifact);
      const results = await race(retirementFirst ? retire : publish, retirementFirst ? publish : retire);
      assert.equal(results[retirementFirst ? 1 : 0], 'false'); assert.ok(JSON.parse(results[retirementFirst ? 0 : 1]!).retirement_token);
      assert.equal(sql('SELECT object_path FROM public.media_caption_manifests'), `manual-captions/${assetId}/v5-${revision}.json`);
    });
    test(`actual concurrent settle/retire cannot erase a pending or stale receipt, retirement first=${retirementFirst}`, async () => {
      const setup = reserved(); assert.ok(value(dispatchSql(setup.artifact))); sql(hardDelete);
      const pending = read(setup.artifact), settle = settleSql(pending), retire = retireSql(pending);
      const results = await race(retirementFirst ? retire : settle, retirementFirst ? settle : retire);
      assert.equal(results[retirementFirst ? 0 : 1], ''); assert.equal(read(pending).retirement_token,null);
      assert.ok(value(retireSql(read(pending))));
    });
  }
  test('stale or forged retirement does not clear even a withdrawn current head', () => {
    const setup = publication(); assert.equal(value(publishSql(setup.grantId,setup.artifact.storage_path)),true);
    sql(`UPDATE public.media_assets SET deleted_at=now(),purge_status='pending' WHERE id='${assetId}';`);
    const artifact = read(setup.artifact);
    assert.equal(value(retireSql({ ...artifact, write_token: randomUUID() })),null);
    assert.equal(sql('SELECT object_path FROM public.media_caption_manifests'),artifact.storage_path);
    assert.ok(value(retireSql(artifact)));
    assert.equal(sql('SELECT object_path IS NULL FROM public.media_caption_manifests'),'t');
  });
  test('retired publication cannot be relinked by the generic caption CAS', () => {
    const setup = publication(); sql(`SELECT public.media_caption_translation_revoke('${assetId}','${ownerId}');`);
    assert.ok(value(retireSql(setup.artifact)));
    const refused = spawnSync(executable('psql'),args,{env:environment,input:`SET ROLE service_role; SELECT public.cas_media_caption_manifest('${assetId}','${ownerId}',${encoded(source)},'${revision}','${nextRevision}',${quote(setup.artifact.storage_path)});`,encoding:'utf8',timeout:5000});
    assert.notEqual(refused.status,0); assert.match(refused.stderr,/translation_output_not_publishable/);
    assert.equal(sql('SELECT object_path FROM public.media_caption_manifests'),`manual-captions/${assetId}/v5-${revision}.json`);
  });
  test('retirement failure rolls back withdrawn head changes and source-delete failure rolls back cascades', () => {
    const setup = publication(); assert.equal(value(publishSql(setup.grantId,setup.artifact.storage_path)),true);
    sql(`UPDATE public.media_assets SET deleted_at=now(),purge_status='pending' WHERE id='${assetId}';
      CREATE FUNCTION public.translation_fixture_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_retention_failure'; END; $$;
      CREATE TRIGGER translation_fixture_refuse BEFORE UPDATE ON public.media_caption_translation_artifacts FOR EACH ROW EXECUTE FUNCTION public.translation_fixture_refuse();`);
    try {
      for (const statement of [retireSql(read(setup.artifact)),hardDelete]) {
        const failed = spawnSync(executable('psql'),args,{env:environment,input:`SET ROLE service_role; ${statement}`,encoding:'utf8',timeout:5000});
        assert.notEqual(failed.status,0); assert.match(failed.stderr,/synthetic_retention_failure/);
        assert.equal(sql('SELECT object_path FROM public.media_caption_manifests'),setup.artifact.storage_path);
        assert.equal(sql('SELECT count(*) FROM public.media_assets'),'1');
        assert.equal(read(setup.artifact).retirement_token,null);
      }
    } finally { sql('DROP TRIGGER translation_fixture_refuse ON public.media_caption_translation_artifacts; DROP FUNCTION public.translation_fixture_refuse();'); }
  });
  test('lock timeout is bounded and leaves the writer undispatched', async () => {
    const setup = reserved(), blocker = session();
    try {
      await blocker.query(`BEGIN; SELECT id FROM public.media_assets WHERE id='${assetId}' FOR UPDATE;`);
      const start = Date.now();
      const refused = spawnSync(executable('psql'), args, { env: environment, input: `SET ROLE service_role; ${dispatchSql(setup.artifact)}`, encoding: 'utf8', timeout: 4000 });
      assert.notEqual(refused.status, 0); assert.match(refused.stderr, /lock timeout/); assert.ok(Date.now() - start < 3500);
      assert.equal(read(setup.artifact).write_state, 'reserved');
    } finally { await blocker.close(); }
  });
});
