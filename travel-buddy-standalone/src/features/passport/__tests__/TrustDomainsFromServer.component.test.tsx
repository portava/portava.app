/**
 * census-passport P45 — "Trust must be domain-specific, confidence-aware and
 * EXPLAINABLE".
 *
 * The server has owned per-domain trust since TABLE 12: `trust.domains` carries,
 * for each of the six domains, the non-stigmatizing PRESENTATION word the server
 * computed from the canonical category scores, an `applicable` flag, and — added
 * for P45/P50 — a `basis` saying whether that word was MEASURED, PARTIAL,
 * SUBSTITUTED (the neutral-50 default stood in), NOT_APPLICABLE, or UNAVAILABLE
 * (trust_profiles could not be read at all).
 *
 * The client threw all of it away. `deriveTrustView` rebuilt six rows from
 * capability flags and printed the constant string "In good standing" on every
 * in-scope domain — so:
 *
 *   • a domain the server measured as "Building" or "New" was shown to the user
 *     as "In good standing". The client did not merely duplicate the server's
 *     work, it OVERRODE a measured verdict with a flattering constant;
 *   • `applicable` answered a different question from the server's (the client
 *     asked "canBecomeBuddy", the server asks "does this person actually offer a
 *     buddy service");
 *   • `basis` never reached a human at all, so the one field built to make the
 *     substituted card distinguishable from the measured one was invisible.
 *
 * That last point IS the "explainable" clause. These tests assert the OUTCOME —
 * what a person reading the Trust screen can tell — not the shape of a fixture.
 *
 * The fallback block matters as much as the rest: an older server that sends no
 * `trust.domains` must still get six rows, so this fix cannot blank the surface
 * against a deployment that has not caught up.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import TrustScreen from '../TrustScreen.tsx';
import { deriveTrustView, type TrustProjectionEnvelope } from '../useTrustProjection.ts';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me', isAuthed: true }),
}));

jest.mock('../../../services/apiToken', () => ({
  freshToken: jest.fn(async () => null),
}));

jest.mock('../useTrustProjection', () => {
  const actual = jest.requireActual('../useTrustProjection');
  return {
    ...actual,
    useTrustProjection: () => ({
      projection: null,
      loading: false,
      error: null,
      reload: jest.fn(),
    }),
  };
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** The six domains exactly as `buildDomainTrust` emits them (TABLE 12). */
const SERVER_DOMAINS = [
  { key: 'overall', domain: 'Overall', presentation: 'Strong', applicable: true, basis: 'measured' as const },
  { key: 'traveler', domain: 'Traveler', presentation: 'Building', applicable: true, basis: 'partial' as const },
  { key: 'trip_guest', domain: 'Trip Guest', presentation: 'Established', applicable: true, basis: 'substituted' as const },
  { key: 'trip_host', domain: 'Trip Host', presentation: 'New', applicable: true, basis: 'substituted' as const },
  { key: 'contributor', domain: 'Contributor', presentation: 'Excellent', applicable: true, basis: 'measured' as const },
  { key: 'buddy', domain: 'Buddy', presentation: 'Not applicable', applicable: false, basis: 'not_applicable' as const },
];

