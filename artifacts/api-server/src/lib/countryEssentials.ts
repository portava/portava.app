/**
 * Country essentials — curated static travel-readiness reference data.
 *
 * Fields:
 *   plugTypes  — IEC "World Plugs" letter types (A–N) in common use
 *   voltage    — nominal mains voltage (V)
 *   frequency  — mains frequency (Hz)
 *   driveSide  — 'left' | 'right' (side of the road)
 *   emergency  — { all?, police?, ambulance?, fire? } dial numbers
 *
 * HONESTY CONTRACT (this is safety-relevant data):
 *   - confidence is 'curated' with an explicit source note + dataset date.
 *   - Plug/voltage/frequency are engineering-standardized (IEC) and stable.
 *   - Emergency numbers vary by region and change; EVERY consumer must show
 *     the CONFIRM_DISCLAIMER. Where a reliable universal number exists (112 in
 *     the EU/EEA, 911 in North America) it is used as `all`.
 *   - Countries not in this set return null (unknown) — never a guess.
 *
 * Sources: IEC World Plugs (iec.ch/world-plugs); national emergency-number
 * directories / ITU. Dataset date below.
 */

export const ESSENTIALS_DATASET_DATE = "2026-07-24";
export const ESSENTIALS_SOURCE = "IEC World Plugs; national emergency-service directories (curated)";
export const CONFIRM_DISCLAIMER =
  "Confirm emergency numbers locally on arrival — they vary by region and can change.";

export interface EmergencyNumbers {
  all?: string;
  police?: string;
  ambulance?: string;
  fire?: string;
}

export interface CountryEssential {
  plugTypes: string[];
  voltage: number;
  frequency: number;
  driveSide: "left" | "right";
  emergency: EmergencyNumbers;
}

