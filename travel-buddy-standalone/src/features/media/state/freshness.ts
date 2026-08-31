/**
 * features/media — freshness + confidence copy (spec §10/§13/§17/§39/§46).
 *
 * The client NEVER presents cached/observed data as live. It shows a
 * freshness class and a "last updated" label. Forecast/predicted states carry
 * distinct copy (§17). No fake-live treatment (§46).
 *
 * Pure, framework-free — no react-native imports.
 */
import type {
  ConfidenceState,
  FreshnessClass,
  ObservationClass,
} from '../types/media.ts';

/** Short label for a freshness class (§10). */
export function freshnessClassLabel(f: FreshnessClass): string {
  switch (f) {
    case 'live':
      return 'Just now';
    case 'fresh':
      return 'Fresh';
    case 'recent':
      return 'Recent';
    case 'historical':
      return 'Earlier';
  }
}

/**
 * Relative "updated Nm ago" label from an age in minutes.
 *
 * Returns null for a null/negative age so the caller can omit the label
 * entirely rather than render a misleading "0m ago". This is the source of the
 * "Updated 2m ago" copy in §13.
 */
export function relativeAgeLabel(ageMinutes: number | null | undefined): string | null {
  if (ageMinutes == null || !Number.isFinite(ageMinutes) || ageMinutes < 0) return null;
  const m = Math.floor(ageMinutes);
  if (m < 1) return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Derive a freshness class from an age in minutes when the server did not send
 * one. Thresholds are deliberately conservative so nothing stale ever reads as
 * "live":  <10m live · <60m fresh · <24h recent · else historical.
 */
export function freshnessFromAge(ageMinutes: number | null | undefined): FreshnessClass {
  if (ageMinutes == null || !Number.isFinite(ageMinutes) || ageMinutes < 0) return 'historical';
  if (ageMinutes < 10) return 'live';
  if (ageMinutes < 60) return 'fresh';
  if (ageMinutes < 60 * 24) return 'recent';
  return 'historical';
}

/** "Strong current picture" style copy from a confidence state (§13). */
export function currentPictureLabel(strength: ConfidenceState): string {
  switch (strength) {
    case 'strong':
      return 'Strong current picture';
    case 'moderate':
      return 'Forming current picture';
    case 'low':
      return 'Limited current picture';
  }
}

/**
 * Whether the given observation class represents directly-observed evidence vs
 * a derived/forecast/generated state. Drives the distinct visual treatment
 * required by §2/§46 (observed vs inferred vs predicted).
 */
export function isObservedEvidence(cls: ObservationClass): boolean {
  return cls === 'observed';
}

/** Short human label for an observation class, for the intelligence strip (§46). */
export function observationClassLabel(cls: ObservationClass): string {
  switch (cls) {
    case 'observed':
      return 'Observed';
    case 'inferred':
      return 'Inferred';
    case 'user_claimed':
      return 'Reported';
    case 'generated':
      return 'Illustrative';
    case 'predicted':
      return 'Likely';
  }
}

/**
 * A cached-content banner string (§39): cached intelligence must show its
 * last-updated time and must never be presented as live. Returns null when
 * there is no known age (caller shows a generic "cached" note instead).
 */
export function cachedAsOfLabel(ageMinutes: number | null | undefined): string | null {
  const rel = relativeAgeLabel(ageMinutes);
  return rel ? `Cached · updated ${rel}` : null;
}
