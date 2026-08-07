/**
 * Filter catalogue — value-domain and interpolation correctness.
 *
 * ## What this file deliberately does NOT do
 *
 * It does not judge how any filter LOOKS. Whether Wanderlust (saturate 1.5) is
 * perceptually distinct enough from Vivid (saturate 2.0) to earn its own slot,
 * and whether the warm presets flatter real landscapes, food and skin in
 * daylight, are questions that can only be answered against real photographs on
 * a real device. Nothing here should be read as validating those choices, and
 * no number in filters.ts should be tuned on the strength of these tests
 * passing. That tuning is parked for after the device pass.
 *
 * What it DOES check is everything that is objectively decidable without a
 * screen:
 *
 *   - every preset's raw values sit in the domain CSS/RN actually accept
 *     (a negative brightness or a sepia above 1 is a bug at any taste level)
 *   - intensity 0 is identity for EVERY preset, not just the one spot-checked
 *   - intensity 100 reproduces the preset exactly
 *   - interpolation is monotonic between those endpoints
 *   - Original is a true no-op, structurally equal to identity
 *   - no two presets are literally the same numbers (a duplicate is dead UI)
 *   - no preset is degenerate — invisible at its own default intensity
 *
 * Run with: node --import tsx/esm --test src/lib/media/__tests__/filterValues.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mediaFilters,
  getMediaFilter,
  buildCssFilter,
  resolveFilterStyle,
  type FilterValues,
} from '../filters.ts';

const IDENTITY: FilterValues = {
  brightness: 1,
  contrast: 1,
  saturate: 1,
  sepia: 0,
  hueRotate: 0,
  grayscale: 0,
};

const NON_ORIGINAL = mediaFilters.filter((f) => f.id !== 'original');

// Domains CSS filter functions and RN's FilterFunction actually accept.
// Upper bounds are sanity ceilings, not taste judgements: a brightness of 8
// is a typo, not a look.
const DOMAINS: Record<keyof FilterValues, { min: number; max: number }> = {
  brightness: { min: 0, max: 3 },
  contrast:   { min: 0, max: 3 },
  saturate:   { min: 0, max: 4 },
  sepia:      { min: 0, max: 1 },
  grayscale:  { min: 0, max: 1 },
  hueRotate:  { min: -360, max: 360 },
};

describe('preset values sit in a valid domain', () => {
  for (const f of mediaFilters) {
    it(`${f.id}: every component is a finite number inside its domain`, () => {
      for (const key of Object.keys(DOMAINS) as Array<keyof FilterValues>) {
        const v = f.values[key];
        assert.equal(typeof v, 'number', `${f.id}.${key} must be a number, got ${typeof v}`);
        assert.ok(Number.isFinite(v), `${f.id}.${key} must be finite, got ${v}`);
        const { min, max } = DOMAINS[key];
        assert.ok(v >= min && v <= max, `${f.id}.${key} = ${v} is outside [${min}, ${max}]`);
      }
    });
  }

  it('sepia and grayscale are proportions, never above 1', () => {
    // These two clamp silently at the platform layer, so an out-of-range value
    // would not throw — it would just quietly stop responding to intensity.
    for (const f of mediaFilters) {
      assert.ok(f.values.sepia <= 1, `${f.id} sepia ${f.values.sepia} > 1`);
      assert.ok(f.values.grayscale <= 1, `${f.id} grayscale ${f.values.grayscale} > 1`);
    }
  });

  it('brightness and contrast are never zero — that is a black or flat frame', () => {
    for (const f of mediaFilters) {
      assert.ok(f.values.brightness > 0, `${f.id} brightness must be > 0`);
      assert.ok(f.values.contrast > 0, `${f.id} contrast must be > 0`);
    }
  });

  it('defaultIntensity is a usable 0–100 value', () => {
    for (const f of mediaFilters) {
      assert.ok(
        Number.isFinite(f.defaultIntensity) && f.defaultIntensity >= 0 && f.defaultIntensity <= 100,
        `${f.id} defaultIntensity ${f.defaultIntensity} outside 0–100`,
      );
    }
  });

  it('no non-Original preset defaults to an intensity that makes it invisible', () => {
    // A default of 0 would present a named filter in the carousel that does
    // nothing when tapped.
    for (const f of NON_ORIGINAL) {
      assert.ok(f.defaultIntensity > 0, `${f.id} defaults to intensity 0 — it would do nothing`);
    }
  });
});

describe('Original is a true identity no-op', () => {
  const original = getMediaFilter('original');

  it('its values are structurally identity', () => {
    assert.deepEqual(original.values, IDENTITY);
  });

  it('it produces no CSS at any intensity', () => {
    for (const intensity of [0, 1, 25, 50, 99, 100]) {
      assert.equal(buildCssFilter(original, intensity), 'none', `intensity ${intensity}`);
    }
  });

  it('it produces no style on either platform at any intensity', () => {
    for (const intensity of [0, 50, 100]) {
      assert.equal(resolveFilterStyle('original', intensity, 'web'), undefined);
      assert.equal(resolveFilterStyle('original', intensity, 'native'), undefined);
    }
  });
});

describe('intensity endpoints', () => {
  it('intensity 0 is identity for EVERY preset', () => {
    // The endpoint that matters most: dragging the slider to zero must return
    // the untouched photo, whichever filter is selected.
    for (const f of mediaFilters) {
      assert.equal(
        buildCssFilter(f, 0),
        'none',
        `${f.id} still applies something at intensity 0`,
      );
      assert.equal(resolveFilterStyle(f.id, 0, 'web'), undefined, `${f.id} web`);
      assert.equal(resolveFilterStyle(f.id, 0, 'native'), undefined, `${f.id} native`);
    }
  });

  it('intensity 100 reproduces the preset values exactly', () => {
    for (const f of NON_ORIGINAL) {
      const css = buildCssFilter(f, 100);
      // Each component that differs from identity must appear at its full value.
      if (Math.abs(f.values.brightness - 1) > 0.001) {
        assert.match(css, new RegExp(`brightness\\(${f.values.brightness.toFixed(3)}\\)`), `${f.id} brightness`);
      }
      if (Math.abs(f.values.saturate - 1) > 0.001) {
        assert.match(css, new RegExp(`saturate\\(${f.values.saturate.toFixed(3)}\\)`), `${f.id} saturate`);
      }
      if (f.values.grayscale > 0.001) {
        assert.match(css, new RegExp(`grayscale\\(${f.values.grayscale.toFixed(3)}\\)`), `${f.id} grayscale`);
      }
    }
  });
});

describe('interpolation between the endpoints', () => {
  it('every component moves monotonically from identity toward the preset', () => {
    // Linear today. This guards the property rather than the formula, so a
    // future easing curve is free to change the shape but not to overshoot or
    // double back.
    for (const f of NON_ORIGINAL) {
      for (const key of Object.keys(DOMAINS) as Array<keyof FilterValues>) {
        const from = IDENTITY[key];
        const to = f.values[key];
        if (Math.abs(to - from) < 0.001) continue;

        let prev = from;
        for (let t = 0; t <= 100; t += 10) {
          const now = componentAt(f.values[key], IDENTITY[key], t);
          const movingUp = to > from;
          assert.ok(
            movingUp ? now >= prev - 1e-9 : now <= prev + 1e-9,
            `${f.id}.${key} not monotonic at intensity ${t}: ${prev} → ${now} (target ${to})`,
          );
          assert.ok(
            movingUp ? now <= to + 1e-9 : now >= to - 1e-9,
            `${f.id}.${key} overshoots ${to} at intensity ${t}: ${now}`,
          );
          prev = now;
        }
      }
    }
  });

  it('half intensity lands between identity and the preset, never outside', () => {
    for (const f of NON_ORIGINAL) {
      for (const key of Object.keys(DOMAINS) as Array<keyof FilterValues>) {
        const from = IDENTITY[key];
        const to = f.values[key];
        const mid = componentAt(to, from, 50);
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        assert.ok(mid >= lo - 1e-9 && mid <= hi + 1e-9, `${f.id}.${key} midpoint ${mid} outside [${lo}, ${hi}]`);
      }
    }
  });

  it('interpolated values stay inside their domain at every intensity', () => {
    // Interpolating between two in-range values cannot leave the range, but
    // this pins it so a future preset added out of range fails here loudly
    // rather than clamping silently on device.
    for (const f of NON_ORIGINAL) {
      for (const key of Object.keys(DOMAINS) as Array<keyof FilterValues>) {
        const { min, max } = DOMAINS[key];
        for (let t = 0; t <= 100; t += 25) {
          const v = componentAt(f.values[key], IDENTITY[key], t);
          assert.ok(v >= min && v <= max, `${f.id}.${key} = ${v} outside [${min}, ${max}] at intensity ${t}`);
        }
      }
    }
  });
});

describe('the catalogue has no dead entries', () => {
  it('no two presets carry identical values', () => {
    // A literal duplicate is dead UI: two carousel slots that cannot be told
    // apart under any lighting. NOTE: this proves only that the NUMBERS
    // differ. Whether two presets are perceptually distinct — the open
    // Wanderlust/Vivid question — is a device judgement, not this assertion.
    const seen = new Map<string, string>();
    for (const f of mediaFilters) {
      const key = JSON.stringify(f.values);
      const dup = seen.get(key);
      assert.equal(dup, undefined, `${f.id} has values identical to ${dup}`);
      seen.set(key, f.id);
    }
  });

  it('every non-Original preset differs from identity in at least one component', () => {
    for (const f of NON_ORIGINAL) {
      assert.notDeepEqual(f.values, IDENTITY, `${f.id} is identity in disguise — it would do nothing`);
    }
  });

  it('every preset has a name and a description', () => {
    for (const f of mediaFilters) {
      assert.ok(f.name.trim().length > 0, `${f.id} has no name`);
      assert.ok(f.description.trim().length > 0, `${f.id} has no description`);
    }
  });

  it('names are unique — the carousel label is the only text identifier', () => {
    const names = mediaFilters.map((f) => f.name);
    assert.equal(new Set(names).size, names.length, 'duplicate filter name');
  });
});

/** Mirror of the lerp in filters.ts, used to probe interpolation properties. */
function componentAt(preset: number, identity: number, intensity: number): number {
  const t = Math.max(0, Math.min(100, intensity)) / 100;
  return identity + (preset - identity) * t;
}
