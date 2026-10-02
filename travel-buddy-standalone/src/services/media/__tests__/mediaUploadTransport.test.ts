/**
 * Media §37 — upload resume / retry (MD281), background upload (MD284) and the
 * client processing module (MD320), exercised end to end against an IN-MEMORY
 * implementation of the server's session protocol
 * (artifacts/api-server/src/routes/postcardMediaTransport.ts).
 *
 * The fake server keeps real bytes: every assertion that an upload "resumed"
 * or "completed" is checked against the assembled object byte for byte, not
 * against a counter.
 *
 * Pure node:test — no react-native, no network.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  backoffDelayMs,
  classifyStatus,
  parseRetryAfter,
  withRetry,
} from '../uploadRetry.ts';
import {
  uploadSlotResumable,
  type FileLike,
  type ResumableTransport,
} from '../resumableUpload.ts';
import {
  newPostcardUploadJob,
  runPostcardUpload,
  type PipelineDeps,
  type PostcardUploadInput,
  type PostcardUploadJob,
} from '../postcardUploadPipeline.ts';
import { MAX_RUNS, PostcardUploadQueue, queueKey, type QueueRuntime } from '../postcardUploadQueue.ts';
import { backgroundFile, backgroundPartTransport, type FsLike, type PartDescriptor } from '../backgroundTransfer.ts';
import {
  _setTestMediaNatives,
  extractVideoPoster,
  imageUploadPlan,
  normalizePickedAsset,
  prepareImageForUpload,
  SERVER_MAX_IMAGE_BYTES,
  SERVER_MAX_IMAGE_DIM,
} from '../mediaProcessing.ts';
import { _setTestResumableUploadFlag, isResumableMediaUploadEnabled } from '../uploadTransportFlag.ts';

const CHUNK = 64;

// ── A byte-accurate fake of the server session protocol ───────────────────────

class FakeFile implements FileLike {
  constructor(public readonly bytes: Uint8Array) {}
  get size() { return this.bytes.length; }
  slice(start: number, end: number): Uint8Array { return this.bytes.slice(start, end); }
}

function bytesOf(n: number, seed = 7): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  return b;
}

interface FakeServer {
  transport: ResumableTransport;
  parts: Map<number, Uint8Array>;
  assembled: Uint8Array | null;
  puts: number[];
  sessions: number;
  /** Queue of forced outcomes for the next part PUTs: a status, or 'throw' for no answer. */
  putScript: Array<number | 'throw'>;
  sessionScript: Array<number | 'throw'>;
  assembleScript: Array<number | 'throw'>;
  totalBytes: number;
  supported: boolean;
  urlGeneration: number;
  expiredBefore: number;
}

