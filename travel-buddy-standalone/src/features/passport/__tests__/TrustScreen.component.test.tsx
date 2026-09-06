/**
 * Component tests for TrustScreen — the Passport Trust & Credentials surface
 * (spec §9/§10/§11, TABLE 12/13/14).
 *
 * Covers the load-bearing contract points:
 *   1. Score + qualitative label render (self / permitted view).
 *   2. Confidence is surfaced — an 82 with high evidence is presented
 *      differently from the same number with little (§10).
 *   3. NO private report counts / moderation evidence / safety history are ever
 *      rendered, even when smuggled onto the projection object (§10).
 *   4. Positive capability chips come straight from projection.capabilities —
 *      only granted (true) flags appear (TABLE 14, §11).
 *   5. Low-evidence accounts get non-stigmatizing copy and NO numeric score
 *      (§10).
 *
 * The screen is driven through its `projectionOverride` test seam, so no
 * network or auth is exercised. render() is awaited (RNTL 14 + React 19 +
 * jest-expo) so the queries bind.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import TrustScreen from '../TrustScreen.tsx';
import type { TrustProjectionEnvelope } from '../useTrustProjection.ts';

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
// here, so make the DATA HOOK inert (no fetch, no post-unmount setState that
// would otherwise leak act() warnings and contaminate later tests). The pure
// `deriveTrustView` deriver is kept real via requireActual — it is the logic
// actually under test.
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

/**
 * The TABLE 12 domain block exactly as the server builds it
 * (PassportProjectionService.buildDomainTrust): one presentation word per
 * domain plus its applicability. A projection carrying trust ALWAYS carries
 * this array, so the fixtures carry it too — the screen reads it verbatim.
 */
function serverDomains(overallWord: string) {
  return [
    { key: 'overall', domain: 'Overall', presentation: overallWord, applicable: true },
    // The remaining domains fall back to the trust engine's neutral 50 →
    // "Established" when there is no trust profile.
    { key: 'traveler', domain: 'Traveler', presentation: 'Established', applicable: true },
    { key: 'trip_guest', domain: 'Trip Guest', presentation: 'Established', applicable: true },
    { key: 'trip_host', domain: 'Trip Host', presentation: 'Established', applicable: true },
    { key: 'contributor', domain: 'Contributor', presentation: 'Established', applicable: true },
    // Non-buddy accounts: the server itself marks Buddy out of scope.
    { key: 'buddy', domain: 'Buddy', presentation: 'Not applicable', applicable: false },
  ];
}

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
      domains: serverDomains('Excellent'),
    },
    credentials: [
      { key: 'identity', label: 'Identity Verified', detail: null, tier: 'verified' },
      { key: 'established', label: 'Established Account', detail: null, tier: 'positive' },
      { key: 'trip_experience', label: 'Trip Experience', detail: '8 trips', tier: 'positive' },
    ],
    capabilities: {
      owner: {
        canJoinPublicTrip: true,
        canHostTrip: true,
        canCreateLargePlan: false,
        canUseCrewLocation: false,
        canContributeLiveIntel: true,
        canBecomeBuddy: false,
      },
      actions: {},
    },
    stats: { countries: 12, cities: 30, stamps: 40, trips: 8 },
    viewerContext: 'self',
    ...overrides,
  };
}

describe('TrustScreen', () => {
  it('renders the numeric score and its qualitative label (self view)', async () => {
    await render(<TrustScreen projectionOverride={makeProjection()} />);

    // 0–100 score exposed where the server provided it (§9).
    expect(screen.getByText('87')).toBeTruthy();
    expect(screen.getByText('/ 100')).toBeTruthy();
    // Qualitative label appears (hero + the Overall domain row) — at least once.
    expect(screen.getAllByText('Strong').length).toBeGreaterThan(0);
  });

  it('surfaces the confidence band, not just the number (§10)', async () => {
    // An 87 with HIGH evidence is presented with its own confidence band + copy,
    // distinct from the same 87 with little evidence (the low band — "Early days"
    // — is exercised in the low-evidence test below).
    await render(<TrustScreen projectionOverride={makeProjection()} />);

    expect(screen.getByText('High confidence')).toBeTruthy();
    expect(
      screen.getByText('Backed by a substantial travel and contribution history.'),
    ).toBeTruthy();
    // The band is specifically HIGH here — the low-evidence framing is absent.
    expect(screen.queryByText('Early days')).toBeNull();
  });

  it('never renders private report counts, moderation evidence or safety history (§10)', async () => {
    const proj = makeProjection();
    // Smuggle private fields onto the projection object; the screen must ignore
    // every one of them.
    (proj as Record<string, unknown>).reportCount = 3;
    (proj as Record<string, unknown>).moderationNotes = 'warned for spam';
    (proj as Record<string, unknown>).safetyHistory = ['banned once'];
    (proj.trust as Record<string, unknown>).reportCount = 5;

    await render(<TrustScreen projectionOverride={proj} />);

    // Safe, whitelisted content still renders…
    expect(screen.getByText('87')).toBeTruthy();

    // …but nothing private leaks into the rendered tree.
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toMatch(/moderation/i);
    expect(tree).not.toMatch(/warned/i);
    expect(tree).not.toMatch(/banned/i);
    expect(tree).not.toMatch(/spam/i);
    expect(tree).not.toMatch(/\breport/i);
    expect(tree).not.toContain('safetyHistory');
  });

  it('renders positive capability chips straight from the projection (TABLE 14)', async () => {
    await render(<TrustScreen projectionOverride={makeProjection()} />);

    // Granted (true) capabilities appear as chips…
    expect(screen.getByText('Host trips')).toBeTruthy();
    expect(screen.getByText('Join public trips')).toBeTruthy();
    expect(screen.getByText('Contribute live intel')).toBeTruthy();

    // …ungranted (false) capabilities are never shown (client never invents them).
    expect(screen.queryByText('Create large plans')).toBeNull();
    expect(screen.queryByText('Share crew location')).toBeNull();
    expect(screen.queryByText('Become a Buddy')).toBeNull();
  });

  it('shows non-stigmatizing copy and NO numeric score for low-evidence accounts (§10)', async () => {
    const proj = makeProjection({
      trust: {
        label: 'New Traveler · Verified',
        publicLevel: 'new_traveler',
        score: null, // server withholds the number in this view
        confidence: 'low',
        strengths: [],
        domains: serverDomains('Established'),
      },
      capabilities: {
        owner: {
          canJoinPublicTrip: false,
          canHostTrip: false,
          canCreateLargePlan: false,
          canUseCrewLocation: false,
          canContributeLiveIntel: false,
          canBecomeBuddy: false,
        },
        actions: {},
      },
      stats: { countries: 0, cities: 0, stamps: 0, trips: 0 },
      viewerContext: 'public',
    });

    await render(<TrustScreen projectionOverride={proj} />);

    // Server's non-stigmatizing label is rendered verbatim (hero + Overall row).
    expect(screen.getAllByText('New Traveler · Verified').length).toBeGreaterThan(0);
    // Non-stigmatizing confidence copy.
    expect(screen.getByText('Early days')).toBeTruthy();
    // No numeric score anywhere.
    expect(screen.queryByText('/ 100')).toBeNull();
    // The domain the SERVER marked out of scope carries the server's own
    // neutral "Not applicable" word (TABLE 12) — the client substitutes nothing.
    expect(screen.getAllByText('Not applicable').length).toBeGreaterThan(0);
  });
});
