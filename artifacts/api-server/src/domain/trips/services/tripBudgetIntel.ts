/**
 * tripBudgetIntel — pure budget-intelligence logic (NO LLM calls).
 *
 * Everything here is deterministic arithmetic over admin-curated
 * price_baselines rows (migration 0171) plus the caller-supplied what-if
 * inputs. HONESTY CONTRACT: no number is ever invented — when there is no
 * baseline data (or no dates) the result is { available: false } with an
 * explicit reason instead of a guess.
 *
 * Baseline resolution priority: city → country → global (country/city NULL).
 */

export type BudgetTier = "budget" | "comfortable" | "upscale" | "luxury";

export const BUDGET_TIERS: readonly BudgetTier[] = [
  "budget",
  "comfortable",
  "upscale",
  "luxury",
] as const;

export const BASELINE_CATEGORIES = [
  "lodging",
  "food",
  "transport",
  "activities",
  "nightlife",
  "other",
] as const;
export type BaselineCategory = (typeof BASELINE_CATEGORIES)[number];

const ESTIMATE_DISCLAIMER =
  "Estimates are derived from curated baseline data and may not reflect current " +
  "prices, seasonality, or your travel style. Always verify against live prices " +
  "before committing money.";

// Uncertainty band multipliers applied to the curated mid value.
const BAND_LOW = 0.85;
const BAND_HIGH = 1.2;

interface Band {
  low: number;
  mid: number;
  high: number;
}

export interface EstimateUnavailable {
  available: false;
  reason: "dates_not_set" | "invalid_dates" | "no_baseline_data";
  disclaimer?: string;
}

export interface EstimateAvailable {
  available: true;
  days: number;
  tier: BudgetTier;
  currency: string;
  scope: "city" | "country" | "global";
  perDay: Band;
  total: Band;
  breakdown: Array<{ category: string; perDay: number; source_note: string | null }>;
  assumptions: string[];
  confidence: "curated_baseline";
  lastVerifiedAt: string | null;
  disclaimer: string;
}

export type EstimateResult = EstimateAvailable | EstimateUnavailable;

// ── Country-code resolution (defensive) ───────────────────────────────────────
// The canonical helper is toCountryCode from ../lib/countryCodes; it may not
// exist in every checkout, so it is imported dynamically and this module falls
// back to a small verbatim name→ISO2 map. Codes are identifiers, not data
// invention.

let _toCountryCode: ((name: string) => string | null) | null | undefined;

const COUNTRY_NAME_TO_ISO2: Record<string, string> = {
  "united states": "US", usa: "US", "united states of america": "US",
  "united kingdom": "GB", uk: "GB", england: "GB", "great britain": "GB",
  france: "FR", spain: "ES", portugal: "PT", italy: "IT", germany: "DE",
  netherlands: "NL", belgium: "BE", switzerland: "CH", austria: "AT",
  greece: "GR", croatia: "HR", "czech republic": "CZ", czechia: "CZ",
  poland: "PL", hungary: "HU", ireland: "IE", iceland: "IS",
  norway: "NO", sweden: "SE", denmark: "DK", finland: "FI",
  japan: "JP", "south korea": "KR", korea: "KR", china: "CN",
  thailand: "TH", vietnam: "VN", indonesia: "ID", bali: "ID",
  malaysia: "MY", singapore: "SG", philippines: "PH", india: "IN",
  australia: "AU", "new zealand": "NZ",
  mexico: "MX", canada: "CA", brazil: "BR", argentina: "AR",
  chile: "CL", peru: "PE", colombia: "CO", "costa rica": "CR",
  morocco: "MA", egypt: "EG", "south africa": "ZA", kenya: "KE",
  turkey: "TR", "türkiye": "TR", "united arab emirates": "AE", uae: "AE",
};

async function resolveCountryCode(countryInput: string | null | undefined): Promise<string | null> {
  const raw = String(countryInput ?? "").trim();
  if (!raw) return null;
  // Already an ISO2 code
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();

  if (_toCountryCode === undefined) {
    try {
      // Computed specifier so a missing module is a runtime fallback, not a
      // compile-time error.
      const specifier = "./" + "countryCodes.js";
      const mod: any = await import(/* @vite-ignore */ specifier);
      _toCountryCode = typeof mod?.toCountryCode === "function" ? mod.toCountryCode : null;
    } catch {
      _toCountryCode = null;
    }
  }

  if (_toCountryCode) {
    try {
      const viaHelper = _toCountryCode(raw);
      if (viaHelper && /^[A-Za-z]{2}$/.test(viaHelper)) return viaHelper.toUpperCase();
    } catch {
      /* fall through to inline map */
    }
  }
  return COUNTRY_NAME_TO_ISO2[raw.toLowerCase()] ?? null;
}

