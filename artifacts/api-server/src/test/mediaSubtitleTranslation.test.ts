import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import { _setTestTranslationProvider, _clearTranslationProvider } from '../lib/translation.js';
import { parseWebVtt } from '../lib/media/vendors/mediaCaptionSource.js';
import type { MediaJob, MediaJobQueue } from '../lib/media/jobs/queue.js';
import { runMediaWorkerPass, type MediaJobContext } from '../lib/media/jobs/worker.js';
import { translationArtifactFixture } from './helpers/translationArtifactFixture.js';
import {
  createSubtitleTranslationMediaJobHandler, subtitleTranslationDraftPath,
  type SubtitleCaptionSnapshot, type SubtitleTranslationConsent,
} from '../lib/media/captions/subtitleTranslationHandler.js';

const assetId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const jobId = '33333333-3333-4333-8333-333333333333';
const token = '44444444-4444-4444-8444-444444444444';
const consentId = '55555555-5555-4555-8555-555555555555';
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHola @alice https://example.test/a.\n\n00:00:02.000 --> 00:00:04.000\nHola mundo.\n';

function fixture() {
  const controller = new AbortController();
  const job: MediaJob = { id: jobId, token, assetId, ownerUserId: ownerId,
    sourceVersion: 41, kind: 'subtitle_translation', bucket: 'post-media', path: `${ownerId}/original.mp4`,
    sizeBytes: 128, modelVersion: 'fixture-not-a-model', targetLanguage: 'en', revisionKey: 'b'.repeat(64),
    attempt: 1, leaseUntil: new Date(Date.now() + 15_000).toISOString() };
  let grant: SubtitleTranslationConsent | null = { consentId, jobId, jobRevisionKey: job.revisionKey!, assetId, ownerId,
    sourceVersion: 41, revisionKey: 'a'.repeat(64), sourceLanguage: 'es', targetLanguage: 'en',
    modelVersion: job.modelVersion, configVersion: 'config-1', translation: true, recordedAt: '2026-10-15T00:00:00Z' };
  const source = { id: assetId, owner_user_id: ownerId, version: 41, storage_bucket: 'post-media', storage_path: job.path,
    media_type: 'video', duration_ms: 4000, deleted_at: null as string | null, purge_status: 'not_requested', processing_status: 'ready', moderation_status: 'approved' };
  const snapshot: SubtitleCaptionSnapshot = { assetId, sourceVersion: 41, revisionKey: 'a'.repeat(64), tracks: [
    { language: 'es', sourceKind: 'manual', aiLabel: null, vtt, revision: 1 },
    { language: 'fr', sourceKind: 'manual', aiLabel: null, vtt: vtt.replaceAll('Hola', 'Bonjour'), revision: 2 },
  ] };
  const objects = new Map<string, string>([[job.path, 'original-video']]);
  const config = { enabled: true, modelVersion: job.modelVersion, configVersion: 'config-1', allowedPairs: [{ source: 'es', target: 'en' }] };
  let calls = 0;
  let afterTranslate = () => {};
  let afterUpload = () => {};
  let afterReserve = () => {};
  let privateBucket = true;
  let storageError = false;
  let cleanupError = false;
  let current = true;
  let version = job.modelVersion;
  let authorized = true;
  let translate = (text: string) => text.replaceAll('Hola', 'Hello');
  const removed: string[] = [];
  const providerInputs: string[] = [];
  const retained = translationArtifactFixture({ canRetire: () => !grant || !current || !!source.deleted_at,
    canDispatch: () => current && !!grant && !source.deleted_at });
  const sc = {
    async rpc(name: string, args: Record<string, unknown>) {
      const result = await retained.rpc(name,args);
      if (name === 'media_caption_translation_artifact_reserve') afterReserve();
      return result;
    },
    from(name: string) {
      if (name === 'media_caption_translation_artifacts') return retained.query();
      assert.equal(name, 'media_assets');
      const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: structuredClone(source), error: null }) };
      return query;
    },
    storage: {
      async getBucket() { return { data: { id: 'post-media', public: !privateBucket, allowed_mime_types: ['application/json'] }, error: null }; },
      from(name: string) {
        assert.equal(name, 'post-media');
        return {
          async list(prefix: string, options: { search: string }) {
            return { data: [...objects.keys()].filter(path => path === `${prefix}/${options.search}`).map(() => ({ name: options.search })), error: null };
          },
          async upload(path: string, content: Buffer, options: { upsert: boolean }) {
            assert.equal(options.upsert, false);
            assert.notEqual(path, job.path);
            if (objects.has(path)) return { error: { statusCode: '409' }, data: null };
            objects.set(path, content.toString());
            afterUpload();
            return { error: storageError ? { message: 'private storage failure' } : null, data: { id: assetId, path, fullPath: `post-media/${path}` } };
          },
          async download(path: string) {
            const value = objects.get(path);
            return { data: value === undefined ? null : new Blob([value]), error: value === undefined ? { statusCode: '404' } : null };
          },
          async remove(paths: string[]) {
            if (cleanupError) return { error: { message: 'cleanup failure' } };
            for (const path of paths) { removed.push(path); objects.delete(path); }
            return { error: null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
  const dependencies = {
    async readConsent() { return structuredClone(grant); },
    async readCaptionSnapshot() {
      if (!authorized || source.deleted_at || source.owner_user_id !== ownerId) throw new Error('denied');
      return structuredClone(snapshot);
    },
    jobError: (code: string, retryable: boolean) => Object.assign(new Error(code), { code, retryable }),
    provider: () => ({ async detectLanguage() { throw new Error('detection must not run'); },
      async translateText(text: string) {
        calls++; providerInputs.push(text); afterTranslate();
        return { translatedText: translate(text), provider: 'self-hosted', providerVersion: version };
      } }),
  };
  const context: MediaJobContext = { job, signal: controller.signal, isCurrent: async () => current };
  const handler = createSubtitleTranslationMediaJobHandler(sc, config, dependencies);
  return { sc, handler, context, config, dependencies, snapshot, source, objects, removed, providerInputs, retained,
    calls: () => calls, abort: () => controller.abort(), revoke: () => { grant = null; },
    grant: (change: (value: SubtitleTranslationConsent) => void) => change(grant!),
    during: (change: () => void) => { afterTranslate = change; }, uploaded: (change: () => void) => { afterUpload = change; },
    reserved: (change: () => void) => { afterReserve = change; },
    lose: () => { current = false; }, public: () => { privateBucket = false; }, badVersion: () => { version = 'wrong-model'; },
    failUpload: () => { storageError = true; }, failCleanup: () => { cleanupError = true; },
    deny: () => { authorized = false; }, response: (callback: typeof translate) => { translate = callback; },
  };
}

test('translation handler stages an AI-labelled private draft with exact cue timings and untouched original tracks', async () => {
  const setup = fixture();
  const original = structuredClone(setup.snapshot);
  const output = await setup.handler.handle(setup.context);
  assert.equal(output.result.state, 'draft_ready');
  assert.equal(output.result.artifactKey, subtitleTranslationDraftPath(setup.context.job, setup.config.configVersion, consentId));
  const draft = JSON.parse(setup.objects.get(String(output.result.artifactKey))!);
  assert.equal(draft.sourceKind, 'translation');
  assert.equal(draft.aiLabel, 'AI translation · needs creator review');
  assert.equal(draft.vtt, vtt.replaceAll('Hola', 'Hello'));
  assert.equal(draft.consentId, consentId);
  assert.equal(draft.jobId, jobId);
  assert.equal(draft.revisionKey, original.revisionKey);
  assert.equal(draft.sourceVersion, 41);
  assert.deepEqual(setup.snapshot, original);
  assert.equal(setup.objects.get(setup.context.job.path), 'original-video');
  assert.equal(JSON.stringify(output.result).includes('Hello'), false);
  assert.equal(setup.providerInputs.some(text => text.includes('@alice') || text.includes('https://')), false);
  assert.ok(output.inputBytes > 0 && output.outputBytes > 0);
});

test('default subtitle provider cannot transmit through explicit legacy managed selection', async () => {
  const saved = { ...process.env };
  let managedCalls = 0;
  try {
    process.env.TRANSLATION_PROVIDER = 'openai';
    delete process.env.TRANSLATION_SELF_HOSTED_URL;
    _setTestTranslationProvider({ async detectLanguage() { managedCalls++; throw new Error('leak'); },
      async translateText() { managedCalls++; throw new Error('leak'); } });
    const setup = fixture();
    const handler = createSubtitleTranslationMediaJobHandler(setup.sc, setup.config, { ...setup.dependencies, provider: undefined });
    await assert.rejects(handler.handle(setup.context));
    assert.equal(managedCalls, 0);
    assert.equal(setup.objects.size, 1);
  } finally { process.env = saved; _clearTranslationProvider(); }
});

for (const failure of ['absent_consent', 'transcription_only', 'old_job', 'old_caption_revision', 'wrong_pair', 'wrong_model', 'wrong_owner', 'old_source', 'disabled', 'public_bucket', 'lease_lost', 'cancelled', 'encrypted_or_blocked']) {
  test(`${failure} refuses before model work or draft storage`, async () => {
    const setup = fixture();
    if (failure === 'absent_consent') setup.revoke();
    if (failure === 'transcription_only') setup.grant(grant => { (grant as any).translation = undefined; (grant as any).transcription = true; });
    if (failure === 'old_job') setup.grant(grant => { grant.jobRevisionKey = 'c'.repeat(64); });
    if (failure === 'old_caption_revision') setup.snapshot.revisionKey = 'c'.repeat(64);
    if (failure === 'wrong_pair') setup.grant(grant => { grant.sourceLanguage = 'fr'; });
    if (failure === 'wrong_model') setup.grant(grant => { grant.modelVersion = 'wrong'; });
    if (failure === 'wrong_owner') setup.source.owner_user_id = 'someone-else';
    if (failure === 'old_source') setup.source.version++;
    if (failure === 'disabled') setup.config.enabled = false;
    if (failure === 'public_bucket') setup.public();
    if (failure === 'lease_lost') setup.lose();
    if (failure === 'cancelled') setup.abort();
    if (failure === 'encrypted_or_blocked') setup.deny();
    await assert.rejects(setup.handler.handle(setup.context));
    assert.equal(setup.calls(), 0);
    assert.equal(setup.objects.size, 1);
  });
}

for (const failure of ['revoke', 'edit', 'delete', 'lease', 'cancel', 'model_identity']) {
  test(`late ${failure} cannot create a review draft`, async () => {
    const setup = fixture();
    setup.during(() => {
      if (failure === 'revoke') setup.revoke();
      if (failure === 'edit') setup.snapshot.revisionKey = 'c'.repeat(64);
      if (failure === 'delete') setup.source.deleted_at = '2026-10-15T01:00:00Z';
      if (failure === 'lease') setup.lose();
      if (failure === 'cancel') setup.abort();
      if (failure === 'model_identity') setup.badVersion();
    });
    await assert.rejects(setup.handler.handle(setup.context));
    assert.equal(setup.objects.size, 1);
  });
}

test('revocation during upload erases only this lease draft', async () => {
  const setup = fixture();
  setup.uploaded(setup.revoke);
  await assert.rejects(setup.handler.handle(setup.context));
  assert.equal(setup.objects.size, 1);
  assert.deepEqual(setup.removed, [subtitleTranslationDraftPath(setup.context.job, setup.config.configVersion, consentId)]);
});

for (const change of ['cancel','revoke','lease']) {
  test(`late ${change} after reservation never dispatches and records positive non-dispatch`, async () => {
    const setup = fixture();
    setup.reserved(change === 'cancel' ? setup.abort : change === 'revoke' ? setup.revoke : setup.lose);
    await assert.rejects(setup.handler.handle(setup.context));
    assert.equal(setup.objects.size,1); assert.equal(setup.retained.rows[0]?.write_state,'never_dispatched');
    assert.ok(!setup.retained.calls.includes('media_caption_translation_artifact_dispatch'));
    assert.deepEqual(setup.removed,[]);
  });
}

test('uncertain upload remains undisposable debt; confirmed upload compensation failure is retryable', async () => {
  const setup = fixture();
  setup.failUpload();
  await assert.rejects(setup.handler.handle(setup.context));
  assert.equal(setup.objects.size, 2);
  assert.equal(setup.retained.rows[0]?.write_state, 'dispatched');
  assert.deepEqual(setup.removed, []);
  const failed = fixture();
  failed.uploaded(failed.revoke);
  failed.failCleanup();
  await assert.rejects(failed.handler.handle(failed.context), (error: any) => error.code === 'subtitle_cleanup_required' && error.retryable);
  assert.equal(failed.objects.size, 2);
});

test('discard rejects foreign lease output and removes only its own draft', async () => {
  const setup = fixture();
  const output = await setup.handler.handle(setup.context);
  const other = { ...setup.context, job: { ...setup.context.job, token: consentId } };
  await assert.rejects(setup.handler.discard(other, output));
  assert.equal(setup.objects.size, 2);
  setup.lose();
  await setup.handler.discard(setup.context, output);
  assert.equal(setup.objects.size, 1);
  assert.equal(setup.objects.get(setup.context.job.path), 'original-video');
});

test('same-lease retry reauthorizes and reuses only its own exact draft; cached output does not survive revocation', async () => {
  const setup = fixture();
  const first = await setup.handler.handle(setup.context);
  const calls = setup.calls();
  const second = await setup.handler.handle(setup.context);
  assert.equal(second.result.cached, true);
  assert.equal(second.result.artifactKey, first.result.artifactKey);
  assert.equal(setup.calls(), calls);
  setup.revoke();
  await assert.rejects(setup.handler.handle(setup.context));
  assert.equal(setup.calls(), calls);
});

test('a later lease never reuses or deletes another lease artifact', async () => {
  const setup = fixture();
  const first = await setup.handler.handle(setup.context);
  const calls = setup.calls();
  const next = { ...setup.context, job: { ...setup.context.job, token: consentId } };
  const second = await setup.handler.handle(next);
  assert.notEqual(second.result.artifactKey, first.result.artifactKey);
  assert.equal(second.result.cached, false);
  assert.ok(setup.calls() > calls);
  setup.lose();
  await setup.handler.discard(setup.context, first);
  assert.equal(setup.objects.has(String(second.result.artifactKey)), true);
  assert.equal(setup.objects.has(String(first.result.artifactKey)), false);
});

test('duplicate invocations cannot overwrite the same lease artifact', async () => {
  const setup = fixture();
  const outputs = await Promise.allSettled([setup.handler.handle(setup.context), setup.handler.handle(setup.context)]);
  assert.equal(outputs.filter(output => output.status === 'fulfilled').length, 1);
  assert.equal(outputs.filter(output => output.status === 'rejected').length, 1);
  const retried = await setup.handler.handle(setup.context);
  const completed = outputs.find(output => output.status === 'fulfilled');
  assert.equal(completed?.status, 'fulfilled');
  if (completed?.status !== 'fulfilled') throw new Error('Expected one dispatch');
  assert.equal(retried.result.artifactKey, completed.value.result.artifactKey);
  assert.equal(retried.result.cached, true);
  assert.equal(completed.value.result.cached, false);
  assert.equal(setup.objects.size, 2);
  assert.equal(setup.removed.length, 0);
});

test('a replacement grant cannot reauthorize an old original job', async () => {
  const setup = fixture();
  setup.during(() => setup.grant(grant => { grant.consentId = token; grant.jobRevisionKey = 'c'.repeat(64); }));
  await assert.rejects(setup.handler.handle(setup.context));
  assert.equal(setup.objects.size, 1);
});

test('more than 100 cues are translated in bounded batches without dropping timings or cues', async () => {
  const setup = fixture();
  setup.snapshot.tracks[0]!.vtt = `WEBVTT\n\n${Array.from({ length: 101 }, (_, index) => `00:00:00.000 --> 00:00:04.000\nHola mundo ${index}.`).join('\n\n')}\n`;
  const output = await setup.handler.handle(setup.context);
  const draft = JSON.parse(setup.objects.get(String(output.result.artifactKey))!);
  const parsed = parseWebVtt(draft.vtt, 4000);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('expected valid track');
  assert.equal(parsed.track.cues.length, 101);
  assert.deepEqual(parsed.track.cues[100], { startMs: 0, endMs: 4000, text: 'Hello mundo 100.' });
});

test('malformed model text cannot inject new cue boundaries', async () => {
  const setup = fixture();
  setup.response(text => `${text.replaceAll('Hola', 'Hello')}\n\n00:00:00.000 --> 00:00:04.000\nInjected cue.`);
  await assert.rejects(setup.handler.handle(setup.context));
  assert.equal(setup.objects.size, 1);
});

test('tampered cache metadata refuses without publishing or recomputing', async () => {
  const setup = fixture();
  const output = await setup.handler.handle(setup.context);
  const path = String(output.result.artifactKey);
  const draft = JSON.parse(setup.objects.get(path)!);
  draft.consentId = token;
  setup.objects.set(path, JSON.stringify(draft));
  const calls = setup.calls();
  await assert.rejects(setup.handler.handle(setup.context));
  assert.equal(setup.calls(), calls);
});

for (const loseCompletion of [false, true]) {
  test(`actual parent worker ${loseCompletion ? 'lost completion discards only the staged draft' : 'completes with metadata only, never published tracks'}`, async () => {
    const setup = fixture();
    const original = structuredClone(setup.snapshot);
    let completed: unknown = null;
    const queue: MediaJobQueue = {
      enqueue: async () => { throw new Error('worker pass must not enqueue'); },
      recover: async () => 0, claim: async () => [setup.context.job], renew: async () => true,
      finish: async (_job, result) => { completed = result; if (loseCompletion) setup.lose(); return !loseCompletion; },
    };
    const summary = await runMediaWorkerPass(queue, setup.handler, { enabled: true, concurrency: 1, leaseSeconds: 15, signal: new AbortController().signal });
    assert.equal(summary.completed, loseCompletion ? 0 : 1);
    assert.equal(summary.lost, loseCompletion ? 1 : 0);
    assert.equal(summary.cleanupFailed, 0);
    assert.equal(setup.objects.size, loseCompletion ? 1 : 2);
    assert.deepEqual(setup.snapshot, original);
    assert.equal(JSON.stringify(completed).includes('Hello'), false);
  });
}