function makeProjection(
  overrides: Partial<TrustProjectionEnvelope> = {},
): TrustProjectionEnvelope {
  return {
    userId: 'u1',
    identity: { name: 'Ana', handle: 'ana', verified: true },
    trust: {
      label: 'Strong',
      publicLevel: 'strong',
      score: 87,
      confidence: 'high',
      strengths: ['Safe & Respectful'],
      domains: SERVER_DOMAINS,
      confidenceBasis: 'trust_evidence',
    },
    credentials: [],
    capabilities: {
      owner: {
        // Deliberately GENEROUS: every capability granted. The client's old
        // deriver would call every domain applicable and print "In good
        // standing" on all six from these flags alone.
        canJoinPublicTrip: true,
        canHostTrip: true,
        canCreateLargePlan: true,
        canUseCrewLocation: true,
        canContributeLiveIntel: true,
        canBecomeBuddy: true,
      },
    },
    stats: { countries: 9, cities: 22, stamps: 40, trips: 11 },
    viewerContext: 'self',
    ...overrides,
  } as TrustProjectionEnvelope;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The server's word is the word — the client must not overwrite it
// ─────────────────────────────────────────────────────────────────────────────

describe('P45 — the domain word shown is the server-computed one', () => {
  test('each domain reports the server presentation, not a client constant', () => {
    const view = deriveTrustView(makeProjection());
    const byKey = Object.fromEntries(view.domains.map((d) => [d.key, d]));

    expect(byKey.overall.standing).toBe('Strong');
    expect(byKey.traveler.standing).toBe('Building');
    expect(byKey.trip_guest.standing).toBe('Established');
    expect(byKey.trip_host.standing).toBe('New');
    expect(byKey.contributor.standing).toBe('Excellent');
  });

  test('"In good standing" is never printed over a measured verdict', () => {
    const view = deriveTrustView(makeProjection());
    const standings = view.domains.map((d) => d.standing);
    expect(standings).not.toContain('In good standing');
  });

  test('applicability is the server\'s answer, not the capability flag\'s', () => {
    // canBecomeBuddy is TRUE in the fixture. The server nevertheless says the
    // Buddy domain does not apply, because this person offers no buddy service.
    // The client must defer.
    const view = deriveTrustView(makeProjection());
    const buddy = view.domains.find((d) => d.key === 'buddy')!;
    expect(buddy.applicable).toBe(false);
    expect(buddy.standing).toBe('Not applicable');
  });

  test('a domain the server calls applicable stays applicable when the matching capability is false', () => {
    const p = makeProjection();
    p.capabilities.owner.canHostTrip = false;
    p.capabilities.owner.canContributeLiveIntel = false;
    const view = deriveTrustView(p);
    const byKey = Object.fromEntries(view.domains.map((d) => [d.key, d]));
    expect(byKey.trip_host.applicable).toBe(true);
    expect(byKey.trip_host.standing).toBe('New');
    expect(byKey.contributor.applicable).toBe(true);
    expect(byKey.contributor.standing).toBe('Excellent');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Explainability — a substituted word must be distinguishable from a
//    measured one BY A PERSON READING THE SCREEN
// ─────────────────────────────────────────────────────────────────────────────

describe('P45 — the substituted word is distinguishable from the measured one', () => {
  test('the view carries the basis for every domain', () => {
    const view = deriveTrustView(makeProjection());
    const byKey = Object.fromEntries(view.domains.map((d) => [d.key, d]));
    expect(byKey.overall.basis).toBe('measured');
    expect(byKey.traveler.basis).toBe('partial');
    expect(byKey.trip_guest.basis).toBe('substituted');
    expect(byKey.buddy.basis).toBe('not_applicable');
  });

  test('a substituted domain carries human-readable copy saying so; a measured one does not', () => {
    const view = deriveTrustView(makeProjection());
    const byKey = Object.fromEntries(view.domains.map((d) => [d.key, d]));

    expect(byKey.trip_guest.basisNote).toBeTruthy();
    expect(String(byKey.trip_guest.basisNote).toLowerCase()).toContain('not yet');

    // A measured domain must NOT be annotated — otherwise the disclosure is
    // decoration rather than a distinction.
    expect(byKey.overall.basisNote).toBeNull();
    expect(byKey.contributor.basisNote).toBeNull();
  });

  test('an unreadable trust profile says so rather than reading as a verdict', () => {
    const p = makeProjection();
    p.trust!.domains = SERVER_DOMAINS.map((d) => ({ ...d, basis: 'unavailable' as const }));
    const view = deriveTrustView(p);
    for (const row of view.domains) {
      expect(row.basis).toBe('unavailable');
      expect(String(row.basisNote ?? '').toLowerCase()).toContain('unavailable');
    }
  });

  test('the screen RENDERS the substituted disclosure — it is not merely on the object', async () => {
    await render(<TrustScreen projectionOverride={makeProjection()} />);
    // Trip Guest and Trip Host are substituted in the fixture.
    expect(screen.queryAllByText(/not yet measured/i).length).toBeGreaterThan(0);
    // And the server's own words are on screen.
    expect(screen.queryAllByText('Building').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Excellent').length).toBeGreaterThan(0);
  });

  test('a fully measured profile shows NO substitution disclosure', async () => {
    const p = makeProjection();
    p.trust!.domains = SERVER_DOMAINS.map((d) => ({
      ...d,
      applicable: true,
      presentation: 'Strong',
      basis: 'measured' as const,
    }));
    await render(<TrustScreen projectionOverride={p} />);
    expect(screen.queryAllByText(/not yet measured/i).length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Fallback — an older server that sends no domains must not blank the screen
// ─────────────────────────────────────────────────────────────────────────────

describe('P45 — capability-derived fallback survives for a server without domains', () => {
  test('six rows still appear when trust.domains is absent', () => {
    const p = makeProjection();
    delete (p.trust as any).domains;
    const view = deriveTrustView(p);
    expect(view.domains).toHaveLength(6);
    expect(view.domains.map((d) => d.key)).toEqual([
      'overall', 'traveler', 'trip_guest', 'trip_host', 'contributor', 'buddy',
    ]);
    // Legacy path keeps its legacy word.
    expect(view.domains.find((d) => d.key === 'trip_guest')!.standing).toBe('In good standing');
    // …and reports that it was derived on the client, not measured by the server.
    expect(view.domains.find((d) => d.key === 'trip_guest')!.basis).toBe('client_derived');
  });

  test('an empty domains array is treated as absent, not as "no domains apply"', () => {
    const p = makeProjection();
    p.trust!.domains = [];
    const view = deriveTrustView(p);
    expect(view.domains).toHaveLength(6);
  });

  test('no trust at all still yields six neutral rows', () => {
    const p = makeProjection();
    delete (p as any).trust;
    const view = deriveTrustView(p);
    expect(view.domains).toHaveLength(6);
    expect(view.domains.every((d) => d.standing.length > 0)).toBe(true);
  });
});
