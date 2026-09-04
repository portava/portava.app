/**
 * passportProjectionCache — the §31 tiered-TTL policy, as pure logic.
 *
 *   • age < VOLATILE_TTL  → full projection served, marked fresh.
 *   • VOLATILE ≤ age < STATIC → static half served, VOLATILE fields blanked
 *     (availability/state/trust/shared context null; capabilities fail closed),
 *     marked stale — "never render stale availability as current" (§31).
 *   • age ≥ STATIC_TTL  → cache miss (null).
 *   • bad/skewed timestamp → static half only, never trusted as fresh.
 */
import {
  STATIC_TTL_MS,
  VOLATILE_TTL_MS,
  resolveCached,
  scrubVolatile,
  type CachedProjection,
} from '../passportProjectionCache.ts';
import type { PassportProjectionView } from '../../services/passportProjection.ts';

function view(): PassportProjectionView {
  return {
    userId: 'u1',
    identity: { userId: 'u1', name: 'A', handle: 'a', avatarUrl: null, verified: true, verificationLevel: 'id', homeCountry: 'VN' },
    viewerContext: 'follower',
    travelerState: { state: 'open_to_plans', label: 'Open to Plans', city: 'Da Nang', validFrom: null, expiresAt: null },
    availability: { openToPlans: true, socialAvailability: 'open', currentWindow: null, expiresAt: null },
    trust: { label: 'Strong', publicLevel: 'strong', score: 87, confidence: 'high' },
    hasTravelIdentity: true,
    stats: { countries: 17, cities: 42, stamps: 63, trips: 8 },
    recentStamps: [],
    featuredJourney: null,
    upcomingPlans: [],
    memories: [],
    sharedContext: { facts: [], summary: 'x', handoffEligible: true } as PassportProjectionView['sharedContext'],
    actions: { can_follow: true, can_message: true, can_make_plan: true, can_invite_trip: true, can_view_availability: true, can_view_trust: true },
    interests: ['Nightlife'],
    restricted: false,
  };
}

function entry(fetchedAt: number): CachedProjection {
  return { data: view(), fetchedAt };
}

describe('scrubVolatile', () => {
  it('blanks every volatile field and denies every capability, keeping the static half', () => {
    const s = scrubVolatile(view());
    expect(s.travelerState).toBeNull();
    expect(s.availability).toBeNull();
    expect(s.trust).toBeNull();
    expect(s.sharedContext).toBeNull();
    expect(s.actions).toEqual({
      can_follow: false, can_message: false, can_make_plan: false,
      can_invite_trip: false, can_view_availability: false, can_view_trust: false,
    });
    // Static half intact.
    expect(s.identity.handle).toBe('a');
    expect(s.stats.stamps).toBe(63);
    expect(s.interests).toEqual(['Nightlife']);
    expect(s.hasTravelIdentity).toBe(true);
  });
});

describe('resolveCached tiers', () => {
  const now = 1_000_000_000_000;

  it('serves the full projection while inside the short TTL (fresh)', () => {
    const r = resolveCached(entry(now - (VOLATILE_TTL_MS - 1)), now)!;
    expect(r.fresh).toBe(true);
    expect(r.data.availability).not.toBeNull();
    expect(r.data.actions.can_follow).toBe(true);
  });

  it('blanks volatile fields past the short TTL but keeps static (stale)', () => {
    const r = resolveCached(entry(now - (VOLATILE_TTL_MS + 1)), now)!;
    expect(r.fresh).toBe(false);
    expect(r.data.travelerState).toBeNull();
    expect(r.data.availability).toBeNull();
    expect(r.data.trust).toBeNull();
    expect(r.data.actions.can_message).toBe(false);
    expect(r.data.stats.stamps).toBe(63);
  });

  it('is a cache miss once past the long TTL', () => {
    expect(resolveCached(entry(now - (STATIC_TTL_MS + 1)), now)).toBeNull();
  });

  it('null entry is a miss', () => {
    expect(resolveCached(null, now)).toBeNull();
  });

  it('a future/skewed timestamp is never trusted as fresh — volatile blanked', () => {
    const r = resolveCached(entry(now + 5_000), now)!;
    expect(r.fresh).toBe(false);
    expect(r.data.availability).toBeNull();
  });
});
