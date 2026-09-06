/**
 * Component tests for the TrustScreen recovery-hints section (§9/§10).
 *
 * The server computes recovery advice (TrustRecoveryService → the safe trust
 * summary) and now projects it as `trust.recoveryHints` — but ONLY on the
 * owner's own view. Nothing rendered it, so a user who was in recovery had no
 * way to learn what to do about it. These tests hold the delivered behaviour:
 *
 *   1. When the server sent hints, every one renders, verbatim and in server
 *      order, under its own heading.
 *   2. When the server sent none (another viewer's projection has no such key),
 *      the section is absent entirely — the client does NOT fall back to canned
 *      advice, and does not derive hints from the score or the domains. An
 *      absent read stays absent.
 *   3. An empty array behaves the same as absent on screen (nothing to show),
 *      still with no invented copy.
 *
 * Driven through the `projectionOverride` seam — no network, no auth.
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import TrustScreen from '../TrustScreen.tsx';
import { deriveTrustView, type TrustProjectionEnvelope } from '../useTrustProjection.ts';

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

// ── useTrustProjection — keep the pure deriver real (it is under test), make the
// data hook inert so no fetch or post-unmount setState leaks into other tests.
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

/** The exact strings the server's step templates produce, in priority order. */
const HINTS = [
  'Attend 5 more plans without cancelling',
  'Reply to 3 messages within 24 hours',
  'Verify 2 hidden gems in person',
];

const SECTION_TITLE = 'Ways to strengthen your standing';

function makeProjection(
  trustOverrides: Record<string, unknown> = {},
  envelopeOverrides: Partial<TrustProjectionEnvelope> = {},
): TrustProjectionEnvelope {
  return {
    userId: 'u1',
    identity: { name: 'Ana', handle: 'ana', verified: true },
    trust: {
      label: 'Building Trust',
      publicLevel: 'building_trust',
      score: 44,
      confidence: 'medium',
      strengths: [],
      ...trustOverrides,
    } as TrustProjectionEnvelope['trust'],
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
    stats: { countries: 3, cities: 5, stamps: 6, trips: 2 },
    viewerContext: 'self',
    ...envelopeOverrides,
  };
}

describe('TrustScreen — recovery hints', () => {
  it('renders every server hint, verbatim and in server order (owner view)', async () => {
    await render(
      <TrustScreen projectionOverride={makeProjection({ recoveryHints: HINTS })} />,
    );

    expect(screen.getByText(SECTION_TITLE)).toBeTruthy();
    for (const hint of HINTS) {
      expect(screen.getByText(hint)).toBeTruthy();
    }

    // Server order is preserved — the client does not re-sort the advice.
    const tree = JSON.stringify(screen.toJSON());
    const positions = HINTS.map((h) => tree.indexOf(h));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('renders NO hint section when the server sent none (another viewer)', async () => {
    // A non-self projection simply has no `recoveryHints` key — the server's
    // privacy decision. The screen must show nothing rather than substitute
    // generic advice, and must not derive hints from the score/domains.
    const proj = makeProjection({ score: null }, { viewerContext: 'follower' });
    expect('recoveryHints' in (proj.trust as object)).toBe(false);

    await render(<TrustScreen projectionOverride={proj} />);

    expect(screen.queryByText(SECTION_TITLE)).toBeNull();
    for (const hint of HINTS) {
      expect(screen.queryByText(hint)).toBeNull();
    }
    // Nothing hint-shaped was invented in place of the absent read. (The
    // heading itself is the marker — a bare /strengthen/i would also match the
    // unrelated confidence copy "it strengthens as you travel and contribute".)
    const tree = JSON.stringify(screen.toJSON());
    expect(tree).not.toContain(SECTION_TITLE);
    expect(tree).not.toMatch(/cancelling/i);
    expect(tree).not.toMatch(/hidden gems/i);
  });

  it('shows nothing (and invents nothing) for an owner with an empty list', async () => {
    await render(
      <TrustScreen projectionOverride={makeProjection({ recoveryHints: [] })} />,
    );

    expect(screen.queryByText(SECTION_TITLE)).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain(SECTION_TITLE);
  });

  it('deriveTrustView passes the hints through untouched', async () => {
    const view = deriveTrustView(makeProjection({ recoveryHints: HINTS }));
    expect(view.recoveryHints).toEqual(HINTS);

    // Absent on the wire → an empty list in the view model, never a default.
    expect(deriveTrustView(makeProjection()).recoveryHints).toEqual([]);
  });
});
