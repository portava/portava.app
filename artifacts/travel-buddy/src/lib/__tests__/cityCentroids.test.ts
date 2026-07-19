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
import { CITY_CENTROIDS, getCityCentroid } from '../cityCentroids.ts';

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

  // Latin American cities
  check('Quito',        -0.2295,  -78.5243);
  check('Caracas',      10.4806,  -66.9036);
  check('Montevideo',  -34.9011,  -56.1645);
  check('Asunción',    -25.2867,  -57.6470);
  check('La Paz',      -16.5000,  -68.1193);
  check('Guayaquil',    -2.1962,  -79.8862);
  check('Cali',          3.4516,  -76.5320);
  check('Barranquilla', 10.9639,  -74.7964);
  check('Recife',       -8.0476,  -34.8770);
  check('Belo Horizonte', -19.9167, -43.9345);
  check('Managua',      12.1364,  -86.2919);
  check('Guatemala City', 14.6349, -90.5069);
  check('Havana',       23.1136,  -82.3666);
  check('Santo Domingo', 18.4861, -69.9312);

  // Central Asian & South Caucasus cities
  check('Tashkent',     41.2995,   69.2401);
  check('Almaty',       43.2220,   76.8512);
  check('Astana',       51.1801,   71.4460);
  check('Baku',         40.4093,   49.8671);
  check('Tbilisi',      41.6938,   44.8015);
  check('Yerevan',      40.1872,   44.5152);
  check('Bishkek',      42.8746,   74.5698);
  check('Dushanbe',     38.5598,   68.7733);
  check('Ashgabat',     37.9601,   58.3261);

  // Scandinavian & Baltic secondary cities
  check('Aarhus',       56.1629,   10.2039);
  check('Gdańsk',       54.3520,   18.6466);
  check('Gothenburg',   57.7089,   11.9746);
  check('Kaunas',       54.8985,   23.9036);
  check('Malmö',        55.6050,   13.0038);
  check('Reykjavik',    64.1355,  -21.8954);
  check('Tampere',      61.4978,   23.7610);
  check('Tartu',        58.3780,   26.7290);
  check('Turku',        60.4518,   22.2666);

  // Eastern European & Balkan cities
  check('Kyiv',         50.4501,   30.5234);

  it('Kiev (alternate spelling) resolves to the same coordinates as Kyiv', () => {
    const kyiv = CITY_CENTROIDS['Kyiv'];
    const kiev = CITY_CENTROIDS['Kiev'];
    assert.ok(kyiv !== undefined, 'Kyiv is missing from CITY_CENTROIDS');
    assert.ok(kiev !== undefined, 'Kiev is missing from CITY_CENTROIDS');
    assert.deepEqual(kiev, kyiv, 'Kiev and Kyiv should have identical coordinates');
  });
  check('Minsk',        53.9045,   27.5615);
  check('Chisinau',     47.0105,   28.8638);
  check('Belgrade',     44.8176,   20.4569);
  check('Skopje',       41.9981,   21.4254);
  check('Tirana',       41.3275,   19.8187);
  check('Sarajevo',     43.8563,   18.4131);
  check('Riga',         56.9460,   24.1059);
  check('Tallinn',      59.4370,   24.7536);
  check('Vilnius',      54.6872,   25.2797);
  check('Bucharest',    44.4268,   26.1025);
  check('Sofia',        42.6977,   23.3219);
  check('Zagreb',       45.8150,   15.9819);
  check('Ljubljana',    46.0569,   14.5058);
  check('Bratislava',   48.1486,   17.1077);
  check('Krakow',       50.0647,   19.9450);
  check('Lviv',         49.8397,   24.0297);
});

