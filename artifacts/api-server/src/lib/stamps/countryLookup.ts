/**
 * Country lookup for stamps.
 *
 * Provides *real* ISO 3166-1 alpha-2 country codes — never guessed from
 * spelling. Two lookup paths:
 *
 *   1. countryCodeFromName(name)  — full country-name → ISO code map
 *   2. countryFromCity(city)      — well-known city → { country, countryCode }
 *
 * If neither path resolves, callers must treat the code as unknown ("XX")
 * rather than abbreviating the country name (the old `slice(0, 2)` behaviour
 * produced fake codes like "UN" for "United Kingdom" typos or "PH" collisions).
 */

const NAME_TO_CODE: Record<string, string> = {
  "afghanistan": "AF", "albania": "AL", "algeria": "DZ", "argentina": "AR",
  "armenia": "AM", "australia": "AU", "austria": "AT", "azerbaijan": "AZ",
  "bahamas": "BS", "bahrain": "BH", "bangladesh": "BD", "belarus": "BY",
  "belgium": "BE", "belize": "BZ", "bolivia": "BO", "bosnia and herzegovina": "BA",
  "botswana": "BW", "brazil": "BR", "brunei": "BN", "bulgaria": "BG",
  "cambodia": "KH", "cameroon": "CM", "canada": "CA", "chile": "CL",
  "china": "CN", "colombia": "CO", "costa rica": "CR", "croatia": "HR",
  "cuba": "CU", "cyprus": "CY", "czech republic": "CZ", "czechia": "CZ",
  "denmark": "DK", "dominican republic": "DO", "ecuador": "EC", "egypt": "EG",
  "el salvador": "SV", "estonia": "EE", "ethiopia": "ET", "fiji": "FJ",
  "finland": "FI", "france": "FR", "georgia": "GE", "germany": "DE",
  "ghana": "GH", "greece": "GR", "guatemala": "GT", "honduras": "HN",
  "hong kong": "HK", "hungary": "HU", "iceland": "IS", "india": "IN",
  "indonesia": "ID", "iran": "IR", "iraq": "IQ", "ireland": "IE",
  "israel": "IL", "italy": "IT", "jamaica": "JM", "japan": "JP",
  "jordan": "JO", "kazakhstan": "KZ", "kenya": "KE", "korea": "KR",
  "south korea": "KR", "north korea": "KP", "kuwait": "KW", "laos": "LA",
  "latvia": "LV", "lebanon": "LB", "lithuania": "LT", "luxembourg": "LU",
  "macau": "MO", "malaysia": "MY", "maldives": "MV", "malta": "MT",
  "mexico": "MX", "monaco": "MC", "mongolia": "MN", "montenegro": "ME",
  "morocco": "MA", "myanmar": "MM", "burma": "MM", "nepal": "NP",
  "netherlands": "NL", "the netherlands": "NL", "new zealand": "NZ",
  "nicaragua": "NI", "nigeria": "NG", "north macedonia": "MK", "norway": "NO",
  "oman": "OM", "pakistan": "PK", "panama": "PA", "paraguay": "PY",
  "peru": "PE", "philippines": "PH", "the philippines": "PH", "poland": "PL",
  "portugal": "PT", "qatar": "QA", "romania": "RO", "russia": "RU",
  "russian federation": "RU", "saudi arabia": "SA", "serbia": "RS",
  "singapore": "SG", "slovakia": "SK", "slovenia": "SI", "south africa": "ZA",
  "spain": "ES", "sri lanka": "LK", "sweden": "SE", "switzerland": "CH",
  "taiwan": "TW", "tanzania": "TZ", "thailand": "TH", "tunisia": "TN",
  "turkey": "TR", "turkiye": "TR", "uae": "AE", "united arab emirates": "AE",
  "uganda": "UG", "ukraine": "UA", "united kingdom": "GB", "uk": "GB",
  "great britain": "GB", "england": "GB", "scotland": "GB", "wales": "GB",
  "northern ireland": "GB", "united states": "US", "usa": "US",
  "united states of america": "US", "us": "US", "america": "US",
  "uruguay": "UY", "uzbekistan": "UZ", "venezuela": "VE", "vietnam": "VN",
  "viet nam": "VN", "zambia": "ZM", "zimbabwe": "ZW",
};

