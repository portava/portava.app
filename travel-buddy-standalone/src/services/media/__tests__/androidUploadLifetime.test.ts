import { it } from 'node:test';
import assert from 'node:assert/strict';
import { androidUploadTasks, type AndroidUploadModule } from '../androidBackgroundUpload.ts';
import { createUploadLifetime } from '../uploadLifetime.ts';
import { newPostcardUploadJob, runPostcardUpload, type PipelineDeps, type PostcardUploadInput } from '../postcardUploadPipeline.ts';
import { PostcardUploadQueue, queueKey } from '../postcardUploadQueue.ts';

const input: PostcardUploadInput = { asset: { uri: 'file:///private/photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', isVideo: false, fileSizeBytes: 5, width: 1, height: 1, durationSeconds: null }, visibility: 'private', location: {}, addToPassport: false };
const opts = { httpMethod: 'PUT' as const, uploadType: 0, sessionType: 0, headers: { 'Content-Type': 'image/jpeg' } };
function ownerFixture() {
  let current = true;
  let observer = () => {};
  const owner = { ownerId: 'a', sessionId: 'session-a', isCurrent: () => current, invalidate: () => { current = false; } };
  const lifetime = createUploadLifetime(owner, (check) => { observer = check; return () => {}; });
  return { lifetime, change: () => { current = false; observer(); } };
}
function nativeFixture() {
  let clearCount = 0;
  let uploadCount = 0;
  const listeners = new Map<string, ((p: { owner: string }) => void) | ((p: { id: string; totalBytesSent: number; totalBytesExpectedToSend: number }) => void)>();
  const native: AndroidUploadModule = {
    wasCancelledAsync: async () => false, cancelOwnerAsync: async () => { clearCount++; },
    bindAsync: async () => {}, clearAsync: async () => { clearCount++; }, cancelAsync: async () => {},
    uploadAsync: async () => { uploadCount++; return { status: 200 }; },
    addListener: (event, listener) => { listeners.set(event, listener); return { remove: () => { listeners.delete(event); } }; },
  };
  return { native, listeners, clears: () => clearCount, uploads: () => uploadCount };
}
it('session change clears native transfers and prevents a staged task starting', async () => {
  const { lifetime, change } = ownerFixture(); const n = nativeFixture();
  try {
    const make = await androidUploadTasks(n.native, lifetime, 'https://storage.example');
    const task = make('https://storage.example/signed', 'file:///private/part', opts);
    change();
    await assert.rejects(task.uploadAsync(), /session changed/);
    assert.equal(n.uploads(), 0); assert.equal(n.clears(), 1);
  } finally { lifetime.dispose(); }
});
it('owner change while binding cannot activate a late native upload', async () => {
  const { lifetime, change } = ownerFixture(); const n = nativeFixture(); let release!: () => void;
  n.native.bindAsync = () => new Promise<void>((r) => { release = r; });
  try {
    const binding = androidUploadTasks(n.native, lifetime, 'https://storage.example');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    change(); release();
    await assert.rejects(binding, /session changed/); assert.equal(n.uploads(), 0);
  } finally { lifetime.dispose(); }
});
it('notification cancellation aborts this job and removes its native listener', async () => {
  const { lifetime } = ownerFixture(); const n = nativeFixture();
  try {
    await androidUploadTasks(n.native, lifetime, 'https://storage.example');
    (n.listeners.get('onUploadCancelled') as (p: { owner: string }) => void)({ owner: 'different-job' });
    assert.equal(lifetime.signal.aborted, false);
    (n.listeners.get('onUploadCancelled') as (p: { owner: string }) => void)({ owner: lifetime.key });
    assert.equal(lifetime.signal.aborted, true); assert.equal(n.listeners.size, 0);
  } finally { lifetime.dispose(); }
});
function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    createShell: async () => ({ ok: true, data: { id: 'post' } }), reserveSlot: async () => ({ ok: true, data: { mediaId: 'media', uploadUrl: 'signed' } }),
    readFile: async () => ({ size: 5, slice: () => new Uint8Array(5) }), resumable: { enabled: false, transport: { api: async () => ({ status: 404, body: null, retryAfter: null }), putPart: async () => ({ status: 200, retryAfter: null }) } },
    putWhole: async () => ({ ok: true }), extractPoster: async () => null, uploadPoster: async () => null,
    complete: async () => ({ ok: true, data: {} }), discardShell: async () => {}, persist: async () => {}, now: () => 1,
    env: { sleep: async () => {}, random: () => 0 }, ...overrides,
  };
}
it('account replacement during bytes pauses the original job without publishing or deleting', async () => {
  let current = true; let completed = 0; let deleted = 0;
  const job = await runPostcardUpload(newPostcardUploadJob('job', 'a', input, 1), deps({
    isCurrent: () => current,
    putWhole: async () => { current = false; return { ok: false }; },
    complete: async () => { completed++; return { ok: true, data: {} }; }, discardShell: async () => { deleted++; },
  }));
  assert.equal(job.stage, 'slot'); assert.equal(job.retryable, true); assert.equal(completed, 0); assert.equal(deleted, 0);
});
it('queue cancel interrupts the in-flight transport and cleans the original shell once', async () => {
  const storage = new Map<string, string>(); let entered!: () => void; let disposed = 0; let deleted = 0;
  const started = new Promise<void>((r) => { entered = r; });
  let resolvePut!: (value: { ok: boolean }) => void;
  const runtime = deps({ cancel: () => { resolvePut({ ok: false }); }, dispose: () => { disposed++; },
    putWhole: () => { entered(); return new Promise((r) => { resolvePut = r; }); }, discardShell: async () => { deleted++; } });
  const queue = new PostcardUploadQueue({ storage: { getItem: async (k) => storage.get(k) ?? null, setItem: async (k, v) => { storage.set(k,v); } }, accountId: async () => 'a', now: () => 1, newId: () => 'job', deps: async () => runtime });
  await queue.enqueue(input); await started; queue.cancel('job'); await queue.resumePending();
  assert.equal(JSON.parse(storage.get(queueKey('a'))!)[0].stage, 'cancelled'); assert.equal(deleted, 1); assert.equal(disposed, 1);
});
it('cancelling during shell creation ends the job instead of silently dropping the cancel request', async () => {
  let cancelled = false;
  const job = await runPostcardUpload(newPostcardUploadJob('job', 'a', input, 1), deps({
    isCancelled: () => cancelled,
    createShell: async () => { cancelled = true; return { ok: false, retryable: true, message: 'aborted' }; },
  }));
  assert.equal(job.stage, 'cancelled');
});

