/**
 * MemoryComposer — video duration gate (unit layer).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/MemoryComposer.duration.test.ts
 *
 * ## What is tested
 *
 * The Memories composer enforces a 30-second limit on videos posted as
 * memories. The relevant code path (mirroring PostcardComposer) is:
 *
 *   const durationSeconds =
 *     picked.type === 'video' && picked.duration != null
 *       ? Math.round(picked.duration / 1000)
 *       : undefined;
 *
 *   if (picked.type === 'video' && durationSeconds != null) {
 *     const durationValidation = validateMedia(
 *       { uri: picked.uri, mimeType, type: 'video', duration: durationSeconds },
 *       { surface: 'memory' },
 *     );
 *     if (!durationValidation.ok) {
 *       Alert.alert('Cannot use this video', durationValidation.message);
 *       return;
 *     }
 *   }
 *
 * The gate is entirely driven by `validateMedia` from services/media.ts, which
 * reads VIDEO_MAX_DURATION_SECONDS.memory (= 30) from constants/mediaLimits.ts.
 * Testing `validateMedia` directly with surface: 'memory' covers:
 *
 *   1. Over-limit video (31 s) → ok: false, Alert would fire with duration message.
 *   2. Under-limit video (29 s) → ok: true, no alert, asset accepted.
 *   3. The rejection message mentions the 30-second limit.
 *
 * No React Native renderer is needed — all scenarios are exercised through
 * the pure-function layer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMedia } from '../../services/media.ts';
import { VIDEO_MAX_DURATION_SECONDS } from '../../constants/mediaLimits.ts';

const MEMORY_LIMIT = VIDEO_MAX_DURATION_SECONDS.memory; // 30

// ── Over-limit video (31 s) ───────────────────────────────────────────────────

describe('MemoryComposer.applyAsset — over-limit video', () => {
  it('validateMedia returns ok: false for a 31-second video on surface memory', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 31 },
      { surface: 'memory' },
    );
    assert.equal(result.ok, false, 'expected validation to fail for 31-second video');
  });

  it('the rejection message mentions the 30-second memory duration limit', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 31 },
      { surface: 'memory' },
    );
    assert.equal(result.ok, false);
    if (result.ok) return; // type-narrow — never reached
    assert.ok(
      result.message.includes(String(MEMORY_LIMIT)),
      `expected message to include "${MEMORY_LIMIT}" seconds, got: "${result.message}"`,
    );
  });

  it('the kind is too_large (Alert.alert would fire with the duration message)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 31 },
      { surface: 'memory' },
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'too_large');
  });

  it('a video exactly 1 second over the limit also fails', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: MEMORY_LIMIT + 1 },
      { surface: 'memory' },
    );
    assert.equal(result.ok, false);
  });
});

// ── Under-limit video (29 s) ──────────────────────────────────────────────────

describe('MemoryComposer.applyAsset — under-limit video', () => {
  it('validateMedia returns ok: true for a 29-second video on surface memory', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 29 },
      { surface: 'memory' },
    );
    assert.equal(result.ok, true, 'expected 29-second video to pass validation');
  });

  it('a 29-second video produces no error kind (asset would be accepted)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 29 },
      { surface: 'memory' },
    );
    assert.equal(result.ok, true);
    assert.ok(!('kind' in result), 'ok result must have no kind field');
  });

  it('a video at exactly the limit (30 s) also passes', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: MEMORY_LIMIT },
      { surface: 'memory' },
    );
    assert.equal(result.ok, true, 'video at exactly the limit should be accepted');
  });
});

// ── Surface isolation — memory limit does not bleed into other surfaces ────────

describe('MemoryComposer duration gate — surface isolation', () => {
  it('a 31-second video passes on the postcard surface (limit 60 s)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 31 },
      { surface: 'postcard' },
    );
    assert.equal(result.ok, true, '31 s is under the 60 s postcard limit');
  });

  it('a 31-second video fails only on the memory surface (limit 30 s)', () => {
    const memoryResult = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 31 },
      { surface: 'memory' },
    );
    assert.equal(memoryResult.ok, false, 'should fail for memory surface');
  });
});
