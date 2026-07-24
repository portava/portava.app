/**
 * toFsqCityKey — derives the canonical FSQ ingestion city key from a city
 * name + country name.
 *
 * Convention: {city-slug}-{country-iso2}, e.g. "cebu-ph", "manila-ph",
 * "bangkok-th". Operators should use this same format when running
 * scripts/load-fsq-city.mjs --city <key>.
 *
 * Returns null when the country is unrecognized — the component is fail-soft
 * and renders nothing if the key is null or the city hasn't been ingested.
 */

/** Common travel-destination country name → ISO 3166-1 alpha-2 */
const COUNTRY_ISO2: Record<string, string> = {
  'Philippines':            'ph',
  'Indonesia':              'id',
  'Thailand':               'th',
  'Vietnam':                'vn',
  'Malaysia':               'my',
  'Singapore':              'sg',
  'Japan':                  'jp',
  'South Korea':            'kr',
  'China':                  'cn',
  'Hong Kong':              'hk',
  'Taiwan':                 'tw',
  'India':                  'in',
  'Sri Lanka':              'lk',
  'Nepal':                  'np',
  'Maldives':               'mv',
  'Cambodia':               'kh',
  'Laos':                   'la',
  'Myanmar':                'mm',
  'Bangladesh':             'bd',
  'Australia':              'au',
  'New Zealand':            'nz',
  'Fiji':                   'fj',
  'United States':          'us',
  'USA':                    'us',
  'Canada':                 'ca',
  'Mexico':                 'mx',
  'Brazil':                 'br',
  'Argentina':              'ar',
  'Colombia':               'co',
  'Peru':                   'pe',
  'Chile':                  'cl',
  'Ecuador':                'ec',
  'Bolivia':                'bo',
  'Uruguay':                'uy',
  'United Kingdom':         'gb',
  'UK':                     'gb',
  'Germany':                'de',
  'France':                 'fr',
  'Italy':                  'it',
  'Spain':                  'es',
  'Portugal':               'pt',
  'Netherlands':            'nl',
  'Belgium':                'be',
  'Switzerland':            'ch',
  'Austria':                'at',
  'Greece':                 'gr',
  'Turkey':                 'tr',
  'Sweden':                 'se',
  'Norway':                 'no',
  'Denmark':                'dk',
  'Finland':                'fi',
  'Poland':                 'pl',
  'Czech Republic':         'cz',
  'Hungary':                'hu',
  'Croatia':                'hr',
  'Romania':                'ro',
  'Ukraine':                'ua',
  'Russia':                 'ru',
  'Egypt':                  'eg',
  'Morocco':                'ma',
  'Tunisia':                'tn',
  'South Africa':           'za',
  'Kenya':                  'ke',
  'Tanzania':               'tz',
  'Ghana':                  'gh',
  'Nigeria':                'ng',
  'Ethiopia':               'et',
  'Qatar':                  'qa',
  'United Arab Emirates':   'ae',
  'UAE':                    'ae',
  'Saudi Arabia':           'sa',
  'Jordan':                 'jo',
  'Israel':                 'il',
  'Lebanon':                'lb',
  'Pakistan':               'pk',
};

/**
 * Derives the FSQ ingestion city key from city + country names.
 * Returns null when the country is unrecognized or inputs are blank.
 *
 * Example:
 *   toFsqCityKey("Cebu City", "Philippines") → "cebu-city-ph"
 *   toFsqCityKey("Cebu", "Philippines")       → "cebu-ph"
 *   toFsqCityKey("Bangkok", "Thailand")        → "bangkok-th"
 */
export function toFsqCityKey(
  city: string | null | undefined,
  country: string | null | undefined,
): string | null {
  if (!city || !country) return null;
  const iso2 = COUNTRY_ISO2[country.trim()];
  if (!iso2) return null;
  const citySlug = city
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip combining diacritics
    .replace(/[^a-z0-9]+/g, '-')      // non-alphanumeric → hyphen
    .replace(/^-+|-+$/g, '');         // trim leading/trailing hyphens
  if (!citySlug) return null;
  return `${citySlug}-${iso2}`;
}
