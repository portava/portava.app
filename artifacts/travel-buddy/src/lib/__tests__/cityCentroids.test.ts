/**
 * Validates the CITY_CENTROIDS map for structural correctness:
 *   - all lat values are within [-90, 90]
 *   - all lng values are within [-180, 180]
 *   - no entry sits on null island [0, 0]
 *
 * Note: JS object literals silently drop duplicate keys (last wins), so
 * duplicate detection is done against the raw source text at build time;
 * the runtime assertions here catch range / null-island errors instead.
 *
 * Run via the standard node:test runner (auto-discovered by run-node-tests.mjs).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_CENTROIDS } from '../cityCentroids.ts';

describe('CITY_CENTROIDS — coordinate validity', () => {
  const entries = Object.entries(CITY_CENTROIDS);

  it('has at least 100 entries', () => {
    assert.ok(
      entries.length >= 100,
      `Expected ≥100 entries, got ${entries.length}`,
    );
  });

  it('all lat values are within [-90, 90]', () => {
    const bad = entries.filter(([, [lat]]) => lat < -90 || lat > 90);
    assert.deepEqual(
      bad.map(([k]) => k),
      [],
      `Cities with out-of-range lat: ${bad.map(([k]) => k).join(', ')}`,
    );
  });

  it('all lng values are within [-180, 180]', () => {
    const bad = entries.filter(([, [, lng]]) => lng < -180 || lng > 180);
    assert.deepEqual(
      bad.map(([k]) => k),
      [],
      `Cities with out-of-range lng: ${bad.map(([k]) => k).join(', ')}`,
    );
  });

  it('no entry is on null island [0, 0]', () => {
    const bad = entries.filter(([, [lat, lng]]) => lat === 0 && lng === 0);
    assert.deepEqual(
      bad.map(([k]) => k),
      [],
      `Cities incorrectly placed at [0, 0]: ${bad.map(([k]) => k).join(', ')}`,
    );
  });

  it('all coordinate pairs are finite numbers', () => {
    const bad = entries.filter(
      ([, [lat, lng]]) =>
        !Number.isFinite(lat) || !Number.isFinite(lng),
    );
    assert.deepEqual(
      bad.map(([k]) => k),
      [],
      `Cities with non-finite coords: ${bad.map(([k]) => k).join(', ')}`,
    );
  });
});

describe('CITY_CENTROIDS — key-level spot checks for new cities', () => {
  const check = (city: string, expectedLat: number, expectedLng: number) => {
    it(`includes ${city} with plausible coordinates`, () => {
      const coords = CITY_CENTROIDS[city];
      assert.ok(coords !== undefined, `${city} is missing from CITY_CENTROIDS`);
      const [lat, lng] = coords;
      // Plausibility: within ±2° of expected centroid
      assert.ok(
        Math.abs(lat - expectedLat) < 2,
        `${city} lat ${lat} is implausibly far from expected ${expectedLat}`,
      );
      assert.ok(
        Math.abs(lng - expectedLng) < 2,
        `${city} lng ${lng} is implausibly far from expected ${expectedLng}`,
      );
    });
  };

  // African cities
  check('Accra',         5.6037,  -0.1870);
  check('Addis Ababa',   9.0320,  38.7423);
  check('Dar es Salaam',-6.7924,  39.2083);
  check('Kigali',       -1.9706,  30.1044);
  check('Kampala',       0.3476,  32.5825);
  check('Dakar',        14.7167, -17.4677);
  check('Abidjan',       5.3600,  -4.0083);
  check('Tunis',        36.8065,  10.1815);
  check('Algiers',      36.7372,   3.0865);
  check('Luanda',       -8.8383,  13.2344);

  // Asian cities
  check('Davao City',    7.1907, 125.4553);
  check('Iloilo',       10.7202, 122.5621);
  check('Phnom Penh',   11.5564, 104.9282);
  check('Chiang Mai',   18.7883,  98.9853);
  check('Shenzhen',     22.5431, 114.0579);
  check('Wuhan',        30.5928, 114.3055);
  check('Hangzhou',     30.2741, 120.1551);
  check('Kolkata',      22.5726,  88.3639);
  check('Hyderabad',    17.3850,  78.4867);
  check('Karachi',      24.8607,  67.0011);
  check('Doha',         25.2854,  51.5310);
  check('Jeddah',       21.4858,  39.1925);
});
