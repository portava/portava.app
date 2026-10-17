import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { translationArtifactFixture } from './helpers/translationArtifactFixture.js';
import { decodeTranslationArtifact, eraseTranslationArtifact, readTranslationArtifact, reserveTranslationArtifact, uploadTranslationArtifact, type TranslationArtifactIntent } from '../lib/media/captions/translationArtifactStore.js';
import { RetainedCaptionTranslationReconciler } from '../services/media/RetainedCaptionTranslationReconciler.js';
import { mediaCleanupClient } from '../services/media/MediaCleanupTransport.js';
import { runConfiguredMediaCleanup } from '../scripts/runMediaDerivativeCleanup.js';
import { _setTestServiceClient } from '../lib/supabase.js';

const intent: TranslationArtifactIntent = { asset_id: '10000000-0000-4000-a000-000000000001', owner_user_id: '20000000-0000-4000-a000-000000000001',
  source_version: 5, consent_id: '30000000-0000-4000-a000-000000000001', job_id: '40000000-0000-4000-a000-000000000001',
  lease_token: '50000000-0000-4000-a000-000000000001', kind: 'draft', draft_id: 'a'.repeat(64), caption_revision: 'b'.repeat(64), output_revision: 'a'.repeat(64) };
function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const state = { deleted: false, public: false, removeFails: false, uploadError: false, uploads: 0, removes: 0, schema: true,
    held: null as ReturnType<typeof deferred<void>> | null, entered: deferred<void>() };
  const retained = translationArtifactFixture({ canRetire: () => state.deleted });
  const objects = new Map<string, string>();
  const client = {
    rpc: retained.rpc,
    from(table: string) {
      if (table === 'media_caption_translation_artifacts') return retained.query();
      const filters: Array<(row: { flag: string }) => boolean> = [];
      const rows = table === 'feature_flags' && state.schema ? [{ flag: 'media_caption_translation_enabled' }] : [];
      const query = {
        select() { return query; }, eq(key: 'flag', value: string) { filters.push(row => row[key] === value); return query; },
        lte() { return query; }, not() { return query; }, order() { return query; }, limit() { return query; }, abortSignal() { return query; },
        async maybeSingle() { return { data: rows.filter(row => filters.every(filter => filter(row)))[0] ?? null, error: null }; },
        then(resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) { return Promise.resolve({ data: [], error: null }).then(resolve, reject); },
      };
      return query;
    },
    storage: {
      async getBucket() { return { data: { id: 'post-media', public: state.public }, error: null }; },
      from(bucket: string) {
        assert.equal(bucket, 'post-media');
        return {
          async upload(path: string, bytes: Buffer) {
            state.uploads++; state.entered.resolve(); if (state.held) await state.held.promise;
            objects.set(path, bytes.toString());
            return { data: state.uploadError ? null : { id: intent.asset_id, path, fullPath: `post-media/${path}` }, error: state.uploadError ? new Error('unknown remote commit') : null };
          },
          async remove(paths: string[]) {
            state.removes++; if (state.removeFails) return { error: new Error('unconfirmed erase') };
            for (const path of paths) objects.delete(path);
            return { error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  return { state, retained, objects, client };
}

for (const kind of ['draft', 'publication'] as const) {
  test(`${kind}: missing reserve/dispatch/settlement RPC fails closed without fallback`, async () => {
    for (const operation of ['reserve', 'dispatch', 'settle']) {
      const setup = fixture(); setup.retained.state.failRpc = `media_caption_translation_artifact_${operation}`;
      let artifact;
      if (operation === 'reserve') await assert.rejects(reserveTranslationArtifact(setup.client, { ...intent, kind }, {}));
      else {
        artifact = await reserveTranslationArtifact(setup.client, { ...intent, kind }, {});
        await assert.rejects(uploadTranslationArtifact(setup.client, artifact, Buffer.from('synthetic')));
      }
      assert.equal(setup.state.uploads, operation === 'settle' ? 1 : 0);
      assert.equal(setup.state.removes, 0);
      if (operation === 'settle') assert.equal(setup.retained.rows[0]?.write_state, 'dispatched');
    }
  });
  test(`${kind}: unknown upload preserves object and pending receipt, never compensates`, async () => {
    const setup = fixture(); setup.state.uploadError = true;
    const artifact = await reserveTranslationArtifact(setup.client, { ...intent, kind }, {});
    await assert.rejects(uploadTranslationArtifact(setup.client, artifact, Buffer.from('synthetic')));
    setup.state.deleted = true;
    const result = await new RetainedCaptionTranslationReconciler(setup.client).runPass();
    assert.equal(result.unsettled, 1); assert.equal(result.removed, 0); assert.equal(setup.state.removes, 0);
    assert.equal(setup.objects.get(artifact.storage_path), 'synthetic');
  });
  test(`${kind}: delete during held upload preserves debt until positively settled; failed removal retries exactly`, async () => {
    const setup = fixture(); setup.state.held = deferred<void>();
    const artifact = await reserveTranslationArtifact(setup.client, { ...intent, kind }, {});
    const uploaded = uploadTranslationArtifact(setup.client, artifact, Buffer.from('synthetic'));
    await setup.state.entered.promise; setup.state.deleted = true;
    const reconciler = new RetainedCaptionTranslationReconciler(setup.client);
    assert.equal((await reconciler.runPass()).unsettled, 1); assert.equal(setup.state.removes, 0);
    setup.state.held.resolve(); await uploaded;
    setup.state.removeFails = true; assert.equal((await reconciler.runPass()).failed, 1);
    assert.equal(setup.retained.rows.length, 1); assert.equal(setup.objects.size, 1);
    setup.state.removeFails = false; assert.equal((await reconciler.runPass()).removed, 1);
    assert.equal(setup.retained.rows.length, 0); assert.equal(setup.objects.size, 0);
  });
}

test('deadline settles the caller, not a still-pending upload; late bytes remain discoverable', async () => {
  const setup = fixture(); setup.state.held = deferred<void>();
  const artifact = await reserveTranslationArtifact(setup.client, intent, {});
  const bounded = mediaCleanupClient(setup.client, new AbortController().signal, 15);
  await assert.rejects(uploadTranslationArtifact(bounded, artifact, Buffer.from('late')));
  setup.state.deleted = true; setup.state.held.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(setup.objects.size, 1); assert.equal(setup.retained.rows[0]?.write_state, 'dispatched');
  assert.equal((await new RetainedCaptionTranslationReconciler(setup.client).runPass()).unsettled, 1);
  assert.equal(setup.state.removes, 0);
});

test('duplicate dispatch does not upload twice and settled live output is preserved', async () => {
  const setup = fixture(), artifact = await reserveTranslationArtifact(setup.client, intent, {});
  const uploaded = await uploadTranslationArtifact(setup.client, artifact, Buffer.from('synthetic'));
  await assert.rejects(uploadTranslationArtifact(setup.client, artifact, Buffer.from('replacement')));
  assert.equal(setup.state.uploads, 1);
  assert.equal(await eraseTranslationArtifact(setup.client, uploaded), false);
  assert.equal(setup.objects.get(artifact.storage_path), 'synthetic');
});

test('confirmed erasure with unconfirmed forget retains exact receipt for retry', async () => {
  const setup = fixture(), artifact = await reserveTranslationArtifact(setup.client, intent, {});
  await uploadTranslationArtifact(setup.client, artifact, Buffer.from('synthetic')); setup.state.deleted = true;
  setup.retained.state.failRpc = 'media_caption_translation_artifact_forget';
  const reconciler = new RetainedCaptionTranslationReconciler(setup.client);
  assert.equal((await reconciler.runPass()).failed, 1); assert.equal(setup.objects.size, 0);
  assert.ok(setup.retained.rows[0]?.retirement_token);
  setup.retained.state.failRpc = ''; assert.equal((await reconciler.runPass()).removed, 1); assert.equal(setup.retained.rows.length, 0);
});

test('pagination does not starve settled objects behind a pending writer', async () => {
  const setup = fixture();
  for (const letter of ['a', 'b', 'c']) {
    const artifact = await reserveTranslationArtifact(setup.client, { ...intent, draft_id: letter.repeat(64), output_revision: letter.repeat(64) }, {});
    if (letter !== 'a') await uploadTranslationArtifact(setup.client, artifact, Buffer.from(letter));
  }
  setup.state.deleted = true; const reconciler = new RetainedCaptionTranslationReconciler(setup.client);
  let removed = 0, unsettled = 0;
  for (let pass = 0; pass < 4; pass++) { const result = await reconciler.runPass({ limit: 1 }); removed += result.removed; unsettled += result.unsettled; }
  assert.equal(removed, 2); assert.ok(unsettled >= 1); assert.equal(setup.retained.rows.length, 1);
});

test('schema absence skips only unapplied translation; malformed inventory and public buckets refuse', async () => {
  const setup = fixture(), reconciler = new RetainedCaptionTranslationReconciler(setup.client);
  setup.state.schema = false; assert.equal((await reconciler.runPass()).schemaInstalled, false);
  setup.state.schema = true; setup.retained.state.malformed = true; await assert.rejects(reconciler.runPass());
  setup.retained.state.malformed = false;
  const artifact = await reserveTranslationArtifact(setup.client, intent, {}); await uploadTranslationArtifact(setup.client, artifact, Buffer.from('synthetic'));
  setup.state.deleted = true; setup.state.public = true; assert.equal((await reconciler.runPass()).failed, 1);
  assert.equal(setup.state.removes, 0);
});

test('malformed or foreign identity/settlement receipts cannot authorize removal', async () => {
  const setup = fixture(), artifact = await reserveTranslationArtifact(setup.client, intent, {});
  for (const patch of [{ write_state: null }, { write_state: 'uploaded' }, { storage_path: 'foreign' }, { owner_user_id: intent.asset_id },
    { retirement_token: intent.asset_id }, { write_settled_at: 'invalid' }, { cleanup_requested: null }]) {
    assert.throws(() => decodeTranslationArtifact({ ...artifact, ...patch }));
  }
  assert.deepEqual(await readTranslationArtifact(setup.client, artifact.storage_path), artifact);
});

test('installed Supabase Storage upload performs one fetch for success, HTTP failure and transport failure', async () => {
  for (const mode of ['success', 'http', 'transport']) {
    let calls = 0;
    const client = createClient('http://127.0.0.1:9', 'synthetic-only', { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: async (_url, options) => {
        calls++; assert.equal(options?.method, 'POST');
        if (mode === 'transport') throw new Error('synthetic connection loss');
        return new Response(JSON.stringify(mode === 'success' ? { Id: intent.asset_id, Key: 'post-media/synthetic.json' } : { message: 'synthetic 503' }),
          { status: mode === 'success' ? 200 : 503, headers: { 'content-type': 'application/json' } });
      },
    } });
    const result = await client.storage.from('post-media').upload('synthetic.json', Buffer.from('synthetic'), { upsert: false });
    assert.equal(calls, 1); assert.equal(Boolean(result.error), mode !== 'success');
  }
});

test('real SDK success-shaped but incomplete upload acknowledgement is not settlement', async () => {
  const setup = fixture();
  const sdk = createClient('http://127.0.0.1:9','synthetic-only',{ auth:{persistSession:false,autoRefreshToken:false},global:{
    fetch: async () => new Response('{}',{status:200,headers:{'content-type':'application/json'}}),
  } });
  const client = { from: setup.client.from.bind(setup.client), rpc: setup.client.rpc.bind(setup.client), storage: sdk.storage } as unknown as SupabaseClient;
  const artifact = await reserveTranslationArtifact(client,intent,{});
  await assert.rejects(uploadTranslationArtifact(client,artifact,Buffer.from('synthetic')));
  assert.equal(setup.retained.rows[0]?.write_state,'dispatched');
  assert.ok(!setup.retained.calls.includes('media_caption_translation_artifact_settle'));
});

test('existing cleanup runner is inert OFF and reports retained pending debt when explicitly enabled locally', async () => {
  const setup = fixture(); const output: string[] = [];
  const previousArgs = process.argv, previousExit = process.exitCode;
  _setTestServiceClient(setup.client);
  mock.method(process.stdout, 'write', (chunk: string) => { output.push(String(chunk)); return true; });
  try {
    process.argv = [...previousArgs, '--once'];
    await runConfiguredMediaCleanup({}); assert.equal(setup.retained.calls.length, 0); assert.match(output.join(''), /disabled/);
    await reserveTranslationArtifact(setup.client, intent, {});
    await runConfiguredMediaCleanup({ MEDIA_DERIVATIVE_CLEANUP_ENABLED: 'true' });
    const line = output.find(item => item.includes('retained_translation_cleanup'));
    assert.ok(line); assert.equal(JSON.parse(line).state, 'degraded'); assert.equal(process.exitCode, 1);
  } finally { mock.restoreAll(); _setTestServiceClient(null); process.argv = previousArgs; process.exitCode = previousExit; }
});