const CODE_TO_NAME: Record<string, string> = {};
for (const [name, code] of Object.entries(NAME_TO_CODE)) {
  // First (canonical) name wins for each code
  if (!CODE_TO_NAME[code]) {
    CODE_TO_NAME[code] = name.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
}
// Prefer prettier canonical names over first-alphabetical aliases
Object.assign(CODE_TO_NAME, {
  GB: "United Kingdom", US: "United States", KR: "South Korea",
  AE: "United Arab Emirates", NL: "Netherlands", PH: "Philippines",
  RU: "Russia", TR: "Turkey", MM: "Myanmar", CZ: "Czech Republic",
});

/** Well-known city → country. Keys are normalized (lowercase, trimmed). */
const CITY_TO_CODE: Record<string, string> = {
  // Europe
  "london": "GB", "manchester": "GB", "edinburgh": "GB", "glasgow": "GB",
  "liverpool": "GB", "birmingham": "GB", "bristol": "GB", "dublin": "IE",
  "paris": "FR", "lyon": "FR", "marseille": "FR", "nice": "FR",
  "bordeaux": "FR", "berlin": "DE", "munich": "DE", "hamburg": "DE",
  "frankfurt": "DE", "cologne": "DE", "madrid": "ES", "barcelona": "ES",
  "seville": "ES", "valencia": "ES", "malaga": "ES", "lisbon": "PT",
  "porto": "PT", "rome": "IT", "milan": "IT", "venice": "IT",
  "florence": "IT", "naples": "IT", "amsterdam": "NL", "rotterdam": "NL",
  "brussels": "BE", "antwerp": "BE", "vienna": "AT", "zurich": "CH",
  "geneva": "CH", "prague": "CZ", "budapest": "HU", "warsaw": "PL",
  "krakow": "PL", "athens": "GR", "santorini": "GR", "stockholm": "SE",
  "gothenburg": "SE", "oslo": "NO", "copenhagen": "DK", "helsinki": "FI",
  "reykjavik": "IS", "moscow": "RU", "saint petersburg": "RU",
  "istanbul": "TR", "dubrovnik": "HR", "zagreb": "HR", "split": "HR",
  "bucharest": "RO", "sofia": "BG", "belgrade": "RS", "tallinn": "EE",
  "riga": "LV", "vilnius": "LT", "kyiv": "UA", "kiev": "UA",
  // Americas
  "new york": "US", "new york city": "US", "los angeles": "US",
  "san francisco": "US", "chicago": "US", "miami": "US", "seattle": "US",
  "boston": "US", "austin": "US", "las vegas": "US", "honolulu": "US",
  "washington": "US", "denver": "US", "portland": "US", "new orleans": "US",
  "san diego": "US", "fort lauderdale": "US", "ft lauderdale": "US",
  "toronto": "CA", "vancouver": "CA", "montreal": "CA",
  "calgary": "CA", "ottawa": "CA", "mexico city": "MX", "cancun": "MX",
  "guadalajara": "MX", "tulum": "MX", "rio de janeiro": "BR",
  "sao paulo": "BR", "buenos aires": "AR", "santiago": "CL", "lima": "PE",
  "cusco": "PE", "bogota": "CO", "medellin": "CO", "cartagena": "CO",
  "quito": "EC", "havana": "CU", "san jose": "CR", "panama city": "PA",
  "montevideo": "UY",
  // Asia-Pacific
  "tokyo": "JP", "osaka": "JP", "kyoto": "JP", "sapporo": "JP",
  "fukuoka": "JP", "seoul": "KR", "busan": "KR", "beijing": "CN",
  "shanghai": "CN", "shenzhen": "CN", "guangzhou": "CN", "chengdu": "CN",
  "hong kong": "HK", "macau": "MO", "taipei": "TW", "bangkok": "TH",
  "chiang mai": "TH", "phuket": "TH", "pattaya": "TH", "singapore": "SG",
  "kuala lumpur": "MY", "penang": "MY", "jakarta": "ID", "bali": "ID",
  "denpasar": "ID", "ubud": "ID", "manila": "PH", "cebu": "PH",
  "cebu city": "PH", "davao": "PH", "boracay": "PH", "palawan": "PH",
  "bohol": "PH", "tagbilaran": "PH", "siargao": "PH", "iloilo": "PH",
  "bacolod": "PH", "cagayan de oro": "PH", "zamboanga": "PH",
  "hanoi": "VN", "ho chi minh city": "VN", "saigon": "VN", "da nang": "VN",
  "hoi an": "VN", "phnom penh": "KH", "siem reap": "KH", "vientiane": "LA",
  "luang prabang": "LA", "yangon": "MM", "kathmandu": "NP", "colombo": "LK",
  "mumbai": "IN", "delhi": "IN", "new delhi": "IN", "bangalore": "IN",
  "bengaluru": "IN", "goa": "IN", "jaipur": "IN", "chennai": "IN",
  "kolkata": "IN", "sydney": "AU", "melbourne": "AU", "brisbane": "AU",
  "perth": "AU", "adelaide": "AU", "cairns": "AU", "gold coast": "AU",
  "auckland": "NZ", "wellington": "NZ", "queenstown": "NZ",
  "christchurch": "NZ", "male": "MV",
  // Middle East & Africa
  "dubai": "AE", "abu dhabi": "AE", "doha": "QA", "riyadh": "SA",
  "jeddah": "SA", "tel aviv": "IL", "jerusalem": "IL", "amman": "JO",
  "beirut": "LB", "muscat": "OM", "kuwait city": "KW", "manama": "BH",
  "cairo": "EG", "alexandria": "EG", "marrakech": "MA", "marrakesh": "MA",
  "casablanca": "MA", "fez": "MA", "tunis": "TN", "cape town": "ZA",
  "johannesburg": "ZA", "durban": "ZA", "nairobi": "KE", "lagos": "NG",
  "accra": "GH", "addis ababa": "ET", "dar es salaam": "TZ",
  "zanzibar": "TZ", "kampala": "UG",
};

const VALID_CODE_RE = /^[A-Za-z]{2}$/;

function norm(raw: string): string {
  return raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** ISO code for a country name, or null when unknown. Never guesses. */
export function countryCodeFromName(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  // Already a 2-letter code that maps to a known country
  if (VALID_CODE_RE.test(trimmed) && CODE_TO_NAME[trimmed.toUpperCase()]) {
    return trimmed.toUpperCase();
  }
  return NAME_TO_CODE[norm(trimmed)] ?? null;
}

/** Canonical country name for an ISO code, or null when unknown. */
export function countryNameFromCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return CODE_TO_NAME[code.trim().toUpperCase()] ?? null;
}

/** Country info derived from a well-known city name, or null when unknown. */
export function countryFromCity(
  city: string | null | undefined,
): { country: string; countryCode: string } | null {
  if (!city) return null;
  const code = CITY_TO_CODE[norm(city)];
  if (!code) return null;
  return { country: CODE_TO_NAME[code] ?? code, countryCode: code };
}

export interface ResolvedCountry {
  country: string | null;
  countryCode: string; // real ISO code, or "XX" when not derivable
}

/**
 * Best-effort resolution of real country info from whatever fields exist.
 * Priority: explicit valid code → country name map → city lookup → XX.
 * Never fabricates a code from the spelling of the country name.
 */
export function resolveCountry(input: {
  country?: string | null;
  countryCode?: string | null;
  city?: string | null;
}): ResolvedCountry {
  if (input.countryCode && VALID_CODE_RE.test(input.countryCode.trim())) {
    const code = input.countryCode.trim().toUpperCase();
    return { country: input.country ?? countryNameFromCode(code), countryCode: code };
  }
  const fromName = countryCodeFromName(input.country);
  if (fromName) return { country: input.country ?? countryNameFromCode(fromName), countryCode: fromName };
  const fromCity = countryFromCity(input.city);
  if (fromCity) return { country: input.country ?? fromCity.country, countryCode: fromCity.countryCode };
  return { country: input.country ?? null, countryCode: "XX" };
}
