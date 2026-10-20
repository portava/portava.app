import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, mock, test } from 'node:test';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import express from 'express';
import router from '../routes/mediaCaptionTranslation.js';
import { _setTestClient, _clearTestClient } from '../lib/http.js';
import { _resetRateLimit } from '../lib/rateLimit.js';
import { _setTestTranslationProvider, _clearTranslationProvider } from '../lib/translation.js';
import { makeFeedDb } from './helpers/fakeFeedDb.js';
import { translationArtifactFixture } from './helpers/translationArtifactFixture.js';
import { RetainedCaptionTranslationReconciler } from '../services/media/RetainedCaptionTranslationReconciler.js';
import { readSubtitleTranslationConsent, purgeRevokedTranslationDrafts } from '../services/media/CaptionTranslationService.js';
import { readCaptionSnapshot } from '../services/media/AuthoredCaptionsService.js';
import { createSubtitleTranslationMediaJobHandler, type SubtitleTranslationContext } from '../lib/media/captions/subtitleTranslationHandler.js';
import { createConfiguredSubtitleTranslationHandler } from '../lib/media/captions/configuredSubtitleTranslationHandler.js';

const owner = '10000000-0000-4000-a000-000000000001';
const viewer = '10000000-0000-4000-a000-000000000002';
const assetId = '20000000-0000-4000-a000-000000000001';
const postId = '30000000-0000-4000-a000-000000000001';
const revision = 'a'.repeat(64);
const sourcePath = `${owner}/original.mp4`;
const originalPath = `manual-captions/${assetId}/v5-${revision}.json`;
const vtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHola #日本 @alice https://example.test/a\n';
const originalTracks = [{ language: 'es', sourceKind: 'manual', aiLabel: null, vtt, revision: 1 },
  { language: 'fr', sourceKind: 'manual', aiLabel: null, vtt: vtt.replace('Hola','Bonjour'), revision: 3 }];
const environment = { ...process.env };
const nativeFetch = globalThis.fetch;
let server: http.Server;
let port: number;
let fake: ReturnType<typeof makeFeedDb>;
let objects: Map<string,string>;
let afterUpload: (() => void) | undefined;
let afterDownload: ((path: string) => void) | undefined;
let removeFails: boolean;
let ambiguousCas: boolean;
let commitBeforeCasError: boolean;
let privateBucket: boolean;
let calls: string[];
let providerCalls: number;
let uploadFails: boolean;
let retained: ReturnType<typeof translationArtifactFixture>;
const source = () => fake.tables.media_assets[0];
const active = () => fake.tables.media_caption_translation_consents.find(grant => grant.revoked_at === null)!;
const job = () => fake.tables.media_derivative_jobs.find(row => row.id === active()?.job_id)!;
const revokeRows = () => {
  for (const grant of fake.tables.media_caption_translation_consents) grant.revoked_at = new Date().toISOString();
  for (const row of fake.tables.media_derivative_jobs) { row.state = 'cancelled'; row.result = null; row.lease_token = null; row.lease_until = null; }
};

