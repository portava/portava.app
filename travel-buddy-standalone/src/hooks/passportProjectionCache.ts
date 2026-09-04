/**
 * passportProjectionCache — the §31 client cache policy for the Passport
 * aggregate, as pure functions plus a small in-memory store.
 *
 * §31 splits the projection into two freshness tiers:
 *   • STATIC  — identity, travel stats, stamps, permitted journey/plan/memory
 *     previews, travel-identity flag, interests. Safe to show for a long time.
 *   • VOLATILE — current traveler state, availability, Open-to-Plans, trust
 *     projection, shared context and viewer capabilities. "Never render stale
 *     Availability as current" — so once a cached projection is past the SHORT
 *     TTL these fields are BLANKED (capabilities fail closed) even while the
 *     static half is still shown, and a revalidation fetch replaces them.
 *
 * A projection past the LONG TTL is treated as a cache miss (nothing served).
 * `now` is a parameter everywhere so tests need no real clock.
 */
import type { PassportProjectionView } from '../services/passportProjection.ts';
import { DENIED_VIEWER_ACTIONS } from '../services/passportProjection.ts';

/** Long TTL for the static identity half (24h). */
export const STATIC_TTL_MS = 24 * 60 * 60 * 1000;
/** Short TTL for availability / state / trust / capabilities (60s). */
export const VOLATILE_TTL_MS = 60 * 1000;

export interface CachedProjection {
  data: PassportProjectionView;
  /** Epoch ms the projection was fetched from the server. */
  fetchedAt: number;
}

/**
 * Blank every VOLATILE field so a stale projection can never present old
 * availability / state / trust as current, and can never offer a capability
 * the server may since have revoked (fail closed). The STATIC half is kept.
 */
export function scrubVolatile(data: PassportProjectionView): PassportProjectionView {
  return {
    ...data,
    travelerState: null,
    availability: null,
    trust: null,
    sharedContext: null,
    actions: { ...DENIED_VIEWER_ACTIONS },
  };
}

export interface ResolvedCache {
  data: PassportProjectionView;
  /** True when the whole projection (including volatile fields) is fresh. */
  fresh: boolean;
}

/**
 * What a cache entry may render right now, or null when it is too old to use.
 *   age < VOLATILE_TTL          → full data, fresh
 *   VOLATILE_TTL ≤ age < STATIC → static half only (volatile blanked), stale
 *   age ≥ STATIC_TTL            → null (cache miss)
 */
export function resolveCached(entry: CachedProjection | null | undefined, nowMs: number): ResolvedCache | null {
  if (!entry) return null;
  const age = nowMs - entry.fetchedAt;
  if (!Number.isFinite(age) || age < 0) {
    // A clock skew / bad timestamp: treat as fresh-enough static, blank volatile.
    return { data: scrubVolatile(entry.data), fresh: false };
  }
  if (age >= STATIC_TTL_MS) return null;
  if (age >= VOLATILE_TTL_MS) return { data: scrubVolatile(entry.data), fresh: false };
  return { data: entry.data, fresh: true };
}

// ── In-memory store (survives remounts within a session; cleared on reload) ──

const memory = new Map<string, CachedProjection>();

export function readMemoryCache(userId: string): CachedProjection | null {
  return memory.get(userId) ?? null;
}

export function writeMemoryCache(userId: string, data: PassportProjectionView, fetchedAt: number): void {
  memory.set(userId, { data, fetchedAt });
}

/** Test seam: drop everything the in-memory store holds. */
export function __clearMemoryCache(): void {
  memory.clear();
}

export function projectionStorageKey(userId: string): string {
  return `passport:projection:${userId}`;
}
