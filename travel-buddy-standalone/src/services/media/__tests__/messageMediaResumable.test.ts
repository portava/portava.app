/**
 * census-telegraph T223 on the client — a message-media retry RESUMES (same
 * upload id, only the missing parts re-sent) and a server without the
 * capability falls back once, then is not probed again.
 *
 * node:test over the pure modules with a fake server that models the
 * session/part/assemble protocol (artifacts/api-server/src/routes/
 * messageMediaTransport.ts). The hook's wiring is held by source assertions
 * (useMessageMediaPicker cannot be mounted here). WHAT THIS DOES NOT SHOW: a
 * device upload over a real network.
 *
 * Run: node --import tsx/esm --test src/services/media/__tests__/messageMediaResumable.test.ts
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResumableTransport } from '../resumableUpload.ts';
import {
  uploadMessageMediaResumable, abandonMessageMediaUpload, _resetMessageResumableSupport,
  messageResumableKnownUnsupported, uploadIdFor, MESSAGE_UPLOAD_SESSION_PATH,
} from '../messageMediaResumable.ts';

const CHUNK = 4 * 1024 * 1024;
const file = (size: number) => ({ size, slice: (a: number, b: number) => ({ a, b }) });
const env = { sleep: async () => {}, random: () => 0.5, retry: { maxAttempts: 2, baseMs: 1, maxMs: 1 } };

function server(opts: { supported?: boolean; dropPartAfter?: number; assembleLosesPart0Once?: boolean } = {}) {
  let lostOnce = false;
  const stored = new Map<string, Set<number>>(); // uploadId → parts landed
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const puts: string[] = [];
  let putsLeft = opts.dropPartAfter ?? Infinity;
  const t: ResumableTransport = {
    async api(method, path, body) {
      calls.push({ method, path, body });
      if (opts.supported === false) return { status: 404, body: { error: 'not_found' }, retryAfter: null };
      const b = body as { uploadId: string; totalBytes: number };
      const count = Math.ceil(b.totalBytes / CHUNK);
      const have = stored.get(b.uploadId) ?? new Set<number>();
      stored.set(b.uploadId, have);
      if (method === 'DELETE') { stored.delete(b.uploadId); return { status: 200, body: { removed: true }, retryAfter: null }; }
      if (path === MESSAGE_UPLOAD_SESSION_PATH) {
        const missing = [...Array(count).keys()].filter((i) => !have.has(i));
        return { status: 200, retryAfter: null, body: {
          chunkBytes: CHUNK, totalBytes: b.totalBytes, receivedBytes: [...have].reduce((s, i) => s + (i < count - 1 ? CHUNK : b.totalBytes - CHUNK * (count - 1)), 0),
          missingParts: missing.map((i) => ({ index: i, size: i < count - 1 ? CHUNK : b.totalBytes - CHUNK * (count - 1), uploadUrl: `https://s/${b.uploadId}/${i}` })),
        } };
      }
      if (path === `${MESSAGE_UPLOAD_SESSION_PATH}/assemble`) {
        if (opts.assembleLosesPart0Once && !lostOnce) { lostOnce = true; have.delete(0); return { status: 409, body: { error: 'conflict' }, retryAfter: null }; }
        if (have.size < count) return { status: 409, body: { error: 'conflict' }, retryAfter: null };
        return { status: 201, retryAfter: null, body: { url: `post-media/me/${b.uploadId}.jpg`, path: `me/${b.uploadId}.jpg`, thumbnailUrl: 'post-media/me/t.jpg', width: 10, height: 10, processed: true } };
      }
      return { status: 404, body: null, retryAfter: null };
    },
    async putPart(url) {
      if (putsLeft <= 0) throw new Error('Network error during upload');
      putsLeft -= 1;
      puts.push(url);
      const [, , , id, idx] = url.split('/');
      stored.get(id!)!.add(Number(idx));
      return { status: 200, retryAfter: null };
    },
  };
  return { t, calls, puts, stored, heal: () => { putsLeft = Infinity; } };
}

beforeEach(() => _resetMessageResumableSupport());

describe('resumable message media', () => {
  it('a retry with the SAME upload id resumes: only the parts that never landed are sent again', async () => {
    const srv = server({ dropPartAfter: 2 });
    const f = file(CHUNK * 3 + 100); // 4 parts
    const first = await uploadMessageMediaResumable(f, 'image/jpeg', 'up-1', srv.t, env);
    assert.equal(first.kind, 'failed');
    assert.equal(srv.puts.length, 2);
    srv.heal();
    const second = await uploadMessageMediaResumable(f, 'image/jpeg', 'up-1', srv.t, env);
    assert.equal(second.kind, 'stored', JSON.stringify(second));
    assert.deepEqual(srv.puts.slice(2), ['https://s/up-1/2', 'https://s/up-1/3'], 'parts 0 and 1 are not re-sent');
    assert.equal((second as any).resumedFromBytes, CHUNK * 2);
    assert.equal((second as any).media.url, 'post-media/me/up-1.jpg');
  });

  it('every call names the session by upload id, mime and size — the server derives the path, the client never sends one', async () => {
    const srv = server();
    await uploadMessageMediaResumable(file(100), 'image/png', 'up-2', srv.t, env);
    for (const c of srv.calls) assert.deepEqual(c.body, { uploadId: 'up-2', mimeType: 'image/png', totalBytes: 100 });
  });

  it('a server without the capability is reported unsupported ONCE and never probed again this run', async () => {
    const srv = server({ supported: false });
    assert.equal((await uploadMessageMediaResumable(file(100), 'image/jpeg', 'up-3', srv.t, env)).kind, 'unsupported');
    assert.equal(messageResumableKnownUnsupported(), true);
    const n = srv.calls.length;
    assert.equal((await uploadMessageMediaResumable(file(100), 'image/jpeg', 'up-4', srv.t, env)).kind, 'unsupported');
    assert.equal(srv.calls.length, n, 'no second probe');
  });

  it('an assemble answering 409 (incomplete) is another round, never "assembled": the lost part is re-sent and the upload lands', async () => {
    const srv = server({ assembleLosesPart0Once: true });
    const r = await uploadMessageMediaResumable(file(CHUNK + 10), 'image/jpeg', 'up-6', srv.t, env);
    assert.equal(r.kind, 'stored', JSON.stringify(r));
    assert.deepEqual(srv.puts, ['https://s/up-6/0', 'https://s/up-6/1', 'https://s/up-6/0']);
  });

  it('abandon sends DELETE for the session', async () => {
    const srv = server();
    await abandonMessageMediaUpload('up-5', 'image/jpeg', 100, srv.t);
    assert.deepEqual(srv.calls.map((c) => c.method), ['DELETE']);
  });

  it('uploadIdFor keeps the id for the same file and mints a new one for a new file', () => {
    let n = 0; const mint = () => `id-${++n}`;
    const a = uploadIdFor(null, 'file-a', mint);
    assert.equal(uploadIdFor(a, 'file-a', mint).id, 'id-1');
    assert.equal(uploadIdFor(a, 'file-b', mint).id, 'id-2');
  });
});

describe('wiring (source assertions)', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const hook = readFileSync(join(root, 'src/hooks/useMessageMediaPicker.ts'), 'utf8');
  const media = readFileSync(join(root, 'src/services/media.ts'), 'utf8');
  it('the message picker uploads through the resumable path with a per-file id, kept across retries', () => {
    assert.match(hook, /uploadIdRef\.current = uploadIdFor\(uploadIdRef\.current, `\$\{media\.localUri\}\|/);
    assert.match(hook, /await uploadMediaResumable\(\s*pickedMedia, uploadIdRef\.current\.id, \{ surface: 'message' \}/);
    assert.doesNotMatch(hook, /await uploadMedia\(pickedMedia/);
  });
  it('the resumable upload falls back to the single-request upload when unsupported', () => {
    assert.match(media, /if \(out\.kind === 'unsupported'\) return uploadMedia\(media, validateOpts\);/);
    assert.match(media, /const v = validateMedia\(media, validateOpts\);/);
  });
});