before(async () => {
  const app = express(); app.use('/api', router);
  await new Promise<void>((resolve,reject) => { server = app.listen(0,'127.0.0.1',error => error ? reject(error) : resolve()); });
  port = (server.address() as { port:number }).port;
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  mock.method(globalThis,'fetch',async () => { assert.fail('No external provider requests'); });
  _resetRateLimit(); calls = []; providerCalls = 0; removeFails = false; ambiguousCas = false; commitBeforeCasError = false; privateBucket = true; uploadFails = false;
  afterUpload = undefined; afterDownload = undefined;
  fake = makeFeedDb({ users: { owner,viewer }, tables: {
    feature_flags: ['media_captions_enabled','media_caption_translation_enabled','media_derivative_jobs_enabled'].map(flag => ({flag,enabled:true})),
    media_assets: [{id:assetId,owner_user_id:owner,storage_bucket:'post-media',storage_path:sourcePath,media_type:'video',duration_ms:2500,
      version:5,deleted_at:null,purge_status:'not_requested',processing_status:'ready',moderation_status:'approved'}],
    post_media: [{post_id:postId,storage_path:sourcePath,public_url:`post-media/${sourcePath}`,processing_status:'ready',moderation_status:'approved'}],
    posts: [{id:postId,author_id:owner,visibility:'public',status:'active',post_status:'published'}],
    profiles: [{id:owner,account_status:'active',is_private:false},{id:viewer,account_status:'active',is_private:false}],
    media_caption_manifests: [{asset_id:assetId,source_version:5,revision_key:revision,object_path:originalPath}],
    media_caption_translation_config: [{singleton:true,enabled:true,model_version:'fixture-model',config_version:'config-1',
      allowed_pairs:[{source:'es',target:'en'}],runtime_verified_at:'2026-01-01T00:00:00Z'}],
    media_caption_translation_consents: [],media_derivative_jobs: [],media_caption_translation_epochs: [],
  } });
  objects = new Map([[sourcePath,'original-video'],[originalPath,JSON.stringify({source:source(),tracks:originalTracks,consent:true})]]);
  retained = translationArtifactFixture({ canRetire: artifact => {
    if (fake.tables.media_caption_manifests.some(row => row.object_path === artifact.storage_path) && !source()?.deleted_at) return false;
    return !source() || !!source().deleted_at || !fake.tables.media_caption_translation_consents.some(row => row.id === artifact.intent.consent_id && row.revoked_at === null);
  } });
  fake.tables.media_caption_translation_artifacts = retained.rows;
  const originalFrom = fake.client.from.bind(fake.client);
  fake.client.from = (name: string) => name === 'media_caption_translation_artifacts' ? retained.query() : originalFrom(name);
  fake.client.rpc = async (name: string, args: any) => {
    calls.push(name);
    if (name.startsWith('media_caption_translation_artifact_')) return retained.rpc(name, args);
    if (name === 'media_caption_translation_revoke') {
      if (args.p_owner_id !== source().owner_user_id) return {data:false,error:null};
      fake.tables.media_caption_translation_epochs = [{asset_id:assetId,epoch:(fake.tables.media_caption_translation_epochs[0]?.epoch ?? 0)+1}];
      for (const grant of fake.tables.media_caption_translation_consents) {
        const bound = fake.tables.media_derivative_jobs.find(row => row.id === grant.job_id);
        grant.cleanup_pending ||= Boolean(bound && bound.attempts > 0 && (!bound.completed_at || bound.attempts > 1));
      }
      revokeRows(); return {data:true,error:null};
    }
    if (name === 'media_caption_translation_enqueue') {
      assert.equal(args.p_source.version,5); assert.equal(args.p_caption_revision,revision); assert.equal(args.p_consent,true);
      const epoch = fake.tables.media_caption_translation_epochs[0]?.epoch ?? 0;
      if (args.p_expected_epoch !== epoch) return {data:null,error:null};
      if (active()) return {data:active().job_id,error:null};
      const consentId = randomUUID(), jobId = randomUUID(), jobRevision = randomBytes(32).toString('hex');
      fake.tables.media_caption_translation_consents.push({id:consentId,asset_id:assetId,owner_user_id:owner,source_version:5,consent_epoch:epoch,
        caption_revision_key:revision,job_revision_key:jobRevision,model_version:'fixture-model',config_version:'config-1',
        source_language:args.p_source_language,target_language:args.p_target_language,job_id:jobId,granted_at:new Date().toISOString(),revoked_at:null,cleanup_pending:false});
      fake.tables.media_derivative_jobs.push({id:jobId,asset_id:assetId,owner_user_id:owner,source_version:5,source_bucket:'post-media',
        source_path:sourcePath,source_bytes:128,kind:'subtitle_translation',model_version:'fixture-model',target_language:args.p_target_language,
        revision_key:jobRevision,state:'pending',attempts:0,completed_at:null,lease_token:null,lease_until:null,result:null});
      return {data:jobId,error:null};
    }
    assert.equal(name,'cas_media_caption_translation');
    assert.equal(args.p_reviewed,true);
    if (ambiguousCas && !commitBeforeCasError) return {data:null,error:{message:'unknown outcome'}};
    if (!active() || active().id !== args.p_consent_id || job().state !== 'completed'
      || fake.tables.media_caption_manifests[0].revision_key !== args.p_expected_revision
      || Object.entries(args.p_source).some(([key,value]) => source()[key] !== value)) return {data:false,error:null};
    fake.tables.media_caption_manifests = [{asset_id:assetId,source_version:5,revision_key:args.p_revision,object_path:args.p_object_path}];
    revokeRows();
    if (commitBeforeCasError) return { data: null, error: { message: 'committed, reply lost' } };
    return {data:true,error:null};
  };
  fake.client.storage = {
    async getBucket() { return {data:{id:'post-media',public:!privateBucket,allowed_mime_types:['application/json']},error:null}; },
    from(bucket: string) {
      assert.equal(bucket,'post-media');
      return {
        async upload(path: string,bytes:Buffer,options:{upsert:boolean}) {
          assert.equal(options.upsert,false); assert.notEqual(path,sourcePath); assert.notEqual(path,originalPath);
          if (objects.has(path)) return {error:{statusCode:'409'},data:null};
          objects.set(path,bytes.toString()); afterUpload?.(); return uploadFails ? { data: null, error: { message: 'unknown upload outcome' } } : {data:{id:assetId,path,fullPath:`post-media/${path}`},error:null};
        },
        async download(path:string) {
          const value = objects.get(path); afterDownload?.(path);
          return value === undefined ? {data:null,error:{statusCode:'404'}} : {data:new Blob([value]),error:null};
        },
        async remove(paths:string[]) {
          if (removeFails) return {error:{message:'fixture erasure unavailable'}};
          for (const path of paths) { assert.notEqual(path,sourcePath); objects.delete(path); }
          return {error:null};
        },
        async list(prefix:string,options:{limit:number;offset?:number}) {
          return {data:[...objects.keys()].filter(path => path.startsWith(prefix+'/')).sort()
            .slice(options.offset ?? 0,(options.offset ?? 0)+options.limit).map(path => ({name:path.slice(prefix.length+1)})),error:null};
        },
      };
    },
  };
  _setTestClient(fake.client,true);
});
afterEach(() => { mock.restoreAll(); _clearTestClient(); _clearTranslationProvider(); process.env = {...environment}; });

