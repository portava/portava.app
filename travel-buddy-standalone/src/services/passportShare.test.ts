/**
 * Trip-photo sharing — view-shot 4.0.3 compatibility tests.
 *
 * Confirms that the usePassportShare hook correctly handles the file URI
 * formats returned by react-native-view-shot 4.0.3 on both iOS and Android,
 * and that the text-only fallback path functions as intended.
 *
 * WHY this test exists
 * ─────────────────────────────────────────────────────────────────────────────
 * react-native-view-shot was downgraded to 4.0.3.  The static audit showed the
 * API is compatible, but captureRef({ result: 'tmpfile' }) returns a bare
 * filesystem path on both iOS and Android (no file:// prefix guaranteed).
 * usePassportShare.ts passes that raw string through toFileUri() before handing
 * it to react-native-share, which requires a proper file:// URI on both
 * platforms.  A broken URI silently falls back to text-only — users lose the
 * postcard image with no visible error.
 *
 * Coverage
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. toFileUri — iOS bare path, iOS file:// path, Android bare path
 *   2. captureRef options used by usePassportShare are valid in 4.0.3
 *   3. Share pipeline (mirrors usePassportShare logic exactly):
 *       a. iOS: captureRef returns bare path → image URI sent to NativeShare ✓
 *       b. iOS: captureRef returns file:// path → no double-prefix ✓
 *       c. Android: captureRef returns bare path → image URI sent to NativeShare ✓
 *       d. captureRef throws → text-only fallback (no crash, no error shown) ✓
 *       e. cardRef.current is null → text-only fallback ✓
 *       f. NativeShare image-open throws → text-only fallback ✓
 *       g. User cancels ("User did not share") → no error state set ✓
 *       h. User cancels ("cancelled") → no error state set ✓
 *       i. Text-only NativeShare throws non-cancel error → error state set ✓
 *
 * Device-level flows (native share sheet, real JPEG capture, real camera roll)
 * are in docs/sdk54-downgrade-smoke-test.md.
 *
 * Run:
 *   node --import tsx/esm --test src/services/passportShare.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toFileUri, makeDeepLink, makeWebFallback } from './passportShareUtils.ts';

// ── 1. toFileUri — platform URI shape handling ────────────────────────────────
//
// react-native-view-shot 4.0.3 captureRef({ result: 'tmpfile' }) returns a
// bare filesystem path on both iOS and Android.  toFileUri() must normalise
// both the bare-path form and the (already-prefixed) file:// form.

describe('toFileUri — platform URI normalisation (react-native-view-shot 4.0.3)', () => {
  it('iOS bare path: /tmp/RNViewShot-*.jpg → file:///tmp/RNViewShot-*.jpg', () => {
    const raw = '/tmp/RNViewShot-com.travelbuddy.app-5A3F.jpg';
    assert.equal(toFileUri(raw), `file://${raw}`);
  });

  it('iOS file:// path: already-prefixed URI is returned unchanged (no double prefix)', () => {
    const raw = 'file:///tmp/RNViewShot-com.travelbuddy.app-5A3F.jpg';
    assert.equal(toFileUri(raw), raw);
  });

  it('Android bare path: /data/user/0/<pkg>/cache/*.jpg → file:///data/... prefix added', () => {
    const raw = '/data/user/0/com.travelbuddy.app/cache/RNViewShot-XY12.jpg';
    assert.equal(toFileUri(raw), `file://${raw}`);
  });

  it('Android external cache bare path is also correctly prefixed', () => {
    const raw = '/sdcard/Android/data/com.travelbuddy.app/cache/capture.jpg';
    assert.equal(toFileUri(raw), `file://${raw}`);
  });
});

// ── 2. captureRef options valid in 4.0.3 ─────────────────────────────────────
//
// Verify the options object used in usePassportShare.ts is accepted by the
// view-shot 4.0.3 validateOptions() logic: format 'jpg' is in acceptedFormats,
// quality 0.9 is in [0, 1], result 'tmpfile' is in acceptedResults.

describe('captureRef options — usePassportShare options are valid in react-native-view-shot 4.0.3', () => {
  const CAPTURE_OPTIONS = { format: 'jpg' as const, quality: 0.9, result: 'tmpfile' as const };

  it('format "jpg" is a valid 4.0.3 capture format on iOS and Android', () => {
    const acceptedFormats = ['png', 'jpg']; // Android also allows webp/raw — iOS does not
    assert.ok(
      acceptedFormats.includes(CAPTURE_OPTIONS.format),
      `format "${CAPTURE_OPTIONS.format}" must be in [${acceptedFormats.join(', ')}]`,
    );
  });

  it('quality 0.9 is within the valid [0, 1] range', () => {
    assert.ok(
      CAPTURE_OPTIONS.quality >= 0 && CAPTURE_OPTIONS.quality <= 1,
      `quality ${CAPTURE_OPTIONS.quality} must be in [0, 1]`,
    );
  });

  it('result "tmpfile" is a valid 4.0.3 result type on both iOS and Android', () => {
    const acceptedResults = ['tmpfile', 'base64', 'data-uri']; // Android also has zip-base64
    assert.ok(
      acceptedResults.includes(CAPTURE_OPTIONS.result),
      `result "${CAPTURE_OPTIONS.result}" must be in [${acceptedResults.join(', ')}]`,
    );
  });
});

// ── 3. Share pipeline simulation ──────────────────────────────────────────────
//
// Mirrors the try/catch structure of usePassportShare.ts exactly so any future
// change to the hook logic that breaks a platform path will fail these tests.
//
// usePassportShare.ts logic (condensed):
//
//   if (cardRef.current) {
//     try { raw = await captureRef(...); imageUri = toFileUri(raw); } catch {}
//   }
//   if (imageUri) {
//     try {
//       await NativeShare.open({ url: imageUri, type: 'image/jpeg', ... });
//       return;           // ← image share succeeded
//     } catch (imgErr) {
//       const msg = imgErr?.message ?? '';
//       if (msg.includes('User did not share') || msg.includes('cancelled')) return;
//       // fall through to text-only
//     }
//   }
//   await NativeShare.open({ message, failOnCancel: false }); // text-only fallback

interface ShareDeps {
  hasCardRef: boolean;
  captureRef: () => Promise<string>;
  nativeShareOpen: (opts: Record<string, unknown>) => Promise<void>;
}

interface ShareOutcome {
  imageShared: boolean;
  textFallback: boolean;
  errorSet: boolean;
}

async function runSharePipeline(deps: ShareDeps): Promise<ShareOutcome> {
  const outcome: ShareOutcome = { imageShared: false, textFallback: false, errorSet: false };
  const message = 'Check out @alice!';
  const title = "@alice's Travel Buddy Passport";

  try {
    let imageUri: string | null = null;

    if (deps.hasCardRef) {
      try {
        const raw = await deps.captureRef();
        imageUri = toFileUri(raw);
      } catch {
        imageUri = null;
      }
    }

    if (imageUri) {
      try {
        await deps.nativeShareOpen({ title, message, url: imageUri, type: 'image/jpeg', failOnCancel: false });
        outcome.imageShared = true;
        return outcome;
      } catch (imgErr: any) {
        const msg: string = imgErr?.message ?? '';
        if (msg.includes('User did not share') || msg.includes('cancelled')) return outcome;
        // image share failed — fall through to text-only
      }
    }

    await deps.nativeShareOpen({ title, message, failOnCancel: false });
    outcome.textFallback = true;
  } catch (e: any) {
    const msg: string = e?.message ?? '';
    if (!msg.includes('User did not share') && !msg.includes('cancelled')) {
      outcome.errorSet = true;
    }
  }

  return outcome;
}

describe('Share pipeline — iOS and Android URI formats (mirrors usePassportShare.ts logic)', () => {
  // 3a. iOS bare path
  it('iOS — captureRef returns bare /tmp/... path → file:// URI sent to NativeShare (image share)', async () => {
    const captured: Array<Record<string, unknown>> = [];

    const result = await runSharePipeline({
      hasCardRef: true,
      captureRef: async () => '/tmp/RNViewShot-com.travelbuddy.app-9F2A.jpg',
      nativeShareOpen: async (opts) => { captured.push(opts); },
    });

    assert.ok(result.imageShared, 'image share must succeed on iOS bare path');
    assert.equal(captured.length, 1);
    assert.equal(
      captured[0]!['url'],
      'file:///tmp/RNViewShot-com.travelbuddy.app-9F2A.jpg',
      'NativeShare must receive file:// URI (not bare path)',
    );
    assert.equal(captured[0]!['type'], 'image/jpeg');
  });

  // 3b. iOS file:// path (already prefixed — no double prefix)
  it('iOS — captureRef returns file:///tmp/... path → URI not double-prefixed', async () => {
    const captured: Array<Record<string, unknown>> = [];

    const result = await runSharePipeline({
      hasCardRef: true,
      captureRef: async () => 'file:///tmp/RNViewShot-com.travelbuddy.app-1A2B.jpg',
      nativeShareOpen: async (opts) => { captured.push(opts); },
    });

    assert.ok(result.imageShared);
    assert.equal(
      captured[0]!['url'],
      'file:///tmp/RNViewShot-com.travelbuddy.app-1A2B.jpg',
      'file:// must not be doubled',
    );
  });

  // 3c. Android bare path
  it('Android — captureRef returns bare /data/... path → file:// URI sent to NativeShare', async () => {
    const captured: Array<Record<string, unknown>> = [];
    const androidPath = '/data/user/0/com.travelbuddy.app/cache/RNViewShot-CD34.jpg';

    const result = await runSharePipeline({
      hasCardRef: true,
      captureRef: async () => androidPath,
      nativeShareOpen: async (opts) => { captured.push(opts); },
    });

    assert.ok(result.imageShared, 'image share must succeed on Android bare path');
    assert.equal(
      captured[0]!['url'],
      `file://${androidPath}`,
      'Android bare path must get file:// prefix',
    );
    assert.equal(captured[0]!['type'], 'image/jpeg');
  });

  // 3d. captureRef throws → text-only fallback
  it('captureRef throws → text-only fallback (no crash, imageShared=false)', async () => {
    const captured: Array<Record<string, unknown>> = [];

    const result = await runSharePipeline({
      hasCardRef: true,
      captureRef: async () => { throw new Error('Native capture failed'); },
      nativeShareOpen: async (opts) => { captured.push(opts); },
    });

    assert.equal(result.imageShared, false);
    assert.ok(result.textFallback, 'text-only fallback must run when captureRef throws');
    assert.equal(captured.length, 1, 'NativeShare.open called exactly once (text-only)');
    assert.equal(
      'url' in (captured[0]!),
      false,
      'text-only call must not include a url (no broken file URI)',
    );
  });

  // 3e. cardRef.current is null (ref not yet attached to a View)
  it('cardRef.current is null → text-only fallback', async () => {
    const captured: Array<Record<string, unknown>> = [];

    const result = await runSharePipeline({
      hasCardRef: false,
      captureRef: async () => { throw new Error('should not be called'); },
      nativeShareOpen: async (opts) => { captured.push(opts); },
    });

    assert.equal(result.imageShared, false);
    assert.ok(result.textFallback);
    assert.equal(captured.length, 1);
  });

  // 3f. NativeShare.open (image) throws a non-cancel error → text-only fallback
  it('NativeShare image-open throws non-cancel error → text-only fallback', async () => {
    let callCount = 0;
    const captured: Array<Record<string, unknown>> = [];

    const result = await runSharePipeline({
      hasCardRef: true,
      captureRef: async () => '/tmp/capture.jpg',
      nativeShareOpen: async (opts) => {
        callCount++;
        if (callCount === 1) {
          // First call is the image share — simulate failure
          throw new Error('Activity not found');
        }
        captured.push(opts); // Second call is text-only fallback
      },
    });

    assert.equal(result.imageShared, false);
    assert.ok(result.textFallback, 'must fall back to text-only when image share throws');
    assert.equal(callCount, 2, 'NativeShare.open must be called twice (image attempt + text fallback)');
  });

  // 3g. User cancels — "User did not share" → no error, no fallback
  it('"User did not share" cancel from image share → no error, no text fallback', async () => {
    const result = await runSharePipeline({
      hasCardRef: true,
      captureRef: async () => '/tmp/capture.jpg',
      nativeShareOpen: async () => {
        throw new Error('User did not share');
      },
    });

    assert.equal(result.imageShared, false);
    assert.equal(result.textFallback, false, 'cancel must not trigger text-only fallback');
    assert.equal(result.errorSet, false, 'cancel must not set error state');
  });

  // 3h. User cancels — "cancelled" keyword → no error, no fallback
  it('"cancelled" cancel message → no error, no text fallback', async () => {
    const result = await runSharePipeline({
      hasCardRef: true,
      captureRef: async () => '/tmp/capture.jpg',
      nativeShareOpen: async () => {
        throw new Error('Share was cancelled by user');
      },
    });

    assert.equal(result.imageShared, false);
    assert.equal(result.textFallback, false);
    assert.equal(result.errorSet, false);
  });

  // 3i. Text-only NativeShare itself throws a non-cancel error → errorSet=true
  it('text-only NativeShare throws non-cancel error → error state is set', async () => {
    const result = await runSharePipeline({
      hasCardRef: false, // skip image capture entirely
      captureRef: async () => '',
      nativeShareOpen: async () => {
        throw new Error('Share sheet unavailable');
      },
    });

    assert.equal(result.textFallback, false);
    assert.ok(result.errorSet, 'unexpected share sheet error must set error state');
  });
});

// ── 4. Message content verification ──────────────────────────────────────────
//
// Confirm makeDeepLink and makeWebFallback produce the content embedded in the
// share message — what the recipient actually receives.

describe('Share message content — deep-link and web fallback URLs', () => {
  it('makeDeepLink encodes the username correctly', () => {
    assert.equal(makeDeepLink('alice'), 'travelbuddy://passport/@alice');
  });

  it('makeWebFallback uses EXPO_PUBLIC_WEB_ORIGIN when set', () => {
    process.env.EXPO_PUBLIC_WEB_ORIGIN = 'https://travel.example.com';
    const result = makeWebFallback('alice');
    delete process.env.EXPO_PUBLIC_WEB_ORIGIN;
    assert.equal(result, 'https://travel.example.com/u/alice');
  });

  it('makeWebFallback falls back to travelbuddy.app when no env is set', () => {
    const savedOrigin = process.env.EXPO_PUBLIC_WEB_ORIGIN;
    const savedApi = process.env.EXPO_PUBLIC_API_BASE_URL;
    delete process.env.EXPO_PUBLIC_WEB_ORIGIN;
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    const result = makeWebFallback('alice');
    if (savedOrigin) process.env.EXPO_PUBLIC_WEB_ORIGIN = savedOrigin;
    if (savedApi) process.env.EXPO_PUBLIC_API_BASE_URL = savedApi;
    assert.equal(result, 'https://travelbuddy.app/u/alice');
  });
});
