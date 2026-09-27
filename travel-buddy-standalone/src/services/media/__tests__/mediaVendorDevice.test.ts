/**
 * census-media §37 — the two DEVICE rows' JS halves:
 *
 *   MD284  every missing part is handed to the OS at once (backgroundTransfer
 *          putPartsInBackground, resumableUpload's batch path), and what the
 *          batch could not deliver is retried one at a time;
 *   MD282  the video-compression seam uses a native module only when the
 *          running binary has one, and otherwise passes the video through
 *          UNCHANGED (videoCompression.ts).
 *
 * Every native surface here is a TEST DOUBLE (an FsLike, a module lookup). What
 * is proved is the JS contract. Whether iOS finishes the handed-over tasks while
 * the app is suspended, and whether a real encoder produces a smaller playable
 * clip, needs a native build and a device — census-media §37 names both.
 *
 * Pure node:test — no react-native, no network.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { uploadSlotResumable, type FileLike, type PartOutcome, type ResumableTransport } from '../resumableUpload.ts';
import { backgroundFile, backgroundPartTransport, putPartsInBackground, type FsLike, type PartDescriptor } from '../backgroundTransfer.ts';
import {
  _setTestVideoCompressionFlag,
  _setTestVideoCompressorLookup,
  compressVideoForUpload,
  isDeviceVideoCompressionEnabled,
  VIDEO_COMPRESSION_POLICY,
  VIDEO_COMPRESSOR_MODULE,
} from '../videoCompression.ts';

const CHUNK = 64;

function bytesOf(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 17 + 3) & 0xff;
  return b;
}

class FakeFile implements FileLike {
  constructor(public readonly bytes: Uint8Array) {}
  get size() { return this.bytes.length; }
  slice(start: number, end: number): Uint8Array { return this.bytes.slice(start, end); }
}

/** A byte-accurate fake of the slot session protocol, with a batch transport. */
function fakeServer(totalBytes: number) {
  const parts = new Map<number, Uint8Array>();
  let assembled: Uint8Array | null = null;
  let generation = 0;
  const log: string[] = [];
  const partCount = Math.ceil(totalBytes / CHUNK);
  const partSize = (i: number) => (i < partCount - 1 ? CHUNK : totalBytes - CHUNK * (partCount - 1));
  /** Forced outcomes for the next batch, by part index: a status, or 'none' for no answer. */
  const batchScript = new Map<number, number | 'none'>();
  const store = (url: string, part: unknown): PartOutcome => {
    const index = Number(/part\/(\d+)/.exec(url)![1]);
    const forced = batchScript.get(index);
    if (forced !== undefined) {
      batchScript.delete(index);
      return forced === 'none' ? { error: 'no answer' } : { status: forced, retryAfter: null };
    }
    parts.set(index, part as Uint8Array);
    return { status: 200, retryAfter: null };
  };
  const transport: ResumableTransport = {
    async api(_method, path) {
      if (path.endsWith('/assemble')) {
        for (let i = 0; i < partCount; i++) if (parts.get(i)?.length !== partSize(i)) return { status: 409, body: {}, retryAfter: null };
        const out = new Uint8Array(totalBytes);
        for (let i = 0; i < partCount; i++) out.set(parts.get(i)!, i * CHUNK);
        assembled = out;
        return { status: 200, body: {}, retryAfter: null };
      }
      generation++;
      const missing: Array<{ index: number; size: number; uploadUrl: string }> = [];
      let receivedBytes = 0;
      for (let i = 0; i < partCount; i++) {
        if (parts.get(i)?.length === partSize(i)) receivedBytes += partSize(i);
        else missing.push({ index: i, size: partSize(i), uploadUrl: `https://storage.test/part/${i}?gen=${generation}` });
      }
      log.push(`session:${missing.map((m) => m.index).join(',')}`);
      return { status: 200, body: { chunkBytes: CHUNK, totalBytes, receivedBytes, missingParts: missing }, retryAfter: null };
    },
    async putPart(url, part) {
      log.push(`put:${/part\/(\d+)/.exec(url)![1]}`);
      const o = store(url, part);
      if ('error' in o) throw new Error(o.error);
      return o;
    },
    async putParts(list) {
      log.push(`batch:${list.map((p) => /part\/(\d+)/.exec(p.url)![1]).join(',')}`);
      return list.map((p) => store(p.url, p.part));
    },
  };
  return { transport, log, batchScript, get assembled() { return assembled; } };
}

