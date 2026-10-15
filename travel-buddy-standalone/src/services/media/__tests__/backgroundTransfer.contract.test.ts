import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import {
  backgroundFile,
  backgroundPartTransport,
  putPartsInBackground,
  sweepStagedParts,
  type FsLike,
  type PartDescriptor,
} from '../backgroundTransfer.ts';

async function diskFs(context: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'media-native-contract-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, 'cache');
  await mkdir(cachePath);
  const sourceUri = pathToFileURL(join(directory, 'source.mp4')).href;
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  await writeFile(new URL(sourceUri), bytes);
  const uploads: Buffer[] = [];
  const reads: string[] = [];
  const fs: FsLike = {
    cacheDirectory: `${pathToFileURL(cachePath).href}/`,
    sessionBackground: 0,
    uploadBinary: 0,
    async getInfoAsync(uri) {
      const info = await stat(new URL(uri)).catch(() => null);
      return info ? { exists: true, size: info.size } : { exists: false };
    },
    async readAsStringAsync(uri, options) {
      reads.push(uri);
      const contents = await readFile(new URL(uri));
      return contents.subarray(options.position, options.position + options.length).toString('base64');
    },
    async writeAsStringAsync(uri, contents) {
      await writeFile(new URL(uri), Buffer.from(contents, 'base64'));
    },
    async deleteAsync(uri) { await rm(new URL(uri), { force: true }); },
    async readDirectoryAsync(uri) { return readdir(new URL(uri)); },
    createUploadTask(_url, uri) {
      return {
        async uploadAsync() {
          uploads.push(await readFile(new URL(uri)));
          return { status: 200 };
        },
      };
    },
  };
  return { fs, sourceUri, cachePath, bytes, uploads, reads };
}

