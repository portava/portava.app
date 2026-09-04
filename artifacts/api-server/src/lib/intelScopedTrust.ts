/**
 * Intelligence Gathering — SCOPED TRUST (unit I4a, spec §15 / Table 23).
 *
 * "scope = geography × claim_family × time_band × traveler_mode × season"
 * "trust_next = clamp(trust_prev + learning_rate*(outcome_score - expected_accuracy)*evidence_weight, 0, 100)"
 * "Public UI shows scoped badges and evidence portfolio, not a universal numeric
 *  Trust score. Internal Trust remains purpose-limited and appealable."
 *
 * THE RULING THIS RESPECTS. 2130 declined intel_expertise_scopes ("would be the
 * sixth verification ladder. Scope the existing Trust services instead."). The
 * existing engine (services/trust, trust_profiles) holds NINE category scores per
 * user; a §15 scope key has five dimensions and thousands of cells, so
 * trust_profiles cannot HOST scoped trust. What this module does instead:
 *
 *   * the per-scope STATE is derived and lives in intel_scoped_trust (2278) —
 *     named for what it is: a calibration ledger keyed (actor, scope), not a
 *     ladder, not a public score, recomputable from intel_attributions;
 *   * every update is ALSO bridged into the existing engine as a trust_events
 *     row under the existing `guide_accuracy` category (Table-23 "outcome
 *     success" / "materially incorrect confident claim"), so trust_profiles —
 *     the ONE user-level trust — keeps being the consumer. The scoped table
 *     feeds the ladder; it does not compete with it.
 *
 * This module is PURE except for the two DB helpers at the bottom. Nothing here
 * is wired into confidence scoring — that is a separate owner decision (see the
 * unit report); getScopedTrust is consumed by tests only.
 */
import type { IntelOutcome, TravelerMode } from "./intelOutcomes.js";

// ── Scope key ────────────────────────────────────────────────────────────────

export const TIME_BANDS = ["late_night", "morning", "afternoon", "evening"] as const;
export type TimeBand = (typeof TIME_BANDS)[number];

export const SEASONS = ["winter", "spring", "summer", "autumn"] as const;
export type Season = (typeof SEASONS)[number];

export interface ScopeInput {
  /** `${country_code}:${city}` (lower-cased), or 'unknown'. */
  geography: string;
  /** The claim family — the prefix of the claim type ('crowd' for crowd.level). */
  claimFamily: string;
  timeBand: TimeBand;
  travelerMode: TravelerMode;
  season: Season;
}

/** Claim family = the taxonomy prefix ('crowd.level' → 'crowd'). Fail-closed 'unknown'. */
export function claimFamilyOf(claimType: string | null | undefined): string {
  if (typeof claimType !== "string" || claimType.length === 0) return "unknown";
  const dot = claimType.indexOf(".");
  return (dot > 0 ? claimType.slice(0, dot) : claimType).toLowerCase();
}

/** Geography cell from a place row. Never coordinates — a city-level label. */
export function geographyOf(place: { country_code?: string | null; city?: string | null } | null | undefined): string {
  const cc = typeof place?.country_code === "string" ? place.country_code.trim().toLowerCase() : "";
  const city = typeof place?.city === "string" ? place.city.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (!cc && !city) return "unknown";
  return `${cc || "xx"}:${city || "unknown"}`;
}

/**
 * Approximate local hour from a UTC instant and a longitude (15° per hour).
 * Places carry no timezone; this keeps 'late_night' meaning late night in
 * Da Nang rather than in UTC. A null longitude falls back to UTC (documented).
 */
export function localHourOf(atIso: string, longitude: number | null | undefined): number | null {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return null;
  const utcHour = new Date(t).getUTCHours();
  const offset = typeof longitude === "number" && Number.isFinite(longitude) ? Math.round(longitude / 15) : 0;
  return ((utcHour + offset) % 24 + 24) % 24;
}

