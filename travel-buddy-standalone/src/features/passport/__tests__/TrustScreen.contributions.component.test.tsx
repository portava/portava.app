/**
 * Component tests for TrustScreen's §20 Contribution surfacing.
 *
 * TrustScreen renders the ContributionCard (TABLE 21) when the reputation route
 * (or the projection-credentials fallback) yields positive signal. These tests
 * drive it through the `projectionOverride` + `contributionsOverride` seams so no
 * network/auth runs.
 *
 * Verifies:
 *   1. The card renders from injected reputation, alongside the existing trust
 *      summary — WITHOUT leaking any private/paid field.
 *   2. No contribution signal → no card (the rest of the screen is unaffected).
 *   3. The projection-credentials fallback surfaces a card from
 *      contribution-relevant credentials with no dedicated reputation route.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import TrustScreen from '../TrustScreen.tsx';
import type { TrustProjectionEnvelope } from '../useTrustProjection.ts';
import type { ContributionProjection } from '../../../services/passportContributions.ts';

// NOTE: intentionally exhaustive — expo-router needs Expo native navigation
// modules unavailable in jest-expo; only the two members TrustScreen uses.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — SessionContext imports Supabase + native
// modules; contribution data is injected via the override seams here.
jest.mock('../../../context/SessionContext', () => ({
  useSession: () => ({ userId: 'me', isAuthed: true }),
}));

// NOTE: intentionally exhaustive — apiToken imports the Supabase client at load;
// the overrides mean neither the trust fetch nor the contributions fetch runs.
jest.mock('../../../services/apiToken', () => ({
  freshToken: jest.fn(async () => null),
}));

// Inert data hook — the screen is driven by the override seams; keep the real
// deriveTrustView (the logic under test in the sibling suite).
jest.mock('../useTrustProjection', () => {
  const actual = jest.requireActual('../useTrustProjection');
  return {
    ...actual,
    useTrustProjection: () => ({ projection: null, loading: false, error: null, reload: jest.fn() }),
  };
});

function makeProjection(overrides: Partial<TrustProjectionEnvelope> = {}): TrustProjectionEnvelope {
  return {
    userId: 'u1',
    identity: { name: 'Ana', handle: 'ana', verified: true },
    // Domains as the server ships them (buildDomainTrust) — the screen reads
    // this array verbatim; a projection carrying trust always carries it.
    trust: {
      label: 'Strong',
      publicLevel: 'strong',
      score: 87,
      confidence: 'high',
      strengths: [],
      domains: [
        { key: 'overall', domain: 'Overall', presentation: 'Excellent', applicable: true },
        { key: 'traveler', domain: 'Traveler', presentation: 'Established', applicable: true },
        { key: 'trip_guest', domain: 'Trip Guest', presentation: 'Established', applicable: true },
        { key: 'trip_host', domain: 'Trip Host', presentation: 'Established', applicable: true },
        { key: 'contributor', domain: 'Contributor', presentation: 'Established', applicable: true },
        { key: 'buddy', domain: 'Buddy', presentation: 'Not applicable', applicable: false },
      ],
    },
    credentials: [{ key: 'identity', label: 'Identity Verified', detail: null, tier: 'verified' }],
    capabilities: {
      owner: {
        canJoinPublicTrip: true,
        canHostTrip: false,
        canCreateLargePlan: false,
        canUseCrewLocation: false,
        canContributeLiveIntel: true,
        canBecomeBuddy: false,
      },
      actions: {},
    },
    stats: { countries: 3, cities: 5, stamps: 10, trips: 4 },
    viewerContext: 'self',
    ...overrides,
  };
}

const contribution: ContributionProjection = {
  level: 'Local Expert',
  acceptedReports: 12,
  confirmations: 6,
  hiddenGems: 2,
  topExpertise: ['Food', 'Nightlife'],
};

describe('TrustScreen — §20 contribution surfacing', () => {
  it('renders the ContributionCard from injected reputation, with the trust summary', async () => {
    await render(
      <TrustScreen projectionOverride={makeProjection()} contributionsOverride={contribution} />,
    );

    // Trust summary still there…
    expect(screen.getByText('87')).toBeTruthy();
    // …and the contribution card surfaces its fields.
    expect(screen.getByText('Contributions')).toBeTruthy();
    expect(screen.getByText('Local Expert')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('Food')).toBeTruthy();

    // No private/paid leakage in the whole tree.
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toMatch(/paid/i);
    expect(tree).not.toMatch(/moderation/i);
  });

  it('renders no card when there is no contribution signal', async () => {
    await render(
      <TrustScreen projectionOverride={makeProjection()} contributionsOverride={null} />,
    );

    expect(screen.getByText('87')).toBeTruthy(); // rest of screen intact
    expect(screen.queryByText('Contributions')).toBeNull();
  });

  it('falls back to contribution-relevant projection credentials when no override is given', async () => {
    const proj = makeProjection({
      credentials: [
        { key: 'identity', label: 'Identity Verified', detail: null, tier: 'verified' },
        { key: 'live_intel', label: 'Trusted Contributor', detail: null, tier: 'positive' },
        { key: 'expertise_food', label: 'Food', detail: null, tier: 'positive' },
      ],
    });

    // No contributionsOverride → fetch disabled (projectionOverride present) →
    // derive from credentials.
    await render(<TrustScreen projectionOverride={proj} />);

    // The ContributionCard surfaces the level + expertise. (The same credential
    // also appears in the generic Credentials list, so these labels legitimately
    // occur more than once — assert presence, not uniqueness.)
    expect(screen.getByText('Contributions')).toBeTruthy();
    expect(screen.getAllByText('Trusted Contributor').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Food').length).toBeGreaterThan(0);
  });
});