function fakeServer(totalBytes: number): FakeServer {
  const srv: FakeServer = {
    parts: new Map(),
    assembled: null,
    puts: [],
    sessions: 0,
    putScript: [],
    sessionScript: [],
    assembleScript: [],
    totalBytes,
    supported: true,
    urlGeneration: 0,
    expiredBefore: 0,
    transport: null as unknown as ResumableTransport,
  };
  const partCount = () => Math.ceil(srv.totalBytes / CHUNK);
  const partSize = (i: number) => (i < partCount() - 1 ? CHUNK : srv.totalBytes - CHUNK * (partCount() - 1));
  srv.transport = {
    async api(method, path) {
      if (method === 'DELETE') { srv.parts.clear(); return { status: 200, body: {}, retryAfter: null }; }
      if (path.endsWith('/assemble')) {
        const forced = srv.assembleScript.shift();
        if (forced === 'throw') throw new Error('network');
        if (forced) return { status: forced, body: {}, retryAfter: null };
        for (let i = 0; i < partCount(); i++) {
          if (srv.parts.get(i)?.length !== partSize(i)) return { status: 409, body: { error: 'conflict' }, retryAfter: null };
        }
        const out = new Uint8Array(srv.totalBytes);
        for (let i = 0; i < partCount(); i++) out.set(srv.parts.get(i)!, i * CHUNK);
        srv.assembled = out;
        srv.parts.clear();
        return { status: 200, body: { assembled: true }, retryAfter: null };
      }
      const forced = srv.sessionScript.shift();
      if (forced === 'throw') throw new Error('network');
      if (forced) return { status: forced, body: forced === 404 ? { error: 'feature_disabled' } : {}, retryAfter: null };
      if (!srv.supported) return { status: 404, body: '<html>Cannot POST</html>', retryAfter: null };
      srv.sessions++;
      srv.urlGeneration++;
      const received: number[] = [];
      const missing: Array<{ index: number; size: number; uploadUrl: string }> = [];
      let receivedBytes = 0;
      for (let i = 0; i < partCount(); i++) {
        if (srv.parts.get(i)?.length === partSize(i)) { received.push(i); receivedBytes += partSize(i); }
        else missing.push({ index: i, size: partSize(i), uploadUrl: `https://storage.test/part/${i}?gen=${srv.urlGeneration}` });
      }
      return {
        status: 200,
        body: { chunkBytes: CHUNK, totalBytes: srv.totalBytes, partCount: partCount(), receivedParts: received, receivedBytes, missingParts: missing, complete: missing.length === 0 },
        retryAfter: null,
      };
    },
    async putPart(url, part, _ct, onSent) {
      const index = Number(/part\/(\d+)/.exec(url)![1]);
      const gen = Number(/gen=(\d+)/.exec(url)![1]);
      srv.puts.push(index);
      const forced = srv.putScript.shift();
      if (forced === 'throw') throw new Error('Network error during upload');
      if (forced) return { status: forced, retryAfter: null };
      if (gen < srv.expiredBefore) return { status: 400, retryAfter: null }; // an expired signature
      const bytes = part as Uint8Array;
      onSent?.(bytes.length);
      srv.parts.set(index, bytes);
      return { status: 200, retryAfter: null };
    },
  };
  return srv;
}

const sleeps: number[] = [];
const env = {
  sleep: async (ms: number) => { sleeps.push(ms); },
  random: () => 0.5,
  retry: { maxAttempts: 4, baseMs: 100, maxMs: 1000 },
};

beforeEach(() => { sleeps.length = 0; });

// ── uploadRetry ───────────────────────────────────────────────────────────────

describe('MD281 — what is retried, and how long the client waits', () => {
  it('retries no-answer, 408/425/429 and 5xx; never another 4xx', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504]) assert.equal(classifyStatus(s).kind, 'retry', `HTTP ${s}`);
    for (const s of [400, 401, 403, 404, 409, 413, 422]) assert.equal(classifyStatus(s).kind, 'fail', `HTTP ${s}`);
    assert.equal(classifyStatus(204).kind, 'ok');
  });
  it("honours Retry-After (seconds or a date), capped at two minutes", () => {
    assert.equal(parseRetryAfter('3'), 3000);
    assert.equal(parseRetryAfter('99999'), 120_000);
    assert.equal(parseRetryAfter(new Date(10_000).toUTCString(), 4_000), 6_000);
    assert.equal(parseRetryAfter('soon'), null);
  });
  it('full-jitter exponential backoff stays inside [0, min(max, base·2^(n-1))]', () => {
    assert.equal(backoffDelayMs(1, { baseMs: 100, maxMs: 1000 }, () => 0.999), 99);
    assert.equal(backoffDelayMs(4, { baseMs: 100, maxMs: 1000 }, () => 0.999), 799);
    assert.equal(backoffDelayMs(9, { baseMs: 100, maxMs: 1000 }, () => 0.999), 999);
    assert.equal(backoffDelayMs(9, { baseMs: 100, maxMs: 1000 }, () => 0), 0);
  });
  it('a thrown request is retried; a refusal is not; exhaustion is PAUSED (retryable), not refused', async () => {
    let n = 0;
    const r = await withRetry(async () => {
      n++;
      if (n < 3) throw new Error('offline');
      return { kind: 'done', value: 'ok' };
    }, { ...env.retry, sleep: env.sleep, random: env.random });
    assert.deepEqual(r, { ok: true, value: 'ok', attempts: 3 });
    const refused = await withRetry(async () => ({ kind: 'fail', reason: 'no', status: 403 }), { ...env.retry, sleep: env.sleep, random: env.random });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.retryable, false);
    assert.equal(!refused.ok && refused.attempts, 1);
    const flaky = await withRetry(async () => ({ kind: 'retry', reason: '503' }), { ...env.retry, sleep: env.sleep, random: env.random });
    assert.equal(!flaky.ok && flaky.retryable, true);
    assert.equal(!flaky.ok && flaky.attempts, 4);
  });
});

