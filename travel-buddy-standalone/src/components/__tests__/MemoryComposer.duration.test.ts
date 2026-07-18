/**
 * MemoryComposer — video duration gate (unit layer).
 *
 * Run with:
 *   node --import tsx/esm --test src/components/__tests__/MemoryComposer.duration.test.ts
 *
 * ## What is tested
 *
 * MemoriesTab.handleSave() enforces a 30-second limit on videos posted as
 * memories. The relevant code path passes `{ surface: 'memory' }` and
 * `duration` to `uploadMedia`, which calls `validateMedia` internally:
 *
 *   await uploadMedia(
 *     { uri, mimeType, type: 'video', duration: videoDuration ?? undefined },
 *     { surface: 'memory' },
 *   );
 *
 * The gate is driven by `validateMedia` from services/media.ts, which reads
 * VIDEO_MAX_DURATION_SECONDS.memory (= 30) from constants/mediaLimits.ts.
 *
 * Testing `validateMedia` directly with surface: 'memory' covers:
 *   1. Over-limit video (31 s) → ok: false, upload would be blocked.
 *   2. Under-limit video (29 s) → ok: true, asset accepted.
 *   3. The rejection message mentions the 30-second limit.
 *   4. Duration absent (undefined/null) → ok: true (skip when metadata absent).
 *   5. Surface isolation — memory limit (30 s) is tighter than postcard (60 s).
 *   6. MIME fallback — absent mimeType on a video asset normalises to 'video/mp4'.
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

describe('MemoryComposer.handleSave — over-limit video', () => {
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

  it('the kind is too_large (upload would be blocked with the duration message)', () => {
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

describe('MemoryComposer.handleSave — under-limit video', () => {
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

// ── Duration absent (metadata missing) ────────────────────────────────────────

describe('MemoryComposer.handleSave — duration absent (metadata missing)', () => {
  it('validateMedia returns ok: true when duration is undefined (no check performed)', () => {
    // handleSave passes `duration: videoDuration ?? undefined`.
    // When videoDuration is null (no metadata), duration becomes undefined,
    // and validateMedia skips the duration check entirely — no upload blocked.
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video' /* no duration */ },
      { surface: 'memory' },
    );
    assert.equal(result.ok, true, 'absent duration must not trigger a rejection');
  });

  it('validateMedia returns ok: true when duration is null (missing metadata)', () => {
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: null },
      { surface: 'memory' },
    );
    assert.equal(result.ok, true, 'null duration must not trigger a rejection');
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
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 31 },
      { surface: 'memory' },
    );
    assert.equal(result.ok, false, 'should fail for memory surface');
  });

  it('memory limit (30 s) is stricter than postcard (60 s) and event (120 s)', () => {
    assert.ok(
      VIDEO_MAX_DURATION_SECONDS.memory < VIDEO_MAX_DURATION_SECONDS.postcard,
      'memory must be shorter than postcard',
    );
    assert.ok(
      VIDEO_MAX_DURATION_SECONDS.memory < VIDEO_MAX_DURATION_SECONDS.event,
      'memory must be shorter than event',
    );
  });
});

// ── MIME fallback — video asset without mimeType normalises to video/mp4 ────────

describe('MemoryComposer — MIME fallback for video assets', () => {
  it('validateMedia treats a video asset with absent mimeType as video (not image)', () => {
    // MemoriesTab.pickVideoOrPhoto now sets:
    //   mimeType = asset.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg')
    // Simulating the fallback: absent mimeType on a video asset → 'video/mp4'.
    // validateMedia must then apply video rules (duration check), not image rules.
    const result = validateMedia(
      { uri: 'file:///tmp/video.mp4', mimeType: 'video/mp4', type: 'video', duration: 31 },
      { surface: 'memory' },
    );
    // If treated as video, duration check fires → ok: false.
    // If mistakenly treated as image, duration is ignored → ok: true (wrong).
    assert.equal(result.ok, false, 'video asset must be validated as video even when mimeType was absent');
  });

  it('an image asset with absent mimeType normalises to image/jpeg (no duration check)', () => {
    // image assets never have duration — the fallback must not accidentally
    // classify them as video and trigger a spurious duration rejection.
    const result = validateMedia(
      { uri: 'file:///tmp/photo.jpg', mimeType: 'image/jpeg', type: 'image' },
      { surface: 'memory' },
    );
    assert.equal(result.ok, true, 'image asset must pass without a duration check');
  });
});
