/**
 * The Trust surface must render the SERVER's domain measurements — never a
 * client-side reconstruction of them (spec §9/§11, TABLE 12).
 *
 * The server (PassportProjectionService.buildDomainTrust) already computes, for
 * every domain, BOTH the non-stigmatizing presentation word (presentationWord)
 * and the applicability decision, and ships them on `trust.domains`. The client
 * previously ignored that array: it rebuilt six rows from capability flags plus
 * travel stats and stamped a single literal — "In good standing" — onto every
 * row it considered applicable. A real per-domain measurement was overwritten
 * with a constant.
 *
 * These tests are written so that reinstating any of those substitutions fails:
 *   • the fixtures make the server's answer CONTRADICT what the capability
 *     flags/stats would have produced, so a client that recomputes cannot
 *     accidentally agree with the server;
 *   • absent measurements (no `domains`, no `capabilities.owner`, no `stats`)
 *     must surface as an honest unknown, following the existing null-score
 *     convention, not as a plausible default that reads as a measurement.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import TrustScreen from '../TrustScreen.tsx';
import {
  deriveTrustView,
  type TrustProjectionEnvelope,
} from '../useTrustProjection.ts';

// ── expo-router ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — expo-router requires Expo native navigation
// modules unavailable in jest-expo; this stubs the two members this screen uses.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// ── safe-area-context — no provider is mounted in these unit renders ──────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── useSession ────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — the real SessionContext imports Supabase +
// native-incompatible modules. Trust is driven by projectionOverride here.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me', isAuthed: true }),
}));

// ── apiToken ──────────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — apiToken is imported at module load by
// useTrustProjection and pulls in Supabase; the projection override means the
// fetch (and thus freshToken) is never actually invoked.
jest.mock('../../../services/apiToken', () => ({
  freshToken: jest.fn(async () => null),
}));

// ── useTrustProjection — the screen is driven entirely by `projectionOverride`
// here, so make the DATA HOOK inert (no fetch, no post-unmount setState). The
// pure `deriveTrustView` deriver is kept real via requireActual — it is the
// logic actually under test.
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

/** Every owner capability DENIED — so any client-side rebuild of the domain
 *  rows from capability flags would mark the specific domains out of scope. */
const NO_CAPS = {
  canJoinPublicTrip: false,
  canHostTrip: false,
  canCreateLargePlan: false,
  canUseCrewLocation: false,
  canContributeLiveIntel: false,
  canBecomeBuddy: false,
};

/**
 * The SERVER's TABLE 12 answer. It deliberately disagrees with NO_CAPS and with
 * the zeroed stats below: the server says these domains ARE in scope and gives
 * each its own presentation word. Only a client that reads `trust.domains` can
 * produce this.
 */
const SERVER_DOMAINS = [
  { key: 'overall', domain: 'Overall', presentation: 'Building', applicable: true },
  { key: 'traveler', domain: 'Traveler', presentation: 'Excellent', applicable: true },
  { key: 'trip_guest', domain: 'Trip Guest', presentation: 'Established', applicable: true },
  { key: 'trip_host', domain: 'Trip Host', presentation: 'Strong', applicable: true },
  { key: 'contributor', domain: 'Contributor', presentation: 'New', applicable: true },
  { key: 'buddy', domain: 'Buddy', presentation: 'Not applicable', applicable: false },
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
      strengths: [],
      domains: SERVER_DOMAINS,
    },
    credentials: [],
    capabilities: { owner: { ...NO_CAPS }, actions: {} },
    stats: { countries: 0, cities: 0, stamps: 0, trips: 0 },
    viewerContext: 'self',
    ...overrides,
  };
}