// ── resumableUpload ───────────────────────────────────────────────────────────

describe('MD281 — a slot is filled in parts, and an interrupted upload resumes', () => {
  const SLOT = { postId: 'p1', mediaId: 'm1' };

  it('a fresh upload sends every part once and assembles the exact bytes', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 3 + 10));
    const srv = fakeServer(file.size);
    const progress: number[] = [];
    const r = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env, (f) => progress.push(f));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(srv.puts, [0, 1, 2, 3]);
    assert.deepEqual([...srv.assembled!], [...file.bytes]);
    assert.equal(progress.at(-1), 1);
  });

  it('RESUME: parts already in storage are not sent again, and progress starts where it left off', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 4));
    const srv = fakeServer(file.size);
    srv.parts.set(0, file.slice(0, CHUNK));
    srv.parts.set(1, file.slice(CHUNK, 2 * CHUNK));
    const progress: number[] = [];
    const r = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env, (f) => progress.push(f));
    assert.equal(r.ok, true);
    assert.deepEqual(srv.puts, [2, 3], 'only the missing parts travel');
    assert.equal(progress[0], 0.5, 'a resumed upload reports 50 %, not 0 %');
    assert.equal(r.ok && r.resumedFromBytes, CHUNK * 2);
    assert.deepEqual([...srv.assembled!], [...file.bytes]);
  });

  it('RETRY: a part that gets no answer twice is sent again and the upload completes', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 2));
    const srv = fakeServer(file.size);
    srv.putScript = ['throw', 503];
    const r = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env);
    assert.equal(r.ok, true);
    assert.deepEqual(srv.puts, [0, 0, 0, 1]);
    assert.equal(sleeps.length, 2, 'it waited before each retry');
  });

  it('an EXPIRED signed URL is replaced by a fresh session, not retried as-is', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 2));
    const srv = fakeServer(file.size);
    srv.expiredBefore = 2; // URLs from the first session are expired
    const r = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(srv.sessions, 2);
    assert.deepEqual([...srv.assembled!], [...file.bytes]);
  });

  it('a server with no session route is UNSUPPORTED (the caller falls back), not a failure', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const srv = fakeServer(file.size);
    srv.supported = false;
    const r = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env);
    assert.deepEqual(r.ok === false && 'unsupported' in r && r.unsupported, true);
  });

  it('the emergency stop (404 feature_disabled) is a refusal, never "unsupported"', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const srv = fakeServer(file.size);
    srv.sessionScript = [404];
    const r = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env);
    assert.equal(r.ok, false);
    assert.equal('unsupported' in r && r.unsupported, false);
    assert.equal(!r.ok && 'retryable' in r && r.retryable, false);
  });

  it('a file that is not the size the slot was reserved for is refused', async () => {
    const srv = fakeServer(CHUNK * 2);
    const r = await uploadSlotResumable(SLOT, new FakeFile(bytesOf(CHUNK * 2 + 1)), 'video/mp4', srv.transport, env);
    assert.equal(r.ok, false);
    assert.equal(srv.puts.length, 0);
  });

  it('a network that stays down PAUSES (retryable) — and the next run resumes from what landed', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 3));
    const srv = fakeServer(file.size);
    // Part 0 lands; every later PUT in this run gets no answer.
    const put = srv.transport.putPart;
    let calls = 0;
    srv.transport.putPart = async (u, p, c, s) => {
      calls++;
      if (calls >= 2) throw new Error('offline');
      return put(u, p, c, s);
    };
    const first = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env);
    srv.transport.putPart = put;
    assert.equal(first.ok, false);
    assert.equal(!first.ok && 'retryable' in first && first.retryable, true, 'paused, not refused');
    assert.equal(srv.parts.has(0), true);
    srv.puts.length = 0;
    const second = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, env);
    assert.equal(second.ok, true);
    assert.deepEqual(srv.puts, [1, 2], 'the second run starts at the first missing part');
    assert.deepEqual([...srv.assembled!], [...file.bytes]);
  });

  it('cancellation stops between parts and reports cancelled', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 3));
    const srv = fakeServer(file.size);
    let cancel = false;
    const put = srv.transport.putPart;
    srv.transport.putPart = async (u, p, c, s) => { const r = await put(u, p, c, s); cancel = true; return r; };
    const r = await uploadSlotResumable(SLOT, file, 'video/mp4', srv.transport, { ...env, isCancelled: () => cancel });
    assert.equal(!r.ok && 'cancelled' in r && r.cancelled, true);
    assert.equal(srv.assembled, null);
  });
});