function request(method:string,suffix='',body?:unknown,token:string|null='owner'):Promise<{status:number;body:any;headers:http.IncomingHttpHeaders}> {
  return new Promise((resolve,reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const call = http.request({hostname:'127.0.0.1',port,method,agent:false,path:`/api/media/caption-translations/${assetId}${suffix}`,
      headers:{'content-type':'application/json',...(payload ? {'content-length':Buffer.byteLength(payload)}:{}),...(token ? {authorization:`Bearer ${token}`}:{})}},
    response => { let text=''; response.on('data',chunk => {text+=chunk;}); response.on('end',() => resolve({status:response.statusCode!,body:JSON.parse(text),headers:response.headers})); });
    call.setTimeout(5000,() => call.destroy(new Error('HTTP fixture timeout')));
    call.on('error',reject); call.end(payload);
  });
}
const enqueue = (patch:object={},token:string|null='owner') => request('POST','',{version:5,revisionKey:revision,sourceLanguage:'es',targetLanguage:'en',consent:true,
  expectedConsentEpoch:fake.tables.media_caption_translation_epochs[0]?.epoch ?? 0,...patch},token);
const jobError = (code:string,retryable:boolean) => Object.assign(new Error(code),{code,retryable});
async function claimed() {
  assert.equal((await enqueue()).status,200);
  const row = job(); row.state='processing'; row.attempts=1; row.lease_token=randomUUID(); row.lease_until=new Date(Date.now()+120000).toISOString();
  const context:SubtitleTranslationContext = {job:{id:row.id,token:row.lease_token,assetId,ownerUserId:owner,sourceVersion:5,kind:row.kind,
    bucket:row.source_bucket,path:row.source_path,sizeBytes:128,modelVersion:row.model_version,targetLanguage:row.target_language,revisionKey:row.revision_key},
    signal:new AbortController().signal,isCurrent:async () => job()?.state === 'processing'};
  return context;
}
async function completed() {
  const context = await claimed();
  const handler = createSubtitleTranslationMediaJobHandler(fake.client,{enabled:true,modelVersion:'fixture-model',configVersion:'config-1',allowedPairs:[{source:'es',target:'en'}]},{
    readCaptionSnapshot,readConsent:claimedJob => readSubtitleTranslationConsent(fake.client,claimedJob),jobError,
    provider:() => ({async detectLanguage() {throw new Error('not used');},async translateText(text) {
      providerCalls++; return {translatedText:text.replaceAll('Hola','Hello'),provider:'self-hosted',providerVersion:'fixture-model'};
    }}),
  });
  const output = await handler.handle(context);
  job().state='completed'; job().completed_at=new Date().toISOString(); job().result=output.result; job().lease_token=null; job().lease_until=null;
  return output.result;
}
const publish = (draftId:unknown,patch:object={}) => request('POST','/draft/publish',{version:5,revisionKey:revision,draftId,reviewed:true,vtt:vtt.replace('Hola','Reviewed hello'),...patch});

