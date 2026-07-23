/**
 * countryCodes.ts — ISO-3166-1 alpha-2 country resolution.
 *
 * Portava stores trip destination_country as a free-text NAME while the
 * entry-requirements corridor table is keyed on ISO2 codes. This module maps
 * either an ISO2 code or an English country name (case/diacritic-insensitive,
 * common variants included) to a canonical uppercase ISO2 code.
 *
 * Pure data + pure functions. No I/O.
 */

/** ISO2 → canonical English name. */
const CODES: Record<string, string> = {
  AF: "Afghanistan", AL: "Albania", DZ: "Algeria", AD: "Andorra", AO: "Angola",
  AG: "Antigua and Barbuda", AR: "Argentina", AM: "Armenia", AU: "Australia",
  AT: "Austria", AZ: "Azerbaijan", BS: "Bahamas", BH: "Bahrain",
  BD: "Bangladesh", BB: "Barbados", BY: "Belarus", BE: "Belgium",
  BZ: "Belize", BJ: "Benin", BT: "Bhutan", BO: "Bolivia",
  BA: "Bosnia and Herzegovina", BW: "Botswana", BR: "Brazil", BN: "Brunei",
  BG: "Bulgaria", BF: "Burkina Faso", BI: "Burundi", CV: "Cabo Verde",
  KH: "Cambodia", CM: "Cameroon", CA: "Canada", CF: "Central African Republic",
  TD: "Chad", CL: "Chile", CN: "China", CO: "Colombia", KM: "Comoros",
  CG: "Congo", CD: "Democratic Republic of the Congo", CR: "Costa Rica",
  CI: "Cote d'Ivoire", HR: "Croatia", CU: "Cuba", CY: "Cyprus",
  CZ: "Czechia", DK: "Denmark", DJ: "Djibouti", DM: "Dominica",
  DO: "Dominican Republic", EC: "Ecuador", EG: "Egypt", SV: "El Salvador",
  GQ: "Equatorial Guinea", ER: "Eritrea", EE: "Estonia", SZ: "Eswatini",
  ET: "Ethiopia", FJ: "Fiji", FI: "Finland", FR: "France", GA: "Gabon",
  GM: "Gambia", GE: "Georgia", DE: "Germany", GH: "Ghana", GR: "Greece",
  GD: "Grenada", GT: "Guatemala", GN: "Guinea", GW: "Guinea-Bissau",
  GY: "Guyana", HT: "Haiti", HN: "Honduras", HU: "Hungary", IS: "Iceland",
  IN: "India", ID: "Indonesia", IR: "Iran", IQ: "Iraq", IE: "Ireland",
  IL: "Israel", IT: "Italy", JM: "Jamaica", JP: "Japan", JO: "Jordan",
  KZ: "Kazakhstan", KE: "Kenya", KI: "Kiribati", KP: "North Korea",
  KR: "South Korea", KW: "Kuwait", KG: "Kyrgyzstan", LA: "Laos",
  LV: "Latvia", LB: "Lebanon", LS: "Lesotho", LR: "Liberia", LY: "Libya",
  LI: "Liechtenstein", LT: "Lithuania", LU: "Luxembourg", MG: "Madagascar",
  MW: "Malawi", MY: "Malaysia", MV: "Maldives", ML: "Mali", MT: "Malta",
  MH: "Marshall Islands", MR: "Mauritania", MU: "Mauritius", MX: "Mexico",
  FM: "Micronesia", MD: "Moldova", MC: "Monaco", MN: "Mongolia",
  ME: "Montenegro", MA: "Morocco", MZ: "Mozambique", MM: "Myanmar",
  NA: "Namibia", NR: "Nauru", NP: "Nepal", NL: "Netherlands",
  NZ: "New Zealand", NI: "Nicaragua", NE: "Niger", NG: "Nigeria",
  MK: "North Macedonia", NO: "Norway", OM: "Oman", PK: "Pakistan",
  PW: "Palau", PS: "Palestine", PA: "Panama", PG: "Papua New Guinea",
  PY: "Paraguay", PE: "Peru", PH: "Philippines", PL: "Poland",
  PT: "Portugal", QA: "Qatar", RO: "Romania", RU: "Russia", RW: "Rwanda",
  KN: "Saint Kitts and Nevis", LC: "Saint Lucia",
  VC: "Saint Vincent and the Grenadines", WS: "Samoa", SM: "San Marino",
  ST: "Sao Tome and Principe", SA: "Saudi Arabia", SN: "Senegal",
  RS: "Serbia", SC: "Seychelles", SL: "Sierra Leone", SG: "Singapore",
  SK: "Slovakia", SI: "Slovenia", SB: "Solomon Islands", SO: "Somalia",
  ZA: "South Africa", SS: "South Sudan", ES: "Spain", LK: "Sri Lanka",
  SD: "Sudan", SR: "Suriname", SE: "Sweden", CH: "Switzerland",
  SY: "Syria", TW: "Taiwan", TJ: "Tajikistan", TZ: "Tanzania",
  TH: "Thailand", TL: "Timor-Leste", TG: "Togo", TO: "Tonga",
  TT: "Trinidad and Tobago", TN: "Tunisia", TR: "Turkey",
  TM: "Turkmenistan", TV: "Tuvalu", UG: "Uganda", UA: "Ukraine",
  AE: "United Arab Emirates", GB: "United Kingdom", US: "United States",
  UY: "Uruguay", UZ: "Uzbekistan", VU: "Vanuatu", VA: "Vatican City",
  VE: "Venezuela", VN: "Vietnam", YE: "Yemen", ZM: "Zambia", ZW: "Zimbabwe",
  // Common travel territories (distinct entry rules from their sovereign state)
  HK: "Hong Kong", MO: "Macao", PR: "Puerto Rico", GU: "Guam",
  VI: "U.S. Virgin Islands", KY: "Cayman Islands", BM: "Bermuda",
  AW: "Aruba", CW: "Curacao", SX: "Sint Maarten", TC: "Turks and Caicos Islands",
  VG: "British Virgin Islands", GI: "Gibraltar", FO: "Faroe Islands",
  GL: "Greenland", NC: "New Caledonia", PF: "French Polynesia",
  RE: "Reunion", GP: "Guadeloupe", MQ: "Martinique",
};