// ── resolveTier ───────────────────────────────────────────────────────────────

/**
 * Normalize a profile budget_style-ish string to a baseline tier.
 * Profile enum today: 'budget' | 'mid-range' | 'luxury' | 'flexible'.
 * Unknown / missing input defaults to 'comfortable'.
 */
export function resolveTier(input?: string | null): BudgetTier {
  const v = String(input ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  switch (v) {
    case "budget":
    case "cheap":
    case "backpacker":
    case "shoestring":
    case "low":
      return "budget";
    case "comfortable":
    case "mid-range":
    case "midrange":
    case "mid":
    case "moderate":
    case "standard":
    case "flexible":
      return "comfortable";
    case "upscale":
    case "premium":
    case "high-end":
      return "upscale";
    case "luxury":
    case "luxe":
    case "lux":
      return "luxury";
    default:
      return "comfortable";
  }
}

// ── estimateTripCost ──────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function band(mid: number): Band {
  return { low: round2(mid * BAND_LOW), mid: round2(mid), high: round2(mid * BAND_HIGH) };
}

/** Inclusive day count from two YYYY-MM-DD (or ISO) date strings. */
function inclusiveDays(startDate: string, endDate: string): number | null {
  const start = new Date(String(startDate).slice(0, 10) + "T00:00:00Z");
  const end = new Date(String(endDate).slice(0, 10) + "T00:00:00Z");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const diff = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (diff < 0) return null;
  return diff + 1;
}

/**
 * Estimate a trip's cost from curated baselines.
 *
 * @param sc   service-role Supabase client (or test fake)
 * @param trip row with destination_city / destination_country / start_date / end_date
 * @param opts tier override + party size (informational — amounts stay per person)
 */
export async function estimateTripCost(
  sc: any,
  trip: {
    destination_city?: string | null;
    destination_country?: string | null;
    start_date?: string | null;
    end_date?: string | null;
  },
  opts: { tier?: BudgetTier; partySize?: number } = {},
): Promise<EstimateResult> {
  const tier: BudgetTier = opts.tier ?? "comfortable";

  if (!trip.start_date || !trip.end_date) {
    return { available: false, reason: "dates_not_set" };
  }
  const days = inclusiveDays(trip.start_date, trip.end_date);
  if (days === null || days <= 0) {
    return { available: false, reason: "invalid_dates" };
  }

  // ── Baseline lookup: city → country → global ────────────────────────────────
  let rows: any[] = [];
  let scope: "city" | "country" | "global" | null = null;

  const city = String(trip.destination_city ?? "").trim();
  if (city) {
    const { data, error } = await sc
      .from("price_baselines")
      .select("*")
      .ilike("city", city);
    if (!error && Array.isArray(data) && data.length > 0) {
      rows = data as any[];
      scope = "city";
    }
  }

  if (!scope) {
    const countryCode = await resolveCountryCode(trip.destination_country);
    if (countryCode) {
      const { data, error } = await sc
        .from("price_baselines")
        .select("*")
        .eq("country", countryCode)
        .is("city", null);
      if (!error && Array.isArray(data) && data.length > 0) {
        rows = data as any[];
        scope = "country";
      }
    }
  }

  if (!scope) {
    const { data, error } = await sc
      .from("price_baselines")
      .select("*")
      .is("country", null)
      .is("city", null);
    if (!error && Array.isArray(data) && data.length > 0) {
      rows = data as any[];
      scope = "global";
    }
  }

  if (!scope || rows.length === 0) {
    return {
      available: false,
      reason: "no_baseline_data",
      disclaimer:
        "No curated price baselines exist for this destination yet, so no estimate " +
        "is shown rather than an invented one.",
    };
  }

  // ── Per-category tier resolution (nearest-tier fallback, noted) ─────────────
  const assumptions: string[] = [];
  const byCategory = new Map<string, any[]>();
  for (const r of rows) {
    const cat = String((r as any).category ?? "other");
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(r);
  }

  const tierIdx = BUDGET_TIERS.indexOf(tier);
  const breakdown: Array<{ category: string; perDay: number; source_note: string | null }> = [];
  const usedRows: any[] = [];

  for (const [category, catRows] of byCategory) {
    let chosen = catRows.find((r) => String((r as any).tier) === tier) ?? null;
    if (!chosen) {
      // Nearest tier by distance in the tier ladder; ties resolve to cheaper.
      let bestDist = Number.POSITIVE_INFINITY;
      for (const r of catRows) {
        const idx = BUDGET_TIERS.indexOf(String((r as any).tier) as BudgetTier);
        if (idx < 0) continue;
        const dist = Math.abs(idx - tierIdx);
        if (dist < bestDist || (dist === bestDist && chosen && idx < BUDGET_TIERS.indexOf(String((chosen as any).tier) as BudgetTier))) {
          bestDist = dist;
          chosen = r;
        }
      }
      if (chosen) {
        assumptions.push(
          `No '${tier}' baseline for ${category}; used nearest tier '${String((chosen as any).tier)}' instead.`,
        );
      }
    }
    if (!chosen) continue;
    usedRows.push(chosen);
    breakdown.push({
      category,
      perDay: round2(Number((chosen as any).daily_amount) || 0),
      source_note: ((chosen as any).source_note as string | null) ?? null,
    });
  }

  if (usedRows.length === 0) {
    return {
      available: false,
      reason: "no_baseline_data",
      disclaimer:
        "Baseline rows exist for this destination but none are usable for the " +
        "requested tier, so no estimate is shown rather than an invented one.",
    };
  }

  breakdown.sort((a, b) => b.perDay - a.perDay);

  const perDayMid = breakdown.reduce((sum, b) => sum + b.perDay, 0);
  const perDay = band(perDayMid);
  const total: Band = {
    low: round2(perDay.low * days),
    mid: round2(perDay.mid * days),
    high: round2(perDay.high * days),
  };

  // Currency: report the first used row's currency; flag mixes honestly.
  const currencies = [...new Set(usedRows.map((r) => String((r as any).currency ?? "USD")))];
  const currency = currencies[0] ?? "USD";
  if (currencies.length > 1) {
    assumptions.push(
      `Baseline rows mix currencies (${currencies.join(", ")}); amounts are reported as ${currency} without conversion.`,
    );
  }

  // Oldest verification date across the rows actually used.
  let lastVerifiedAt: string | null = null;
  for (const r of usedRows) {
    const v = (r as any).last_verified_at ? String((r as any).last_verified_at) : null;
    if (v && (lastVerifiedAt === null || v < lastVerifiedAt)) lastVerifiedAt = v;
  }

  assumptions.push("All amounts are PER PERSON.");
  const partySize = Number(opts.partySize ?? 0);
  if (Number.isFinite(partySize) && partySize > 1) {
    assumptions.push(
      `Trip currently has ${partySize} accepted members — multiply totals by ${partySize} for a group figure.`,
    );
  }
  assumptions.push(
    `Low/high band = ${BAND_LOW}x / ${BAND_HIGH}x of the curated mid value.`,
  );
  assumptions.push(`Baseline scope used: ${scope}.`);

  return {
    available: true,
    days,
    tier,
    currency,
    scope,
    perDay,
    total,
    breakdown,
    assumptions,
    confidence: "curated_baseline",
    lastVerifiedAt,
    disclaimer: ESTIMATE_DISCLAIMER,
  };
}