const sleeps: number[] = [];
const env = { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5, retry: { maxAttempts: 3, baseMs: 100, maxMs: 1000 } };
beforeEach(() => { sleeps.length = 0; });

describe('MD284 — every missing part is handed over AT ONCE', () => {
  it('a transport that can batch gets every missing part in ONE call, and the slot assembles byte-exact', async () => {
    const bytes = bytesOf(CHUNK * 4 + 10);
    const srv = fakeServer(bytes.length);
    const r = await uploadSlotResumable({ postId: 'p', mediaId: 'm' }, new FakeFile(bytes), 'video/mp4', srv.transport, env);
    assert.equal(r.ok, true);
    assert.deepEqual(srv.log, ['session:0,1,2,3,4', 'batch:0,1,2,3,4']);
    assert.deepEqual(srv.assembled, bytes);
  });

  it('what the batch could not deliver (no answer, 503) is retried ONE AT A TIME after a wait — never counted as sent', async () => {
    const bytes = bytesOf(CHUNK * 3);
    const srv = fakeServer(bytes.length);
    srv.batchScript.set(1, 'none');
    srv.batchScript.set(2, 503);
    const progress: number[] = [];
    const r = await uploadSlotResumable({ postId: 'p', mediaId: 'm' }, new FakeFile(bytes), 'video/mp4', srv.transport, env, (f) => progress.push(f));
    assert.equal(r.ok, true);
    assert.deepEqual(srv.log, ['session:0,1,2', 'batch:0,1,2', 'put:1', 'put:2']);
    assert.equal(sleeps.length, 1, 'one backoff wait before the stragglers');
    assert.ok(progress.every((f, i) => i === 0 || f >= progress[i - 1]!), 'progress never goes backwards');
    assert.ok(Math.max(...progress.slice(0, 3)) < 1, 'undelivered parts were not reported as sent');
    assert.deepEqual(srv.assembled, bytes);
  });

  it('a REFUSED part in the batch (403: an expired signature) gets a fresh session, not a retry of the same URL', async () => {
    const bytes = bytesOf(CHUNK * 3);
    const srv = fakeServer(bytes.length);
    srv.batchScript.set(2, 403);
    const r = await uploadSlotResumable({ postId: 'p', mediaId: 'm' }, new FakeFile(bytes), 'video/mp4', srv.transport, env);
    assert.equal(r.ok, true);
    assert.deepEqual(srv.log, ['session:0,1,2', 'batch:0,1,2', 'session:2', 'put:2']);
  });

  it('a non-retryable refusal (413) fails the run; nothing is assembled', async () => {
    const bytes = bytesOf(CHUNK * 2);
    const srv = fakeServer(bytes.length);
    srv.batchScript.set(0, 413);
    const r = await uploadSlotResumable({ postId: 'p', mediaId: 'm' }, new FakeFile(bytes), 'video/mp4', srv.transport, env);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && !r.unsupported && r.retryable, false);
    assert.equal(srv.assembled, null);
  });

  it('a transport without putParts keeps the one-at-a-time path (the foreground transport is unchanged)', async () => {
    const bytes = bytesOf(CHUNK * 2 + 1);
    const srv = fakeServer(bytes.length);
    const serial: ResumableTransport = { api: srv.transport.api, putPart: srv.transport.putPart };
    const r = await uploadSlotResumable({ postId: 'p', mediaId: 'm' }, new FakeFile(bytes), 'video/mp4', serial, env);
    assert.equal(r.ok, true);
    assert.deepEqual(srv.log, ['session:0,1,2', 'put:0', 'put:1', 'put:2']);
  });
});