test('HTTP requires captured consent epoch, denies delayed opt-in after revoke and permits fresh deliberate consent',async () => {
  const firstStatus = await request('GET');
  assert.equal(firstStatus.body.consentEpoch,0);
  assert.equal((await enqueue({expectedConsentEpoch:undefined})).status,400);
  assert.equal((await enqueue({expectedConsentEpoch:0})).status,200);
  const firstJob = job().id;
  const revoked = await request('DELETE');
  assert.equal(revoked.body.consentEpoch,1);
  assert.equal((await enqueue({expectedConsentEpoch:0})).status,409);
  assert.equal(active(),undefined);
  assert.equal(fake.tables.media_derivative_jobs.length,1);
  const refreshedStatus = await request('GET');
  assert.equal((await enqueue({expectedConsentEpoch:refreshedStatus.body.consentEpoch})).status,200);
  assert.notEqual(job().id,firstJob);
});

test('HTTP does not claim completed physical erasure while a revoked writer may finish later',async () => {
  await claimed();
  const revoked = await request('DELETE');
  assert.equal(revoked.status,200); assert.equal(revoked.body.revoked,true); assert.equal(revoked.body.cleanupPending,true);
  assert.equal((await request('DELETE')).body.cleanupPending,true);
  assert.equal((await request('GET')).body.cleanupPending,true);
  assert.equal(objects.size,2);
});

test('real HTTP enqueue/status, persisted resolver, handler, protected draft and reviewed CAS preserve original language tracks',async () => {
  const output = await completed();
  assert.ok(providerCalls>0);
  const read = await request('GET','/draft?version=5');
  assert.equal(read.status,200); assert.equal(read.body.draft.draftId,output.draftId);
  assert.equal(read.body.draft.vtt,vtt.replace('Hola','Hello')); assert.match(read.headers['cache-control']!,/no-store/);
  assert.equal(JSON.stringify(read.body).includes('leaseToken'),false);
  assert.equal(objects.get(originalPath),JSON.stringify({source:source(),tracks:originalTracks,consent:true}));
  const saved = await publish(output.draftId);
  assert.equal(saved.status,200); assert.equal(saved.body.aiLabel,'AI translation · creator reviewed');
  const published = JSON.parse(objects.get(fake.tables.media_caption_manifests[0].object_path)!);
  assert.deepEqual(published.tracks.slice(0,2),originalTracks);
  assert.equal(published.tracks[2].vtt,vtt.replace('Hola','Reviewed hello'));
  assert.equal(published.tracks[2].sourceKind,'translation');
  assert.equal(source().version,5); assert.equal(objects.get(sourcePath),'original-video');
  assert.equal(objects.has(String(output.artifactKey)),false);
  assert.equal(calls.includes('cas_media_caption_manifest'),false);
  assert.equal((await request('GET','/draft?version=5')).status,404);
});

test('HTTP rejects missing explicit consent, stale generations, E2EE, viewers and unauthenticated users without enqueue',async () => {
  assert.equal((await enqueue({consent:false})).status,400);
  assert.equal((await enqueue({version:4})).status,409);
  assert.equal((await enqueue({revisionKey:'b'.repeat(64)})).status,409);
  assert.equal((await enqueue({},'viewer')).status,403);
  assert.equal((await enqueue({},null)).status,401);
  _resetRateLimit();
  fake.tables.media_attachments=[{media_asset_id:assetId,entity_type:'message',entity_id:postId}];
  assert.equal((await enqueue()).status,404);
  assert.equal(calls.length,0); assert.equal(providerCalls,0);
});

test('OFF status/revoke remain available; held deleted source cannot leak draft even when physical erasure fails',async () => {
  const output = await completed();
  removeFails=true; source().deleted_at=new Date().toISOString();
  fake.tables.feature_flags.forEach(flag => {flag.enabled=false;});
  assert.equal((await request('GET')).body.enabled,false);
  const revoked = await request('DELETE');
  assert.equal(revoked.status,200); assert.equal(revoked.body.cleanupPending,true);
  assert.equal(objects.has(String(output.artifactKey)),true);
  assert.equal((await request('GET','/draft?version=5')).status,404);
  assert.equal(fake.tables.media_derivative_jobs[0].state,'cancelled');
  removeFails=false; await purgeRevokedTranslationDrafts(fake.client,assetId);
  assert.equal(objects.has(String(output.artifactKey)),false); assert.equal(objects.has(originalPath),true);
});