describe('deriveTrustView — domains are a server measurement, not a client rebuild', () => {
  it('reads each domain row straight off trust.domains, contradicting the capability flags', () => {
    const view = deriveTrustView(makeProjection());

    expect(view.hasDomains).toBe(true);
    expect(view.domains).not.toBeNull();
    expect(view.domains!.map((d) => [d.key, d.standing, d.applicable])).toEqual([
      ['overall', 'Building', true],
      ['traveler', 'Excellent', true],
      ['trip_guest', 'Established', true],
      ['trip_host', 'Strong', true],
      ['contributor', 'New', true],
      ['buddy', 'Not applicable', false],
    ]);
  });

  it('never substitutes the "In good standing" literal for a per-domain word', () => {
    // Every capability GRANTED: a client that stamps a literal onto each
    // applicable row would emit "In good standing" six times here. The server's
    // own words must appear instead.
    const view = deriveTrustView(
      makeProjection({
        capabilities: {
          owner: {
            canJoinPublicTrip: true,
            canHostTrip: true,
            canCreateLargePlan: true,
            canUseCrewLocation: true,
            canContributeLiveIntel: true,
            canBecomeBuddy: true,
          },
          actions: {},
        },
        stats: { countries: 9, cities: 20, stamps: 30, trips: 6 },
      }),
    );
    expect(view.domains!.some((d) => d.standing === 'In good standing')).toBe(false);
    expect(view.domains!.map((d) => d.standing)).toEqual([
      'Building',
      'Excellent',
      'Established',
      'Strong',
      'New',
      'Not applicable',
    ]);
  });

  it('gives Overall the server presentation word, not the overall trust label', () => {
    const view = deriveTrustView(makeProjection());
    const overall = view.domains!.find((d) => d.key === 'overall')!;
    // trust.label is "Strong"; the server's Overall domain word is "Building".
    expect(overall.standing).toBe('Building');
  });

  it('keeps a domain in scope when the server says so and the capability flag says otherwise', () => {
    const view = deriveTrustView(makeProjection());
    const host = view.domains!.find((d) => d.key === 'trip_host')!;
    expect(host.applicable).toBe(true);
    expect(host.standing).toBe('Strong');
  });

  it('honours the server marking a domain out of scope (buddy)', () => {
    const view = deriveTrustView(
      makeProjection({
        capabilities: { owner: { ...NO_CAPS, canBecomeBuddy: true }, actions: {} },
      }),
    );
    const buddy = view.domains!.find((d) => d.key === 'buddy')!;
    // The capability flag is granted, but the SERVER decided the domain does
    // not apply — the server wins.
    expect(buddy.applicable).toBe(false);
    expect(buddy.standing).toBe('Not applicable');
  });

  it('does not infer domains from travel stats — absent stats change nothing', () => {
    const withStats = deriveTrustView(makeProjection());
    const noStats = deriveTrustView(makeProjection({ stats: undefined }));
    expect(noStats.domains).toEqual(withStats.domains);
    const traveler = noStats.domains!.find((d) => d.key === 'traveler')!;
    expect(traveler.applicable).toBe(true);
    expect(traveler.standing).toBe('Excellent');
  });

  it('leaves an absent domains array UNKNOWN rather than fabricating six rows', () => {
    const view = deriveTrustView(
      makeProjection({
        trust: {
          label: 'Strong',
          publicLevel: 'strong',
          score: 87,
          confidence: 'high',
          strengths: [],
        },
      }),
    );
    expect(view.hasDomains).toBe(false);
    expect(view.domains).toBeNull();
  });

  it('leaves a domain with no presentation word UNKNOWN (null), not "in good standing"', () => {
    const view = deriveTrustView(
      makeProjection({
        trust: {
          label: 'Strong',
          publicLevel: 'strong',
          score: 87,
          confidence: 'high',
          strengths: [],
          domains: [
            { key: 'overall', domain: 'Overall', applicable: true } as never,
          ],
        },
      }),
    );
    expect(view.domains![0].standing).toBeNull();
  });
});

describe('deriveTrustView — absent capabilities are UNKNOWN, not denied', () => {
  it('returns null chips (not an empty measured list) when owner capabilities are absent', () => {
    const view = deriveTrustView(makeProjection({ capabilities: undefined }));
    expect(view.hasCapabilities).toBe(false);
    expect(view.capabilityChips).toBeNull();
  });

  it('still returns an empty measured list when the server denied every capability', () => {
    const view = deriveTrustView(makeProjection());
    expect(view.hasCapabilities).toBe(true);
    expect(view.capabilityChips).toEqual([]);
  });
});

describe('TrustScreen — renders the server measurement', () => {
  it('shows the server presentation word for a domain whose capability flag is false', async () => {
    await render(<TrustScreen projectionOverride={makeProjection()} />);

    // Server words, one per domain…
    expect(screen.getByText('Excellent')).toBeTruthy();
    expect(screen.getByText('Established')).toBeTruthy();
    // "Strong" is both the hero label and the Trip Host word — at least once.
    expect(screen.getAllByText('Strong').length).toBeGreaterThan(0);
    // …and no client-invented standing anywhere in the tree.
    expect(screen.queryByText('In good standing')).toBeNull();
  });

  it('says capabilities are not shown when the server projected none', async () => {
    await render(
      <TrustScreen projectionOverride={makeProjection({ capabilities: undefined })} />,
    );

    expect(screen.getByText("Capabilities aren't shown in this view.")).toBeTruthy();
  });

  it('says trust-by-area is not shown when the server sent no domains', async () => {
    await render(
      <TrustScreen
        projectionOverride={makeProjection({
          trust: {
            label: 'Strong',
            publicLevel: 'strong',
            score: 87,
            confidence: 'high',
            strengths: [],
          },
        })}
      />,
    );

    expect(screen.getByText("Trust by area isn't shown in this view.")).toBeTruthy();
    // No fabricated rows.
    expect(screen.queryByText('In good standing')).toBeNull();
    expect(screen.queryByText('Not applicable')).toBeNull();
  });
});