// ── postcardUploadPipeline ────────────────────────────────────────────────────

interface Calls {
  shells: number;
  slots: number;
  discarded: string[];
  completed: Array<Record<string, unknown>>;
  posters: number;
  wholePuts: number;
  persisted: PostcardUploadJob[];
}

function input(overrides: Partial<PostcardUploadInput['asset']> = {}, size = CHUNK * 3): PostcardUploadInput {
  return {
    asset: {
      uri: 'file:///clip.mp4', mimeType: 'video/mp4', fileName: 'clip.mp4', fileSizeBytes: size,
      width: 1080, height: 1920, isVideo: true, durationSeconds: 12, ...overrides,
    },
    caption: 'sunset', visibility: 'public', location: { locationCity: 'Da Nang' }, addToPassport: true,
  };
}

function pipelineDeps(srv: FakeServer, file: FakeFile, calls: Calls, over: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    createShell: async () => { calls.shells++; return { ok: true, data: { id: 'post-1' } }; },
    reserveSlot: async () => { calls.slots++; return { ok: true, data: { mediaId: 'media-1', uploadUrl: 'https://storage.test/whole' } }; },
    readFile: async () => file,
    resumable: { enabled: true, transport: srv.transport },
    putWhole: async () => { calls.wholePuts++; srv.assembled = file.bytes; return { ok: true }; },
    extractPoster: async () => 'file:///frame.jpg',
    uploadPoster: async () => { calls.posters++; return 'u/post-1/media-1.mp4.poster.jpg'; },
    complete: async (_p, _m, params) => { calls.completed.push(params); return { ok: true, data: {} }; },
    discardShell: async (id) => { calls.discarded.push(id); },
    persist: async (j) => { calls.persisted.push(j); },
    now: () => 1_000,
    env,
    ...over,
  };
}

function freshCalls(): Calls {
  return { shells: 0, slots: 0, discarded: [], completed: [], posters: 0, wholePuts: 0, persisted: [] };
}