// ISO-3166 alpha-2 → essentials. Curated; accurate for common travel
// destinations. Emergency fields use the primary number a traveler should dial.
export const COUNTRY_ESSENTIALS: Record<string, CountryEssential> = {
  // ── North America ──
  US: { plugTypes: ["A", "B"], voltage: 120, frequency: 60, driveSide: "right", emergency: { all: "911" } },
  CA: { plugTypes: ["A", "B"], voltage: 120, frequency: 60, driveSide: "right", emergency: { all: "911" } },
  MX: { plugTypes: ["A", "B"], voltage: 127, frequency: 60, driveSide: "right", emergency: { all: "911" } },
  CR: { plugTypes: ["A", "B"], voltage: 120, frequency: 60, driveSide: "right", emergency: { all: "911" } },

  // ── United Kingdom & Ireland ──
  GB: { plugTypes: ["G"], voltage: 230, frequency: 50, driveSide: "left", emergency: { all: "999", police: "999", ambulance: "999", fire: "999" } },
  IE: { plugTypes: ["G", "F"], voltage: 230, frequency: 50, driveSide: "left", emergency: { all: "112", police: "999" } },

  // ── EU / EEA (112 is the pan-European emergency number) ──
  FR: { plugTypes: ["C", "E"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  DE: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112", police: "110" } },
  ES: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  IT: { plugTypes: ["C", "F", "L"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  NL: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  BE: { plugTypes: ["C", "E"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  PT: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  AT: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  CH: { plugTypes: ["C", "J"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112", police: "117", fire: "118", ambulance: "144" } },
  GR: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  SE: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  NO: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112", ambulance: "113", fire: "110" } },
  DK: { plugTypes: ["C", "E", "F", "K"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  FI: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  PL: { plugTypes: ["C", "E"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  CZ: { plugTypes: ["C", "E"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  HU: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  HR: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  IS: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },

  // ── Rest of Europe ──
  TR: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  RU: { plugTypes: ["C", "F"], voltage: 220, frequency: 50, driveSide: "right", emergency: { all: "112", police: "102", ambulance: "103", fire: "101" } },

  // ── East / SE / South Asia ──
  JP: { plugTypes: ["A", "B"], voltage: 100, frequency: 50, driveSide: "left", emergency: { police: "110", fire: "119", ambulance: "119" } },
  CN: { plugTypes: ["A", "C", "I"], voltage: 220, frequency: 50, driveSide: "right", emergency: { police: "110", ambulance: "120", fire: "119" } },
  KR: { plugTypes: ["C", "F"], voltage: 220, frequency: 60, driveSide: "right", emergency: { police: "112", fire: "119", ambulance: "119" } },
  TW: { plugTypes: ["A", "B"], voltage: 110, frequency: 60, driveSide: "right", emergency: { police: "110", fire: "119", ambulance: "119" } },
  HK: { plugTypes: ["G"], voltage: 220, frequency: 50, driveSide: "left", emergency: { all: "999" } },
  TH: { plugTypes: ["A", "B", "C", "O"], voltage: 230, frequency: 50, driveSide: "left", emergency: { police: "191", ambulance: "1669", fire: "199" } },
  VN: { plugTypes: ["A", "C", "F"], voltage: 220, frequency: 50, driveSide: "right", emergency: { police: "113", ambulance: "115", fire: "114" } },
  ID: { plugTypes: ["C", "F"], voltage: 230, frequency: 50, driveSide: "left", emergency: { all: "112", police: "110" } },
  MY: { plugTypes: ["G"], voltage: 240, frequency: 50, driveSide: "left", emergency: { all: "999" } },
  SG: { plugTypes: ["G"], voltage: 230, frequency: 50, driveSide: "left", emergency: { police: "999", ambulance: "995", fire: "995" } },
  PH: { plugTypes: ["A", "B", "C"], voltage: 220, frequency: 60, driveSide: "right", emergency: { all: "911" } },
  IN: { plugTypes: ["C", "D", "M"], voltage: 230, frequency: 50, driveSide: "left", emergency: { all: "112", police: "100", ambulance: "102", fire: "101" } },

  // ── Oceania ──
  AU: { plugTypes: ["I"], voltage: 230, frequency: 50, driveSide: "left", emergency: { all: "000", police: "000" } },
  NZ: { plugTypes: ["I"], voltage: 230, frequency: 50, driveSide: "left", emergency: { all: "111" } },

  // ── Middle East ──
  AE: { plugTypes: ["G"], voltage: 220, frequency: 50, driveSide: "right", emergency: { police: "999", ambulance: "998", fire: "997" } },
  SA: { plugTypes: ["G"], voltage: 230, frequency: 60, driveSide: "right", emergency: { police: "999", ambulance: "997", fire: "998" } },
  IL: { plugTypes: ["C", "H", "M"], voltage: 230, frequency: 50, driveSide: "right", emergency: { police: "100", ambulance: "101", fire: "102" } },

  // ── Africa ──
  EG: { plugTypes: ["C", "F"], voltage: 220, frequency: 50, driveSide: "right", emergency: { police: "122", ambulance: "123" } },
  ZA: { plugTypes: ["C", "D", "M", "N"], voltage: 230, frequency: 50, driveSide: "left", emergency: { police: "10111", ambulance: "10177" } },
  KE: { plugTypes: ["G"], voltage: 240, frequency: 50, driveSide: "left", emergency: { all: "999" } },
  NG: { plugTypes: ["D", "G"], voltage: 230, frequency: 50, driveSide: "right", emergency: { all: "112" } },
  MA: { plugTypes: ["C", "E"], voltage: 220, frequency: 50, driveSide: "right", emergency: { police: "19", ambulance: "15" } },

  // ── Latin America ──
  BR: { plugTypes: ["C", "N"], voltage: 127, frequency: 60, driveSide: "right", emergency: { police: "190", ambulance: "192" } },
  AR: { plugTypes: ["C", "I"], voltage: 220, frequency: 50, driveSide: "right", emergency: { all: "911", ambulance: "107" } },
  CL: { plugTypes: ["C", "L"], voltage: 220, frequency: 50, driveSide: "right", emergency: { police: "133", ambulance: "131", fire: "132" } },
  CO: { plugTypes: ["A", "B"], voltage: 110, frequency: 60, driveSide: "right", emergency: { all: "123" } },
  PE: { plugTypes: ["A", "B", "C"], voltage: 220, frequency: 60, driveSide: "right", emergency: { all: "105", ambulance: "106" } },
};

/** Look up essentials by ISO-3166 alpha-2 code (case-insensitive). Null when unknown. */
export function essentialsFor(code: string | null | undefined): (CountryEssential & { code: string }) | null {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  const e = COUNTRY_ESSENTIALS[c];
  return e ? { code: c, ...e } : null;
}

/** How many countries are covered (for observability). */
export function essentialsCoverage(): number {
  return Object.keys(COUNTRY_ESSENTIALS).length;
}