// ── sandboxBudget ─────────────────────────────────────────────────────────────

export interface SandboxWhatIf {
  extraDays?: number;
  dailySpendOverride?: number;
  budgetDelta?: number;
  protectedCategories?: string[];
}

export interface SandboxSuggestion {
  type: "reduce_category" | "shorten_trip";
  category?: string;
  perDayReduction?: number;
  daysToCut?: number;
  estimatedSavings: number;
  note: string;
}

export type SandboxResult =
  | { available: false; reason: "no_inputs" }
  | {
      available: true;
      days: number;
      dailySpend: Band;
      total: Band | null;
      budget: { totalBudget: number; budgetDelta: number; effectiveBudget: number } | null;
      fitsBudget: boolean | null;
      gap: number | null;
      suggestions: SandboxSuggestion[];
      protectedCategories: string[];
      notes: string[];
    };

/**
 * Pure what-if arithmetic over an existing estimate (or a caller-supplied
 * daily spend) versus the trip's saved budget row. Never touches the DB and
 * never proposes trimming a protected category.
 *
 * @param current   estimateTripCost result, or null when unavailable
 * @param budgetRow trip_budget row (total_budget, currency) or null
 * @param whatIf    scenario knobs
 */
export function sandboxBudget(
  current: EstimateResult | null,
  budgetRow: { total_budget?: number | string | null; currency?: string | null } | null,
  whatIf: SandboxWhatIf = {},
): SandboxResult {
  const hasEstimate = Boolean(current && current.available);
  const override =
    whatIf.dailySpendOverride !== undefined && whatIf.dailySpendOverride !== null
      ? Number(whatIf.dailySpendOverride)
      : null;

  if (!hasEstimate && override === null) {
    return { available: false, reason: "no_inputs" };
  }

  const est = hasEstimate ? (current as EstimateAvailable) : null;
  const notes: string[] = [];
  const protectedCategories = (whatIf.protectedCategories ?? []).map((c) => String(c));

  if (!est) {
    notes.push(
      "No baseline estimate is available for this trip — this scenario runs off your dailySpendOverride only.",
    );
  }

  const extraDays = Number.isFinite(Number(whatIf.extraDays)) ? Math.trunc(Number(whatIf.extraDays)) : 0;
  const baseDays = est ? est.days : 0;
  const days = Math.max(0, baseDays + extraDays);
  if (extraDays !== 0) {
    notes.push(`Scenario ${extraDays > 0 ? "adds" : "removes"} ${Math.abs(extraDays)} day(s) (base ${baseDays}).`);
  }

  let dailySpend: Band;
  if (override !== null) {
    const o = round2(Math.max(0, override));
    dailySpend = { low: o, mid: o, high: o };
    notes.push("dailySpendOverride applied — no uncertainty band on an exact override.");
  } else {
    dailySpend = { ...(est as EstimateAvailable).perDay };
  }

  let total: Band | null = null;
  if (days > 0) {
    total = {
      low: round2(dailySpend.low * days),
      mid: round2(dailySpend.mid * days),
      high: round2(dailySpend.high * days),
    };
  } else {
    notes.push("Trip length is unknown or zero in this scenario, so no total can be computed.");
  }

  // ── Budget comparison ───────────────────────────────────────────────────────
  const budgetDelta = Number.isFinite(Number(whatIf.budgetDelta)) ? Number(whatIf.budgetDelta) : 0;
  const totalBudgetRaw = budgetRow?.total_budget;
  const totalBudget =
    totalBudgetRaw === null || totalBudgetRaw === undefined ? null : Number(totalBudgetRaw);

  let budget: { totalBudget: number; budgetDelta: number; effectiveBudget: number } | null = null;
  let fitsBudget: boolean | null = null;
  let gap: number | null = null;

  if (totalBudget !== null && Number.isFinite(totalBudget)) {
    const effectiveBudget = round2(totalBudget + budgetDelta);
    budget = { totalBudget: round2(totalBudget), budgetDelta: round2(budgetDelta), effectiveBudget };
    if (total) {
      fitsBudget = total.mid <= effectiveBudget;
      gap = round2(total.mid - effectiveBudget); // positive = over budget
    } else {
      notes.push("fitsBudget cannot be evaluated without a scenario total.");
    }
  } else {
    notes.push("No trip budget is set, so fitsBudget cannot be evaluated.");
  }

  // ── Gap-closing suggestions (never touch protected categories) ──────────────
  const suggestions: SandboxSuggestion[] = [];
  if (gap !== null && gap > 0 && total && days > 0) {
    let remaining = gap;

    // Category trims come only from the real baseline breakdown; an override
    // scenario has no per-category data to trim.
    if (est && override === null) {
      const trimmable = est.breakdown.filter((b) => !protectedCategories.includes(b.category));
      for (const b of trimmable) {
        if (remaining <= 0) break;
        const maxPerDayCut = round2(b.perDay * 0.3); // heuristic cap: 30% of the category
        if (maxPerDayCut <= 0) continue;
        const neededPerDay = round2(remaining / days);
        const perDayReduction = Math.min(maxPerDayCut, neededPerDay);
        const estimatedSavings = round2(perDayReduction * days);
        if (estimatedSavings <= 0) continue;
        suggestions.push({
          type: "reduce_category",
          category: b.category,
          perDayReduction,
          estimatedSavings,
          note: `Trim ${b.category} by ${perDayReduction}/day (capped at 30% of its ${b.perDay}/day baseline) to save ~${estimatedSavings}.`,
        });
        remaining = round2(remaining - estimatedSavings);
      }
      if (protectedCategories.length > 0) {
        notes.push(
          `Protected categories left untouched: ${protectedCategories.join(", ")}.`,
        );
      }
    }

    if (remaining > 0 && dailySpend.mid > 0 && days > 1) {
      const daysToCut = Math.min(days - 1, Math.ceil(remaining / dailySpend.mid));
      if (daysToCut > 0) {
        const estimatedSavings = round2(daysToCut * dailySpend.mid);
        suggestions.push({
          type: "shorten_trip",
          daysToCut,
          estimatedSavings,
          note: `Shorten the trip by ${daysToCut} day(s) to save ~${estimatedSavings}.`,
        });
        remaining = round2(remaining - estimatedSavings);
      }
    }

    if (remaining > 0) {
      notes.push(
        `Suggestions close only part of the gap; ~${remaining} remains over budget without touching protected categories.`,
      );
    }
  }

  return {
    available: true,
    days,
    dailySpend,
    total,
    budget,
    fitsBudget,
    gap,
    suggestions,
    protectedCategories,
    notes,
  };
}