describe('MD281/MD284 — the postcard upload is a resumable, persisted sequence of stages', () => {
  it('runs shell → slot → bytes → poster → done, persisting every stage, poster linked at /complete', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 3));
    const srv = fakeServer(file.size);
    const calls = freshCalls();
    const job = await runPostcardUpload(newPostcardUploadJob('j1', 'acct', input(), 1_000), pipelineDeps(srv, file, calls));
    assert.equal(job.stage, 'done');
    assert.deepEqual(calls.persisted.map((j) => j.stage), ['shell', 'slot', 'slot', 'bytes', 'poster', 'done']);
    assert.equal(calls.completed[0]!.thumbnailPath, 'u/post-1/media-1.mp4.poster.jpg');
    assert.deepEqual([...srv.assembled!], [...file.bytes]);
    assert.deepEqual(calls.discarded, []);
  });

  it('a job re-entered at `slot` (the app died mid-upload) neither re-creates the post nor re-sends landed parts', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 3));
    const srv = fakeServer(file.size);
    srv.parts.set(0, file.slice(0, CHUNK));
    const calls = freshCalls();
    const interrupted: PostcardUploadJob = {
      ...newPostcardUploadJob('j2', 'acct', input(), 1_000),
      stage: 'slot', postId: 'post-1', mediaId: 'media-1', uploadUrl: 'https://storage.test/whole', fileSizeBytes: file.size, transport: 'resumable', runs: 1,
    };
    const job = await runPostcardUpload(interrupted, pipelineDeps(srv, file, calls));
    assert.equal(job.stage, 'done');
    assert.equal(calls.shells, 0);
    assert.equal(calls.slots, 0);
    assert.deepEqual(srv.puts, [1, 2]);
  });

  it('a network outage PAUSES the job at its stage — the post shell is kept for the resume', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 2));
    const srv = fakeServer(file.size);
    srv.transport.putPart = async () => { throw new Error('offline'); };
    const calls = freshCalls();
    const job = await runPostcardUpload(newPostcardUploadJob('j3', 'acct', input({}, file.size), 1_000), pipelineDeps(srv, file, calls));
    assert.equal(job.stage, 'slot');
    assert.equal(job.retryable, true);
    assert.deepEqual(calls.discarded, [], 'a paused upload keeps its post shell');
  });

  it('a REFUSAL fails the job and discards the shell, as the composer always has', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const srv = fakeServer(file.size);
    const calls = freshCalls();
    const job = await runPostcardUpload(
      newPostcardUploadJob('j4', 'acct', input({}, file.size), 1_000),
      pipelineDeps(srv, file, calls, { complete: async () => ({ ok: false, message: 'invalid_payload' }) }),
    );
    assert.equal(job.stage, 'failed');
    assert.deepEqual(calls.discarded, ['post-1']);
  });

  it('a transient /complete failure pauses rather than discarding a fully uploaded post', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const srv = fakeServer(file.size);
    const calls = freshCalls();
    const job = await runPostcardUpload(
      newPostcardUploadJob('j5', 'acct', input({}, file.size), 1_000),
      pipelineDeps(srv, file, calls, { complete: async () => ({ ok: false, message: '503', retryable: true }) }),
    );
    assert.equal(job.stage, 'poster');
    assert.equal(job.retryable, true);
    assert.deepEqual(calls.discarded, []);
  });

  it('no session route → ONE signed PUT (retried), then the same poster + complete', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 2));
    const srv = fakeServer(file.size);
    srv.supported = false;
    const calls = freshCalls();
    let n = 0;
    const job = await runPostcardUpload(
      newPostcardUploadJob('j6', 'acct', input({}, file.size), 1_000),
      pipelineDeps(srv, file, calls, {
        putWhole: async () => { n++; calls.wholePuts++; return n < 2 ? { ok: false, status: null, message: 'offline' } : { ok: true }; },
      }),
    );
    assert.equal(job.stage, 'done');
    assert.equal(job.transport, 'single');
    assert.equal(calls.wholePuts, 2);
  });

  it('an image never asks for a poster; a video whose frame cannot be extracted still posts', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const calls = freshCalls();
    await runPostcardUpload(
      newPostcardUploadJob('j7', 'acct', input({ isVideo: false, mimeType: 'image/jpeg', uri: 'file:///p.jpg' }, file.size), 1_000),
      pipelineDeps(fakeServer(file.size), file, calls),
    );
    assert.equal(calls.posters, 0);
    const calls2 = freshCalls();
    const job = await runPostcardUpload(
      newPostcardUploadJob('j8', 'acct', input({}, file.size), 1_000),
      pipelineDeps(fakeServer(file.size), file, calls2, { extractPoster: async () => null }),
    );
    assert.equal(job.stage, 'done');
    assert.equal(calls2.completed[0]!.thumbnailPath, undefined);
  });

  it('cancel discards the shell and abandons the session', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 2));
    const srv = fakeServer(file.size);
    const calls = freshCalls();
    let stages = 0;
    const job = await runPostcardUpload(
      newPostcardUploadJob('j9', 'acct', input({}, file.size), 1_000),
      pipelineDeps(srv, file, calls),
      { onStage: () => { stages++; }, isCancelled: () => stages >= 2 },
    );
    assert.equal(job.stage, 'cancelled');
    assert.deepEqual(calls.discarded, ['post-1']);
  });

  it('an unreported file size is read from the bytes before the slot is reserved (the slot size is exact)', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 2 + 5));
    const srv = fakeServer(file.size);
    const calls = freshCalls();
    let reserved = -1;
    const job = await runPostcardUpload(
      newPostcardUploadJob('j10', 'acct', input({ fileSizeBytes: null }), 1_000),
      pipelineDeps(srv, file, calls, { reserveSlot: async (_p, params) => { reserved = params.fileSizeBytes; return { ok: true, data: { mediaId: 'media-1', uploadUrl: 'u' } }; } }),
    );
    assert.equal(reserved, file.size);
    assert.equal(job.stage, 'done');
  });
});

