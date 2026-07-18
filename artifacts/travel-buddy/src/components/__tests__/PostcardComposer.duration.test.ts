/**
 * PostcardComposer — video duration gate (unit layer).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/PostcardComposer.duration.test.ts
 *
 * ## What is tested
 *
 * PostcardComposer.applyAsset() enforces a 60-second limit on videos posted as
 * postcards. The relevant code path is:
 *
 *   const durationSeconds =
 *     picked.type === 'video' && picked.duration != null
 *       ? Math.round(picked.duration / 1000)
 *       : undefined;
 *
 *   if (picked.type === 'video' && durationSeconds != null) {
 *     const durationValidation = validateMedia(
 *       { uri: picked.uri, mimeType, type: 'video', duration: durationSeconds },
 *       { surface: 'postcard' },
 *     );
 *     if (!durationValidation.ok) {
 *       Alert.alert('Cannot use this video', durationValidation.message);
 *       return;
 *     }
 *   }
 *
 * The gate is entirely driven by `validateMedia` from services/media.ts, which
 * reads VIDEO_MAX_DURATION_SECONDS.postcard (= 60) from constants/mediaLimits.ts.
 * Testing `validateMedia` directly with surface: 'postcard' covers:
 *
 *   1. Over-limit video (61 s) → ok: false, Alert would fire with duration message.
 *   2. Under-limit video (59 s) → ok: true, no alert, asset accepted.
 *   3. Duration absent (undefined) → applyAsset skips the validation block
 *      entirely; modelled here by calling validateMedia without a duration field,
 *      which also returns ok: true per the spec's "skip when metadata absent"
 *      requirement.
 *
 * No React Native renderer is needed — all three scenarios are exercised through
 * the pure-function layer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMedia } from '../../services/media.ts';
import { VIDEO_MAX_DURATION_SECONDS } from '../../constants/mediaLimits.ts';

const POSTCARD_LIMIT = VIDEO_MAX_DURATION_SECONDS.postcard; // 60

// ── Over-limit video (61 s) ───────────────────────────────────────────────────

describe('PostcardComposer.applyAsset — over-limit video', () => {
  it('validateMedia returns ok: false for a 61-second video on surface postcard', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 61 },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, false, 'expected validation to fail for 61-second video');
  });

  it('the rejection message mentions the postcard duration limit', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 61 },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, false);
    if (result.ok) return; // type-narrow — never reached
    assert.ok(
      result.message.includes(String(POSTCARD_LIMIT)),
      `expected message to include "${POSTCARD_LIMIT}" seconds, got: "${result.message}"`,
    );
  });

  it('the kind is too_large (Alert.alert would fire with the duration message)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 61 },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'too_large');
  });

  it('a video exactly 1 second over the limit also fails', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: POSTCARD_LIMIT + 1 },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, false);
  });
});

// ── Under-limit video (59 s) ──────────────────────────────────────────────────

describe('PostcardComposer.applyAsset — under-limit video', () => {
  it('validateMedia returns ok: true for a 59-second video on surface postcard', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 59 },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, true, 'expected 59-second video to pass validation');
  });

  it('a 59-second video produces no error kind (asset would be accepted)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 59 },
      { surface: 'postcard' },
    );
    // ok: true means no kind / message fields exist
    assert.equal(result.ok, true);
    assert.ok(!('kind' in result), 'ok result must have no kind field');
  });

  it('a video at exactly the limit (60 s) also passes', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: POSTCARD_LIMIT },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, true, 'video at exactly the limit should be accepted');
  });
});

// ── Duration absent (metadata missing) ───────────────────────────────────────

describe('PostcardComposer.applyAsset — duration absent (metadata missing)', () => {
  it('validateMedia returns ok: true when duration is undefined (no check performed)', () => {
    // applyAsset only calls validateMedia when durationSeconds != null.
    // When duration is absent, the guard block is skipped entirely — no Alert.
    // Calling validateMedia without duration mirrors the same "no check" outcome.
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video' /* no duration */ },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, true, 'absent duration must not trigger a rejection');
  });

  it('validateMedia returns ok: true when duration is null (missing metadata)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: null },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, true, 'null duration must not trigger a rejection');
  });

  it('the applyAsset guard: durationSeconds is undefined when picked.duration is null', () => {
    // This test documents the applyAsset guard logic in isolation.
    // picked.duration (ms) === null → durationSeconds = undefined → block is skipped.
    function computeDurationSeconds(
      type: string,
      durationMs: number | null | undefined,
    ): number | undefined {
      return type === 'video' && durationMs != null
        ? Math.round(durationMs / 1000)
        : undefined;
    }

    assert.equal(computeDurationSeconds('video', null),      undefined, 'null ms → undefined');
    assert.equal(computeDurationSeconds('video', undefined), undefined, 'undefined ms → undefined');
    assert.equal(computeDurationSeconds('image', 5000),      undefined, 'non-video → undefined');
    assert.equal(computeDurationSeconds('video', 61000),     61,        '61 000 ms → 61 s');
    assert.equal(computeDurationSeconds('video', 59000),     59,        '59 000 ms → 59 s');
  });
});

// ── Surface isolation — postcard limit does not bleed into other surfaces ──────

describe('PostcardComposer duration gate — surface isolation', () => {
  it('a 61-second video passes on the event surface (limit 120 s)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 61 },
      { surface: 'event' },
    );
    assert.equal(result.ok, true, '61 s is under the 120 s event limit');
  });

  it('a 61-second video fails only on the postcard surface (limit 60 s)', () => {
    const postcardResult = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 61 },
      { surface: 'postcard' },
    );
    assert.equal(postcardResult.ok, false, 'should fail for postcard surface');
  });
});