export function timeBandOf(atIso: string, longitude: number | null | undefined): TimeBand | null {
  const h = localHourOf(atIso, longitude);
  if (h === null) return null;
  if (h < 6) return "late_night";
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

/** Meteorological season; the hemisphere flips it. Unknown latitude ⇒ northern. */
export function seasonOf(atIso: string, latitude: number | null | undefined): Season | null {
  const t = Date.parse(atIso);
  if (!Number.isFinite(t)) return null;
  const m = new Date(t).getUTCMonth(); // 0..11
  const north: Season = m <= 1 || m === 11 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : "autumn";
  const south = typeof latitude === "number" && Number.isFinite(latitude) && latitude < 0;
  if (!south) return north;
  return ({ winter: "summer", spring: "autumn", summer: "winter", autumn: "spring" } as const)[north];
}

/** The canonical scope-key string — stable, sortable, stored on every attribution row. */
export function buildScopeKey(s: ScopeInput): string {
  return `geo=${s.geography}|fam=${s.claimFamily}|band=${s.timeBand}|mode=${s.travelerMode}|season=${s.season}`;
}

/** Inverse of buildScopeKey; null on any drift (fail-closed). */
export function parseScopeKey(key: string): ScopeInput | null {
  const m = /^geo=([^|]+)\|fam=([^|]+)\|band=([^|]+)\|mode=([^|]+)\|season=([^|]+)$/.exec(key);
  if (!m) return null;
  const [, geography, claimFamily, timeBand, travelerMode, season] = m;
  if (!(TIME_BANDS as readonly string[]).includes(timeBand)) return null;
  if (!(SEASONS as readonly string[]).includes(season)) return null;
  return { geography, claimFamily, timeBand: timeBand as TimeBand, travelerMode: travelerMode as TravelerMode, season: season as Season };
}

/**
 * Assemble the scope for an outcome from real facts: the subject's place row
 * (city/country/coords), the claim type, the served_at instant and the
 * reporter's declared traveler mode. Every dimension falls back to a stated
 * default rather than failing — a scope is a bucket, not a gate.
 */
export function scopeFor(args: {
  place: { country_code?: string | null; city?: string | null; latitude?: number | null; longitude?: number | null } | null;
  claimType: string;
  servedAt: string;
  travelerMode?: TravelerMode | null;
}): ScopeInput {
  return {
    geography: geographyOf(args.place),
    claimFamily: claimFamilyOf(args.claimType),
    timeBand: timeBandOf(args.servedAt, args.place?.longitude) ?? "evening",
    travelerMode: args.travelerMode ?? "unknown",
    season: seasonOf(args.servedAt, args.place?.latitude) ?? "summer",
  };
}

// ── Trust update (the §15 formula, exactly) ──────────────────────────────────

/** A new scope starts neutral, like trust_profiles' 50.00 defaults. */
export const DEFAULT_SCOPED_TRUST = 50;
/** Points per unit of (outcome_score − expected_accuracy) × evidence_weight. */
export const DEFAULT_LEARNING_RATE = 10;
export const SCOPED_TRUST_ALGORITHM_VERSION = "scoped_trust.v1";

export interface TrustUpdateInput {
  /** 0..1 accuracy grade of the outcome (lib/intelAttribution OUTCOME_SCORE). */
  outcomeScore: number;
  /** 0..1 — the served confidence: how accurate the claim CLAIMED to be. */
  expectedAccuracy: number;
  /** 0..1 — the attribution weight (Table 22, normalized). */
  evidenceWeight: number;
  learningRate?: number;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const unit = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? clamp(x, 0, 1) : null;

/**
 * trust_next = clamp(trust_prev + learning_rate*(outcome_score - expected_accuracy)*evidence_weight, 0, 100)
 * Fail-closed: a non-finite input leaves trust unchanged (returns prev).
 */
export function updateScopedTrust(trustPrev: number, u: TrustUpdateInput): number {
  const prev = Number.isFinite(trustPrev) ? clamp(trustPrev, 0, 100) : DEFAULT_SCOPED_TRUST;
  const score = unit(u.outcomeScore);
  const expected = unit(u.expectedAccuracy);
  const weight = unit(u.evidenceWeight);
  if (score === null || expected === null || weight === null) return prev;
  const lr = typeof u.learningRate === "number" && Number.isFinite(u.learningRate) ? u.learningRate : DEFAULT_LEARNING_RATE;
  return clamp(prev + lr * (score - expected) * weight, 0, 100);
}

// ── Table 23 signals ─────────────────────────────────────────────────────────

export const TRUST_SIGNALS = [
  "independent_confirmation",       // Positive, weighted by confirmer independence
  "outcome_success",                // Positive in relevant scope
  "honest_correction_before_harm",  // Small positive conduct effect; original error still measured
  "calibrated_uncertainty",         // Positive calibration effect
  "materially_incorrect_confident", // Negative accuracy and calibration effect
  "undisclosed_relationship",       // Strong conduct/commercial penalty
  "fabrication_or_manipulation",    // Severe enforcement; lineage invalidation
] as const;
export type TrustSignal = (typeof TRUST_SIGNALS)[number];

export interface TrustSignalEffect {
  /** Which of the §15 dimensions the signal moves. */
  accuracy: "positive" | "negative" | "none";
  calibration: "positive" | "negative" | "none";
  conduct: "positive" | "negative" | "none";
  /** Existing-engine bridge: trust_events delta (category guide_accuracy) and severity. */
  bridgeDelta: number;
  bridgeSeverity: "minor" | "moderate" | "serious" | "severe";
  /** Only the enforcement signal invalidates lineage (Table 23, last row). */
  invalidatesLineage: boolean;
}

/** Table 23, row by row. The producers of the last four are listed in the unit report as NOT wired. */
export const TRUST_SIGNAL_EFFECT: Record<TrustSignal, TrustSignalEffect> = {
  independent_confirmation:       { accuracy: "positive", calibration: "none",     conduct: "none",     bridgeDelta:  1, bridgeSeverity: "minor",    invalidatesLineage: false },
  outcome_success:                { accuracy: "positive", calibration: "positive", conduct: "none",     bridgeDelta:  1, bridgeSeverity: "minor",    invalidatesLineage: false },
  honest_correction_before_harm:  { accuracy: "none",     calibration: "none",     conduct: "positive", bridgeDelta:  1, bridgeSeverity: "minor",    invalidatesLineage: false },
  calibrated_uncertainty:         { accuracy: "none",     calibration: "positive", conduct: "none",     bridgeDelta:  0, bridgeSeverity: "minor",    invalidatesLineage: false },
  materially_incorrect_confident: { accuracy: "negative", calibration: "negative", conduct: "none",     bridgeDelta: -2, bridgeSeverity: "moderate", invalidatesLineage: false },
  undisclosed_relationship:       { accuracy: "none",     calibration: "none",     conduct: "negative", bridgeDelta: -8, bridgeSeverity: "serious",  invalidatesLineage: false },
  fabrication_or_manipulation:    { accuracy: "negative", calibration: "negative", conduct: "negative", bridgeDelta: -20, bridgeSeverity: "severe",  invalidatesLineage: true },
};

/** The confidence at or above which a wrong claim was "confident" (Table 15 'live' band). */
export const CONFIDENT_CLAIM_THRESHOLD = 0.75;

/**
 * Which Table-23 signal an attribution row carries — derived from the outcome
 * and the served confidence, nothing else.
 *   did_not_go        → no signal (the traveler never tested the claim)
 *   contradiction     → materially_incorrect_confident if the claim was confident,
 *                       else calibrated_uncertainty (it said it was unsure, and was)
 *   otherwise         → outcome_success
 */
export function signalForAttribution(a: {
  outcome: IntelOutcome; contradiction: boolean; expectedAccuracy: number | null;
}): TrustSignal | null {
  if (a.outcome === "did_not_go") return null;
  if (a.contradiction) {
    return typeof a.expectedAccuracy === "number" && a.expectedAccuracy >= CONFIDENT_CLAIM_THRESHOLD
      ? "materially_incorrect_confident"
      : "calibrated_uncertainty";
  }
  return "outcome_success";
}

// ── Badges (read-only derivation; no table) ──────────────────────────────────

export const SCOPED_BADGES = ["scoped_reliable", "scoped_calibrated", "scoped_specialist"] as const;
export type ScopedBadge = (typeof SCOPED_BADGES)[number];

export interface ScopedTrustRow {
  actor_id: string;
  scope_key: string;
  trust: number;
  outcomes: number;
  successes: number;
  contradictions: number;
  /** Running mean of |outcome_score − expected_accuracy| over graded outcomes. */
  calibration_error: number | null;
}

/** Minimum graded outcomes before any badge can be shown (no badge off one lucky outcome). */
export const BADGE_MIN_OUTCOMES = 10;
export const BADGE_RELIABLE_TRUST = 70;
export const BADGE_SPECIALIST_TRUST = 85;
export const BADGE_SPECIALIST_OUTCOMES = 25;
export const BADGE_CALIBRATED_MAX_ERROR = 0.2;

/** Public-facing scoped badges for one scope row. Never a number. */
export function deriveScopedBadges(row: Pick<ScopedTrustRow, "trust" | "outcomes" | "calibration_error">): ScopedBadge[] {
  const out: ScopedBadge[] = [];
  if (!Number.isFinite(row.trust) || row.outcomes < BADGE_MIN_OUTCOMES) return out;
  if (row.trust >= BADGE_RELIABLE_TRUST) out.push("scoped_reliable");
  if (typeof row.calibration_error === "number" && row.calibration_error <= BADGE_CALIBRATED_MAX_ERROR) out.push("scoped_calibrated");
  if (row.trust >= BADGE_SPECIALIST_TRUST && row.outcomes >= BADGE_SPECIALIST_OUTCOMES) out.push("scoped_specialist");
  return out;
}