// ── postcardUploadQueue ───────────────────────────────────────────────────────

function memoryStorage() {
  const map = new Map<string, string>();
  return { map, getItem: async (k: string) => map.get(k) ?? null, setItem: async (k: string, v: string) => { map.set(k, v); } };
}

describe('MD284 — the queue owns the upload: it survives the screen, the app and the process', () => {
  let storage: ReturnType<typeof memoryStorage>;
  let account: string | null;
  beforeEach(() => { storage = memoryStorage(); account = 'acct-A'; });

  function runtime(deps: Omit<PipelineDeps, 'persist'>): QueueRuntime {
    let id = 0;
    return { storage, accountId: async () => account, newId: () => `job-${++id}`, now: () => 1_000 + id, deps: async () => deps };
  }

  it('a job is DURABLE before its first request, and a NEW process resumes it to done without re-creating the post', async () => {
    const file = new FakeFile(bytesOf(CHUNK * 3));
    const srv = fakeServer(file.size);
    const calls = freshCalls();
    // Process 1: the network drops after part 0.
    let putCalls = 0;
    const put = srv.transport.putPart;
    const offline: ResumableTransport = { api: srv.transport.api, putPart: async (u, p, c, s) => { if (++putCalls > 1) throw new Error('offline'); return put(u, p, c, s); } };
    const q1 = new PostcardUploadQueue(runtime(pipelineDeps({ ...srv, transport: offline }, file, calls)));
    const job = await q1.enqueue(input({}, file.size));
    assert.ok(job);
    await q1.resumePending();
    const stored = JSON.parse(storage.map.get(queueKey('acct-A'))!) as PostcardUploadJob[];
    assert.equal(stored[0]!.stage, 'slot');
    assert.equal(stored[0]!.retryable, true);
    assert.equal(stored[0]!.postId, 'post-1');
    // Process 2: a fresh queue over the same storage — what a relaunch is.
    srv.puts.length = 0;
    const q2 = new PostcardUploadQueue(runtime(pipelineDeps(srv, file, calls)));
    await q2.resumePending();
    const after = (await q2.list())[0]!;
    assert.equal(after.stage, 'done');
    assert.equal(calls.shells, 1, 'the post was created once, across both processes');
    assert.deepEqual(srv.puts, [1, 2], 'part 0 was not sent again');
    assert.deepEqual([...srv.assembled!], [...file.bytes]);
  });

  it('never runs a job under another account, and enqueues nothing with no account', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const calls = freshCalls();
    const q = new PostcardUploadQueue(runtime(pipelineDeps(fakeServer(file.size), file, calls, {
      createShell: async () => { calls.shells++; return { ok: false, message: 'offline', retryable: true }; },
    })));
    await q.enqueue(input({}, file.size));
    await q.resumePending();
    account = 'acct-B';
    const before = calls.shells;
    await q.resumePending();
    assert.equal(calls.shells, before, "account B's session never runs account A's job");
    assert.deepEqual(await q.list(), [], "and account B cannot see it");
    account = null;
    assert.equal(await q.enqueue(input({}, file.size)), null);
  });

  it('an account switch DURING a run stops the run before the next job starts', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const calls = freshCalls();
    const q = new PostcardUploadQueue(runtime(pipelineDeps(fakeServer(file.size), file, calls, {
      createShell: async () => {
        calls.shells++;
        account = 'acct-B'; // the user signs out and another signs in mid-upload
        return { ok: false, message: 'offline', retryable: true };
      },
    })));
    // Two jobs for account A, recorded without running.
    const stored = [1, 2].map((n) => newPostcardUploadJob(`a-${n}`, 'acct-A', input({}, file.size), 1_000 + n));
    await storage.setItem(queueKey('acct-A'), JSON.stringify(stored));
    await q.resumePending();
    assert.equal(calls.shells, 1, "the second job of account A never starts under account B's session");
  });

  it('a job that keeps pausing is given up after MAX_RUNS, and its shell discarded', async () => {
    const file = new FakeFile(bytesOf(CHUNK));
    const calls = freshCalls();
    const srv = fakeServer(file.size);
    srv.transport.putPart = async () => { throw new Error('offline'); };
    const q = new PostcardUploadQueue(runtime(pipelineDeps(srv, file, calls)));
    await q.enqueue(input({}, file.size));
    for (let i = 0; i < MAX_RUNS + 1; i++) await q.resumePending();
    const [j] = await q.list();
    assert.equal(j!.stage, 'failed');
    assert.deepEqual(calls.discarded, ['post-1']);
  });

  it('ships OFF: the transport flag defaults false until a device run proves it', () => {
    _setTestResumableUploadFlag(null);
    assert.equal(isResumableMediaUploadEnabled(), false);
  });
});