describe('getCityCentroid — normalisation (casing & whitespace)', () => {
  it('resolves lowercase city name: "tashkent" → Tashkent centroid', () => {
    const coords = getCityCentroid('tashkent');
    assert.ok(coords !== undefined, '"tashkent" returned undefined — normalisation failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 41.2995) < 2, `lat ${lat} implausibly far from Tashkent`);
    assert.ok(Math.abs(lng - 69.2401) < 2, `lng ${lng} implausibly far from Tashkent`);
  });

  it('resolves all-caps city name: "QUITO" → Quito centroid', () => {
    const coords = getCityCentroid('QUITO');
    assert.ok(coords !== undefined, '"QUITO" returned undefined — normalisation failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - (-0.2295)) < 2, `lat ${lat} implausibly far from Quito`);
    assert.ok(Math.abs(lng - (-78.5243)) < 2, `lng ${lng} implausibly far from Quito`);
  });

  it('resolves city name with leading/trailing spaces: "  Bangkok  "', () => {
    const coords = getCityCentroid('  Bangkok  ');
    assert.ok(coords !== undefined, '"  Bangkok  " returned undefined — trim failed');
  });

  it('resolves mixed-case multi-word city: "ho chi minh city"', () => {
    const coords = getCityCentroid('ho chi minh city');
    assert.ok(coords !== undefined, '"ho chi minh city" returned undefined — normalisation failed');
  });

  it('resolves apostrophe city name: "xi\'an" → Xi\'an centroid', () => {
    const coords = getCityCentroid("xi'an");
    assert.ok(coords !== undefined, '"xi\'an" returned undefined — apostrophe normalisation failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 34.3416) < 2, `lat ${lat} implausibly far from Xi'an`);
    assert.ok(Math.abs(lng - 108.9398) < 2, `lng ${lng} implausibly far from Xi'an`);
  });

  it('resolves diacritic city in lowercase: "são paulo" → São Paulo centroid', () => {
    const coords = getCityCentroid('são paulo');
    assert.ok(coords !== undefined, '"são paulo" returned undefined — diacritic normalisation failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - (-23.5505)) < 2, `lat ${lat} implausibly far from São Paulo`);
    assert.ok(Math.abs(lng - (-46.6333)) < 2, `lng ${lng} implausibly far from São Paulo`);
  });

  it('resolves diacritic city in uppercase: "ASUNCIÓN" → Asunción centroid', () => {
    const coords = getCityCentroid('ASUNCIÓN');
    assert.ok(coords !== undefined, '"ASUNCIÓN" returned undefined — diacritic uppercase normalisation failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - (-25.2867)) < 2, `lat ${lat} implausibly far from Asunción`);
  });

  it('resolves diacritic city mixed-case: "montréal" → Montréal centroid', () => {
    const coords = getCityCentroid('montréal');
    assert.ok(coords !== undefined, '"montréal" returned undefined — diacritic mixed-case normalisation failed');
  });

  it('still returns undefined for a genuinely unknown city', () => {
    const coords = getCityCentroid('atlantis');
    assert.equal(coords, undefined, 'Expected undefined for unknown city "atlantis"');
  });

  it('exact-match keys bypass normalisation (no double-transform)', () => {
    // 'Tashkent' already matches exactly — ensure it still resolves
    const exact = getCityCentroid('Tashkent');
    assert.ok(exact !== undefined, '"Tashkent" (exact key) should always resolve');
  });
});

describe('getCityCentroid — accent-stripped inputs resolve via alias keys', () => {
  /**
   * CITY_CENTROIDS stores both accented canonical keys and accent-stripped
   * alias keys for cities whose official names use diacritics.  These tests
   * confirm that inputs without accents (as a user might type them) still
   * resolve to a centroid — either via the alias key directly (exact match)
   * or via the lowercase normalisation path.
   */

  it('"sao paulo" (no accent) resolves via the "Sao Paulo" alias', () => {
    const coords = getCityCentroid('sao paulo');
    assert.ok(coords !== undefined, '"sao paulo" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - (-23.5505)) < 2, `lat ${lat} implausibly far from São Paulo`);
    assert.ok(Math.abs(lng - (-46.6333)) < 2, `lng ${lng} implausibly far from São Paulo`);
  });

  it('"SAO PAULO" (uppercase, no accent) resolves via normalisation', () => {
    const coords = getCityCentroid('SAO PAULO');
    assert.ok(coords !== undefined, '"SAO PAULO" returned undefined — accent-stripped uppercase alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - (-23.5505)) < 2, `lat ${lat} implausibly far from São Paulo`);
    assert.ok(Math.abs(lng - (-46.6333)) < 2, `lng ${lng} implausibly far from São Paulo`);
  });

  it('"medellin" (no accent) resolves via the "Medellin" alias', () => {
    const coords = getCityCentroid('medellin');
    assert.ok(coords !== undefined, '"medellin" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 6.2442) < 2, `lat ${lat} implausibly far from Medellín`);
    assert.ok(Math.abs(lng - (-75.5812)) < 2, `lng ${lng} implausibly far from Medellín`);
  });

  it('"MEDELLIN" (uppercase, no accent) resolves via normalisation', () => {
    const coords = getCityCentroid('MEDELLIN');
    assert.ok(coords !== undefined, '"MEDELLIN" returned undefined — accent-stripped uppercase alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 6.2442) < 2, `lat ${lat} implausibly far from Medellín`);
    assert.ok(Math.abs(lng - (-75.5812)) < 2, `lng ${lng} implausibly far from Medellín`);
  });

  it('"bogota" (no accent) resolves via the "Bogota" alias', () => {
    const coords = getCityCentroid('bogota');
    assert.ok(coords !== undefined, '"bogota" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 4.7110) < 2, `lat ${lat} implausibly far from Bogotá`);
    assert.ok(Math.abs(lng - (-74.0721)) < 2, `lng ${lng} implausibly far from Bogotá`);
  });

  it('"BOGOTA" (uppercase, no accent) resolves via normalisation', () => {
    const coords = getCityCentroid('BOGOTA');
    assert.ok(coords !== undefined, '"BOGOTA" returned undefined — accent-stripped uppercase alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 4.7110) < 2, `lat ${lat} implausibly far from Bogotá`);
    assert.ok(Math.abs(lng - (-74.0721)) < 2, `lng ${lng} implausibly far from Bogotá`);
  });

  it('"asuncion" (no accent) resolves via the "Asuncion" alias', () => {
    const coords = getCityCentroid('asuncion');
    assert.ok(coords !== undefined, '"asuncion" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - (-25.2867)) < 2, `lat ${lat} implausibly far from Asunción`);
    assert.ok(Math.abs(lng - (-57.6470)) < 2, `lng ${lng} implausibly far from Asunción`);
  });

  it('"montreal" (no accent) resolves via the "Montreal" alias', () => {
    const coords = getCityCentroid('montreal');
    assert.ok(coords !== undefined, '"montreal" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 45.5017) < 2, `lat ${lat} implausibly far from Montréal`);
    assert.ok(Math.abs(lng - (-73.5673)) < 2, `lng ${lng} implausibly far from Montréal`);
  });

  it('"san jose" (no accent) resolves via the "San Jose" alias', () => {
    const coords = getCityCentroid('san jose');
    assert.ok(coords !== undefined, '"san jose" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 9.9281) < 2, `lat ${lat} implausibly far from San José`);
    assert.ok(Math.abs(lng - (-84.0907)) < 2, `lng ${lng} implausibly far from San José`);
  });

  it('"krakow" (no accent) resolves via the "Krakow" alias', () => {
    const coords = getCityCentroid('krakow');
    assert.ok(coords !== undefined, '"krakow" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 50.0647) < 2, `lat ${lat} implausibly far from Kraków`);
    assert.ok(Math.abs(lng - 19.9450) < 2, `lng ${lng} implausibly far from Kraków`);
  });

  it('"chisinau" (no accent) resolves via the "Chisinau" alias', () => {
    const coords = getCityCentroid('chisinau');
    assert.ok(coords !== undefined, '"chisinau" returned undefined — accent-stripped alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 47.0105) < 2, `lat ${lat} implausibly far from Chișinău`);
    assert.ok(Math.abs(lng - 28.8638) < 2, `lng ${lng} implausibly far from Chișinău`);
  });

  it('accent-stripped and accented forms both resolve to identical coordinates', () => {
    // São Paulo / Sao Paulo
    const accented = getCityCentroid('São Paulo');
    const stripped = getCityCentroid('Sao Paulo');
    assert.ok(accented !== undefined, '"São Paulo" should resolve');
    assert.ok(stripped !== undefined, '"Sao Paulo" should resolve');
    assert.deepEqual(accented, stripped, 'São Paulo and Sao Paulo should have identical coordinates');

    // Medellín / Medellin
    const accentedMed = getCityCentroid('Medellín');
    const strippedMed = getCityCentroid('Medellin');
    assert.ok(accentedMed !== undefined, '"Medellín" should resolve');
    assert.ok(strippedMed !== undefined, '"Medellin" should resolve');
    assert.deepEqual(accentedMed, strippedMed, 'Medellín and Medellin should have identical coordinates');

    // Bogotá / Bogota
    const accentedBog = getCityCentroid('Bogotá');
    const strippedBog = getCityCentroid('Bogota');
    assert.ok(accentedBog !== undefined, '"Bogotá" should resolve');
    assert.ok(strippedBog !== undefined, '"Bogota" should resolve');
    assert.deepEqual(accentedBog, strippedBog, 'Bogotá and Bogota should have identical coordinates');
  });
});

describe('getCityCentroid — compound / parenthesised / suffixed city strings', () => {
  it('resolves slash-separated "Kyiv/Kiev" to the Kyiv centroid', () => {
    const coords = getCityCentroid('Kyiv/Kiev');
    assert.ok(coords !== undefined, '"Kyiv/Kiev" returned undefined — slash splitting failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 50.4501) < 2, `lat ${lat} implausibly far from Kyiv`);
    assert.ok(Math.abs(lng - 30.5234) < 2, `lng ${lng} implausibly far from Kyiv`);
  });

  it('resolves parenthesised "Bangkok (Thailand)" to the Bangkok centroid', () => {
    const coords = getCityCentroid('Bangkok (Thailand)');
    assert.ok(coords !== undefined, '"Bangkok (Thailand)" returned undefined — parenthesis splitting failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 13.7563) < 2, `lat ${lat} implausibly far from Bangkok`);
    assert.ok(Math.abs(lng - 100.5018) < 2, `lng ${lng} implausibly far from Bangkok`);
  });

  it('resolves comma-suffixed "New York, NY" to the New York centroid', () => {
    const coords = getCityCentroid('New York, NY');
    assert.ok(coords !== undefined, '"New York, NY" returned undefined — comma splitting failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 40.7128) < 2, `lat ${lat} implausibly far from New York`);
    assert.ok(Math.abs(lng - (-74.0060)) < 2, `lng ${lng} implausibly far from New York`);
  });
});
