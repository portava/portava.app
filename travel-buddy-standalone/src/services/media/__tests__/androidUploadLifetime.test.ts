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
