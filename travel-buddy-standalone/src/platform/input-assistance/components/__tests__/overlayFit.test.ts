/**
 * §46 — the overlay's height against the software keyboard and the OS text
 * scale. Run: node --import tsx/esm --test src/platform/input-assistance/components/__tests__/overlayFit.test.ts
 *
 * WHAT THESE ASSERTIONS ARE WORTH
 * -------------------------------
 * They prove the GEOMETRY: given a field position, a window, a keyboard height
 * and a text scale, the card is capped to the band that is visible. That is the
 * half of census G327/G328 that is a code fact.
 *
 * They do NOT prove that no overlay on any real screen is occluded. The inputs
 * here are fixtures; on a handset they come from `measureInWindow` and from
 * `keyboardDidShow`, and whether those report what this module assumes is a
 * device question. Both rows therefore stay CANNOT-VERIFY, and
 * `docs/architecture/input-assistance-a11y-device-protocol.md` carries the
 * procedure that would settle them. A green run of this file is NOT a
 * substitute for that protocol's ledger.
 *
 * THE FIXTURE IS CHOSEN TO BE ABLE TO FAIL. The old behaviour was a literal
 * `maxHeight = 320`, so every case below uses a window/keyboard/field
 * combination whose answer is NOT 320 — a test whose expected value equals the
 * constant it replaced would pass against the defect.
 *
 * MUTATION LOG (each applied, watched go red, reverted):
 *   - overlayFit: drop the `keyboardHeight` term from `visibleBottom`
 *     → "the keyboard takes the room away" goes red.
 *   - overlayFit: return `desired` unconditionally
 *     → four cases go red.
 *   - overlayFit: clamp with `Math.min` instead of the MIN_OVERLAY_HEIGHT floor
 *     → "never shrinks to an unusable sliver" goes red.
 *   - scaledOverlayCap: ignore fontScale → "the cap grows with the text scale"
 *     goes red.
 *   - rowLineLimit: `return 1` → three cases go red.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  overlayFit,
  scaledOverlayCap,
  rowLineLimit,
  DEFAULT_OVERLAY_MAX_HEIGHT,
  MIN_OVERLAY_HEIGHT,
  OVERLAY_BOTTOM_GUTTER,
  MAX_FONT_SCALE_GROWTH,
} from '../overlayFit.ts';

const WINDOW = 800;

test('§46: an unmeasured field gets the full cap — an unknown position is not a known-bad one', () => {
  const fit = overlayFit({ fieldBottomY: null, windowHeight: WINDOW, keyboardHeight: 336 });
  assert.equal(fit.maxHeight, DEFAULT_OVERLAY_MAX_HEIGHT);
  assert.equal(fit.clamped, false);
});

test('§46: with the keyboard down and room to spare, the cap is unchanged', () => {
  const fit = overlayFit({ fieldBottomY: 120, windowHeight: WINDOW, keyboardHeight: 0 });
  assert.equal(fit.maxHeight, DEFAULT_OVERLAY_MAX_HEIGHT);
  assert.equal(fit.clamped, false);
  assert.equal(fit.occluded, false);
});

test('§46: the keyboard takes the room away — the card shrinks to the visible band', () => {
  // 800 window, 300 keyboard, field bottom at 300 ⇒ 800-300-300-8 = 192 visible.
  const fit = overlayFit({ fieldBottomY: 300, windowHeight: WINDOW, keyboardHeight: 300 });
  assert.equal(fit.maxHeight, 192);
  assert.equal(fit.clamped, true);
  assert.equal(fit.occluded, false);
  // The defect this replaces would have drawn 320 into a 192-px hole.
  assert.ok(fit.maxHeight < DEFAULT_OVERLAY_MAX_HEIGHT);
});

test('§46: the SAME field with the keyboard down is not shrunk — the keyboard is the cause', () => {
  const down = overlayFit({ fieldBottomY: 300, windowHeight: WINDOW, keyboardHeight: 0 });
  const up = overlayFit({ fieldBottomY: 300, windowHeight: WINDOW, keyboardHeight: 300 });
  assert.equal(down.maxHeight, DEFAULT_OVERLAY_MAX_HEIGHT);
  assert.ok(up.maxHeight < down.maxHeight);
});

test('§46: a bottom inset (home indicator / tab bar) is room the card does not have', () => {
  const bare = overlayFit({ fieldBottomY: 300, windowHeight: WINDOW, keyboardHeight: 300 });
  const inset = overlayFit({
    fieldBottomY: 300,
    windowHeight: WINDOW,
    keyboardHeight: 300,
    bottomInset: 34,
  });
  assert.equal(inset.maxHeight, bare.maxHeight - 34);
});

test('§46: it never shrinks to an unusable sliver — and says so when it is occluded', () => {
  // Field 20 px above the keyboard: nothing sensible fits.
  const fit = overlayFit({ fieldBottomY: 480, windowHeight: WINDOW, keyboardHeight: 300 });
  assert.equal(fit.maxHeight, MIN_OVERLAY_HEIGHT);
  assert.equal(fit.clamped, true);
  // THE RESIDUAL, asserted rather than hidden: part of the card IS behind the
  // keyboard here, because this layer cannot flip the overlay above the field.
  assert.equal(fit.occluded, true);
});

test('§46: the gutter is real — one pixel more field and the card is one pixel shorter', () => {
  const a = overlayFit({ fieldBottomY: 300, windowHeight: WINDOW, keyboardHeight: 300 });
  const b = overlayFit({ fieldBottomY: 301, windowHeight: WINDOW, keyboardHeight: 300 });
  assert.equal(a.maxHeight - b.maxHeight, 1);
  assert.equal(a.maxHeight, WINDOW - 300 - 300 - OVERLAY_BOTTOM_GUTTER);
});

test("§46: a caller's own cap is the ceiling the fit works down from, not an override", () => {
  const fit = overlayFit({ fieldBottomY: 120, windowHeight: WINDOW, keyboardHeight: 0, cap: 180 });
  assert.equal(fit.maxHeight, 180);
  const tight = overlayFit({ fieldBottomY: 300, windowHeight: WINDOW, keyboardHeight: 300, cap: 180 });
  assert.equal(tight.maxHeight, 180, 'a cap smaller than the available band is still the cap');
});

// ── §46 dynamic type ─────────────────────────────────────────────────────────

test('§46: the cap grows with the text scale so the row COUNT survives it', () => {
  assert.equal(scaledOverlayCap(320, 1), 320);
  assert.equal(scaledOverlayCap(320, 2), 640);
  assert.equal(scaledOverlayCap(320, 1.5), 480);
});

test('§46: a scale below 1, or nonsense, never shrinks the cap', () => {
  assert.equal(scaledOverlayCap(320, 0.5), 320);
  assert.equal(scaledOverlayCap(320, Number.NaN), 320);
  assert.equal(scaledOverlayCap(320, undefined), 320);
});

test('§46: growth is bounded — a 10x scale does not ask for a 3200-px card', () => {
  assert.equal(scaledOverlayCap(320, 10), 320 * MAX_FONT_SCALE_GROWTH);
});

test('§46: a scaled cap is still clamped by the keyboard — space wins over desire', () => {
  const fit = overlayFit({
    fieldBottomY: 300,
    windowHeight: WINDOW,
    keyboardHeight: 300,
    fontScale: 3,
  });
  // The desire is 960; the band is 192. The user sees fewer rows, not a card
  // three quarters of the way behind the keyboard.
  assert.equal(fit.maxHeight, 192);
  assert.equal(fit.clamped, true);
});

test('§46: large text wraps the label instead of truncating the answer', () => {
  assert.equal(rowLineLimit(1), 1);
  assert.equal(rowLineLimit(1.2), 1);
  assert.equal(rowLineLimit(1.3), 2);
  assert.equal(rowLineLimit(1.9), 2);
  assert.equal(rowLineLimit(2), 3);
  assert.equal(rowLineLimit(3.1), 3, 'bounded: one row must not become the whole list');
});

test('§46: an absent or broken font scale reads as unscaled, never as huge', () => {
  assert.equal(rowLineLimit(undefined), 1);
  assert.equal(rowLineLimit(Number.NaN), 1);
  assert.equal(rowLineLimit(0), 1);
});
