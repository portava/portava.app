/**
 * useCollapsingHeader.test.ts
 *
 * Verifies the no-overlap invariant between the large header and compact bar:
 * the compact bar must NEVER have a non-zero opacity while the large header
 * still has a non-zero opacity.  This prevents the double-title flicker seen
 * on slow devices where navBarProgress can snap to 1 before the first
 * animation frame completes.
 *
 * All assertions exercise the pure `_computeCollapsingOpacities` helper which
 * mirrors the Reanimated worklet arithmetic exactly — no Reanimated runtime
 * needed.
 *
 * Run (auto-discovered by scripts/run-node-tests.mjs):
 *   node --import tsx/esm --test src/hooks/__tests__/useCollapsingHeader.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  _computeCollapsingOpacities,
  LARGE_FADE_END,
  COMPACT_FADE_START,
} from '../collapsingHeaderUtils.ts';

// ── helpers ────────────────────────────────────────────────────────────────────

/** Round to 6 decimal places to avoid floating-point noise in assertions. */
function round(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. Threshold constants — no-overlap guarantee
// ═══════════════════════════════════════════════════════════════════════════════

describe('threshold constants — compact bar starts no earlier than large header ends', () => {
  it('COMPACT_FADE_START equals LARGE_FADE_END so the ranges share no gap or overlap', () => {
    assert.equal(
      COMPACT_FADE_START,
      LARGE_FADE_END,
      'COMPACT_FADE_START must equal LARGE_FADE_END — any earlier value creates an overlap window',
    );
  });

  it('LARGE_FADE_END is > 0 and < 1 (animates, not instant)', () => {
    assert.ok(LARGE_FADE_END > 0 && LARGE_FADE_END < 1,
      'LARGE_FADE_END must be a fraction strictly between 0 and 1');
  });

  it('COMPACT_FADE_START is > 0 and < 1 (compact bar never starts immediately)', () => {
    assert.ok(COMPACT_FADE_START > 0 && COMPACT_FADE_START < 1,
      'COMPACT_FADE_START must be a fraction strictly between 0 and 1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. Boundary values
// ═══════════════════════════════════════════════════════════════════════════════

describe('boundary values at progress=0 and progress=1', () => {
  it('at progress=0: large header fully visible, compact bar hidden', () => {
    const { largeHeaderOpacity, compactBarOpacity } = _computeCollapsingOpacities(0);
    assert.equal(round(largeHeaderOpacity), 1, 'large header must be fully opaque at p=0');
    assert.equal(round(compactBarOpacity), 0, 'compact bar must be invisible at p=0');
  });

  it('at progress=1: compact bar fully visible, large header hidden', () => {
    const { largeHeaderOpacity, compactBarOpacity } = _computeCollapsingOpacities(1);
    assert.equal(round(largeHeaderOpacity), 0, 'large header must be invisible at p=1');
    assert.equal(round(compactBarOpacity), 1, 'compact bar must be fully opaque at p=1');
  });

  it('at progress=LARGE_FADE_END: large header reaches exactly 0, compact bar at 0', () => {
    const { largeHeaderOpacity, compactBarOpacity } = _computeCollapsingOpacities(LARGE_FADE_END);
    assert.equal(round(largeHeaderOpacity), 0,
      'large header opacity must hit 0 at exactly LARGE_FADE_END');
    assert.equal(round(compactBarOpacity), 0,
      'compact bar must still be 0 at LARGE_FADE_END — no overlap at boundary');
  });

  it('at progress=COMPACT_FADE_START: compact bar is still 0 (starts fading in after this point)', () => {
    const { compactBarOpacity } = _computeCollapsingOpacities(COMPACT_FADE_START);
    assert.equal(round(compactBarOpacity), 0,
      'compact bar must be 0 at COMPACT_FADE_START itself');
  });

  it('just past COMPACT_FADE_START the compact bar begins to appear', () => {
    const { compactBarOpacity } = _computeCollapsingOpacities(COMPACT_FADE_START + 0.01);
    assert.ok(compactBarOpacity > 0,
      'compact bar should start appearing just past COMPACT_FADE_START');
  });

  it('just before LARGE_FADE_END the large header is still partially visible', () => {
    const { largeHeaderOpacity } = _computeCollapsingOpacities(LARGE_FADE_END - 0.01);
    assert.ok(largeHeaderOpacity > 0,
      'large header should still be visible just before LARGE_FADE_END');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. No-overlap invariant across the full progress range
// ═══════════════════════════════════════════════════════════════════════════════

describe('no-overlap invariant — both headers never simultaneously non-zero', () => {
  /**
   * Simulates the coarse frame steps a slow device might produce: instead of
   * smooth 60 fps increments, progress jumps in large steps.  At each step
   * both opacities must not be simultaneously positive.
   */
  const SLOW_DEVICE_STEPS = [
    0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35,
    0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70,
    0.75, 0.80, 0.85, 0.90, 0.95, 1.00,
  ];

  it('no step has both largeHeaderOpacity > 0 AND compactBarOpacity > 0', () => {
    for (const p of SLOW_DEVICE_STEPS) {
      const { largeHeaderOpacity, compactBarOpacity } = _computeCollapsingOpacities(p);
      const bothVisible = largeHeaderOpacity > 0 && compactBarOpacity > 0;
      assert.ok(
        !bothVisible,
        `At progress=${p.toFixed(2)}: both headers visible simultaneously — ` +
        `largeHeader=${round(largeHeaderOpacity)}, compactBar=${round(compactBarOpacity)}. ` +
        'This would cause a double-title flicker on slow devices.',
      );
    }
  });

  it('no progress in [0, 1] at 1000-step resolution has both headers simultaneously visible', () => {
    const STEPS = 1000;
    for (let i = 0; i <= STEPS; i++) {
      const p = i / STEPS;
      const { largeHeaderOpacity, compactBarOpacity } = _computeCollapsingOpacities(p);
      if (largeHeaderOpacity > 0 && compactBarOpacity > 0) {
        assert.fail(
          `Overlap detected at progress=${p.toFixed(4)}: ` +
          `largeHeader=${round(largeHeaderOpacity)}, compactBar=${round(compactBarOpacity)}`,
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Monotonicity — opacities move in the right direction
// ═══════════════════════════════════════════════════════════════════════════════

describe('monotonicity — opacities trend in the correct direction', () => {
  it('large header opacity is non-increasing as progress increases from 0 to 1', () => {
    let prev = _computeCollapsingOpacities(0).largeHeaderOpacity;
    for (let i = 1; i <= 100; i++) {
      const p = i / 100;
      const { largeHeaderOpacity } = _computeCollapsingOpacities(p);
      assert.ok(
        largeHeaderOpacity <= prev + 1e-9, // tiny epsilon for float noise
        `Large header opacity increased from ${round(prev)} to ${round(largeHeaderOpacity)} at p=${p.toFixed(2)}`,
      );
      prev = largeHeaderOpacity;
    }
  });

  it('compact bar opacity is non-decreasing as progress increases from 0 to 1', () => {
    let prev = _computeCollapsingOpacities(0).compactBarOpacity;
    for (let i = 1; i <= 100; i++) {
      const p = i / 100;
      const { compactBarOpacity } = _computeCollapsingOpacities(p);
      assert.ok(
        compactBarOpacity >= prev - 1e-9, // tiny epsilon for float noise
        `Compact bar opacity decreased from ${round(prev)} to ${round(compactBarOpacity)} at p=${p.toFixed(2)}`,
      );
      prev = compactBarOpacity;
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. Out-of-range progress values are clamped safely
// ═══════════════════════════════════════════════════════════════════════════════

describe('clamping — progress values outside [0, 1] are handled safely', () => {
  it('negative progress clamps to the same result as progress=0', () => {
    const atZero    = _computeCollapsingOpacities(0);
    const negative  = _computeCollapsingOpacities(-0.5);
    assert.equal(round(negative.largeHeaderOpacity), round(atZero.largeHeaderOpacity));
    assert.equal(round(negative.compactBarOpacity),  round(atZero.compactBarOpacity));
  });

  it('progress > 1 clamps to the same result as progress=1', () => {
    const atOne  = _computeCollapsingOpacities(1);
    const over   = _computeCollapsingOpacities(1.5);
    assert.equal(round(over.largeHeaderOpacity), round(atOne.largeHeaderOpacity));
    assert.equal(round(over.compactBarOpacity),  round(atOne.compactBarOpacity));
  });
});