/** An FsLike whose upload tasks resolve only when the test releases them. */
function gatedFs(fileBytes: Uint8Array, opts: { failStageAt?: number } = {}) {
  const files = new Map<string, string>();
  const started: string[] = [];
  const release: Array<() => void> = [];
  const deleted: string[] = [];
  let reads = 0;
  const fs: FsLike = {
    cacheDirectory: 'file:///cache/',
    sessionBackground: 1,
    uploadBinary: 0,
    async getInfoAsync() { return { exists: true, size: fileBytes.length }; },
    async readAsStringAsync(_uri, o) {
      reads++;
      if (opts.failStageAt !== undefined && reads === opts.failStageAt + 1) throw new Error('disk full');
      return Buffer.from(fileBytes.slice(o.position, o.position + o.length)).toString('base64');
    },
    async writeAsStringAsync(uri, contents) { files.set(uri, contents); },
    async deleteAsync(uri) { deleted.push(uri); files.delete(uri); },
    createUploadTask(url, fileUri, options) {
      assert.equal(options.sessionType, 1, 'every task is a BACKGROUND session task');
      return {
        uploadAsync() {
          started.push(url);
          assert.ok(files.has(fileUri), 'the staged file exists when its task starts');
          return new Promise((resolve) => release.push(() => resolve({ status: 200, headers: {} })));
        },
      };
    },
  };
  return { fs, started, release, deleted, files };
}

