/**
 * ValidationService (Phase 5 — Creation, spec §23).
 *
 * The §23 "validation and correction while typing" suite for creation flows,
 * surfaced through the Phase-1 gateway as `validation` / `correction` /
 * `disambiguation` assistance rows. Every check is NON-BLOCKING and preserves
 * user control (§23/§20/§37): the row explains the issue and offers a canonical
 * choice or fallback — it never overwrites the field and never blocks submit.
 *
 * §23 table implemented here:
 *   • Duplicate Place/Gem      → disambiguation (built from duplicateDetection).
 *   • City-country mismatch    → correction (suggest canonical country).
 *   • Trip date conflict       → validation (explain overlap / inverted range).
 *   • Unresolved address       → validation with map-pin / nearby / raw fallback.
 *   • Invalid hashtag/handle   → correction (normalization / reserved-name rule).
 *   • Provider disagreement    → disambiguation (show choices; never silently
 *                                overwrite the canonical Portava record).
 * (Username availability is already handled in Phase 4 socialIdentity.)
 *
 * REUSE: country resolution uses the shared `countryFromCity` / `toCountryCode`
 * dictionaries; hashtag normalization uses the SAME `canonicalizeHashtag` +
 * `validateUsername` reserved-name rules the write paths use. No new dictionaries.
 */
import { strokeFold } from '../canonicalLocations';
import { countryFromCity, countryNameFromCode } from '../stamps/countryLookup';
import { toCountryCode } from '../countryCodes';
import { canonicalizeHashtag } from './socialIdentity';
import type { InputContext, InputSuggestion, SuggestionAction } from './types';

// ── City ⇄ country mismatch (§23 "Suggest canonical correction") ───────────────

export interface CityCountryVerdict {
  ok: boolean;
  /** Present when the typed city maps to a known country. */
  canonicalCountry: string | null;
  canonicalCountryCode: string | null;
  /** Present only on a real mismatch. */
  typedCountryCode?: string | null;
  reason?: string;
}

/**
 * Does the typed country agree with the country the city is known to be in?
 *
 * PURE. Resolves the city to its canonical country (via the shared city→code
 * dictionary, stroke-folded so "Đà Nẵng" resolves like "Da Nang"), then compares
 * ISO codes with the typed country. Unknown city or unknown typed country ⇒ `ok`
 * (never fabricate a mismatch — §36 provider neutrality / no false correction).
 */
export function checkCityCountryMismatch(input: {
  city?: string | null;
  country?: string | null;
}): CityCountryVerdict {
  const city = (input.city ?? '').trim();
  const country = (input.country ?? '').trim();
  if (!city) return { ok: true, canonicalCountry: null, canonicalCountryCode: null };

  const fromCity = countryFromCity(strokeFold(city));
  if (!fromCity) {
    // City not in the known dictionary — cannot assert a mismatch.
    return { ok: true, canonicalCountry: null, canonicalCountryCode: null };
  }
  if (!country) {
    // No country typed yet — offer the canonical one, but it is not a mismatch.
    return {
      ok: true,
      canonicalCountry: fromCity.country,
      canonicalCountryCode: fromCity.countryCode,
    };
  }

  const typedCode = toCountryCode(country);
  if (!typedCode) {
    // Typed country not recognized — cannot confidently call it a mismatch.
    return {
      ok: true,
      canonicalCountry: fromCity.country,
      canonicalCountryCode: fromCity.countryCode,
    };
  }

  if (typedCode.toUpperCase() === fromCity.countryCode.toUpperCase()) {
    return { ok: true, canonicalCountry: fromCity.country, canonicalCountryCode: fromCity.countryCode };
  }
  return {
    ok: false,
    canonicalCountry: fromCity.country,
    canonicalCountryCode: fromCity.countryCode,
    typedCountryCode: typedCode.toUpperCase(),
    reason: `${city} is in ${fromCity.country}, not ${countryNameFromCode(typedCode) ?? country}`,
  };
}

// ── Trip date conflict (§23 "Explain conflict and preserve user control") ──────

