import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { executeAccountDeletion } from '../services/accountDeletion/AccountDeletionService.js';
import { eraseAccountMedia } from '../services/accountDeletion/accountMediaDeletion.js';
import { accountMediaSqlFixture, accountId, otherId, assetId, source } from './helpers/accountMediaDeletionFixture.js';

const binary = process.env.PORTAVA_TEST_POSTGRES_BIN;
const revision = 'a'.repeat(64), translated = 'b'.repeat(64), consent = 'c'.repeat(64);
const quote = (value: unknown): string => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const encoded = (value: unknown) => `${quote(JSON.stringify(value))}::jsonb`;
const withdraw = `UPDATE public.media_assets SET deleted_at=clock_timestamp(),moderation_status='owner_deleted',processing_status='removed',purge_status='pending',updated_at=clock_timestamp() WHERE id='${assetId}' RETURNING version;`;

describe('Account Media deletion native source barrier', { skip: !binary && 'PORTAVA_TEST_POSTGRES_BIN is required for actual PostgreSQL 17.11 execution', concurrency: false }, () => {
  let root: string, socket: string, parameters: string[], environment: NodeJS.ProcessEnv;
  let started = false;
  const fetchBefore = globalThis.fetch;
  const executable = (name: string) => { if (!binary) throw new Error('Native PostgreSQL runtime required'); return join(binary, name); };
  const command = (name: string, args: string[], input?: string) => {
    const result = spawnSync(executable(name), args, { env: environment, input, encoding: 'utf8', timeout: 25000, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, `${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
  };
  const prefix = "SET statement_timeout='8s'; SET lock_timeout='2s'; SET TIME ZONE 'UTC'; ";
  const sql = (statement: string) => command('psql', parameters, prefix + statement);
  const value = <Value = unknown>(statement: string): Value => JSON.parse(sql(`SET ROLE service_role; ${statement}`) || 'null') as Value;
  const sessions = new Set<ReturnType<typeof session>>();
  function session(appName = `account-media-${randomUUID()}`) {
    const child = spawn(executable('psql'), parameters, { env: { ...environment, PGAPPNAME: appName }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { errors += String(chunk); });
    const connection = {
      appName,
      async query(statement: string) {
        const marker = randomUUID(), offset = output.length;
        child.stdin.write(`${statement}\nSELECT '${marker}';\n`);
        const deadline = Date.now() + 10000;
        while (!output.slice(offset).includes(marker)) {
          if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Native session did not finish: ${errors}`);
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
  async function waiting(appName: string) {
    const deadline = Date.now() + 1700;
    while (sql(`SELECT count(*) FROM pg_stat_activity WHERE application_name=${quote(appName)} AND wait_event_type='Lock'`) !== '1') {
      if (Date.now() > deadline) throw new Error('Expected a real PostgreSQL lock wait');
      await delay(5);
    }
  }
  async function asyncSql(statement: string) {
    const connection = session('account-media-operation');
    try { return await connection.query(prefix + statement); }
    finally { await connection.close(); }
  }
  function fixture() {
    const result = accountMediaSqlFixture(asyncSql);
    for (const path of [source().storage_path, source().thumbnail_path]) result.objects.add(`post-media/${path}`);
    return result;
  }
  const cleanup = (fixture: ReturnType<typeof accountMediaSqlFixture>) => eraseAccountMedia(fixture.client, accountId,
    { env: { MEDIA_DUBBING_STORAGE_BUCKET: 'private-dubbing' }, timeoutMs: 60000, operationTimeoutMs: 12000 });
  function dubbingJob() {
    const jobId = randomUUID(), token = randomUUID(), receipt = randomUUID();
    sql(`INSERT INTO public.media_dubbing_consents(asset_id,owner_user_id,target_language,source_version,caption_revision,translation_revision,consent_revision,previous_revision,opted_in,disclosure_version)
      VALUES('${assetId}','${accountId}','en',4,'${revision}','${translated}','${consent}','${'0'.repeat(64)}',true,'synthetic-dubbing-v1');
      INSERT INTO public.media_derivative_jobs(id,asset_id,owner_user_id,source_version,source_bucket,source_path,source_bytes,kind,model_version,target_language,revision_key,state,priority,lease_token,lease_until)
      VALUES('${jobId}','${assetId}','${accountId}',4,'post-media',${quote(source().storage_path)},128,'dubbing','fixture-model','en','${translated}','processing',50,'${token}',clock_timestamp()+interval '2 minutes');`);
    const manifest = { kind: 'synthetic_dubbing', label: 'AI-generated translated audio', voiceCloning: false, training: false, originalPreserved: true,
      assetId, sourceVersion: 4, modelVersion: 'fixture-model', revisionKey: translated, language: 'en', captionRevision: revision, translationRevision: translated, consentRevision: consent };
    return { receipt, jobId, token, stage: `SELECT to_jsonb(public.media_dubbing_stage('${jobId}','${token}','${receipt}',${encoded(manifest)},'private-dubbing'));`,
      settle: `SELECT to_jsonb(public.media_dubbing_settle('${jobId}','${token}','${receipt}',true));` };
  }
  function translationJob() {
    const canonical = value(`SELECT to_jsonb(found) FROM public.media_assets found WHERE id='${assetId}'`);
    const jobId = value<string>(`SELECT to_jsonb(public.media_caption_translation_enqueue('${assetId}','${accountId}',${encoded(canonical)},'${revision}','es','en',true,0));`);
    assert.ok(jobId);
    const job = value<{ lease_token: string }>("SELECT to_jsonb(found) FROM public.media_derivative_claim('subtitle_translation','fixture-model',1,120) found;");
    const grant = value<{ id: string }>(`SELECT to_jsonb(found) FROM public.media_caption_translation_consents found WHERE job_id='${jobId}';`);
    const intent = { asset_id: assetId, owner_user_id: accountId, source_version: 4, kind: 'draft', consent_id: grant.id,
      job_id: jobId, lease_token: job.lease_token, draft_id: translated, caption_revision: revision, output_revision: translated };
    const receipt = randomUUID(), token = randomUUID();
    return { receipt, token, reserve: `SELECT public.media_caption_translation_artifact_reserve('${receipt}','${token}',${encoded(intent)},${encoded(canonical)});` };
  }

  before(() => {
    globalThis.fetch = async () => { throw new Error('Native fixture forbids network'); };
    root = realpathSync(mkdtempSync(join(tmpdir(), 'account-media-native-')));
    socket = join(root, 'socket'); mkdirSync(socket, { mode: 0o700 });
    environment = { PATH: `${binary}:/usr/bin:/bin`, HOME: root, TMPDIR: root, LC_ALL: 'C', NODE_ENV: 'test' };
    assert.match(command('postgres', ['--version']), /\b17\.11\b/);
    command('initdb', ['-D', join(root, 'data'), '-U', 'postgres', '--auth-local=trust', '--auth-host=reject', '--no-locale', '-E', 'UTF8']);
    command('pg_ctl', ['-D', join(root, 'data'), '-l', join(root, 'postgres.log'), '-w', '-t', '10', '-o', `-F -h '' -k '${socket}' -p 55444 -c unix_socket_permissions=0700 -c max_connections=12 -c shared_buffers=16MB`, 'start']);
    started = true;
    parameters = ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', socket, '-p', '55444', '-U', 'postgres', '-d', 'postgres'];
    assert.equal(sql('SHOW server_version_num'), '170011'); assert.equal(sql('SHOW listen_addresses'), ''); assert.equal(sql('SELECT inet_server_addr() IS NULL'), 't');
    const lifecycle = readFileSync(new URL('../migrations/2952_media_asset_deletion_lifecycle.sql', import.meta.url), 'utf8');
    const auditTable = lifecycle.match(/CREATE TABLE IF NOT EXISTS media_asset_lifecycle_events \([\s\S]*?\n\);/);
    assert.ok(auditTable);
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE TABLE public.media_assets(id uuid PRIMARY KEY,owner_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
        uploader_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,version integer NOT NULL,storage_bucket text NOT NULL,storage_path text NOT NULL,
        thumbnail_path text,media_type text NOT NULL,size_bytes bigint,duration_ms integer,deleted_at timestamptz,updated_at timestamptz NOT NULL,
        moderation_status text NOT NULL,processing_status text NOT NULL,purge_status text NOT NULL,purge_requested_at timestamptz,purged_at timestamptz,purge_error text);
      CREATE TABLE public.feature_flags(flag text PRIMARY KEY,enabled boolean,description text);
      ${auditTable[0]}
      GRANT USAGE ON SCHEMA auth TO service_role;
      GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public,auth TO service_role;`);
    assert.equal(sql("SELECT confdeltype FROM pg_constraint WHERE conrelid='public.media_asset_lifecycle_events'::regclass AND confrelid='public.media_assets'::regclass AND contype='f'"), 'c');
    const version = readFileSync(new URL('../migrations/3320_media_canonical_contract_constraints.sql', import.meta.url), 'utf8');
    const versionSql = version.match(/CREATE OR REPLACE FUNCTION public\.media_assets_bump_version\(\)[\s\S]*?FOR EACH ROW EXECUTE FUNCTION public\.media_assets_bump_version\(\);/);
    assert.ok(versionSql); sql(versionSql[0]);
    for (const name of ['3980_media_derivative_jobs.sql', '3983_media_caption_manifest.sql', '3986_media_synthetic_dubbing.sql',
      '3987_media_caption_translation.sql', '3995_media_caption_translation_retained_outputs.sql']) sql(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    sql(`INSERT INTO public.feature_flags VALUES('media_captions_enabled',true,'synthetic fixture'); UPDATE public.feature_flags SET enabled=true;
      INSERT INTO public.media_caption_translation_config VALUES(true,true,'fixture-model','fixture-config','[{"source":"es","target":"en"}]',now());`);
  });
  beforeEach(() => {
    sql(`TRUNCATE auth.users CASCADE; TRUNCATE public.media_dubbing_artifacts,public.media_caption_translation_artifacts,public.media_asset_lifecycle_events;
      INSERT INTO auth.users VALUES('${accountId}'),('${otherId}'); UPDATE public.feature_flags SET enabled=true;
      INSERT INTO public.media_assets SELECT * FROM jsonb_populate_record(NULL::public.media_assets,${encoded(source())});
      INSERT INTO public.media_caption_manifests(asset_id,source_version,revision_key,object_path)
        VALUES('${assetId}',4,'${revision}','manual-captions/${assetId}/v4-${revision}.json');`);
  });
  after(async () => {
    try { for (const connection of sessions) await connection.close(); if (started) command('pg_ctl', ['-D', join(root, 'data'), '-m', 'immediate', '-w', '-t', '10', 'stop']); }
    finally { globalThis.fetch = fetchBefore; if (root) rmSync(root, { recursive: true, force: true }); }
  });

  test('healthy actual source purge confirms returned version and exact one-row deletion with flags OFF', async () => {
    sql('UPDATE public.feature_flags SET enabled=false');
    const connected = fixture();
    let observedBeforeDelete = 0;
    connected.state.before = async operation => {
      if (operation.table === 'media_assets' && operation.action === 'delete') {
        assert.equal(sql("SELECT count(*) FROM public.media_asset_lifecycle_events WHERE event_type='purge_succeeded'"), '1');
        assert.equal(sql(`SELECT actor_user_id FROM public.media_asset_lifecycle_events WHERE media_asset_id='${assetId}' AND event_type='purge_succeeded'`), accountId);
        assert.equal(sql(`SELECT purge_status FROM public.media_assets WHERE id='${assetId}'`), 'completed');
        observedBeforeDelete += 1;
      }
    };
    assert.equal(await cleanup(connected), 1);
    assert.equal(observedBeforeDelete, 1);
    assert.equal(connected.objects.size, 0);
    assert.equal(sql('SELECT count(*) FROM public.media_assets'), '0');
    assert.equal(sql('SELECT count(*) FROM public.media_asset_lifecycle_events'), '0');
    const deletion = connected.operations.find(operation => operation.table === 'media_assets' && operation.action === 'delete');
    assert.ok(deletion?.filters.some(filter => filter[1] === 'version' && filter[2] === 6));
  });
  test('uploader-only actual canonical owner drives purge; unrelated other-owner source survives', async () => {
    sql(`UPDATE public.media_assets SET owner_user_id='${otherId}' WHERE id='${assetId}';`);
    const unrelated = { ...source(otherId, otherId), id: '55555555-5555-4555-8555-555555555555' };
    sql(`INSERT INTO public.media_assets SELECT * FROM jsonb_populate_record(NULL::public.media_assets,${encoded(unrelated)});`);
    const connected = fixture();
    let observedBeforeDelete = 0;
    connected.state.before = async operation => {
      if (operation.table === 'media_assets' && operation.action === 'delete') {
        assert.equal(sql(`SELECT count(*) FROM public.media_asset_lifecycle_events WHERE actor_user_id='${otherId}'`), '1');
        assert.equal(sql(`SELECT actor_user_id FROM public.media_asset_lifecycle_events WHERE media_asset_id='${assetId}' AND event_type='purge_succeeded'`), otherId);
        assert.equal(sql(`SELECT purge_status FROM public.media_assets WHERE id='${assetId}'`), 'completed');
        observedBeforeDelete += 1;
      }
    };
    assert.equal(await cleanup(connected), 1);
    assert.equal(observedBeforeDelete, 1);
    assert.equal(sql('SELECT count(*) FROM public.media_asset_lifecycle_events'), '0');
    assert.equal(sql('SELECT id FROM public.media_assets'), unrelated.id);
  });
  test('actual account service completes only after connected native source purge and fresh empty inventories', async () => {
    sql('UPDATE public.feature_flags SET enabled=false');
    const connected = fixture();
    const result = await executeAccountDeletion(connected.client, accountId, { actorId: null });
    assert.equal(result.ok, true, JSON.stringify(result.steps.filter(step => !step.ok)));
    assert.equal(result.deletedCounts.media_assets, 1);
    assert.equal(sql('SELECT count(*) FROM public.media_assets'), '0');
    assert.deepEqual(connected.fallback.state.authDeleted, [accountId]);
    assert.equal(connected.fallback.rows.user_deletion_requests![0]!.user_id, null);
    assert.equal(connected.objects.size, 0);
  });
  for (const kind of ['dubbing', 'translation']) {
    test(`${kind} reservation first: account withdrawal waits, sees pending debt and removes no bytes`, async () => {
      const setup = kind === 'dubbing' ? dubbingJob() : translationJob();
      const writer = session();
      const connected = fixture();
      try {
        await writer.query(prefix + 'SET ROLE service_role; BEGIN;');
        const registered = await writer.query('stage' in setup ? setup.stage : setup.reserve);
        assert.ok(registered && registered !== 'false');
        const outcome = cleanup(connected).then(() => null, error => error);
        await waiting('account-media-operation');
        await writer.query('COMMIT;');
        assert.ok(await outcome instanceof Error);
        assert.equal(connected.operations.some(operation => operation.action === 'remove'), false);
        assert.equal(sql("SELECT purge_status FROM public.media_assets"), 'pending');
        assert.equal(sql(`SELECT count(*) FROM public.${kind === 'dubbing' ? 'media_dubbing_artifacts' : 'media_caption_translation_artifacts'}`), '1');
      } finally { await writer.close(); }
    });
    test(`${kind} withdrawal first: late reservation really blocks then refuses`, async () => {
      const setup = kind === 'dubbing' ? dubbingJob() : translationJob();
      const deleting = session(), writer = session();
      try {
        await deleting.query(prefix + 'SET ROLE service_role; BEGIN;');
        assert.equal(await deleting.query(withdraw), '5');
        await writer.query(prefix + 'SET ROLE service_role;');
        const pending = writer.query('stage' in setup ? setup.stage : setup.reserve);
        await waiting(writer.appName);
        await deleting.query('COMMIT;');
        const response = await pending;
        assert.equal(response, kind === 'dubbing' ? 'false' : '');
        assert.equal(sql(`SELECT count(*) FROM public.${kind === 'dubbing' ? 'media_dubbing_artifacts' : 'media_caption_translation_artifacts'}`), '0');
      } finally { await deleting.close(); await writer.close(); }
    });
    test(`actual account service retains pending request and profile/auth while ${kind} writer is unsettled`, async () => {
      const setup = kind === 'dubbing' ? dubbingJob() : translationJob();
      assert.ok(value('stage' in setup ? setup.stage : setup.reserve));
      const connected = fixture();
      const outcome = await executeAccountDeletion(connected.client, accountId, { actorId: null });
      assert.equal(outcome.ok, false);
      assert.deepEqual(connected.fallback.state.authDeleted, []);
      assert.equal(connected.fallback.rows.profiles![0]!.account_status, 'active');
      assert.equal(connected.fallback.rows.user_deletion_requests![0]!.user_id, accountId);
      assert.equal(sql('SELECT count(*) FROM public.media_assets'), '1');
      assert.equal(connected.operations.some(operation => operation.action === 'remove'), false);
    });
  }
  test('pending dubbing can settle positively after withdrawal and then retry canonical purge', async () => {
    const setup = dubbingJob(); assert.equal(value(setup.stage), true);
    const connected = fixture();
    await assert.rejects(cleanup(connected));
    assert.equal(value(setup.settle), true);
    connected.objects.add(`private-dubbing/synthetic-dubbing/${setup.receipt}.wav`);
    assert.equal(await cleanup(connected), 1);
    assert.equal(connected.objects.size, 0);
    assert.equal(sql('SELECT count(*) FROM public.media_dubbing_artifacts'), '0');
  });
  test('real zero-row final delete after a version change cannot finalize account Media', async () => {
    const connected = fixture();
    connected.state.before = async operation => {
      if (operation.table === 'media_assets' && operation.action === 'delete') sql(`UPDATE public.media_assets SET updated_at=clock_timestamp() WHERE id='${assetId}'`);
    };
    await assert.rejects(cleanup(connected));
    assert.equal(sql('SELECT count(*) FROM public.media_assets'), '1');
    assert.equal(sql('SELECT purge_status FROM public.media_assets'), 'completed');
  });
  test('storage error preserves native source and retry uses existing actual purge', async () => {
    const connected = fixture(); connected.state.failRemove = true;
    await assert.rejects(cleanup(connected));
    assert.equal(sql('SELECT purge_status FROM public.media_assets'), 'failed');
    connected.state.failRemove = false;
    assert.equal(await cleanup(connected), 1);
  });
  test('rollback restores withdrawal and demonstrates why auth cascade must be gated', async () => {
    const setup = dubbingJob(); assert.equal(value(setup.stage), true);
    sql(`BEGIN; ${withdraw} ROLLBACK;`);
    assert.equal(sql('SELECT version FROM public.media_assets'), '4');
    assert.equal(sql('SELECT purge_status FROM public.media_assets'), 'not_requested');
    sql(`DELETE FROM auth.users WHERE id='${accountId}'`);
    assert.equal(sql('SELECT count(*) FROM public.media_assets'), '0');
    assert.equal(sql('SELECT count(*) FROM public.media_dubbing_artifacts'), '1');
  });
  test('lock timeout is bounded and preserves source and original objects', async () => {
    const locked = session(), connected = fixture();
    try {
      await locked.query(prefix + `BEGIN; SELECT id FROM public.media_assets WHERE id='${assetId}' FOR UPDATE;`);
      const start = Date.now();
      await assert.rejects(cleanup(connected));
      assert.ok(Date.now() - start < 7000);
      assert.equal(connected.operations.some(operation => operation.action === 'remove'), false);
    } finally { await locked.close(); }
  });
  test('client roles cannot stage or inspect retained receipts; service-only barrier executes', () => {
    for (const role of ['anon', 'authenticated']) for (const statement of ["SELECT * FROM public.media_dubbing_artifacts", "SELECT public.media_dubbing_revoke(NULL,NULL)", "SELECT public.media_caption_translation_artifact_reserve(NULL,NULL,NULL,NULL)"]) {
      const result = spawnSync(executable('psql'), parameters, { env: environment, input: prefix + `SET ROLE ${role}; ${statement};`, encoding: 'utf8', timeout: 5000 });
      assert.notEqual(result.status, 0); assert.match(result.stderr, /permission denied/);
    }
    assert.equal(value(`SELECT to_jsonb(public.media_dubbing_revoke('${assetId}','${accountId}'));`), true);
  });
});
