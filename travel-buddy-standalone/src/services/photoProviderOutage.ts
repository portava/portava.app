/**
 * photoProviderOutage — tells "this place has no photo" apart from
 * "we could not look".
 *
 * WHY THIS FILE EXISTS
 * ====================
 * On 2026-08-15 Discovery served ZERO real photos for OSM-only destinations.
 * Both providers were dead at once, and confirmed by direct call:
 *
 *   Google Places API (New)  403 PERMISSION_DENIED / SERVICE_DISABLED
 *                            — never enabled on GCP project 1019840900693
 *   Foursquare               429 "account has no API credits remaining"
 *
 * Neither is a fact about any place. Both are the provider being switched off.
 *
 * The api-server already knew this: `/api/places/photo` and
 * `/api/places/fsq-photo` return a machine-readable `reason` on every failure
 * path, precisely so a caller can tell these apart. **The client threw it
 * away** — `lookupFsqPhoto` and `lookupGooglePhoto` read only `photoUrl`, and
 * `useFsqPhoto` ended in a bare `.catch(() => {})`. The card then rendered
 * category artwork, which is the SAME thing it renders for a place that
 * genuinely has no photo.
 *
 * So a total provider outage and a photoless café were pixel-identical, and
 * the system reported neither. That is the governing invariant of this
 * workstream — ABSENCE OF EVIDENCE MUST NEVER SILENTLY BECOME EVIDENCE OF
 * ABSENCE — and specifically its second face, swallowed failures are
 * first-class defects: the failure was caught, discarded, and dressed as a
 * successful fallback.
 *
 * WHY NOBODY SAW IT, WHICH IS THE SHARPEST PART
 * =============================================
 * Every prior verification used DB-backed cities. Those carry a pre-seeded
 * `headerImageUrl`, and `useFsqPhoto` returns it immediately without firing a
 * request (`if (existingUrl) return;`). The live provider chain was therefore
 * never exercised — not "tested and passing", never run. The OSM-only path,
 * which is the path most of the world takes, was the only one that called the
 * providers, and it was the one nobody looked at.
 *
 * A seeded fixture that bypasses the code under test is a check that examines
 * nothing. See `useFsqPhoto.nonSeededCity.component.test.tsx`, which pins a
 * NON-SEEDED place specifically so this cannot regress into invisibility again.
 *
 * WHAT THIS MODULE DOES AND DOES NOT DO
 * =====================================
 * It does NOT retry, repair, or work around an outage — neither cause is
 * fixable from this repository. Enabling Places API (New) and restoring
 * Foursquare credits are account actions, and code that pretended otherwise
 * would be the same lie in a new place.
 *
 * It makes the failure OBSERVABLE: classified, counted, and logged once per
 * distinct (provider, reason) so a dead provider announces itself instead of
 * being absorbed into artwork.
 */

/** Which upstream produced a reason string. */
export type PhotoProvider = 'foursquare' | 'google';

/**
 * What a `reason` from the api-server actually means.
 *
 * - `outage`  — we could not look. Says NOTHING about the place. Includes
 *               quota, billing, disabled APIs, auth and transport failures.
 * - `absent`  — we looked and this place genuinely has no photo.
 * - `unknown` — a reason this build does not recognise. Reported separately
 *               rather than folded into either, because guessing which one it
 *               is would reintroduce exactly the conflation this file removes.
 */
export type PhotoReasonKind = 'outage' | 'absent' | 'unknown';

/**
 * The only reason meaning "we looked and there is genuinely no photo".
 * Everything else that is recognised is an outage.
 */
const ABSENT_REASONS: ReadonlySet<string> = new Set([
  'no_photo_found',
  // The proxy found a photo reference whose CDN file is gone (HEAD != ok).
  // That is a fact about THIS place's photo, not about the provider being
  // reachable — the lookup itself succeeded. It belongs with absence, not
  // with outage, and it must not raise a false provider alarm.
  'dead_photo_link',
]);

