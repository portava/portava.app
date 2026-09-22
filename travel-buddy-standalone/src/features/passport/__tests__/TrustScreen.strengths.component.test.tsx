/**
 * Component tests for the trust STRENGTHS render on TrustScreen.
 *
 * `TrustProjection.strengths` is produced server-side (TrustPrivacyGuard —
 * top categories above the server's threshold, capped at 2) and has always
 * reached the client on the projection payload, but nothing rendered it. These
 * tests pin the render itself:
 *
 *   1. A non-empty strengths list is rendered verbatim.
 *   2. An empty list renders NOTHING — no placeholder, no empty container and
 *      no invented copy (unknown stays unknown).
 *   3. The client never invents a strength the server did not send.
 *   4. A strength is shown exactly ONCE: the server re-encodes the same top
 *      strengths as `strength_*` credentials, and those duplicates are dropped
 *      from the credentials list when the strength itself is rendered.
 *   5. A `strength_*` credential the strengths list does NOT cover is still
 *      rendered — dropping is a de-duplication, never a data loss.
 *
 * Driven through the `projectionOverride` test seam: no network, no auth.
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

// ── useTrustProjection — the data hook is made inert (no fetch, no
// post-unmount setState); the pure `deriveTrustView` deriver stays REAL via
// requireActual because it is part of what is under test.
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
      strengths: ['Safe & Respectful', 'Great Communicator'],
    },
    credentials: [
      { key: 'identity', label: 'Identity Verified', detail: null, tier: 'verified' },
    ],
    capabilities: {
      owner: {
        canJoinPublicTrip: true,
        canHostTrip: false,
        canCreateLargePlan: false,
        canUseCrewLocation: false,
        canContributeLiveIntel: false,
        canBecomeBuddy: false,
      },
      actions: {},
    },
    stats: { countries: 12, cities: 30, stamps: 40, trips: 8 },
    viewerContext: 'self',
    ...overrides,
  };
}

describe('TrustScreen — strengths', () => {
  it('renders the server-sent strengths verbatim', async () => {
    await render(<TrustScreen projectionOverride={makeProjection()} />);

    expect(screen.getByText('Safe & Respectful')).toBeTruthy();
    expect(screen.getByText('Great Communicator')).toBeTruthy();
  });

  it('renders nothing at all when the server sent no strengths', async () => {
    const proj = makeProjection({
      trust: {
        label: 'Strong',
        publicLevel: 'strong',
        score: 87,
        confidence: 'high',
        strengths: [],
      },
    });

    await render(<TrustScreen projectionOverride={proj} />);

    // The screen still renders (the strengths block is the only thing gone)…
    expect(screen.getByText('87')).toBeTruthy();
    // …and no strength container, placeholder or invented copy appears.
    expect(screen.queryByLabelText(/Strongest areas/i)).toBeNull();
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toMatch(/strongest/i);
    expect(tree).not.toMatch(/no strengths/i);
  });

  it('never invents a strength the server did not send', async () => {
    const proj = makeProjection({
      trust: {
        label: 'Strong',
        publicLevel: 'strong',
        score: 87,
        confidence: 'high',
        strengths: ['Safe & Respectful'],
      },
    });

    await render(<TrustScreen projectionOverride={proj} />);

    expect(screen.getByText('Safe & Respectful')).toBeTruthy();
    // The second server-side slot is empty — the client leaves it empty.
    expect(screen.queryByText('Great Communicator')).toBeNull();
  });

  it('shows each strength exactly once, not twice via the strength_* credential', async () => {
    // This is the real server payload shape: buildCredentials re-encodes the
    // same top-2 strengths as `strength_*` credentials.
    const proj = makeProjection({
      credentials: [
        { key: 'identity', label: 'Identity Verified', detail: null, tier: 'verified' },
        { key: 'strength_safe_respectful', label: 'Safe & Respectful', detail: 'Good standing', tier: 'positive' },
        { key: 'strength_great_communicator', label: 'Great Communicator', detail: 'Good standing', tier: 'positive' },
      ],
    });

    await render(<TrustScreen projectionOverride={proj} />);

    expect(screen.getAllByText('Safe & Respectful')).toHaveLength(1);
    expect(screen.getAllByText('Great Communicator')).toHaveLength(1);
    // The unrelated credential is untouched.
    expect(screen.getByText('Identity Verified')).toBeTruthy();
  });

  it('keeps a strength_* credential that the strengths list does not cover', async () => {
    const proj = makeProjection({
      trust: {
        label: 'Strong',
        publicLevel: 'strong',
        score: 87,
        confidence: 'high',
        strengths: [],
      },
      credentials: [
        { key: 'strength_reliable_host', label: 'Reliable Host', detail: 'Good standing', tier: 'positive' },
      ],
    });

    await render(<TrustScreen projectionOverride={proj} />);

    // Nothing is hidden without being shown somewhere else.
    expect(screen.getByText('Reliable Host')).toBeTruthy();
  });
});