test('translation consent is not ASR consent, never rebases to a newer grant, and binds lease/config/original caption revision',async () => {
  const context = await claimed();
  assert.ok(await readSubtitleTranslationConsent(fake.client,context.job));
  for (const patch of [{token:randomUUID()},{id:randomUUID()},{sourceVersion:4},{revisionKey:'c'.repeat(64)},{modelVersion:'foreign'},{sizeBytes:129}]) {
    assert.equal(await readSubtitleTranslationConsent(fake.client,{...context.job,...patch}),null);
  }
  job().lease_until=new Date(0).toISOString();
  assert.equal(await readSubtitleTranslationConsent(fake.client,context.job),null);
  job().lease_until=new Date(Date.now()+120000).toISOString();
  fake.tables.media_caption_translation_config[0].config_version='changed';
  assert.equal(await readSubtitleTranslationConsent(fake.client,context.job),null);
  fake.tables.media_caption_translation_config[0].config_version='config-1';
  fake.tables.media_caption_asr_consents=[structuredClone(active())];
  revokeRows();
  assert.equal(await readSubtitleTranslationConsent(fake.client,context.job),null);
  await enqueue();
  assert.equal(await readSubtitleTranslationConsent(fake.client,context.job),null);
});

test('late revoke after protected download refuses text delivery',async () => {
  const output = await completed();
  afterDownload=path => {if (path===output.artifactKey) revokeRows();};
  const result = await request('GET','/draft?version=5');
  assert.equal(result.status,404); assert.equal(JSON.stringify(result.body).includes('Hello'),false);
});

test('late revoke during publication refuses CAS, removes only staging and preserves originals',async () => {
  const output = await completed();
  afterUpload=revokeRows;
  const result = await publish(output.draftId);
  assert.equal(result.status,409);
  assert.equal(fake.tables.media_caption_manifests[0].revision_key,revision);
  assert.equal(objects.size,3); assert.equal(objects.has(originalPath),true);
});

test('uncertain CAS response retains staging rather than deleting a possibly committed object',async () => {
  const output = await completed();
  ambiguousCas=true;
  assert.equal((await publish(output.draftId)).status,503);
  assert.equal(objects.size,4);
  assert.equal(objects.has(originalPath),true); assert.equal(objects.has(String(output.artifactKey)),true);
});

test('actual publication preserves unsettled output on ambiguous upload after bytes arrive', async () => {
  const output = await completed(); uploadFails = true;
  const response = await publish(output.draftId);
  assert.equal(response.status,503);
  const publication = retained.rows.find(row => row.kind === 'publication');
  assert.ok(publication); assert.equal(publication.write_state,'dispatched');
  assert.ok(objects.has(publication.storage_path)); assert.ok(objects.has(originalPath));
  assert.equal(fake.tables.media_caption_manifests[0].object_path,originalPath);
  assert.ok(!calls.includes('cas_media_caption_translation'));
});

test('lost reply after committed publication reconciles without deleting the current snapshot or original captions', async () => {
  const output = await completed(); ambiguousCas = true; commitBeforeCasError = true;
  assert.equal((await publish(output.draftId)).status,503);
  const currentPath = fake.tables.media_caption_manifests[0].object_path;
  assert.notEqual(currentPath,originalPath);
  const result = await new RetainedCaptionTranslationReconciler(fake.client).runPass({assetId});
  assert.equal(result.preserved,1); assert.ok(objects.has(currentPath));
  const current = await readCaptionSnapshot(fake.client,owner,assetId,5);
  assert.deepEqual(current.tracks.filter(track => track.language !== 'en'),originalTracks);
  assert.equal(retained.rows.find(row => row.storage_path === currentPath)?.retirement_token,null);
});

for (const operation of ['reserve','dispatch','settle']) {
  test(`actual publication refuses missing ${operation} RPC without an auditless upload fallback`, async () => {
    const output = await completed();
    retained.state.failRpc = `media_caption_translation_artifact_${operation}`;
    const before = objects.size;
    assert.equal((await publish(output.draftId)).status,503);
    assert.equal(objects.size,before + (operation === 'settle' ? 1 : 0));
    assert.equal(fake.tables.media_caption_manifests[0].object_path,originalPath);
    assert.ok(!calls.includes('cas_media_caption_translation'));
  });
}

