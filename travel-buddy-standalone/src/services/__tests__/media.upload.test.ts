/**
 * uploadMedia — no-URL response guard
 *
 * Verifies that when the API returns HTTP 200 with a body that omits the `url`
 * field, uploadMedia() returns { ok: false, errorKind: 'upload_failed', ... }
 * instead of silently posting blank media.
 *
 * The machine-layer test (PulseCreate.submit.test.ts) already confirms that
 * handleUploadResult correctly routes { ok: true, url: null } to an error state.
 * These tests cover the producer side — the parse branch in uploadMedia itself.
 *
 * Run: node --import tsx/esm --test src/services/__tests__/media.upload.test.ts
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadMedia,
  _setTestTokenProvider,
  _setTestConfiguredOverride,
} from '../media.ts';

// ── Constants ─────────────────────────────────────────────────────────────────

const FAKE_URI = 'file://test/photo.jpg';
const FAKE_MEDIA = { uri: FAKE_URI, mimeType: 'image/jpeg', fileSize: 100 };

// ── Harness setup ─────────────────────────────────────────────────────────────

let savedFetch: typeof globalThis.fetch;

before(() => {
  savedFetch = globalThis.fetch;
  // Bypass isSupabaseConfigured (evaluated at module-load time before env vars).
  _setTestConfiguredOverride(true);
  // Bypass supabase.auth session lookup.
  _setTestTokenProvider(async () => 'fake-bearer-token');
  // Point apiBase() to a known URL (read at call-time, not module-load).
  process.env.EXPO_PUBLIC_API_BASE_URL = 'https://api.test';
});

after(() => {
  globalThis.fetch = savedFetch;
  _setTestConfiguredOverride(null);
  _setTestTokenProvider(null);
  delete process.env.EXPO_PUBLIC_API_BASE_URL;
});

/**
 * Build a fetch stub that returns a blob for the file URI and a JSON API
 * response for any other URL (the upload endpoint).
 */
function makeFetch(apiStatus: number, apiBody: unknown): typeof globalThis.fetch {
  return async (url: string | URL | Request): Promise<Response> => {
    if (url.toString() === FAKE_URI) {
      return new Response(new Uint8Array(100).buffer, { status: 200 });
    }
    return new Response(JSON.stringify(apiBody), {
      status: apiStatus,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

beforeEach(() => {
  globalThis.fetch = savedFetch;
});

// ── Primary case (from task spec) ─────────────────────────────────────────────

test('200 with no url field → ok:false, upload_failed, clear message', async () => {
  globalThis.fetch = makeFetch(200, { message: 'ok' });

  const result = await uploadMedia(FAKE_MEDIA);

  assert.equal(result.ok, false, 'ok must be false when url is absent from 200 response');
  assert.equal(result.url, null, 'url must be null');
  assert.equal(result.errorKind, 'upload_failed');
  assert.equal(result.message, 'Upload succeeded but no URL returned');
});

// ── Variation: explicit null url value ────────────────────────────────────────

test('200 with url: null → ok:false, upload_failed', async () => {
  globalThis.fetch = makeFetch(200, { url: null });

  const result = await uploadMedia(FAKE_MEDIA);

  assert.equal(result.ok, false, 'ok must be false when url is explicitly null');
  assert.equal(result.url, null);
  assert.equal(result.errorKind, 'upload_failed');
  assert.equal(result.message, 'Upload succeeded but no URL returned');
});

// ── Positive control: happy path still works ──────────────────────────────────

test('200 with valid url → ok:true, url and mediaType returned', async () => {
  globalThis.fetch = makeFetch(200, { url: 'https://cdn.test/photo.jpg', path: 'photos/photo.jpg' });

  const result = await uploadMedia(FAKE_MEDIA);

  assert.equal(result.ok, true, 'ok must be true when url is present');
  assert.equal(result.url, 'https://cdn.test/photo.jpg');
  assert.equal(result.mediaType, 'image/jpeg');
  assert.equal(result.errorKind, undefined, 'errorKind must be absent on success');
});
