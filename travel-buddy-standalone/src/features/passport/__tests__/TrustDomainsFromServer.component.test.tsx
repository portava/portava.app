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
// NOTE: intentionally exhaustive — TrustScreen uses only router.push/back; the real module pulls navigation state this suite does not mount.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));
// NOTE: intentionally exhaustive — the real SessionContext provider starts auth + storage work on mount; TrustScreen reads only useSession().
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me', isAuthed: true }),
}));
// NOTE: intentionally exhaustive — apiToken reaches Supabase for a live token; null keeps the screen on the fetch path this suite exercises.
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
  // A substituted domain is what the SERVER now sends for one: the word is
  // "Not yet rated", not a rating. The fixture carried 'Established' and 'New'
  // here, which is what the server used to send and no longer does (owner
  // decision, 2026-09-22) — a fixture that keeps sending the old shape is how a
  // client keeps passing against a server that changed.
  { key: 'trip_guest', domain: 'Trip Guest', presentation: 'Not yet rated', applicable: true, basis: 'substituted' as const },
  { key: 'trip_host', domain: 'Trip Host', presentation: 'Not yet rated', applicable: true, basis: 'substituted' as const },
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
    // Both are substituted in the fixture, so the server's word for them is not
    // a rating. The point of this test is unchanged: whatever the server said,
    // the client shows THAT.
    expect(byKey.trip_guest.standing).toBe('Not yet rated');
    expect(byKey.trip_host.standing).toBe('Not yet rated');
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
    expect(byKey.trip_host.standing).toBe('Not yet rated');
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
    // And the server's own words are on screen — including the one it sends for
    // a domain it declined to rate, which the client renders verbatim rather
    // than re-deciding.
    expect(screen.queryAllByText('Not yet rated').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Building').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('Excellent').length).toBeGreaterThan(0);
  });

  test('a rating word NEVER appears on a substituted row', async () => {
    // The defect this whole decision closes, checked at the pixel: every
    // account read "Established" in six domains. The two substituted rows in
    // the fixture must carry none of the five rating words.
    const view = deriveTrustView(makeProjection());
    const RATINGS = ['Excellent', 'Strong', 'Established', 'Building', 'New'];
    for (const row of view.domains.filter((d) => d.basis === 'substituted')) {
      expect(RATINGS).not.toContain(row.standing);
    }
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

describe('P45 — no server domains is an honest unknown, not a client guess', () => {
  test('six rows still appear when trust.domains is absent', () => {
    const p = makeProjection();
    delete (p.trust as any).domains;
    const view = deriveTrustView(p);
    expect(view.domains).toHaveLength(6);
    expect(view.domains.map((d) => d.key)).toEqual([
      'overall', 'traveler', 'trip_guest', 'trip_host', 'contributor', 'buddy',
    ]);
    // THE LAYOUT SURVIVES AND THE CLAIM DOES NOT. This used to assert "In good
    // standing", derived from a capability flag — permission to do a thing,
    // printed as a statement about the person's record. The owner ruled on
    // 2026-09-22 that standing is never derived from capabilities, so the row
    // says what the client actually knows, which is nothing.
    expect(view.domains.find((d) => d.key === 'trip_guest')!.standing).toBe('Not available');
    // …and reports that it was derived on the client, not measured by the server.
    expect(view.domains.find((d) => d.key === 'trip_guest')!.basis).toBe('client_derived');
  });

  test('NO row on the fallback path carries a standing word', () => {
    // The fixture grants every capability, so a client that still derived
    // anything would print a standing on every row. All six must be unknown.
    const p = makeProjection();
    delete (p.trust as any).domains;
    const view = deriveTrustView(p);
    for (const row of view.domains) {
      expect(row.standing).toBe('Not available');
      expect(row.basisNote).toBe('This traveler\u2019s standing could not be loaded.');
      // The domain still applies; what is missing is the measurement.
      expect(row.applicable).toBe(true);
    }
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

// ────────────────────────────────────────────────────────────────────────────
// 4. A FAILED READ — owner ruling 2026-09-22: labelled, retryable, not hidden
// ────────────────────────────────────────────────────────────────────────────

/** The projection a server sends when it could NOT read `trust_profiles`. */
function degradedProjection(): TrustProjectionEnvelope {
  const p = makeProjection();
  p.trust!.degraded = true;
  p.trust!.confidence = null;
  p.trust!.confidenceBasis = 'unavailable';
  p.trust!.domains = SERVER_DOMAINS.map((d) => ({
    ...d,
    applicable: true,
    presentation: 'Temporarily unavailable',
    basis: 'unavailable' as const,
  }));
  return p;
}

describe('a failed read is labelled and retryable, never dressed up or hidden', () => {
  test('the view reports degraded, and confidence is NOT banded rather than low', () => {
    const view = deriveTrustView(degradedProjection());
    expect(view.degraded).toBe(true);
    // `?? 'low'` here used to print "Early days" over a person the server had
    // declined to describe. Absent is its own state now.
    //
    // MERGE, 2026-09-23: that absent state is `null`, not a `'unknown'` member
    // of the band union. This assertion changed shape, NOT strength — what it
    // exists to catch is a rendered band standing in for a refusal, and both
    // halves of that are still asserted below. The other lane's reason for
    // preferring `null` is recorded on `TrustView.confidence`: a pseudo-band
    // beside the real ones is indexable into the band table, and the row it
    // produced claimed a failed READ over accounts that merely have no profile.
    expect(view.confidence).toBeNull();
    expect(view.confidence).not.toBe('low');
    // The failed-read wording, which is a different claim from "not yet
    // measured" — see TrustScreen.confidenceUnmeasured.component.test.tsx.
    expect(view.confidenceLabel).toBe('Not available');
    expect(view.confidenceCopy).toMatch(/unavailable/i);
    expect(view.confidenceCopy).not.toMatch(/New accounts start here/i);
  });

  test('the SCREEN says so and offers a retry', async () => {
    await render(<TrustScreen projectionOverride={degradedProjection()} />);
    expect(screen.getByText('Trust records are unavailable right now')).toBeTruthy();
    expect(screen.getByText('Retry')).toBeTruthy();
    // Not hidden: the domain layout is still there to be labelled.
    expect(screen.getByText('Trust by area')).toBeTruthy();
    expect(screen.getAllByText('Temporarily unavailable').length).toBe(6);
    // And it is NOT the other unavailable state.
    expect(screen.queryByText('Not yet rated')).toBeNull();
    expect(screen.queryByText('Early days')).toBeNull();
  });

  test('an ordinary measured projection shows NO banner', async () => {
    // The positive control. The cheapest way to pass the test above is to show
    // the banner always, which would tell every user their records are missing.
    await render(<TrustScreen projectionOverride={makeProjection()} />);
    expect(screen.queryByText('Trust records are unavailable right now')).toBeNull();
    expect(deriveTrustView(makeProjection()).degraded).toBe(false);
  });
});