test('publication requires explicit review and validates selected draft, source provenance and private bucket',async () => {
  const output = await completed();
  assert.equal((await publish(output.draftId,{reviewed:false})).status,400);
  assert.equal((await publish('d'.repeat(64))).status,404);
  const draft = JSON.parse(objects.get(String(output.artifactKey))!);
  draft.leaseToken=randomUUID(); objects.set(String(output.artifactKey),JSON.stringify(draft));
  assert.equal((await request('GET','/draft?version=5')).status,409);
  privateBucket=false;
  assert.equal((await request('GET','/draft?version=5')).status,503);
  assert.equal(calls.filter(name => name==='cas_media_caption_translation').length,0);
});

test('configured factory is OFF by default and rejects malformed opted-in settings without work',() => {
  const settings = {MEDIA_SUBTITLE_TRANSLATION_ENABLED:'true',MEDIA_SUBTITLE_TRANSLATION_MODEL_VERSION:'fixture-model',
    MEDIA_SUBTITLE_TRANSLATION_CONFIG_VERSION:'config-1',MEDIA_SUBTITLE_TRANSLATION_ALLOWED_PAIRS:'[{"source":"es","target":"en"}]',
    TRANSLATION_SELF_HOSTED_URL:'http://127.0.0.1:9999',TRANSLATION_SELF_HOSTED_TOKEN:'fixture-local-only-token-1234567890'};
  for (const value of [undefined,'','false']) assert.equal(createConfiguredSubtitleTranslationHandler(fake.client,jobError,{MEDIA_SUBTITLE_TRANSLATION_ENABLED:value}),null);
  for (const patch of [{MEDIA_SUBTITLE_TRANSLATION_ENABLED:'TRUE'},{MEDIA_SUBTITLE_TRANSLATION_TIMEOUT_MS:'1e4'},
    {MEDIA_SUBTITLE_TRANSLATION_TIMEOUT_MS:'120001'},{MEDIA_SUBTITLE_TRANSLATION_ALLOWED_PAIRS:'[]'},
    {TRANSLATION_SELF_HOSTED_URL:'https://remote.example.test'},{TRANSLATION_SELF_HOSTED_TOKEN:'short'},
    {MEDIA_SUBTITLE_TRANSLATION_CONFIG_VERSION:''}]) assert.throws(() => createConfiguredSubtitleTranslationHandler(fake.client,jobError,{...settings,...patch}),/invalid_subtitle_configuration/);
  assert.equal(calls.length,0);
});

test('configured handler calls only independent loopback HTTP runtime despite explicit legacy OpenAI',async () => {
  const context = await claimed();
  let managedCalls=0, runtimeCalls=0;
  process.env.TRANSLATION_PROVIDER='openai';
  _setTestTranslationProvider({async detectLanguage(){managedCalls++;throw new Error('leak');},async translateText(){managedCalls++;throw new Error('leak');}});
  const runtime=http.createServer(async (req,res) => {
    assert.equal(req.url,'/v1/translate');
    let text=''; for await (const chunk of req) text+=chunk;
    const payload=JSON.parse(text); runtimeCalls++;
    assert.equal(/[#@]/.test(payload.text),false);
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({translatedText:payload.text.replaceAll('Hola','Hello'),source:'es',target:'en',providerVersion:'fixture-model'}));
  });
  await new Promise<void>(resolve => runtime.listen(0,'127.0.0.1',resolve));
  try {
    const origin=`http://127.0.0.1:${(runtime.address() as {port:number}).port}`;
    mock.method(globalThis,'fetch',(url:any,init:any) => {assert.equal(new URL(url).origin,origin);return nativeFetch(url,init);});
    const handler=createConfiguredSubtitleTranslationHandler(fake.client,jobError,{MEDIA_SUBTITLE_TRANSLATION_ENABLED:'true',
      MEDIA_SUBTITLE_TRANSLATION_MODEL_VERSION:'fixture-model',MEDIA_SUBTITLE_TRANSLATION_CONFIG_VERSION:'config-1',
      MEDIA_SUBTITLE_TRANSLATION_ALLOWED_PAIRS:'[{"source":"es","target":"en"}]',TRANSLATION_SELF_HOSTED_URL:origin,
      TRANSLATION_SELF_HOSTED_TOKEN:'fixture-local-only-token-1234567890'});
    const output=await handler!.handle(context);
    assert.equal(output.result.state,'draft_ready'); assert.ok(runtimeCalls>0); assert.equal(managedCalls,0);
  } finally {runtime.closeAllConnections();await new Promise<void>(resolve => runtime.close(() => resolve()));}
});
