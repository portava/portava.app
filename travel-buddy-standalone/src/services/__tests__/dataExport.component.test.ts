/**
 * downloadMyData — "Download your data" writes and shares a file only from a
 * whole export.
 *
 * The server answers GET /api/me/export all-or-nothing; this keeps that line on
 * the device: a failed, limited or malformed response writes no file and opens
 * no share sheet, and says which of those it was.
 *
 *   D1  a 200 export is written as portava-data-<day>.json and shared;
 *   D2  a server error, a 429, a 401 and a network failure write nothing;
 *   D3  a 200 that is not the export (a proxy page) writes nothing;
 *   D4  no session: nothing is fetched;
 *   D5  no file sharing on this device: the text share sheet instead;
 *   D6  a write that fails is reported, not swallowed;
 *   D7  every failure has a message a person can act on.
 *
 * Run with: npx jest src/services/__tests__/dataExport.component.test.ts
 */
import assert from 'node:assert/strict';
import { downloadMyData, dataExportErrorMessage, exportFilename, type DataExportDeps, type DataExportError } from '../dataExport.ts';

const EXPORT = {
  format: 'portava.personal-data-export',
  version: 1,
  generatedAt: '2026-11-04T23:10:00.000Z',
  complete: true,
  sections: [{ key: 'profile', label: 'Your profile', rows: 1, truncated: false }, { key: 'posts', label: 'Your posts', rows: 3, truncated: false }],
  data: { profile: [{ id: 'u-1' }], posts: [] },
};

function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function deps(over: Partial<DataExportDeps> = {}) {
  const calls = { fetch: [] as string[], write: [] as Array<[string, string]>, shareFile: [] as string[], shareText: [] as string[] };
  const d: DataExportDeps = {
    fetch: (async (url: string) => { calls.fetch.push(String(url)); return reply(200, EXPORT); }) as unknown as typeof fetch,
    token: async () => 'tok',
    apiBase: () => 'http://api.test',
    configured: () => true,
    writeFile: async (name, text) => { calls.write.push([name, text]); return `file:///cache/${name}`; },
    shareFile: async (uri) => { calls.shareFile.push(uri); return true; },
    shareText: async (title) => { calls.shareText.push(title); },
    ...over,
  };
  return { d, calls };
}

describe('downloadMyData', () => {
  it('D1 writes the export as portava-data-<day>.json and opens the share sheet', async () => {
    const { d, calls } = deps();
    const r = await downloadMyData(d);
    assert.deepEqual(r, { ok: true, sections: 2, complete: true });
    assert.deepEqual(calls.fetch, ['http://api.test/api/me/export']);
    assert.equal(calls.write.length, 1);
    assert.equal(calls.write[0][0], 'portava-data-2026-11-04.json');
    assert.deepEqual(JSON.parse(calls.write[0][1]), EXPORT);
    assert.deepEqual(calls.shareFile, ['file:///cache/portava-data-2026-11-04.json']);
    assert.deepEqual(calls.shareText, []);
  });

  it.each([
    [500, 'server'], [503, 'server'], [429, 'rate_limited'], [401, 'unauthenticated'],
  ] as const)('D2 a %d writes no file and answers %s', async (status, error) => {
    const { d, calls } = deps({ fetch: (async () => reply(status, { error: 'x' })) as unknown as typeof fetch });
    assert.deepEqual(await downloadMyData(d), { ok: false, error });
    assert.deepEqual(calls.write, []);
    assert.deepEqual(calls.shareFile, []);
  });

  it('D2 a network failure writes no file', async () => {
    const { d, calls } = deps({ fetch: (async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch });
    assert.deepEqual(await downloadMyData(d), { ok: false, error: 'network' });
    assert.deepEqual(calls.write, []);
  });

  it('D3 a 200 that is not the export writes no file', async () => {
    const { d, calls } = deps({ fetch: (async () => reply(200, { hello: 'captive portal' })) as unknown as typeof fetch });
    assert.deepEqual(await downloadMyData(d), { ok: false, error: 'server' });
    assert.deepEqual(calls.write, []);
  });

  it('D4 with no session nothing is fetched', async () => {
    const { d, calls } = deps({ token: async () => null });
    assert.deepEqual(await downloadMyData(d), { ok: false, error: 'unauthenticated' });
    assert.deepEqual(calls.fetch, []);
  });

  it('D5 without file sharing it falls back to the text share sheet', async () => {
    const { d, calls } = deps({ shareFile: async () => false });
    assert.equal((await downloadMyData(d)).ok, true);
    assert.deepEqual(calls.shareText, ['portava-data-2026-11-04.json']);
  });

  it('D6 a write that fails is reported', async () => {
    const { d } = deps({ writeFile: async () => { throw new Error('disk full'); } });
    assert.deepEqual(await downloadMyData(d), { ok: false, error: 'share_failed' });
  });

  it('D7 every failure has a message, and the file is named for its own day', () => {
    const errors: DataExportError[] = ['not_configured', 'unauthenticated', 'rate_limited', 'network', 'server', 'share_failed'];
    for (const e of errors) assert.ok(dataExportErrorMessage(e).length > 20, e);
    assert.match(dataExportErrorMessage('server'), /Nothing was sent/);
    assert.equal(exportFilename('2025-01-02T00:00:00Z'), 'portava-data-2025-01-02.json');
    assert.match(exportFilename(undefined), /^portava-data-\d{4}-\d{2}-\d{2}\.json$/);
  });
});