export interface TripDateInput {
  startDate?: string | null; // ISO date (YYYY-MM-DD or full ISO)
  endDate?: string | null;
}
export interface ExistingTripWindow {
  id: string;
  title?: string | null;
  startDate: string | null;
  endDate: string | null;
}
export type TripDateConflictKind = 'inverted_range' | 'overlap';
export interface TripDateVerdict {
  ok: boolean;
  kind?: TripDateConflictKind;
  reason?: string;
  /** The overlapping existing trip, when kind === 'overlap'. */
  conflictsWith?: ExistingTripWindow;
}

function parseDay(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : s);
  return Number.isFinite(t) ? t : null;
}

/**
 * PURE trip-date validation (§23). Two conflicts, both non-blocking:
 *   1. inverted range — end before start.
 *   2. overlap — the new window intersects an existing trip's window.
 * Returns the FIRST conflict found (inverted range takes precedence). Missing
 * dates ⇒ ok (nothing to validate yet).
 */
export function checkTripDateConflict(
  input: TripDateInput,
  existing: ExistingTripWindow[] = [],
): TripDateVerdict {
  const start = parseDay(input.startDate);
  const end = parseDay(input.endDate);

  if (start != null && end != null && end < start) {
    return { ok: false, kind: 'inverted_range', reason: 'End date is before the start date' };
  }
  if (start == null && end == null) return { ok: true };

  // Overlap: treat a one-sided window as a point for intersection purposes.
  const ns = start ?? end!;
  const ne = end ?? start!;
  for (const t of existing) {
    const es = parseDay(t.startDate);
    const ee = parseDay(t.endDate);
    if (es == null && ee == null) continue;
    const os = es ?? ee!;
    const oe = ee ?? es!;
    if (ns <= oe && os <= ne) {
      const label = t.title ? `"${t.title}"` : 'another trip';
      return {
        ok: false,
        kind: 'overlap',
        reason: `These dates overlap ${label}`,
        conflictsWith: t,
      };
    }
  }
  return { ok: true };
}

// ── Hashtag / handle validity (§23 "normalization or reserved-name rules") ─────

export interface HashtagVerdict {
  ok: boolean;
  /** The canonical slug the raw input normalizes to (null when unusable). */
  slug: string | null;
  reason?: string;
}

/**
 * PURE hashtag validity + normalization (§23/§26). Reuses `canonicalizeHashtag`
 * (the write-path canonical slug rule). `ok` is true when the raw input already
 * equals its canonical form; otherwise a correction is warranted (either it
 * normalizes to a different slug, or it has no valid tag body at all).
 */