describe('MD284 — native file-range boundary uses complete staged bytes only', () => {
  for (const mode of ['single', 'batch'] as const) {
    it(`${mode}: a source truncated after stat is never handed to the upload task`, async (context) => {
      const disk = await diskFs(context);
      const file = await backgroundFile(disk.sourceUri, disk.fs);
      await writeFile(new URL(disk.sourceUri), disk.bytes.subarray(0, 32));
      const part = file.slice(0, 64);
      if (mode === 'single') {
        const transport = backgroundPartTransport(async () => ({ status: 200, body: {}, retryAfter: null }), disk.fs);
        await assert.rejects(transport.putPart('https://storage.test/part', part, 'video/mp4'), /staged part size/);
      } else {
        const outcomes = await putPartsInBackground(disk.fs, [{ url: 'https://storage.test/part', part }], 'video/mp4');
        assert.match('error' in outcomes[0]! ? outcomes[0].error : '', /staged part size/);
      }
      assert.deepEqual(disk.uploads, []);
      assert.deepEqual(await readdir(disk.cachePath), []);
      assert.deepEqual(await readFile(new URL(disk.sourceUri)), disk.bytes.subarray(0, 32));
    });

    it(`${mode}: a partial staged write is cleaned up without uploading`, async (context) => {
      const disk = await diskFs(context);
      const write = disk.fs.writeAsStringAsync;
      disk.fs.writeAsStringAsync = (uri, contents, options) =>
        write(uri, Buffer.from(contents, 'base64').subarray(0, 3).toString('base64'), options);
      const file = await backgroundFile(disk.sourceUri, disk.fs);
      const part = file.slice(0, 32);
      if (mode === 'single') {
        const transport = backgroundPartTransport(async () => ({ status: 200, body: {}, retryAfter: null }), disk.fs);
        await assert.rejects(transport.putPart('https://storage.test/part', part, 'video/mp4'), /staged part size/);
      } else {
        const outcomes = await putPartsInBackground(disk.fs, [{ url: 'https://storage.test/part', part }], 'video/mp4');
        assert.match('error' in outcomes[0]! ? outcomes[0].error : '', /staged part size/);
      }
      assert.deepEqual(disk.uploads, []);
      assert.deepEqual(await readdir(disk.cachePath), []);
      assert.deepEqual(await readFile(new URL(disk.sourceUri)), disk.bytes);
    });

    it(`${mode}: unavailable cache refuses before reading any source bytes`, async (context) => {
      const disk = await diskFs(context);
      disk.fs.cacheDirectory = null;
      const part = (await backgroundFile(disk.sourceUri, disk.fs)).slice(0, 32);
      if (mode === 'single') {
        const transport = backgroundPartTransport(async () => ({ status: 200, body: {}, retryAfter: null }), disk.fs);
        await assert.rejects(transport.putPart('https://storage.test/part', part, 'video/mp4'));
      } else {
        const outcomes = await putPartsInBackground(disk.fs, [{ url: 'https://storage.test/part', part }], 'video/mp4');
        assert.ok('error' in outcomes[0]!);
      }
      assert.deepEqual(disk.reads, []);
      assert.deepEqual(disk.uploads, []);
      assert.deepEqual(await readdir(disk.cachePath), []);
    });
  }

  it('batch keeps a complete part byte-exact when a different part is truncated', async (context) => {
    const disk = await diskFs(context);
    const file = await backgroundFile(disk.sourceUri, disk.fs);
    await writeFile(new URL(disk.sourceUri), disk.bytes.subarray(0, 40));
    const outcomes = await putPartsInBackground(disk.fs, [
      { url: 'https://storage.test/part/0', part: file.slice(0, 32) },
      { url: 'https://storage.test/part/1', part: file.slice(32, 64) },
    ], 'video/mp4');
    assert.deepEqual(outcomes[0], { status: 200, retryAfter: null });
    assert.ok('error' in outcomes[1]!);
    assert.deepEqual(disk.uploads, [disk.bytes.subarray(0, 32)]);
    assert.deepEqual(await readdir(disk.cachePath), []);
  });

  for (const size of [NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    it(`rejects invalid native file size ${size}`, async (context) => {
      const disk = await diskFs(context);
      disk.fs.getInfoAsync = async () => ({ exists: true, size });
      await assert.rejects(backgroundFile(disk.sourceUri, disk.fs));
      assert.deepEqual(disk.reads, []);
    });
  }

  for (const range of [
    { start: -1, end: 32 },
    { start: 0.5, end: 32 },
    { start: 0, end: Infinity },
    { start: 0, end: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    it(`refuses invalid byte range ${range.start}:${range.end} in both paths before staging`, async (context) => {
      const disk = await diskFs(context);
      const part: PartDescriptor = { kind: 'file-range', uri: disk.sourceUri, ...range };
      const transport = backgroundPartTransport(async () => ({ status: 200, body: {}, retryAfter: null }), disk.fs);
      await assert.rejects(transport.putPart('https://storage.test/part', part, 'video/mp4'));
      const outcomes = await putPartsInBackground(disk.fs, [{ url: 'https://storage.test/part', part }], 'video/mp4');
      assert.ok('error' in outcomes[0]!);
      assert.deepEqual(disk.reads, []);
      assert.deepEqual(disk.uploads, []);
      assert.deepEqual(await readdir(disk.cachePath), []);
    });
  }

  it('bounds failed sweep attempts as well as successful deletions', async (context) => {
    const disk = await diskFs(context);
    const names = Array.from({ length: 5 }, (_, index) => `media-upload-part.post~media.1.${index}.bin`);
    for (const name of names) await writeFile(join(disk.cachePath, name), 'staged');
    const attempted: string[] = [];
    disk.fs.deleteAsync = async (uri) => { attempted.push(uri); throw new Error('EACCES'); };
    const result = await sweepStagedParts(disk.fs, async () => new Set(), Date.now(), 2);
    assert.equal(attempted.length, 2);
    assert.equal(result.scanned, 5);
    assert.equal(result.deferred, 5);
    assert.deepEqual(result.deleted, []);
    assert.deepEqual((await readdir(disk.cachePath)).sort(), names.sort());
  });
});