/** Extra name variants → ISO2 (keys are normalized: lowercase, no diacritics). */
const ALIASES: Record<string, string> = {
  "usa": "US", "u.s.": "US", "u.s.a.": "US", "united states of america": "US",
  "america": "US", "estados unidos": "US",
  "uk": "GB", "u.k.": "GB", "great britain": "GB", "britain": "GB",
  "england": "GB", "scotland": "GB", "wales": "GB", "northern ireland": "GB",
  "uae": "AE", "emirates": "AE",
  "south korea": "KR", "republic of korea": "KR", "korea": "KR",
  "korea, republic of": "KR", "korea south": "KR",
  "north korea": "KP", "dprk": "KP", "korea north": "KP",
  "viet nam": "VN",
  "czech republic": "CZ",
  "turkiye": "TR",
  "burma": "MM",
  "ivory coast": "CI", "cote divoire": "CI", "côte d'ivoire": "CI",
  "drc": "CD", "dr congo": "CD", "congo-kinshasa": "CD",
  "congo kinshasa": "CD", "democratic republic of congo": "CD",
  "congo-brazzaville": "CG", "congo brazzaville": "CG",
  "republic of the congo": "CG",
  "cape verde": "CV",
  "east timor": "TL", "timor leste": "TL",
  "swaziland": "SZ",
  "macedonia": "MK",
  "holland": "NL", "the netherlands": "NL",
  "russian federation": "RU",
  "iran, islamic republic of": "IR",
  "syrian arab republic": "SY",
  "lao pdr": "LA", "lao people's democratic republic": "LA",
  "brunei darussalam": "BN",
  "the bahamas": "BS", "the gambia": "GM", "the philippines": "PH",
  "vatican": "VA", "holy see": "VA",
  "palestinian territories": "PS", "palestine, state of": "PS",
  "taiwan, province of china": "TW", "chinese taipei": "TW",
  "hong kong sar": "HK", "hong kong, china": "HK",
  "macau": "MO", "macao sar": "MO",
  "bolivia, plurinational state of": "BO",
  "venezuela, bolivarian republic of": "VE",
  "tanzania, united republic of": "TZ",
  "moldova, republic of": "MD",
  "micronesia, federated states of": "FM",
  "saint martin": "SX", "st. lucia": "LC", "st lucia": "LC",
  "st. kitts and nevis": "KN", "st kitts and nevis": "KN",
  "st. vincent and the grenadines": "VC", "st vincent and the grenadines": "VC",
  "sao tome & principe": "ST", "são tomé and príncipe": "ST",
  "curaçao": "CW", "réunion": "RE",
  "trinidad & tobago": "TT", "antigua & barbuda": "AG",
  "bosnia & herzegovina": "BA", "bosnia": "BA",
};

/** Normalize for lookup: lowercase, strip diacritics, collapse whitespace. */
function norm(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Name → code index built once (canonical names + aliases).
const NAME_INDEX: Record<string, string> = (() => {
  const idx: Record<string, string> = {};
  for (const [code, name] of Object.entries(CODES)) idx[norm(name)] = code;
  for (const [alias, code] of Object.entries(ALIASES)) idx[norm(alias)] = code;
  return idx;
})();

/**
 * Resolve an ISO2 code or English country name to an uppercase ISO2 code.
 * Returns null when unrecognized — callers must treat null as an honest
 * unknown, never guess.
 */
export function toCountryCode(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Already an ISO2 code?
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const upper = trimmed.toUpperCase();
    return CODES[upper] ? upper : null;
  }
  return NAME_INDEX[norm(trimmed)] ?? null;
}

/** Canonical English name for an ISO2 code, or null. */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  return CODES[code.trim().toUpperCase()] ?? null;
}
