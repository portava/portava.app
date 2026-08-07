/**
 * resolveFilterStyle — the identity-fallback invariant.
 *
 * The contract this file exists to defend:
 *
 *   A missing, unknown, or malformed filter renders the image UNFILTERED.
 *   Never blank, never a thrown style, never a value React Native would
 *   reject.
 *
 * That matters more than any pixel behaviour here. Filter application is
 * centralised in DisplayMediaImage / CachedImage, which sit directly on the
 * media render path that was just repaired for the blank-media bug. If a bad
 * filter id could throw, or emit a style RN rejects, centralising filters
 * would have become a brand-new way for an image to disappear.
 *
 * `undefined` (apply no style at all) is the required no-filter return — NOT
 * `{ filter: 'none' }`. Returning undefined keeps the unfiltered render path
 * byte-for-byte identical to having no filter feature, which is what makes an
 * unrecognised id incapable of changing how an image mounts.
 *
 * Run with: node --import tsx/esm --test src/lib/media/__tests__/filterStyle.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveFilterStyle,
  buildCssFilter,
  buildFilterFunctions,
  getMediaFilter,
  mediaFilters,
  type MediaFilter,
} from '../filters.ts';

const PLATFORMS = ['web', 'native'] as const;

// A real, non-identity preset to prove the happy path still produces output.
const REAL = 'noir';

describe('resolveFilterStyle — identity fallback (never blank, never throws)', () => {
  // Every value that must mean "no filter". Each is a shape that could
  // plausibly reach a render surface from a DB row, a stale client, or a
  // hand-edited record.
  const NO_FILTER_IDS: Array<[string, unknown]> = [
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['explicit original', 'original'],
    ['unknown id', 'not_a_real_filter'],
    ['id from a future release', 'kodachrome_v2'],
    ['numeric id', 123],
    ['object id', { id: 'noir' }],
    ['array id', ['noir']],
    ['boolean id', true],
    ['whitespace', '   '],
    ['case mismatch', 'NOIR'],
  ];

  for (const platform of PLATFORMS) {
    for (const [label, id] of NO_FILTER_IDS) {
      it(`${platform}: ${label} → undefined (no style applied)`, () => {
        const out = resolveFilterStyle(id as string, 100, platform);
        assert.equal(out, undefined, `${label} must apply no filter style at all`);
      });
    }
  }

  // Malformed intensities paired with a REAL filter id. These must not throw
  // and must not emit NaN into a style value — RN would reject that.
  const MALFORMED_INTENSITIES: Array<[string, unknown]> = [
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['string', '80' as unknown],
    ['object', {}],
    ['array', []],
    ['boolean', false],
  ];

  for (const platform of PLATFORMS) {
    for (const [label, intensity] of MALFORMED_INTENSITIES) {
      it(`${platform}: real filter with ${label} intensity never throws or emits NaN`, () => {
        let out;
        assert.doesNotThrow(() => {
          out = resolveFilterStyle(REAL, intensity as number, platform);
        }, `${label} intensity must not throw`);

        // Either no filter, or a well-formed one — but never NaN anywhere.
        if (out !== undefined) {
          assert.ok(!serialize(out).includes('NaN'), `${label} produced NaN in ${serialize(out)}`);
        }
      });
    }
  }

  for (const platform of PLATFORMS) {
    it(`${platform}: null/undefined intensity falls back to full strength, not NaN`, () => {
      const withNull = resolveFilterStyle(REAL, null, platform);
      const withUndef = resolveFilterStyle(REAL, undefined, platform);
      const withFull = resolveFilterStyle(REAL, 100, platform);

      assert.deepEqual(withNull, withFull, 'null intensity must equal full strength');
      assert.deepEqual(withUndef, withFull, 'undefined intensity must equal full strength');
      assert.notEqual(withFull, undefined, 'a real filter at full strength must produce a style');
    });
  }

  for (const platform of PLATFORMS) {
    it(`${platform}: zero intensity is identity → undefined`, () => {
      // At t=0 every component interpolates back to identity, so there is
      // nothing to apply and the no-style path must be taken.
      assert.equal(resolveFilterStyle(REAL, 0, platform), undefined);
    });

    it(`${platform}: out-of-range intensity clamps rather than extrapolating`, () => {
      assert.deepEqual(
        resolveFilterStyle(REAL, 500, platform),
        resolveFilterStyle(REAL, 100, platform),
        'above 100 must clamp to 100',
      );
      assert.equal(resolveFilterStyle(REAL, -50, platform), undefined, 'below 0 must clamp to 0 → identity');
    });
  }
});

describe('resolveFilterStyle — platform shapes', () => {
  it('web emits a CSS filter string', () => {
    const out = resolveFilterStyle(REAL, 100, 'web');
    assert.ok(out, 'expected a style');
    assert.equal(typeof out.filter, 'string');
    assert.match(out.filter as string, /grayscale\(/, 'Noir must include grayscale');
    assert.ok(!(out.filter as string).includes('none'), 'a real filter must not serialise to none');
  });

  it('native emits the RN filter-function array, not a CSS string', () => {
    const out = resolveFilterStyle(REAL, 100, 'native');
    assert.ok(out, 'expected a style');
    assert.ok(Array.isArray(out.filter), 'native must use the array form');
    assert.ok((out.filter as unknown[]).length > 0);
    // Each entry is a single-key object — the shape RN's FilterFunction expects.
    for (const fn of out.filter as Array<Record<string, unknown>>) {
      assert.equal(Object.keys(fn).length, 1, `expected one key per entry, got ${serialize(fn)}`);
    }
  });

  it('the two platforms disagree in shape but agree on whether a filter applies', () => {
    // The whole point of the split: a filter must never silently no-op on one
    // platform while working on the other.
    for (const f of mediaFilters) {
      const web = resolveFilterStyle(f.id, f.defaultIntensity, 'web');
      const native = resolveFilterStyle(f.id, f.defaultIntensity, 'native');
      assert.equal(
        web === undefined,
        native === undefined,
        `${f.id}: applies on one platform but not the other (web=${serialize(web)}, native=${serialize(native)})`,
      );
    }
  });
});

describe('the filter catalogue itself', () => {
  it('every preset produces a usable style at its default intensity, except Original', () => {
    for (const f of mediaFilters) {
      const out = resolveFilterStyle(f.id, f.defaultIntensity, 'web');
      if (f.id === 'original') {
        assert.equal(out, undefined, 'Original must apply no filter');
      } else {
        assert.notEqual(out, undefined, `${f.id} produced no visible effect at its default intensity`);
      }
    }
  });

  it('filter ids are unique', () => {
    const ids = mediaFilters.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate filter id');
  });

  it('getMediaFilter falls back to Original for anything unrecognised', () => {
    for (const [, id] of [['a', null], ['b', undefined], ['c', 'nope'], ['d', '']] as Array<[string, unknown]>) {
      assert.equal(getMediaFilter(id as string).id, 'original');
    }
  });

  it('buildCssFilter tolerates a filter with a missing values block', () => {
    // Defends against a corrupted or partially-constructed catalogue entry
    // reaching the render path — it must degrade to identity, not throw.
    const broken = { id: 'broken', name: 'Broken', description: '', defaultIntensity: 100, supportsVideo: true } as unknown as MediaFilter;
    assert.doesNotThrow(() => buildCssFilter(broken, 100));
    assert.equal(buildCssFilter(broken, 100), 'none');
    assert.deepEqual(buildFilterFunctions(broken, 100), []);
  });

  it('buildCssFilter tolerates non-numeric component values', () => {
    const broken = {
      id: 'broken',
      name: 'Broken',
      description: '',
      defaultIntensity: 100,
      supportsVideo: true,
      values: { brightness: 'x', contrast: null, saturate: undefined, sepia: NaN, hueRotate: {}, grayscale: [] },
    } as unknown as MediaFilter;
    assert.doesNotThrow(() => buildCssFilter(broken, 100));
    assert.ok(!buildCssFilter(broken, 100).includes('NaN'));
    assert.ok(!serialize(buildFilterFunctions(broken, 100)).includes('NaN'));
  });
});

function serialize(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}
