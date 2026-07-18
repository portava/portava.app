/**
 * useMessageMediaPicker.validation.test.ts
 *
 * Tests for the message-surface media validation logic:
 *  - Confirm images up to 10 MB are accepted
 *  - Confirm images over 10 MB are rejected
 *  - Confirm videos up to 60 s are accepted (message surface cap)
 *  - Confirm videos over 60 s are rejected (62 s edge case)
 *  - Confirm 10 s video is accepted (not silently capped at highlight 10 s limit)
 *  - Confirm 30 s video is accepted
 *  - Confirm 9 s video is accepted
 *  - Confirm duration unit stays in seconds (not multiplied to ms)
 *
 * Run:
 *   node --import tsx/esm --test src/hooks/__tests__/useMessageMediaPicker.validation.test.ts
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateMedia } from '../../services/media.ts';
import type { PickedMedia } from '../../services/media.ts';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeVideo(durationSeconds: number, sizeBytes = 1_000_000): PickedMedia {
  return {
    uri: 'file://test.mp4',
    mimeType: 'video/mp4',
    type: 'video',
    fileSize: sizeBytes,
    duration: durationSeconds,
  };
}

function makeImage(sizeBytes: number): PickedMedia {
  return {
    uri: 'file://test.jpg',
    mimeType: 'image/jpeg',
    type: 'image',
    fileSize: sizeBytes,
  };
}

// ── Image size limits ─────────────────────────────────────────────────────────

describe('message media validation — images', () => {
  test('accepts image exactly at 10 MB limit', () => {
    const result = validateMedia(makeImage(10_000_000), { surface: 'message' });
    assert.equal(result.ok, true);
  });

  test('rejects image just over 10 MB', () => {
    const result = validateMedia(makeImage(10_000_001), { surface: 'message' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'too_large');
  });

  test('accepts small image (100 KB)', () => {
    const result = validateMedia(makeImage(100_000), { surface: 'message' });
    assert.equal(result.ok, true);
  });
});

// ── Video duration limits (message surface = 60 s) ───────────────────────────

describe('message media validation — video duration with surface:message', () => {
  test('accepts 9 s video', () => {
    const result = validateMedia(makeVideo(9), { surface: 'message' });
    assert.equal(result.ok, true, '9 s video should be accepted on message surface');
  });

  test('accepts 10 s video (not blocked by legacy highlight cap)', () => {
    const result = validateMedia(makeVideo(10), { surface: 'message' });
    assert.equal(result.ok, true, '10 s video should be accepted — message limit is 60 s, not 10 s');
  });

  test('accepts 30 s video', () => {
    const result = validateMedia(makeVideo(30), { surface: 'message' });
    assert.equal(result.ok, true, '30 s video should be accepted on message surface');
  });

  test('accepts 60 s video (at limit)', () => {
    const result = validateMedia(makeVideo(60), { surface: 'message' });
    assert.equal(result.ok, true, '60 s video should be accepted — exactly at message cap');
  });

  test('rejects 61 s video (over limit)', () => {
    const result = validateMedia(makeVideo(61), { surface: 'message' });
    assert.equal(result.ok, false, '61 s video should be rejected');
    if (!result.ok) assert.equal(result.kind, 'too_large');
  });

  test('rejects 62 s video', () => {
    const result = validateMedia(makeVideo(62), { surface: 'message' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'too_large');
  });
});

// ── Duration unit guard: seconds, not milliseconds ───────────────────────────

describe('message media validation — duration unit sanity', () => {
  test('30 000 ms passed as duration (unit bug) is correctly rejected as too large', () => {
    // If a caller accidentally passes milliseconds instead of seconds,
    // validateMedia should reject it as "too_large" (30 000 s >> 60 s limit).
    const result = validateMedia(makeVideo(30_000), { surface: 'message' });
    assert.equal(result.ok, false, 'Duration in ms (30 000) should be rejected — confirms seconds are expected');
    if (!result.ok) assert.equal(result.kind, 'too_large');
  });

  test('30 s passed correctly is accepted', () => {
    const result = validateMedia(makeVideo(30), { surface: 'message' });
    assert.equal(result.ok, true, '30 s (correct unit) should pass');
  });
});

// ── Default surface should NOT be used for messages ───────────────────────────

describe('message media validation — surface matters', () => {
  test('11 s video is rejected without surface (defaults to highlight cap 10 s)', () => {
    // Without surface, validateMedia falls back to the 10 s highlight default.
    // This test documents the expected behaviour and why surface:message is required.
    const result = validateMedia(makeVideo(11));
    assert.equal(result.ok, false, '11 s video should fail without surface (highlight cap = 10 s)');
  });

  test('11 s video is accepted with surface:message (message cap = 60 s)', () => {
    const result = validateMedia(makeVideo(11), { surface: 'message' });
    assert.equal(result.ok, true, '11 s video should pass with surface:message');
  });
});
