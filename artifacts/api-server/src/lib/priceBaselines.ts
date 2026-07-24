/**
 * Price baselines — curated seed for trip budget intelligence.
 *
 * The price_baselines table (0171) drives the trip cost-estimate, but shipped
 * empty — so every estimate returned `no_baseline_data`. This provides a
 * curated seed: a GLOBAL baseline (per person, per day, USD) for every
 * category × tier, plus per-country overrides derived by scaling the global
 * baseline by a relative price index. The budget engine resolves city →
 * country → global, so with the global rows present EVERY trip now gets an
 * honest estimate.
 *
 * HONESTY CONTRACT (cost-of-living is inherently estimative):
 *   - confidence='curated'; source_note says these are indicative curated
 *     baselines, NOT a live cost-of-living feed.
 *   - The budget engine already appends ESTIMATE_DISCLAIMER to responses.
 *   - This is exactly the "admin-curated only" state the data roadmap expects
 *     to REPLACE with a licensed provider (Numbeo) once there are live users;
 *     the confidence column makes that a clean swap.
 */

export const BASELINE_DATASET_DATE = "2026-07-24";
export const BASELINE_SOURCE_NOTE =
  "Curated indicative baseline (per person/day, USD), global figure scaled by a per-country price index; not a live cost-of-living feed";

export type BaselineCategory = "lodging" | "food" | "transport" | "activities" | "nightlife" | "other";
export type BaselineTier = "budget" | "comfortable" | "upscale" | "luxury";

export const BASELINE_CATEGORIES: BaselineCategory[] = ["lodging", "food", "transport", "activities", "nightlife", "other"];
export const BASELINE_TIERS: BaselineTier[] = ["budget", "comfortable", "upscale", "luxury"];

/** Global per-person/day baseline in USD. */
export const GLOBAL_BASELINE: Record<BaselineCategory, Record<BaselineTier, number>> = {
  lodging:    { budget: 25, comfortable: 70, upscale: 180, luxury: 450 },
  food:       { budget: 15, comfortable: 40, upscale: 90,  luxury: 200 },
  transport:  { budget: 5,  comfortable: 15, upscale: 40,  luxury: 100 },
  activities: { budget: 8,  comfortable: 25, upscale: 60,  luxury: 150 },
  nightlife:  { budget: 5,  comfortable: 20, upscale: 50,  luxury: 120 },
  other:      { budget: 5,  comfortable: 12, upscale: 30,  luxury: 70  },
};

/**
 * Relative price index per country (1.0 = the global baseline). Curated from
 * well-established relative cost-of-living tiers. Countries not listed fall
 * back to the global baseline at lookup time.
 */
export const COUNTRY_PRICE_INDEX: Record<string, number> = {
  // very cheap
  IN: 0.5, VN: 0.5, ID: 0.55, EG: 0.5, NP: 0.5, PK: 0.5, BD: 0.5, LK: 0.55,
  // cheap
  TH: 0.65, PH: 0.65, MX: 0.7, MA: 0.6, TR: 0.6, PE: 0.65, CO: 0.65, KE: 0.65, NG: 0.6, GT: 0.65, BO: 0.6, VE: 0.6,
  // moderate
  MY: 0.85, ZA: 0.8, BR: 0.85, AR: 0.8, CN: 0.9, PL: 0.85, CZ: 0.9, HU: 0.85, HR: 0.9, RO: 0.8, BG: 0.8, PT: 0.95, GR: 0.95,
  // baseline
  ES: 1.0, IT: 1.05, KR: 1.05, TW: 0.95, IL: 1.1, CR: 1.0, CL: 0.95, EE: 0.95,
  // above baseline
  FR: 1.25, DE: 1.2, NL: 1.3, JP: 1.2, AE: 1.25, GB: 1.35, IE: 1.3, AT: 1.25, BE: 1.25, NZ: 1.25, CA: 1.25, SA: 1.15,
  // expensive
  US: 1.5, AU: 1.5, SE: 1.45, DK: 1.55, FI: 1.45, SG: 1.55, HK: 1.5, LU: 1.55,
  // very expensive
  CH: 1.85, NO: 1.8, IS: 1.8,
};

export interface BaselineRow {
  country: string | null;   // ISO2, or null for the global row
  category: BaselineCategory;
  tier: BaselineTier;
  dailyAmount: number;
}

function round(n: number): number {
  // Round to a tidy figure: nearest 1 under 50, nearest 5 above.
  return n < 50 ? Math.max(1, Math.round(n)) : Math.round(n / 5) * 5;
}

/**
 * Generate all baseline rows: the 24 global rows (country=null) + 24 rows per
 * indexed country (global × its price index).
 */
export function generateBaselineRows(): BaselineRow[] {
  const rows: BaselineRow[] = [];
  // Global rows.
  for (const cat of BASELINE_CATEGORIES) {
    for (const tier of BASELINE_TIERS) {
      rows.push({ country: null, category: cat, tier, dailyAmount: GLOBAL_BASELINE[cat][tier] });
    }
  }
  // Per-country scaled rows.
  for (const [country, index] of Object.entries(COUNTRY_PRICE_INDEX)) {
    for (const cat of BASELINE_CATEGORIES) {
      for (const tier of BASELINE_TIERS) {
        rows.push({ country, category: cat, tier, dailyAmount: round(GLOBAL_BASELINE[cat][tier] * index) });
      }
    }
  }
  return rows;
}
