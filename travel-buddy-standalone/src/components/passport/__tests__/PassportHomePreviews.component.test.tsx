/**
 * PassportHomePreviews — §3 Passport Home previews + §17/§18 viewer affordances.
 *
 * Mounts the REAL component with an injected projection (hookOverride) so no
 * network is touched, and asserts:
 *  - previews render from the projection aggregate (stamps / Featured Journey /
 *    next Trip / memories);
 *  - "Make a Plan" is gated on capabilities.actions.can_make_plan (§18/§30) and
 *    routes to the Compass ask surface;
 *  - the "YOU TWO" Shared-Context entry routes to /passport/shared-context with
 *    the viewed user's id (F1 reachability);
 *  - owner context shows neither viewer affordance;
 *  - the read-only viewer Memories/Plans lists render permitted items and a
 *    clear empty state (F3).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import {
  PassportHomePreviews,
  PassportViewerMemoriesList,
  PassportViewerPlansList,
} from '../PassportHomePreviews.tsx';
import type {
  PassportProjectionView,
  PassportMemoryView,
  PlanProjection,
} from '../../../services/passportProjection.ts';
import type { UsePassportProjectionResult } from '../../../hooks/usePassportProjection.ts';

// ── expo-router — jest.fn router so navigation is assertable ───────────────────
// NOTE: intentionally exhaustive — spreads the mapped manual mock, overriding
// only `router` with jest.fn spies.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    navigate: jest.fn(),
  },
}));

// CachedImage pulls Supabase media-hydration; stub to a null render so the
// preview band mounts without the network.
// NOTE: intentional stub — media rendering is not under test here.
jest.mock('../../CachedImage.tsx', () => ({ CachedImage: () => null }));

const { router } = require('expo-router');
const mockPush = router.push as jest.Mock;

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeProjection(overrides: Partial<PassportProjectionView> = {}): PassportProjectionView {
  return {
    userId: 'them-1',
    identity: {
      userId: 'them-1',
      name: 'Mai Tran',
      handle: 'mai',
      avatarUrl: null,
      verified: true,
      verificationLevel: 'basic_verified',
      homeCountry: 'Vietnam',
    },
    viewerContext: 'following',
    travelerState: { state: 'traveling', label: 'Traveling · Da Nang', city: 'Da Nang', validFrom: null, expiresAt: null },
    availability: { openToPlans: true, socialAvailability: 'open', currentWindow: null, expiresAt: null },
    trust: { label: 'Strong', publicLevel: 'strong', score: null, confidence: 'high' },
    hasTravelIdentity: true,
    stats: { countries: 3, cities: 5, stamps: 12, trips: 2 },
    recentStamps: [
      {
        source: 'trip_derived', name: 'Da Nang', city: 'Da Nang', country: 'Vietnam',
        earnedAt: '2026-07-01T00:00:00Z', rarity: 'rare', artworkUrl: null, verification: 'verified',
      },
    ],
    featuredJourney: {
      tripId: 'trip-1', title: '30 Days in Vietnam', city: 'Da Nang', country: 'Vietnam',
      durationLabel: '30 days', year: 2026, memoryCount: 8, stampCount: 5,
    },
    upcomingPlans: [
      {
        tripId: 'trip-bkk', title: 'Bangkok week', destinationCity: 'Bangkok',
        destinationCountry: 'Thailand', startDate: '2026-09-14', endDate: '2026-09-17', visibility: 'public',
      },
    ],
    memories: [
      {
        id: 'mem-1', title: 'Rooftop sunset', city: 'Da Nang', country: 'Vietnam',
        category: 'city', photoUrl: null, earnedAt: '2026-07-02T00:00:00Z', tripId: 'trip-1',
      },
    ],
    sharedContext: {
      summaryLabel: 'Strong travel overlap',
      factCount: 2,
      facts: [{ key: 'both_in_city', label: 'Both in Da Nang', detail: null }],
      handoffEligible: true,
    },
    actions: {
      can_follow: true, can_message: true, can_make_plan: true,
      can_invite_trip: false, can_view_availability: true, can_view_trust: true,
    },
    interests: ['Food'],
    restricted: false,
    ...overrides,
  };
}

function hook(data: PassportProjectionView | null): UsePassportProjectionResult {
  return { data, loading: false, error: null, reload: jest.fn() };
}

beforeEach(() => jest.clearAllMocks());

// ── Previews render from the projection ───────────────────────────────────────

describe('PassportHomePreviews — previews render from the projection', () => {
  it('renders recent stamps, Featured Journey, next Trip and memories', async () => {
    await render(<PassportHomePreviews userId="them-1" isOwner hookOverride={hook(makeProjection())} />);

    expect(screen.getByTestId('passport-home-previews')).toBeTruthy();
    expect(screen.getByTestId('passport-preview-stamps')).toBeTruthy();
    expect(screen.getByTestId('passport-preview-featured-journey')).toBeTruthy();
    expect(screen.getByTestId('passport-preview-next-trip')).toBeTruthy();
    expect(screen.getByTestId('passport-preview-memories')).toBeTruthy();
    expect(screen.getByText('30 Days in Vietnam')).toBeTruthy();
    expect(screen.getByText('Bangkok week')).toBeTruthy();
  });

  it('renders nothing (fail-soft) when the projection is unavailable', async () => {
    await render(<PassportHomePreviews userId="them-1" isOwner hookOverride={hook(null)} />);
    expect(screen.queryByTestId('passport-home-previews')).toBeNull();
  });

  it('owner context shows neither Make-a-Plan nor the Shared-Context entry', async () => {
    await render(<PassportHomePreviews userId="me-1" isOwner hookOverride={hook(makeProjection())} />);
    expect(screen.queryByTestId('passport-make-a-plan')).toBeNull();
    expect(screen.queryByTestId('passport-shared-context-entry')).toBeNull();
  });
});

// ── Make a Plan — capability gated (§18/§30) ──────────────────────────────────

describe('PassportHomePreviews — Make a Plan capability gate', () => {
  it('renders and routes to Compass when can_make_plan is true', async () => {
    await render(
      <PassportHomePreviews
        userId="them-1"
        isOwner={false}
        otherName="Mai Tran"
        hookOverride={hook(makeProjection())}
      />,
    );

    const btn = screen.getByTestId('passport-make-a-plan');
    expect(btn).toBeTruthy();

    fireEvent.press(btn);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: '/(tabs)/ai' }),
    );
  });

  it('is absent when can_make_plan is false', async () => {
    const proj = makeProjection({
      actions: {
        can_follow: true, can_message: true, can_make_plan: false,
        can_invite_trip: false, can_view_availability: true, can_view_trust: true,
      },
    });
    await render(
      <PassportHomePreviews userId="them-1" isOwner={false} hookOverride={hook(proj)} />,
    );
    expect(screen.queryByTestId('passport-make-a-plan')).toBeNull();
    // The Shared-Context entry is still present for any viewer.
    expect(screen.getByTestId('passport-shared-context-entry')).toBeTruthy();
  });
});

// ── Shared Context entry — reachability (F1) ──────────────────────────────────

describe('PassportHomePreviews — Shared-Context entry (F1)', () => {
  it('routes to /passport/shared-context with the viewed user id and name', async () => {
    await render(
      <PassportHomePreviews
        userId="them-1"
        isOwner={false}
        otherName="Mai Tran"
        hookOverride={hook(makeProjection())}
      />,
    );

    fireEvent.press(screen.getByTestId('passport-shared-context-entry'));
    expect(mockPush).toHaveBeenCalledTimes(1);
    const arg = mockPush.mock.calls[0][0] as string;
    expect(typeof arg).toBe('string');
    expect(arg).toContain('/passport/shared-context?userId=them-1');
    expect(arg).toContain('name=Mai%20Tran');
  });

  it('shows the qualitative summary label (never a numeric score)', async () => {
    await render(
      <PassportHomePreviews userId="them-1" isOwner={false} hookOverride={hook(makeProjection())} />,
    );
    expect(screen.getByText('Strong travel overlap')).toBeTruthy();
    expect(screen.queryByText(/\d+%/)).toBeNull();
  });
});

// ── Viewer Memories/Plans lists (F3) ──────────────────────────────────────────

describe('PassportViewerMemoriesList (F3)', () => {
  const memories: PassportMemoryView[] = [
    { id: 'm1', title: 'Rooftop sunset', city: 'Da Nang', country: 'Vietnam', category: 'city', photoUrl: null, earnedAt: null, tripId: null },
  ];

  it('renders permitted memories', async () => {
    await render(<PassportViewerMemoriesList memories={memories} />);
    expect(screen.getByTestId('viewer-memories-list')).toBeTruthy();
    expect(screen.getByText('Rooftop sunset')).toBeTruthy();
  });

  it('shows an empty state when the projection returned none', async () => {
    await render(<PassportViewerMemoriesList memories={[]} />);
    expect(screen.getByTestId('viewer-memories-empty')).toBeTruthy();
    expect(screen.queryByTestId('viewer-memories-list')).toBeNull();
  });
});

describe('PassportViewerPlansList (F3)', () => {
  const plans: PlanProjection[] = [
    { tripId: 'trip-bkk', title: 'Bangkok week', destinationCity: 'Bangkok', destinationCountry: 'Thailand', startDate: '2026-09-14', endDate: '2026-09-17', visibility: 'public' },
  ];

  it('renders permitted plans and routes to the trip on press', async () => {
    await render(<PassportViewerPlansList plans={plans} />);
    expect(screen.getByTestId('viewer-plans-list')).toBeTruthy();
    fireEvent.press(screen.getByText('Bangkok week'));
    expect(mockPush).toHaveBeenCalledWith('/trip/trip-bkk');
  });

  it('shows an empty state when the projection returned none', async () => {
    await render(<PassportViewerPlansList plans={[]} />);
    expect(screen.getByTestId('viewer-plans-empty')).toBeTruthy();
    expect(screen.queryByTestId('viewer-plans-list')).toBeNull();
  });
});