describe('MD284 — putPartsInBackground STARTS every task before awaiting any', () => {
  it('all N tasks are running at once while none has finished; then every staged file is deleted', async () => {
    const bytes = bytesOf(CHUNK * 3);
    const g = gatedFs(bytes);
    const file = await backgroundFile('file:///video.mp4', g.fs);
    const parts = [0, 1, 2].map((i) => ({ url: `https://storage.test/part/${i}`, part: file.slice(i * CHUNK, (i + 1) * CHUNK) }));
    const pending = putPartsInBackground(g.fs, parts, 'video/mp4');
    for (let i = 0; i < 50 && g.started.length < 3; i++) await new Promise((r) => setImmediate(r));
    assert.equal(g.started.length, 3, 'a serial transport would have started one and waited for it');
    g.release.forEach((f) => f());
    const out = await pending;
    assert.deepEqual(out, [0, 1, 2].map(() => ({ status: 200, retryAfter: null })));
    assert.equal(g.files.size, 0, 'no staged part is left in the cache');
  });

  it('a part that cannot be staged is never handed over and reports NO ANSWER; the others still go', async () => {
    const bytes = bytesOf(CHUNK * 3);
    const g = gatedFs(bytes, { failStageAt: 1 });
    const file = await backgroundFile('file:///video.mp4', g.fs);
    const parts = [0, 1, 2].map((i) => ({ url: `https://storage.test/part/${i}`, part: file.slice(i * CHUNK, (i + 1) * CHUNK) }));
    const pending = putPartsInBackground(g.fs, parts, 'video/mp4');
    for (let i = 0; i < 50 && g.started.length < 2; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(g.started, ['https://storage.test/part/0', 'https://storage.test/part/2']);
    g.release.forEach((f) => f());
    const out = await pending;
    assert.equal('error' in out[1]!, true);
    assert.equal('status' in out[0]! && out[0].status, 200);
  });

  it('the background transport offers the batch, so the queue uses it', async () => {
    const g = gatedFs(bytesOf(10));
    const t = backgroundPartTransport(async () => ({ status: 200, body: {}, retryAfter: null }), g.fs);
    assert.equal(typeof t.putParts, 'function');
    const d: PartDescriptor = { kind: 'file-range', uri: 'file:///v.mp4', start: 0, end: 10 };
    const pending = t.putParts!([{ url: 'https://storage.test/part/0', part: d }], 'video/mp4');
    for (let i = 0; i < 50 && g.started.length < 1; i++) await new Promise((r) => setImmediate(r));
    g.release.forEach((f) => f());
    assert.deepEqual(await pending, [{ status: 200, retryAfter: null }]);
  });
});

// ── MD282 ─────────────────────────────────────────────────────────────────────

describe('MD282 — the compression seam: the native module only when present, the SAME video otherwise', () => {
  const picked = { uri: 'file:///pick.mp4', fileSizeBytes: 50_000_000, width: 1080, height: 1920, isVideo: true, mimeType: 'video/mp4' };
  const asked: string[] = [];
  const moduleThat = (answer: unknown) => ({
    async compressAsync(uri: string, opts: unknown) {
      asked.push(`${uri} ${JSON.stringify(opts)}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  beforeEach(() => { asked.length = 0; });
  afterEach(() => { _setTestVideoCompressionFlag(null); _setTestVideoCompressorLookup(null); });

  it('ships OFF: the switch is false and the video passes through as the same object, with no lookup', async () => {
    assert.equal(isDeviceVideoCompressionEnabled(), false);
    let looked = false;
    _setTestVideoCompressorLookup(() => { looked = true; return moduleThat({}); });
    const r = await compressVideoForUpload(picked);
    assert.equal(r.video, picked);
    assert.equal(!r.compressed && r.reason, 'switched_off');
    assert.equal(looked, false);
  });

  it('module ABSENT (requireOptionalNativeModule → null): the same object, bytes untouched', async () => {
    _setTestVideoCompressionFlag(true);
    const names: string[] = [];
    _setTestVideoCompressorLookup((n) => { names.push(n); return null; });
    const r = await compressVideoForUpload(picked);
    assert.equal(r.video, picked);
    assert.equal(!r.compressed && r.reason, 'module_absent');
    assert.deepEqual(names, [VIDEO_COMPRESSOR_MODULE]);
  });

  it('module PRESENT: asks for the owner bound and uses the smaller copy, with its size and dimensions', async () => {
    _setTestVideoCompressionFlag(true);
    _setTestVideoCompressorLookup(() => moduleThat({ uri: 'file:///out.mp4', sizeBytes: 9_000_000, width: 1080, height: 1920 }));
    const r = await compressVideoForUpload(picked);
    assert.equal(r.compressed, true);
    assert.deepEqual(r.video, { ...picked, uri: 'file:///out.mp4', fileSizeBytes: 9_000_000, width: 1080, height: 1920 });
    assert.deepEqual(asked, [`file:///pick.mp4 ${JSON.stringify(VIDEO_COMPRESSION_POLICY)}`]);
  });

  it('a throw, a bigger file, or an answer without size/dimensions all fall back to the untouched original', async () => {
    _setTestVideoCompressionFlag(true);
    for (const [answer, reason] of [
      [new Error('encoder failed'), 'failed'],
      [{ uri: 'file:///out.mp4', sizeBytes: 60_000_000, width: 1080, height: 1920 }, 'not_smaller'],
      [{ uri: 'file:///out.mp4', sizeBytes: 9_000_000 }, 'incomplete_answer'],
      [{ uri: '', sizeBytes: 9_000_000, width: 1, height: 1 }, 'incomplete_answer'],
    ] as const) {
      _setTestVideoCompressorLookup(() => moduleThat(answer));
      const r = await compressVideoForUpload(picked);
      assert.equal(r.video, picked, String(reason));
      assert.equal(!r.compressed && r.reason, reason);
    }
  });

  it('a module without the contract method is treated as absent', async () => {
    _setTestVideoCompressionFlag(true);
    _setTestVideoCompressorLookup(() => ({ compress: async () => ({}) }));
    const r = await compressVideoForUpload(picked);
    assert.equal(!r.compressed && r.reason, 'module_absent');
  });
});