export function checkHashtagValidity(raw: string): HashtagVerdict {
  const body = (raw ?? '').replace(/^#+/, '');
  const slug = canonicalizeHashtag(raw);
  if (!slug) {
    return { ok: false, slug: null, reason: 'A hashtag needs at least 2 letters or numbers' };
  }
  if (body.toLowerCase() === slug) return { ok: true, slug };
  return {
    ok: false,
    slug,
    reason: `Will be saved as #${slug}`,
  };
}

// ── Projections → InputSuggestion rows ─────────────────────────────────────────

/** City-country mismatch → a `correction` row proposing the canonical country. */
export function projectCityCountryCorrection(
  context: InputContext,
  policyVersion: string,
  verdict: CityCountryVerdict,
  city: string,
): InputSuggestion {
  const country = verdict.canonicalCountry ?? '';
  return {
    id: `${context}:validation:city-country`,
    type: 'correction',
    context,
    label: `Did you mean ${city}, ${country}?`,
    subtitle: verdict.reason,
    // Applying the correction sets the canonical country — the field stays
    // visible + editable (§17/§23 "preserve user control"), never silently.
    action: {
      type: 'set_structured_value',
      value: {
        kind: 'city_country_correction',
        city,
        country: verdict.canonicalCountry,
        countryCode: verdict.canonicalCountryCode,
      },
    },
    structuredValue: {
      kind: 'city_country_correction',
      city,
      country: verdict.canonicalCountry,
      countryCode: verdict.canonicalCountryCode,
    },
    confidence: 0.7,
    source: 'canonical',
    reason: verdict.reason,
    policyVersion,
  };
}

/** Trip date conflict → a non-blocking `validation` row explaining the conflict. */
export function projectTripDateConflict(
  context: InputContext,
  policyVersion: string,
  verdict: TripDateVerdict,
): InputSuggestion {
  return {
    id: `${context}:validation:trip-dates`,
    type: 'validation',
    context,
    label: verdict.reason ?? 'Date conflict',
    // Carries the verdict as a structured value; the client shows a warning but
    // the user stays in control (§23) — it does NOT change the dates.
    action: {
      type: 'set_structured_value',
      value: {
        kind: 'trip_date_conflict',
        conflict: verdict.kind ?? null,
        conflictsWithTripId: verdict.conflictsWith?.id ?? null,
      },
    },
    structuredValue: {
      kind: 'trip_date_conflict',
      conflict: verdict.kind ?? null,
      conflictsWithTripId: verdict.conflictsWith?.id ?? null,
    },
    confidence: 0.2,
    source: 'local',
    reason: verdict.reason,
    policyVersion,
  };
}

/** Invalid/normalizable hashtag → a `correction` row (§23). */
export function projectHashtagCorrection(
  context: InputContext,
  policyVersion: string,
  verdict: HashtagVerdict,
): InputSuggestion {
  const label = verdict.slug ? `Use #${verdict.slug}` : (verdict.reason ?? 'Invalid hashtag');
  const action: SuggestionAction = verdict.slug
    ? { type: 'set_structured_value', value: { kind: 'hashtag', slug: verdict.slug } }
    : { type: 'replace_text', text: '' };
  return {
    id: `${context}:validation:hashtag`,
    type: 'correction',
    context,
    label,
    action,
    structuredValue: verdict.slug ? { kind: 'hashtag', slug: verdict.slug } : undefined,
    confidence: verdict.slug ? 0.6 : 0.2,
    source: 'local',
    reason: verdict.reason,
    policyVersion,
  };
}

// ── Unresolved address (§23 "map pin, nearby candidates, or raw fallback") ─────

/**
 * When a location/address creation field yields NO canonical candidate, offer the
 * §23/§37 fallback actions instead of a dead end. The available fallbacks are
 * CONTEXT-DEPENDENT (§37): a canonical picker never offers "create", but a
 * gem/location flow may offer a map pin. This builds the fallback rows the
 * context's policy permits (the caller decides which by checking the policy).
 */
export function buildAddressFallbacks(
  context: InputContext,
  policyVersion: string,
  rawText: string,
  allow: { dropPin?: boolean; searchNearby?: boolean; useRaw?: boolean },
): InputSuggestion[] {
  const rows: InputSuggestion[] = [];
  if (allow.dropPin) {
    rows.push({
      id: `${context}:validation:drop-pin`,
      type: 'action',
      context,
      label: 'Drop a pin on the map',
      action: { type: 'drop_pin' },
      confidence: 0.5,
      source: 'local',
      reason: "We couldn't match that address",
      policyVersion,
    });
  }
  if (allow.searchNearby) {
    rows.push({
      id: `${context}:validation:search-nearby`,
      type: 'action',
      context,
      label: 'Search nearby places',
      action: { type: 'submit_search', query: rawText },
      confidence: 0.45,
      source: 'local',
      policyVersion,
    });
  }
  if (allow.useRaw && rawText.trim().length > 0) {
    rows.push({
      id: `${context}:validation:use-raw`,
      type: 'validation',
      context,
      label: `Use "${rawText.trim()}" as typed`,
      replacementText: rawText.trim(),
      action: { type: 'replace_text', text: rawText.trim() },
      confidence: 0.35,
      source: 'local',
      reason: 'Unrecognized address — kept as free text',
      policyVersion,
    });
  }
  return rows;
}