// ── backgroundTransfer ────────────────────────────────────────────────────────

describe('MD284 — each part is an OS BACKGROUND transfer of exactly its byte range', () => {
  function fakeFs(fileBytes: Uint8Array, result: { status: number } | null | 'throw' = { status: 200 }) {
    const files = new Map<string, Uint8Array>([['file:///clip.mp4', fileBytes]]);
    const tasks: Array<{ url: string; fileUri: string; options: Record<string, unknown>; body: Uint8Array }> = [];
    const fs: FsLike = {
      cacheDirectory: 'file:///cache/',
      sessionBackground: 0,
      uploadBinary: 0,
      getInfoAsync: async (uri) => ({ exists: files.has(uri), size: files.get(uri)?.length }),
      readAsStringAsync: async (uri, o) => Buffer.from(files.get(uri)!.slice(o.position, o.position + o.length)).toString('base64'),
      writeAsStringAsync: async (uri, contents) => { files.set(uri, new Uint8Array(Buffer.from(contents, 'base64'))); },
      deleteAsync: async (uri) => { files.delete(uri); },
      createUploadTask: (url, fileUri, options) => ({
        uploadAsync: async () => {
          tasks.push({ url, fileUri, options: options as unknown as Record<string, unknown>, body: files.get(fileUri)! });
          if (result === 'throw') throw new Error('task failed');
          return result;
        },
      }),
    };
    return { fs, files, tasks };
  }

  it('writes the part file from the exact range, uploads it as a BACKGROUND binary PUT, then deletes it', async () => {
    const bytes = bytesOf(300);
    const { fs, files, tasks } = fakeFs(bytes);
    const file = await backgroundFile('file:///clip.mp4', fs);
    assert.equal(file.size, 300);
    const t = backgroundPartTransport(async () => ({ status: 200, body: {}, retryAfter: null }), fs);
    const r = await t.putPart('https://storage.test/part/1', file.slice(100, 200) as PartDescriptor, 'video/mp4');
    assert.equal(r.status, 200);
    assert.equal(tasks.length, 1);
    assert.deepEqual([...tasks[0]!.body], [...bytes.slice(100, 200)]);
    assert.equal(tasks[0]!.options.httpMethod, 'PUT');
    assert.equal(tasks[0]!.options.sessionType, fs.sessionBackground);
    assert.equal(tasks[0]!.options.uploadType, fs.uploadBinary);
    assert.deepEqual([...files.keys()], ['file:///clip.mp4'], 'the part file is removed after the transfer');
  });

  it('a transfer with no result is "no answer" (throws → retryable), and its part file is still removed', async () => {
    const { fs, files } = fakeFs(bytesOf(50), null);
    const t = backgroundPartTransport(async () => ({ status: 200, body: {}, retryAfter: null }), fs);
    await assert.rejects(t.putPart('u', (await backgroundFile('file:///clip.mp4', fs)).slice(0, 50), 'video/mp4'));
    assert.deepEqual([...files.keys()], ['file:///clip.mp4']);
  });

  it('a file the OS has already reclaimed cannot be opened for upload', async () => {
    const { fs } = fakeFs(bytesOf(10));
    await assert.rejects(backgroundFile('file:///gone.mp4', fs));
  });
});

// ── mediaProcessing (MD320) ───────────────────────────────────────────────────