/**
 * Reasons that mean the lookup never happened. Kept as exact strings the
 * server actually emits — see `routes/places.ts`. `foursquare_http_*` and
 * `google_places_api_new_*` are matched by prefix below since they carry a
 * variable status/reason suffix.
 */
const OUTAGE_REASONS: ReadonlySet<string> = new Set([
  'no_google_maps_key',
  'no_foursquare_key',
  'foursquare_auth_error',
  'foursquare_quota_exhausted',
  'request_failed',
  'proxy_unreachable',
  'proxy_http_error',
]);

const OUTAGE_PREFIXES = ['foursquare_http_', 'google_places_api_new_'] as const;

/** Classify a server `reason`. A missing reason is not a failure at all. */
export function classifyPhotoReason(reason: string | null | undefined): PhotoReasonKind {
  if (!reason) return 'unknown';
  if (ABSENT_REASONS.has(reason)) return 'absent';
  if (OUTAGE_REASONS.has(reason)) return 'outage';
  if (OUTAGE_PREFIXES.some((p) => reason.startsWith(p))) return 'outage';
  return 'unknown';
}

export interface PhotoOutageRecord {
  provider: PhotoProvider;
  reason: string;
  kind: PhotoReasonKind;
  /** How many lookups have hit this exact (provider, reason). */
  count: number;
  firstSeen: number;
  lastSeen: number;
}

const outages = new Map<string, PhotoOutageRecord>();

/** Stable key for one (provider, reason) pair. */
const outageKey = (provider: PhotoProvider, reason: string) => `${provider}|${reason}`;

/**
 * Emit the loud line. Once per distinct (provider, reason) per session — a
 * dead provider fires on every card on screen, and a per-card log is noise
 * that gets muted, which is how a signal becomes silence again.
 */
function announce(rec: PhotoOutageRecord): void {
  const detail =
    rec.kind === 'outage'
      ? 'PROVIDER UNAVAILABLE — this says nothing about the place. No photo will load for ANY place until it is resolved, and the card falls back to category artwork, which looks identical to a place that has no photo.'
      : 'unrecognised reason — this build does not know whether it means "no photo" or "could not look". Classify it in photoProviderOutage.ts before drawing any conclusion from the artwork.';

  // console.warn rather than a silent counter: this must reach anyone looking
  // at a device log or a browser console without opting in first.
  console.warn(`[photo-provider] ${rec.provider}: ${rec.reason} — ${detail}`);
}

/**
 * Record the outcome of one photo lookup.
 *
 * Call on EVERY non-URL outcome, including ones that look boring. Passing a
 * null/absent reason is a no-op, so callers do not need to pre-filter.
 */
export function reportPhotoLookupResult(
  provider: PhotoProvider,
  reason: string | null | undefined,
): PhotoReasonKind {
  const kind = classifyPhotoReason(reason);
  if (!reason || kind === 'absent') return kind;

  const key = outageKey(provider, reason);
  const now = Date.now();
  const existing = outages.get(key);

  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
    return kind;
  }

  const rec: PhotoOutageRecord = { provider, reason, kind, count: 1, firstSeen: now, lastSeen: now };
  outages.set(key, rec);
  announce(rec);
  return kind;
}

/** Every distinct outage seen this session, for diagnostics and tests. */
export function getPhotoOutages(): PhotoOutageRecord[] {
  return [...outages.values()];
}

/**
 * True when at least one provider is known to be unavailable this session.
 * A surface may use this to say "photos are unavailable right now" instead of
 * implying these places have none — but it must not be used to claim the
 * opposite, since no outage seen is not the same as providers proven healthy.
 */
export function hasPhotoProviderOutage(): boolean {
  return [...outages.values()].some((r) => r.kind === 'outage');
}

/** Test seam. */
export function resetPhotoOutages(): void {
  outages.clear();
}
