/**
 * Trips spec §10.1 / §10.2 — the presence row's `freshness`, `source` and
 * `confidence`, PURE.
 *
 * §10.1: "Every presence row carries observed_at, expires_at, source,
 * confidence, and visibility." §10.2: "LIVE | RECENT | LAST_KNOWN | OFFLINE.
 * The Trip Map must never draw a stale location as if it were current."
 *
 * WHAT EXISTED
 * ============
 * census-trips TR159-TR166: the crew card carried `updatedAt` raw (TR159),
 * `expiresAt` (TR160, C) and `visibility` (TR163, C); no `source` (TR161),
 * no `confidence` (TR162), no freshness CLASS (TR164 — `freshnessBucket`
 * answers live/recent/null and the card turned null into "stale"); and
 * `stale_presence_render_attempt_total` (TR399) did not exist. The columns
 * to answer two of those were already on `user_location_state`: `source`
 * (written by routes/location.ts from the client's report) and
 * `accuracy_meters`; nothing forwarded them.
 *
 * TWO CLOCKS, KEPT APART
 * ======================
 * `user_location_state.updated_at` moves on ANY patch — a permission status,
 * a hand-picked city — while `last_known_at` moves only with a position. A
 * freshness judged on `updated_at` can call a week-old coordinate LIVE
 * because the user changed their manual city this morning. So the position's
 * freshness is judged on `last_known_at` when present, and the card says
 * which clock it used.
 *
 * THE CLASSES
 * ===========
 *   LIVE        observed within FRESH_LIVE_MS (15 min, the Map's own bound)
 *   RECENT      within FRESH_MAX_MS (60 min)
 *   LAST_KNOWN  older than that — "may remain useful but is not live truth"
 *   OFFLINE     no observation at all, or the observation is past its expiry
 *
 * CONFIDENCE is the reported accuracy, banded: ≤ 50 m HIGH, ≤ 200 m MEDIUM,
 * larger LOW, unknown INSUFFICIENT. It is the DEVICE's claim about the fix;
 * it says nothing about whether the person is still there — that is
 * freshness, and the two are carried separately for that reason.
 */

export const PRESENCE_FRESHNESS_CLASSES = ["LIVE", "RECENT", "LAST_KNOWN", "OFFLINE"] as const;
export type PresenceFreshnessClass = (typeof PRESENCE_FRESHNESS_CLASSES)[number];

export const PRESENCE_CONFIDENCES = ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"] as const;
export type PresenceConfidence = (typeof PRESENCE_CONFIDENCES)[number];

/** The Map's bounds (lib/mapTravelers.ts), restated so the two surfaces agree on "live". */
export const PRESENCE_LIVE_MS = 15 * 60 * 1000;
export const PRESENCE_RECENT_MS = 60 * 60 * 1000;

export interface PresenceObservation {
  /** The position's own clock (`last_known_at`); null when the row has never carried a position. */
  lastKnownAt: string | null;
  /** The row's clock (`updated_at`), used only when the position has none. */
  updatedAt: string | null;
  /** When the observation stops being valid (a live-share expiry, a session end); null = no expiry. */
  expiresAt: string | null;
  /** `user_location_state.source`, the client's own word for how it got the fix. */
  source: string | null;
  accuracyMeters: number | null;
}

export interface PresenceFreshness {
  freshnessClass: PresenceFreshnessClass;
  /** ISO instant the classification is about, or null for OFFLINE-with-no-observation. */
  observedAt: string | null;
  /** Which clock `observedAt` came from. */
  observedAtSource: "last_known_at" | "updated_at" | null;
  ageSeconds: number | null;
  source: string | null;
  confidence: PresenceConfidence;
  /** True when a consumer may draw this as CURRENT. Only LIVE and RECENT. */
  drawableAsCurrent: boolean;
}

export function presenceConfidence(accuracyMeters: number | null | undefined): PresenceConfidence {
  if (typeof accuracyMeters !== "number" || !Number.isFinite(accuracyMeters) || accuracyMeters < 0) return "INSUFFICIENT";
  if (accuracyMeters <= 50) return "HIGH";
  if (accuracyMeters <= 200) return "MEDIUM";
  return "LOW";
}

export function classifyPresence(o: PresenceObservation, now: number = Date.now()): PresenceFreshness {
  const observedAt = o.lastKnownAt ?? o.updatedAt ?? null;
  const observedAtSource = o.lastKnownAt ? "last_known_at" : o.updatedAt ? "updated_at" : null;
  const confidence = presenceConfidence(o.accuracyMeters);
  const base = { observedAt, observedAtSource, source: o.source ?? null, confidence } as const;

  const t = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (!Number.isFinite(t)) return { ...base, freshnessClass: "OFFLINE", ageSeconds: null, drawableAsCurrent: false };
  const age = Math.max(0, (now - t) / 1000);
  const exp = o.expiresAt ? Date.parse(o.expiresAt) : Number.NaN;
  if (Number.isFinite(exp) && exp <= now) return { ...base, freshnessClass: "OFFLINE", ageSeconds: age, drawableAsCurrent: false };
  if (age * 1000 <= PRESENCE_LIVE_MS) return { ...base, freshnessClass: "LIVE", ageSeconds: age, drawableAsCurrent: true };
  if (age * 1000 <= PRESENCE_RECENT_MS) return { ...base, freshnessClass: "RECENT", ageSeconds: age, drawableAsCurrent: true };
  return { ...base, freshnessClass: "LAST_KNOWN", ageSeconds: age, drawableAsCurrent: false };
}