describe('MD320 — the device enforces the server envelope before a byte travels', () => {
  it('normalises a pick: video duration ms → whole seconds, unknown size stays unknown', () => {
    const v = normalizePickedAsset({ uri: 'u', type: 'video', duration: 12_400, fileSize: 0, width: 1080, height: 1920 });
    assert.equal(v.isVideo, true);
    assert.equal(v.mimeType, 'video/mp4');
    assert.equal(v.durationSeconds, 12);
    assert.equal(v.fileSizeBytes, null);
    const p = normalizePickedAsset({ uri: 'u', mimeType: 'image/png', fileSize: 2048 });
    assert.equal(p.isVideo, false);
    assert.equal(p.durationSeconds, null);
    assert.equal(p.fileName, 'upload.png');
  });

  it('plans a resize only OUTSIDE the envelope: > 4096 px edge, or > 15 MB', () => {
    assert.deepEqual(imageUploadPlan(4032, 3024, 6_000_000), { action: 'as_is' });
    assert.deepEqual(imageUploadPlan(8000, 6000, 20_000_000), { action: 'resize', resize: { width: 4096 }, reason: 'exceeds_dimension' });
    assert.deepEqual(imageUploadPlan(3000, 12000, 1_000), { action: 'resize', resize: { height: 4096 }, reason: 'exceeds_dimension' });
    assert.deepEqual(imageUploadPlan(4000, 3000, 16 * 1024 * 1024), { action: 'resize', resize: { width: 2800 }, reason: 'exceeds_bytes' });
    assert.deepEqual(imageUploadPlan(null, null, null), { action: 'as_is' });
  });

  it('resizes when required, fails CLOSED when a required resize fails, and never touches a video', async () => {
    const seen: unknown[] = [];
    _setTestMediaNatives({ manipulate: async (uri, actions) => { seen.push(actions); return { uri: `${uri}.jpg`, width: 4096, height: 3072 }; } });
    const big = normalizePickedAsset({ uri: 'file:///big.heic', mimeType: 'image/heic', width: 8000, height: 6000, fileSize: 30_000_000 });
    const r = await prepareImageForUpload(big);
    assert.equal(r.ok && r.resized, true);
    assert.equal(r.ok && r.asset.mimeType, 'image/jpeg');
    assert.deepEqual(seen, [[{ resize: { width: 4096 } }]]);
    const small = await prepareImageForUpload(normalizePickedAsset({ uri: 'file:///s.jpg', width: 1200, height: 900, fileSize: 400_000 }));
    assert.equal(small.ok && small.resized, false);
    assert.equal(seen.length, 1, 'an in-envelope photo is never re-encoded');
    _setTestMediaNatives({ manipulate: async () => { throw new Error('native failure'); } });
    const failed = await prepareImageForUpload(big);
    assert.equal(failed.ok, false, 'the oversized original is never sent in place of a failed resize');
    const video = await prepareImageForUpload(normalizePickedAsset({ uri: 'v', type: 'video', width: 9000, height: 9000 }));
    assert.equal(video.ok && video.resized, false);
    _setTestMediaNatives({ manipulate: null });
  });

  it('a poster frame is taken past the first frame, and a failed extraction is null, never a throw', async () => {
    let asked: number | null = null;
    _setTestMediaNatives({ thumbnail: async (_u, o) => { asked = o.time; return { uri: 'file:///frame.jpg' }; } });
    assert.equal(await extractVideoPoster('file:///v.mp4'), 'file:///frame.jpg');
    assert.equal(asked, 300);
    _setTestMediaNatives({ thumbnail: async () => { throw new Error('codec'); } });
    assert.equal(await extractVideoPoster('file:///v.mp4'), null);
    _setTestMediaNatives({ thumbnail: null });
  });

  it('DRIFT GUARD: the client envelope equals the server constants it mirrors', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const server = join(here, '../../../../../artifacts/api-server/src/lib');
    const proc = readFileSync(join(server, 'mediaProcessing.ts'), 'utf8');
    const pipe = readFileSync(join(server, 'mediaPipeline.ts'), 'utf8');
    assert.equal(Number(/export const MAX_IMAGE_DIM = (\d+);/.exec(proc)![1]), SERVER_MAX_IMAGE_DIM);
    const m = /image:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/.exec(pipe)!;
    assert.equal(Number(m[1]) * 1024 * 1024, SERVER_MAX_IMAGE_BYTES);
  });
});
