/**
 * media.upload.test.ts
 *
 * Tests for uploadMedia() in src/services/media.ts covering:
 *  - rate_limited server response → correct errorKind + user-facing copy
 *  - invalid_payload server response → correct errorKind + user-facing copy
 *  - successful upload → thumbnailUrl populated in MediaUploadResult
 *
 * Run:
 *   node --import tsx/esm --test src/services/__tests__/media.upload.test.ts
 */
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  uploadMedia,
  _setTestTokenProvider,
  _setTestConfiguredOverride,
} from '../media.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal Blob-returning Response for the local-file fetch. */
function makeLocalBlob(): Response {
  const blob = new Blob(['x'], { type: 'image/jpeg' });
  return new Response(blob, { status: 200 });
}

/** Build a JSON Response for the API upload call. */
function makeApiResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Two-call fetch mock: first call returns the local-file blob, second is the API call. */
function makeFetchPair(apiResponse: Response): typeof globalThis.fetch {
  let callCount = 0;
  return async (_input: RequestInfo | URL, _init?: RequestInit) => {
    callCount++;
    if (callCount === 1) return makeLocalBlob();
    return apiResponse;
  };
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL;

beforeEach(() => {
  _setTestTokenProvider(async () => 'test-token');
  _setTestConfiguredOverride(true);
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3001';
});

afterEach(() => {
  _setTestTokenProvider(null);
  _setTestConfiguredOverride(null);
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_API_BASE === undefined) {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
  } else {
    process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_API_BASE;
  }
});

const TEST_MEDIA = {
  uri: 'file://test/photo.jpg',
  mimeType: 'image/jpeg',
  type: 'image' as const,
  fileSize: 100_000,
};

// ── rate_limited ──────────────────────────────────────────────────────────────

describe('uploadMedia — rate_limited', () => {
  test('returns errorKind rate_limited on HTTP 429', async () => {
    globalThis.fetch = makeFetchPair(makeApiResponse(429, { message: 'Slow down' })) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'rate_limited');
  });

  test('shows the correct user-facing copy for 429', async () => {
    globalThis.fetch = makeFetchPair(makeApiResponse(429, {})) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.ok(!result.ok);
    assert.match(result.message ?? '', /please wait a moment/i);
  });

  test('returns errorKind rate_limited when body.error is rate_limited (non-429 status)', async () => {
    globalThis.fetch = makeFetchPair(makeApiResponse(400, { error: 'rate_limited', message: 'Quota exceeded' })) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'rate_limited');
  });
});

// ── invalid_payload ───────────────────────────────────────────────────────────

describe('uploadMedia — invalid_payload', () => {
  test('returns errorKind invalid_payload when server sends that code', async () => {
    globalThis.fetch = makeFetchPair(makeApiResponse(400, { error: 'invalid_payload' })) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, 'invalid_payload');
  });

  test('shows the correct user-facing copy for invalid_payload', async () => {
    globalThis.fetch = makeFetchPair(makeApiResponse(400, { error: 'invalid_payload' })) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.ok(!result.ok);
    assert.match(result.message ?? '', /try a different photo/i);
  });

  test('does not auto-retry — result is a terminal failure (ok=false)', async () => {
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount++;
      if (callCount === 1) return makeLocalBlob();
      return makeApiResponse(400, { error: 'invalid_payload' });
    }) as typeof globalThis.fetch;

    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, false);
    // fetch was called exactly twice (local read + one API attempt) — no retry
    assert.equal(callCount, 2);
  });
});

// ── successful upload → thumbnailUrl populated ────────────────────────────────

describe('uploadMedia — successful upload thumbnailUrl', () => {
  test('thumbnailUrl is populated from server response', async () => {
    const responseBody = {
      url: 'https://cdn.example.com/photo.jpg',
      thumbnailUrl: 'https://cdn.example.com/photo_thumb.jpg',
      width: 1200,
      height: 800,
      processed: true,
    };
    globalThis.fetch = makeFetchPair(makeApiResponse(200, responseBody)) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, true);
    assert.equal(result.thumbnailUrl, 'https://cdn.example.com/photo_thumb.jpg');
  });

  test('thumbnailUrl is null when server omits it', async () => {
    globalThis.fetch = makeFetchPair(makeApiResponse(200, { url: 'https://cdn.example.com/photo.jpg' })) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, true);
    assert.equal(result.thumbnailUrl, null);
  });

  test('width, height, processed are populated from server response', async () => {
    const responseBody = {
      url: 'https://cdn.example.com/photo.jpg',
      thumbnailUrl: 'https://cdn.example.com/photo_thumb.jpg',
      width: 1920,
      height: 1080,
      processed: true,
    };
    globalThis.fetch = makeFetchPair(makeApiResponse(200, responseBody)) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, true);
    assert.equal(result.width, 1920);
    assert.equal(result.height, 1080);
    assert.equal(result.processed, true);
  });

  test('processed defaults to false when server omits it', async () => {
    globalThis.fetch = makeFetchPair(makeApiResponse(200, { url: 'https://cdn.example.com/photo.jpg' })) as typeof globalThis.fetch;
    const result = await uploadMedia(TEST_MEDIA);
    assert.equal(result.ok, true);
    assert.equal(result.processed, false);
  });
});
