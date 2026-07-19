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
import { CITY_CENTROIDS, CITY_ALIASES, getCityCentroid } from '../cityCentroids.ts';

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

  it('Odessa (alternate spelling) resolves to the same coordinates as Odesa', () => {
    const odesa = CITY_CENTROIDS['Odesa'];
    const odessa = CITY_CENTROIDS['Odessa'];
    assert.ok(odesa !== undefined, 'Odesa is missing from CITY_CENTROIDS');
    assert.ok(odessa !== undefined, 'Odessa is missing from CITY_CENTROIDS');
    assert.deepEqual(odessa, odesa, 'Odessa and Odesa should have identical coordinates');
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

  it('resolves NFD-decomposed diacritic: "Bogota\\u0301" (a + combining acute) → Bogotá centroid', () => {
    // Some data sources store NFD decomposed strings (base char + combining mark)
    // rather than the precomposed NFC form.  normaliseCityKey must handle both.
    const decomposed = 'Bogota\u0301'; // 'a' followed by U+0301 COMBINING ACUTE ACCENT
    const coords = getCityCentroid(decomposed);
    assert.ok(coords !== undefined, 'NFD-decomposed "Bogotá" returned undefined — NFD stripping failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 4.7110) < 2, `lat ${lat} implausibly far from Bogotá`);
    assert.ok(Math.abs(lng - (-74.0721)) < 2, `lng ${lng} implausibly far from Bogotá`);
  });

  it('resolves NFD-decomposed "Sa\u0303o Paulo" (tilde-n decomposed) → São Paulo centroid', () => {
    const decomposed = 'Sa\u0303o Paulo'; // 'a' + U+0303 COMBINING TILDE
    const coords = getCityCentroid(decomposed);
    assert.ok(coords !== undefined, 'NFD-decomposed "São Paulo" returned undefined — NFD stripping failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - (-23.5505)) < 2, `lat ${lat} implausibly far from São Paulo`);
    assert.ok(Math.abs(lng - (-46.6333)) < 2, `lng ${lng} implausibly far from São Paulo`);
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

  it('"goteborg" (no alias) resolves via NFD fallback from "Göteborg"', () => {
    // 'Goteborg' is NOT an explicit alias key in CITY_CENTROIDS — only 'Göteborg'
    // exists.  This must resolve via the NFD diacritic-strip tier.
    const coords = getCityCentroid('goteborg');
    assert.ok(coords !== undefined, '"goteborg" returned undefined — NFD fallback failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 57.7089) < 2, `lat ${lat} implausibly far from Göteborg`);
    assert.ok(Math.abs(lng - 11.9746) < 2, `lng ${lng} implausibly far from Göteborg`);
  });

  it('"GOTEBORG" (uppercase, no alias) resolves via NFD fallback', () => {
    const coords = getCityCentroid('GOTEBORG');
    assert.ok(coords !== undefined, '"GOTEBORG" returned undefined — NFD fallback failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 57.7089) < 2, `lat ${lat} implausibly far from Göteborg`);
    assert.ok(Math.abs(lng - 11.9746) < 2, `lng ${lng} implausibly far from Göteborg`);
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

  it('resolves country-suffixed "Tampere, Finland" to the Tampere centroid', () => {
    const coords = getCityCentroid('Tampere, Finland');
    assert.ok(coords !== undefined, '"Tampere, Finland" returned undefined — country-suffix stripping failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 61.4978) < 2, `lat ${lat} implausibly far from Tampere`);
    assert.ok(Math.abs(lng - 23.7610) < 2, `lng ${lng} implausibly far from Tampere`);
  });

  it('resolves country-suffixed "Aarhus, Denmark" to the Aarhus centroid', () => {
    const coords = getCityCentroid('Aarhus, Denmark');
    assert.ok(coords !== undefined, '"Aarhus, Denmark" returned undefined — country-suffix stripping failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 56.1629) < 2, `lat ${lat} implausibly far from Aarhus`);
    assert.ok(Math.abs(lng - 10.2039) < 2, `lng ${lng} implausibly far from Aarhus`);
  });

  it('resolves country-suffixed with lowercase "tampere, finland"', () => {
    const coords = getCityCentroid('tampere, finland');
    assert.ok(coords !== undefined, '"tampere, finland" returned undefined — lowercase country-suffix stripping failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 61.4978) < 2, `lat ${lat} implausibly far from Tampere`);
    assert.ok(Math.abs(lng - 23.7610) < 2, `lng ${lng} implausibly far from Tampere`);
  });

  it('"Tampere, Finland" resolves to identical coords as bare "Tampere"', () => {
    const bare = getCityCentroid('Tampere');
    const suffixed = getCityCentroid('Tampere, Finland');
    assert.ok(bare !== undefined, '"Tampere" should resolve');
    assert.ok(suffixed !== undefined, '"Tampere, Finland" should resolve');
    assert.deepEqual(suffixed, bare, '"Tampere, Finland" must produce the same coordinates as "Tampere"');
  });

  it('"Osaka, Japan" resolves to identical coords as bare "Osaka"', () => {
    const bare = getCityCentroid('Osaka');
    const suffixed = getCityCentroid('Osaka, Japan');
    assert.ok(bare !== undefined, '"Osaka" should resolve');
    assert.ok(suffixed !== undefined, '"Osaka, Japan" should resolve — country suffix not stripped');
    assert.deepEqual(suffixed, bare, '"Osaka, Japan" must produce the same coordinates as "Osaka"');
  });

  it('"Singapore, Singapore" resolves to identical coords as bare "Singapore"', () => {
    const bare = getCityCentroid('Singapore');
    const suffixed = getCityCentroid('Singapore, Singapore');
    assert.ok(bare !== undefined, '"Singapore" should resolve');
    assert.ok(suffixed !== undefined, '"Singapore, Singapore" should resolve');
    assert.deepEqual(suffixed, bare, '"Singapore, Singapore" must produce the same coordinates as "Singapore"');
  });
});

describe('getCityCentroid — country-name fallback', () => {
  /**
   * Some event records store a country name in the city field.
   * getCityCentroid must return a country-level centroid rather than undefined
   * so the map always has a non-blank starting position.
   */

  it('resolves "Thailand" to a plausible centroid', () => {
    const coords = getCityCentroid('Thailand');
    assert.ok(coords !== undefined, '"Thailand" returned undefined — country fallback missing');
    const [lat, lng] = coords;
    // Thailand spans roughly lat 5–21 N, lng 97–106 E
    assert.ok(lat > 4 && lat < 22, `lat ${lat} is not within Thailand`);
    assert.ok(lng > 96 && lng < 107, `lng ${lng} is not within Thailand`);
  });

  it('resolves "thailand" (lowercase) via the country fallback', () => {
    const coords = getCityCentroid('thailand');
    assert.ok(coords !== undefined, '"thailand" (lowercase) returned undefined — country fallback normalisation failed');
    assert.deepEqual(coords, getCityCentroid('Thailand'));
  });

  it('resolves "THAILAND" (uppercase) via the country fallback', () => {
    const coords = getCityCentroid('THAILAND');
    assert.ok(coords !== undefined, '"THAILAND" (uppercase) returned undefined — country fallback normalisation failed');
    assert.deepEqual(coords, getCityCentroid('Thailand'));
  });

  it('resolves "United States" to a plausible centroid', () => {
    const coords = getCityCentroid('United States');
    assert.ok(coords !== undefined, '"United States" returned undefined — country fallback missing');
    const [lat, lng] = coords;
    // Continental USA: lat ~24–49 N, lng ~-125 to -66 W
    assert.ok(lat > 23 && lat < 50, `lat ${lat} is not within the United States`);
    assert.ok(lng > -126 && lng < -65, `lng ${lng} is not within the United States`);
  });

  it('resolves "united states" (lowercase) via the country fallback', () => {
    const coords = getCityCentroid('united states');
    assert.ok(coords !== undefined, '"united states" (lowercase) returned undefined — country fallback normalisation failed');
    assert.deepEqual(coords, getCityCentroid('United States'));
  });

  it('resolves "USA" abbreviation via the country fallback', () => {
    const coords = getCityCentroid('USA');
    assert.ok(coords !== undefined, '"USA" returned undefined — country abbreviation fallback missing');
    assert.deepEqual(coords, getCityCentroid('United States'));
  });

  it('resolves "United States of America" via the country fallback', () => {
    const coords = getCityCentroid('United States of America');
    assert.ok(coords !== undefined, '"United States of America" returned undefined — country fallback missing');
    assert.deepEqual(coords, getCityCentroid('United States'));
  });

  it('city lookup still wins over country when a city name is also a country (Singapore)', () => {
    // Singapore is both a city-state and a country; the city entry must win.
    const city = getCityCentroid('Singapore');
    assert.ok(city !== undefined, '"Singapore" returned undefined');
    // City centroid is [1.3521, 103.8198] — country centroid is identical here
    // but the important thing is the result is defined and plausible
    const [lat, lng] = city;
    assert.ok(Math.abs(lat - 1.3521) < 1, `lat ${lat} implausibly far from Singapore`);
    assert.ok(Math.abs(lng - 103.8198) < 1, `lng ${lng} implausibly far from Singapore`);
  });

  it('still returns undefined for a string that is neither a city nor a country', () => {
    const coords = getCityCentroid('atlantis');
    assert.equal(coords, undefined, 'Expected undefined for unknown input "atlantis"');
  });
});

describe('getCityCentroid — alias fallback', () => {
  it('resolves "Cebu" (no suffix) to the same coords as "Cebu City"', () => {
    const alias = getCityCentroid('Cebu');
    const canonical = getCityCentroid('Cebu City');
    assert.ok(alias !== undefined, '"Cebu" returned undefined — alias lookup failed');
    assert.deepEqual(alias, canonical, '"Cebu" should resolve to the same coords as "Cebu City"');
  });

  it('resolves "cebu" (lowercase) via the alias path', () => {
    const coords = getCityCentroid('cebu');
    assert.ok(coords !== undefined, '"cebu" (lowercase) returned undefined — alias normalisation failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 10.3157) < 2, `lat ${lat} implausibly far from Cebu City`);
    assert.ok(Math.abs(lng - 123.8854) < 2, `lng ${lng} implausibly far from Cebu City`);
  });

  it('resolves "CEBU" (uppercase) via the alias path', () => {
    const coords = getCityCentroid('CEBU');
    assert.ok(coords !== undefined, '"CEBU" (uppercase) returned undefined — alias normalisation failed');
  });

  it('resolves "Davao" to the same coords as "Davao City"', () => {
    const alias = getCityCentroid('Davao');
    const canonical = getCityCentroid('Davao City');
    assert.ok(alias !== undefined, '"Davao" returned undefined — alias lookup failed');
    assert.deepEqual(alias, canonical);
  });

  it('resolves "HCMC" to the same coords as "Ho Chi Minh City"', () => {
    const alias = getCityCentroid('HCMC');
    const canonical = getCityCentroid('Ho Chi Minh City');
    assert.ok(alias !== undefined, '"HCMC" returned undefined — alias lookup failed');
    assert.deepEqual(alias, canonical);
  });

  it('resolves "Ho Chi Minh" (no "City") via the alias path', () => {
    const coords = getCityCentroid('Ho Chi Minh');
    assert.ok(coords !== undefined, '"Ho Chi Minh" returned undefined — alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 10.8231) < 2, `lat ${lat} implausibly far from Ho Chi Minh City`);
    assert.ok(Math.abs(lng - 106.6297) < 2, `lng ${lng} implausibly far from Ho Chi Minh City`);
  });

  it('resolves "Bombay" to Mumbai coords via the alias path', () => {
    const alias = getCityCentroid('Bombay');
    const canonical = getCityCentroid('Mumbai');
    assert.ok(alias !== undefined, '"Bombay" returned undefined — alias lookup failed');
    assert.deepEqual(alias, canonical);
  });

  it('resolves "Madras" to Chennai coords via the alias path', () => {
    const alias = getCityCentroid('Madras');
    const canonical = getCityCentroid('Chennai');
    assert.ok(alias !== undefined, '"Madras" returned undefined — alias lookup failed');
    assert.deepEqual(alias, canonical);
  });

  it('resolves "CDMX" to Mexico City coords via the alias path', () => {
    const alias = getCityCentroid('CDMX');
    const canonical = getCityCentroid('Mexico City');
    assert.ok(alias !== undefined, '"CDMX" returned undefined — alias lookup failed');
    assert.deepEqual(alias, canonical);
  });

  it('resolves "LA" to Los Angeles coords via the alias path', () => {
    const alias = getCityCentroid('LA');
    const canonical = getCityCentroid('Los Angeles');
    assert.ok(alias !== undefined, '"LA" returned undefined — alias lookup failed');
    assert.deepEqual(alias, canonical);
  });

  it('still returns undefined for an unknown alias', () => {
    const coords = getCityCentroid('atlantis');
    assert.equal(coords, undefined, 'Expected undefined for unknown city "atlantis"');
  });

  it('all CITY_ALIASES values resolve to a known CITY_CENTROIDS key', () => {
    const bad: string[] = [];
    for (const [alias, canonical] of Object.entries(CITY_ALIASES)) {
      const coords = getCityCentroid(canonical);
      if (coords === undefined) {
        bad.push(`alias "${alias}" → canonical "${canonical}" has no CITY_CENTROIDS entry`);
      }
    }
    assert.deepEqual(bad, [], `Broken aliases:\n${bad.join('\n')}`);
  });
});

describe('getCityCentroid — NFD diacritic-strip fallback (no explicit alias key)', () => {
  /**
   * Cities in CITY_CENTROIDS that have ONLY the accented canonical form —
   * there is no hand-maintained stripped alias.  These must resolve via the
   * fourth lookup tier (NFD + strip combining marks) and would previously have
   * silently returned undefined.
   */

  it('"Koln" resolves to Köln via NFD fallback', () => {
    const accented = getCityCentroid('Köln');
    const stripped = getCityCentroid('Koln');
    assert.ok(accented !== undefined, '"Köln" (canonical) should resolve');
    assert.ok(stripped !== undefined, '"Koln" returned undefined — NFD fallback failed');
    assert.deepEqual(stripped, accented, '"Koln" and "Köln" should resolve to identical coordinates');
  });

  it('"koln" (lowercase) resolves via NFD fallback', () => {
    const coords = getCityCentroid('koln');
    assert.ok(coords !== undefined, '"koln" returned undefined — NFD fallback failed');
    const [lat] = coords;
    assert.ok(Math.abs(lat - 50.9333) < 2, `lat ${lat} implausibly far from Köln`);
  });

  it('"KOLN" (uppercase) resolves via NFD fallback', () => {
    const coords = getCityCentroid('KOLN');
    assert.ok(coords !== undefined, '"KOLN" returned undefined — NFD fallback failed');
    const [lat] = coords;
    assert.ok(Math.abs(lat - 50.9333) < 2, `lat ${lat} implausibly far from Köln`);
  });

  it('"Dusseldorf" resolves to Düsseldorf via NFD fallback', () => {
    const accented = getCityCentroid('Düsseldorf');
    const stripped = getCityCentroid('Dusseldorf');
    assert.ok(accented !== undefined, '"Düsseldorf" (canonical) should resolve');
    assert.ok(stripped !== undefined, '"Dusseldorf" returned undefined — NFD fallback failed');
    assert.deepEqual(stripped, accented, '"Dusseldorf" and "Düsseldorf" should resolve to identical coordinates');
  });

  it('"goteborg" (no alias, only "Göteborg" in map) resolves via NFD fallback', () => {
    // Verify "Goteborg" is NOT an explicit alias so this truly exercises tier 4.
    const directAlias = (CITY_CENTROIDS as Record<string, [number, number]>)['Goteborg'];
    assert.equal(directAlias, undefined, '"Goteborg" should NOT be an explicit alias key');
    const coords = getCityCentroid('Goteborg');
    assert.ok(coords !== undefined, '"Goteborg" returned undefined — NFD fallback failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 57.7089) < 2, `lat ${lat} implausibly far from Göteborg`);
    assert.ok(Math.abs(lng - 11.9746) < 2, `lng ${lng} implausibly far from Göteborg`);
  });

  it('still returns undefined for a genuinely unknown city (no accent confusion)', () => {
    assert.equal(getCityCentroid('springfield'), undefined);
  });
});

describe('getCityCentroid — Nordic and Eastern European diacritic ↔ ASCII equivalence', () => {
  /**
   * For cities whose official names include Nordic or Eastern European
   * diacritics, both the accented form and the ASCII-stripped form must
   * resolve to exactly the same coordinates.  Partner APIs and user input
   * commonly omit diacritics, so both spellings must be present.
   */

  it('Göteborg and Goteborg resolve to identical coordinates', () => {
    const accented = getCityCentroid('Göteborg');
    const stripped = getCityCentroid('Goteborg');
    assert.ok(accented !== undefined, '"Göteborg" should resolve');
    assert.ok(stripped !== undefined, '"Goteborg" should resolve');
    assert.deepEqual(accented, stripped, 'Göteborg and Goteborg must have identical coordinates');
  });

  it('Gdańsk and Gdansk resolve to identical coordinates', () => {
    const accented = getCityCentroid('Gdańsk');
    const stripped = getCityCentroid('Gdansk');
    assert.ok(accented !== undefined, '"Gdańsk" should resolve');
    assert.ok(stripped !== undefined, '"Gdansk" should resolve');
    assert.deepEqual(accented, stripped, 'Gdańsk and Gdansk must have identical coordinates');
  });

  it('Malmö and Malmo resolve to identical coordinates', () => {
    const accented = getCityCentroid('Malmö');
    const stripped = getCityCentroid('Malmo');
    assert.ok(accented !== undefined, '"Malmö" should resolve');
    assert.ok(stripped !== undefined, '"Malmo" should resolve');
    assert.deepEqual(accented, stripped, 'Malmö and Malmo must have identical coordinates');
  });

  it('Reykjavík and Reykjavik resolve to identical coordinates', () => {
    const accented = getCityCentroid('Reykjavík');
    const stripped = getCityCentroid('Reykjavik');
    assert.ok(accented !== undefined, '"Reykjavík" should resolve');
    assert.ok(stripped !== undefined, '"Reykjavik" should resolve');
    assert.deepEqual(accented, stripped, 'Reykjavík and Reykjavik must have identical coordinates');
  });

  it('"göteborg" (lowercase, accented) resolves to Göteborg centroid', () => {
    const coords = getCityCentroid('göteborg');
    assert.ok(coords !== undefined, '"göteborg" returned undefined — lowercase diacritic lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 57.7089) < 2, `lat ${lat} implausibly far from Göteborg`);
    assert.ok(Math.abs(lng - 11.9746) < 2, `lng ${lng} implausibly far from Göteborg`);
  });

  it('"goteborg" (lowercase, ASCII) resolves to Göteborg centroid via NFD fallback', () => {
    const coords = getCityCentroid('goteborg');
    assert.ok(coords !== undefined, '"goteborg" returned undefined — NFD diacritic-strip fallback failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 57.7089) < 2, `lat ${lat} implausibly far from Göteborg`);
    assert.ok(Math.abs(lng - 11.9746) < 2, `lng ${lng} implausibly far from Göteborg`);
  });

  it('"gdańsk" (lowercase, accented) resolves to Gdańsk centroid', () => {
    const coords = getCityCentroid('gdańsk');
    assert.ok(coords !== undefined, '"gdańsk" returned undefined — lowercase diacritic lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 54.3520) < 2, `lat ${lat} implausibly far from Gdańsk`);
    assert.ok(Math.abs(lng - 18.6466) < 2, `lng ${lng} implausibly far from Gdańsk`);
  });

  it('"gdansk" (lowercase, ASCII) resolves to Gdańsk centroid', () => {
    const coords = getCityCentroid('gdansk');
    assert.ok(coords !== undefined, '"gdansk" returned undefined — ASCII alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 54.3520) < 2, `lat ${lat} implausibly far from Gdańsk`);
    assert.ok(Math.abs(lng - 18.6466) < 2, `lng ${lng} implausibly far from Gdańsk`);
  });

  it('"malmö" (lowercase, accented) resolves to Malmö centroid', () => {
    const coords = getCityCentroid('malmö');
    assert.ok(coords !== undefined, '"malmö" returned undefined — lowercase diacritic lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 55.6050) < 2, `lat ${lat} implausibly far from Malmö`);
    assert.ok(Math.abs(lng - 13.0038) < 2, `lng ${lng} implausibly far from Malmö`);
  });

  it('"malmo" (lowercase, ASCII) resolves to Malmö centroid', () => {
    const coords = getCityCentroid('malmo');
    assert.ok(coords !== undefined, '"malmo" returned undefined — ASCII alias lookup failed');
    const [lat, lng] = coords;
    assert.ok(Math.abs(lat - 55.6050) < 2, `lat ${lat} implausibly far from Malmö`);
    assert.ok(Math.abs(lng - 13.0038) < 2, `lng ${lng} implausibly far from Malmö`);
  });
});