it('an upload enqueued during another transfer drains without waiting for a foreground event', async () => {
  const storage = new Map<string, string>(); let entered!: () => void; let release!: () => void; let id = 0; let puts = 0;
  const started = new Promise<void>((r) => { entered = r; });
  const runtime = deps({ putWhole: async () => { puts++; if (puts === 1) { entered(); await new Promise<void>((r) => { release = r; }); } return { ok: true }; } });
  const queue = new PostcardUploadQueue({ storage: { getItem: async (k) => storage.get(k) ?? null, setItem: async (k, v) => { storage.set(k,v); } }, accountId: async () => 'a', now: () => 1, newId: () => `job-${++id}`, deps: async () => runtime });
  await queue.enqueue(input); await started; await queue.enqueue(input); release(); await queue.resumePending();
  assert.equal(puts, 2);
  assert.equal(JSON.parse(storage.get(queueKey('a'))!).filter((j: { stage: string }) => j.stage === 'done').length, 2);
});

it('a persisted notification cancellation blocks replay after a fresh JS lifetime', async () => {
  const { lifetime } = ownerFixture(); const n = nativeFixture();
  n.native.wasCancelledAsync = async () => true;
  try {
    await assert.rejects(androidUploadTasks(n.native, lifetime, 'https://storage.example'), /cancelled/);
    assert.equal(lifetime.signal.reason, 'user'); assert.equal(n.uploads(), 0);
  } finally { lifetime.dispose(); }
});

it('cancellation after media verification never publishes and retries failed cleanup after restart', async () => {
 let cancelled=false, published=0, removes=0;
 const runtime=deps({isCancelled:()=>cancelled, complete:async()=>{cancelled=true;return {ok:true,data:{}};},
  publish:async()=>{published++;return {ok:true,data:{}};}, discardShell:async()=>{if(++removes===1)throw new Error('offline');}});
 let job=await runPostcardUpload(newPostcardUploadJob('job','a',input,1),runtime);
 assert.equal(job.stage,'cancelled');assert.equal(job.cleanupPending,true);assert.equal(published,0);
 job=await runPostcardUpload(JSON.parse(JSON.stringify(job)),runtime);
 assert.equal(job.cleanupPending,false);assert.equal(removes,2);assert.equal(published,0);
});
it('cancellation while publication acknowledgement is in flight withdraws the owned operation',async()=>{
 let cancelled=false, removes=0;
 const job=await runPostcardUpload(newPostcardUploadJob('job','a',input,1),deps({isCancelled:()=>cancelled,
  publish:async()=>{cancelled=true;return {ok:true,data:{}};},discardShell:async()=>{removes++;}}));
 assert.equal(job.stage,'cancelled');assert.equal(removes,1);
});
it('a failed publication retries only publication, retains outcome identities and sends no draft input',async()=>{
 let publish=0, upload=0;
 const runtime=deps({putWhole:async()=>{upload++;return {ok:true};},publish:async()=>++publish===1?{ok:false,retryable:true,message:'network'}:{ok:true,data:{}}});
 let job=await runPostcardUpload(newPostcardUploadJob('job','a',{...input,caption:'private caption',trackOutcomes:true},1),runtime);
 assert.equal(job.stage,'verified');assert.equal(job.retryable,true);
 const failureId=job.pendingOutcomes![0]!.event_id;
 job=await runPostcardUpload(JSON.parse(JSON.stringify(job)),runtime);
 assert.equal(job.stage,'done');assert.equal(upload,1);assert.equal(job.pendingOutcomes![0]!.event_id,failureId);
 assert.deepEqual(job.pendingOutcomes!.map(e=>e.outcome),['upload_failed','published']);
 assert.equal(JSON.stringify(job.pendingOutcomes).includes('private caption'),false);
 assert.equal(JSON.stringify(job.pendingOutcomes).includes('file:///'),false);
});
it('a durable cancelled job cannot resume bytes after queue reconstruction',async()=>{
 const storage=new Map<string,string>();let puts=0;
 const paused={...newPostcardUploadJob('job','a',input,1),stage:'slot' as const,postId:'post',mediaId:'media',uploadUrl:'signed',fileSizeBytes:5,cancelRequested:true};
 storage.set(queueKey('a'),JSON.stringify([paused]));
 const queue=new PostcardUploadQueue({storage:{getItem:async k=>storage.get(k)??null,setItem:async(k,v)=>{storage.set(k,v);}},accountId:async()=> 'a',newId:()=> 'unused',now:()=>1,deps:async()=>deps({putWhole:async()=>{puts++;return {ok:true};}})});
 await queue.resumePending();assert.equal(puts,0);assert.equal((await queue.list())[0]!.stage,'cancelled');
});

it('prepared upload copies retry local cleanup without deleting the retained saved draft',async()=>{
 let cleanup=0;
 const runtime=deps({isCancelled:()=>true,releaseUploadAsset:async job=>{assert.equal(job.input.retainedDraftAssetUri,'file:///saved-original');if(++cleanup===1)throw new Error('disk');}});
 const prepared={...input,retainedDraftAssetUri:'file:///saved-original'};
 let job=await runPostcardUpload(newPostcardUploadJob('job','a',prepared,1),runtime);
 assert.equal(job.stage,'cancelled');assert.equal(job.localAssetPending,true);
 job=await runPostcardUpload(JSON.parse(JSON.stringify(job)),runtime);
 assert.equal(job.localAssetPending,false);assert.equal(cleanup,2);
});
it('account change during durable enqueue marks the old account job cancelled before it can ever publish',async()=>{
 const storage=new Map<string,string>();let account='a',published=0;
 const queue=new PostcardUploadQueue({storage:{getItem:async k=>storage.get(k)??null,setItem:async(k,v)=>{storage.set(k,v);account='b';}},accountId:async()=>account,newId:()=> 'job',now:()=>1,deps:async()=>deps({publish:async()=>{published++;return {ok:true,data:{}};}})});
 assert.equal(await queue.enqueue(input,{start:false}),null);assert.equal(JSON.parse(storage.get(queueKey('a'))!)[0].cancelRequested,true);
 account='a';await queue.resumePending();assert.equal(published,0);
});

it('cancellation during publication journal acknowledgement retains the draft and retries withdrawal',async()=>{
 let cancelled=false,cleared=0,removed=0,doneEmitted=0;
 const job=await runPostcardUpload(newPostcardUploadJob('job','a',{...input,draftKey:'draft'},1),deps({publish:async()=>({ok:true,data:{}}),persist:async job=>{if(job.stage==='done')cancelled=true;},finishLocalDraft:async()=>{cleared++;},discardShell:async()=>{removed++;}}),{isCancelled:()=>cancelled,onStage:job=>{if(job.stage==='done')doneEmitted++;}});
 assert.equal(job.stage,'cancelled');assert.equal(removed,1);assert.equal(cleared,0);assert.equal(doneEmitted,0);
});

it('cancellation of an acknowledged job persists one cancellation outcome and retains the saved draft', async () => {
 const storage=new Map<string,string>();let cleared=0,removed=0;const events:string[]=[];
 const done={...newPostcardUploadJob('job','a',{...input,trackOutcomes:true},1),stage:'done' as const,postId:'post',mediaId:'media',localDraftPending:true};
 storage.set(queueKey('a'),JSON.stringify([done]));
 const queue=new PostcardUploadQueue({storage:{getItem:async k=>storage.get(k)??null,setItem:async(k,v)=>{storage.set(k,v);}},accountId:async()=> 'a',newId:()=> 'unused',now:()=>1,deps:async()=>deps({finishLocalDraft:async()=>{cleared++;},discardShell:async()=>{removed++;},recordOutcome:async event=>{events.push(event.outcome);return true;}})});
 await queue.cancel('job');await queue.resumePending();await queue.resumePending();
 assert.equal(cleared,0);assert.equal(removed,1);assert.deepEqual(events,['upload_cancelled']);
 const saved=(await queue.list())[0]!;assert.equal(saved.stage,'cancelled');assert.equal(saved.localDraftPending,false);assert.equal(saved.cleanupPending,false);
});

it('exhausted retries still deliver a structured failure outcome', async () => {
 const storage=new Map<string,string>();const events:string[]=[];
 const paused={...newPostcardUploadJob('job','a',{...input,trackOutcomes:true},1),stage:'slot' as const,postId:'post',mediaId:'media',runs:100};
 storage.set(queueKey('a'),JSON.stringify([paused]));
 const queue=new PostcardUploadQueue({storage:{getItem:async k=>storage.get(k)??null,setItem:async(k,v)=>{storage.set(k,v);}},accountId:async()=> 'a',newId:()=> 'unused',now:()=>1,deps:async()=>deps({recordOutcome:async event=>{events.push(event.outcome);assert.equal(event.failure_code,'unknown');return true;}})});
 await queue.resumePending();await queue.resumePending();
 assert.deepEqual(events,['upload_failed']);assert.equal((await queue.list())[0]!.stage,'failed');
});
