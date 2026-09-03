/**
 * Component tests for PlansScreen — the Plans Passport surface (spec §16).
 *
 * Covers the contract points for this screen:
 *   1. OWN passport: each plan renders a per-plan visibility control reflecting
 *      its current visibility, and changing it writes that plan's visibility.
 *   2. ANOTHER passport: Trip overlap is computed from the two permitted plan
 *      lists and rendered ("You'll both be in Bangkok Sep 14–17"), with a
 *      "Connect for Bangkok" action when the server flag permits it.
 *   3. The pure computeTripOverlap intersects by city + date window.
 *
 * The real usePassportPlans hook runs against mocked services, so the data flow
 * (fetch → self detection → overlap compute → visibility write) is exercised.
 *
 * NOTE: render() is awaited (RNTL 14 + React 19 + jest-expo) or the screen
 * stays unbound and queries throw "render not called".
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import PlansScreen from '../PlansScreen.tsx';
import { computeTripOverlap } from '../usePassportPlans.ts';
import { getPassportProjection } from '../../../services/passportProjection.ts';
import { updateTrip } from '../../../services/trips.ts';
import type { PassportProjectionView, PlanProjection } from '../../../services/passportProjection.ts';

// NOTE: intentional stub — the real service reaches Supabase auth + the API
// server, neither available under jest-expo. getPassportProjection is the seam
// under test; _setTestAuthToken is a no-op so imports don't crash.
jest.mock('../../../services/passportProjection', () => ({
  getPassportProjection: jest.fn(),
  _setTestAuthToken: jest.fn(),
}));

// NOTE: intentional stub — trips.ts imports supabase (native). updateTrip is the
// write seam for per-plan visibility; nothing else here is exercised.
jest.mock('../../../services/trips', () => ({
  updateTrip: jest.fn(),
}));

// NOTE: expo-router native navigation modules are unavailable in jest-expo —
// exhaustive stub of the members this screen touches.
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), back: jest.fn() },
}));

// NOTE: safe-area provider isn't mounted in unit renders — return fixed insets.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

const mockGetProjection = getPassportProjection as jest.Mock;
const mockUpdateTrip = updateTrip as jest.Mock;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const DEFAULT_ACTIONS = {
  can_follow: true,
  can_message: true,
  can_make_plan: true,
  can_invite_trip: false,
  can_view_availability: true,
  can_view_trust: true,
};

function makeIdentity(userId: string, name: string, handle: string) {
  return {
    userId,
    name,
    handle,
    avatarUrl: null,
    verified: true,
    verificationLevel: 'trusted_traveler',
    homeCountry: 'Vietnam',
  };
}

function selfProjection(plans: PlanProjection[]): PassportProjectionView {
  return {
    userId: 'me',
    identity: makeIdentity('me', 'Ada Lovelace', 'ada'),
    viewerContext: 'self',
    upcomingPlans: plans,
    actions: DEFAULT_ACTIONS,
    interests: ['Food', 'Nightlife'],
    restricted: false,
  };
}

function otherProjection(plans: PlanProjection[], canMakePlan = true): PassportProjectionView {
  return {
    userId: 'them',
    identity: makeIdentity('them', 'Mai Tran', 'mai'),
    viewerContext: 'following',
    upcomingPlans: plans,
    actions: { ...DEFAULT_ACTIONS, can_make_plan: canMakePlan },
    interests: [],
    restricted: false,
  };
}

const bangkokTheirs: PlanProjection = {
  tripId: 'trip-bkk-them',
  title: 'Bangkok week',
  destinationCity: 'Bangkok',
  destinationCountry: 'Thailand',
  startDate: '2026-09-14',
  endDate: '2026-09-20',
  visibility: 'public',
};

const bangkokMine: PlanProjection = {
  tripId: 'trip-bkk-me',
  title: 'Thailand run',
  destinationCity: 'Bangkok',
  destinationCountry: 'Thailand',
  startDate: '2026-09-12',
  endDate: '2026-09-17',
  visibility: 'private',
};

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Pure overlap ─────────────────────────────────────────────────────────────

describe('computeTripOverlap', () => {
  it('intersects by city and reports the overlapping date window', () => {
    const overlaps = computeTripOverlap([bangkokMine], [bangkokTheirs]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].city).toBe('Bangkok');
    // Intersection of 09-12..09-17 and 09-14..09-20 is 09-14..09-17.
    expect(overlaps[0].startDate).toBe('2026-09-14');
    expect(overlaps[0].endDate).toBe('2026-09-17');
    expect(overlaps[0].label).toBe("You'll both be in Bangkok Sep 14–17");
  });

  it('returns no overlap when cities differ', () => {
    const tokyo: PlanProjection = { ...bangkokMine, destinationCity: 'Tokyo' };
    expect(computeTripOverlap([tokyo], [bangkokTheirs])).toHaveLength(0);
  });

  it('reports a city overlap without dates when exact dates are hidden', () => {
    const hidden: PlanProjection = { ...bangkokTheirs, startDate: null, endDate: null };
    const overlaps = computeTripOverlap([bangkokMine], [hidden]);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].startDate).toBeNull();
    expect(overlaps[0].label).toBe("You'll both be in Bangkok");
  });
});

// ── Self view: per-plan visibility ───────────────────────────────────────────

describe('PlansScreen — own passport', () => {
  it('renders a per-plan visibility control reflecting the current visibility', async () => {
    mockGetProjection.mockResolvedValueOnce({ ok: true, data: selfProjection([bangkokMine]) });

    await render(<PlansScreen targetUserId={null} viewerUserId="me" />);

    await waitFor(() => {
      expect(screen.getByText('Thailand run')).toBeTruthy();
    });
    // The visibility control exposes its current state via an accessibility label.
    expect(screen.getByLabelText('Plan visibility: Private')).toBeTruthy();
    // All four visibility options are offered to the owner.
    expect(screen.getByLabelText('Set visibility to Public')).toBeTruthy();
    expect(screen.getByLabelText('Set visibility to Buddies')).toBeTruthy();
  });

  it('writes the new visibility for that plan when a different option is tapped', async () => {
    mockGetProjection.mockResolvedValueOnce({ ok: true, data: selfProjection([bangkokMine]) });
    mockUpdateTrip.mockResolvedValueOnce({ id: 'trip-bkk-me', visibility: 'public' });

    await render(<PlansScreen targetUserId={null} viewerUserId="me" />);

    await waitFor(() => expect(screen.getByText('Thailand run')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Set visibility to Public'));

    await waitFor(() => {
      expect(mockUpdateTrip).toHaveBeenCalledWith('trip-bkk-me', { visibility: 'public' });
    });
  });
});

// ── Other view: overlap + Connect ────────────────────────────────────────────

describe('PlansScreen — another passport', () => {
  it('renders trip overlap and a Connect CTA when the server permits it', async () => {
    // First fetch = owner (them); second = viewer's own plans (me).
    mockGetProjection
      .mockResolvedValueOnce({ ok: true, data: otherProjection([bangkokTheirs], true) })
      .mockResolvedValueOnce({ ok: true, data: selfProjection([bangkokMine]) });

    const onConnect = jest.fn();
    await render(<PlansScreen targetUserId="them" viewerUserId="me" onConnect={onConnect} />);

    await waitFor(() => {
      expect(screen.getByText("You'll both be in Bangkok Sep 14–17")).toBeTruthy();
    });

    const connect = screen.getByLabelText('Connect for Bangkok');
    expect(connect).toBeTruthy();
    fireEvent.press(connect);
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onConnect.mock.calls[0][0].city).toBe('Bangkok');

    // Viewing another passport must NOT expose owner visibility controls.
    expect(screen.queryByLabelText('Set visibility to Public')).toBeNull();
  });

  it('hides the Connect CTA when the server withholds can_make_plan', async () => {
    mockGetProjection
      .mockResolvedValueOnce({ ok: true, data: otherProjection([bangkokTheirs], false) })
      .mockResolvedValueOnce({ ok: true, data: selfProjection([bangkokMine]) });

    await render(<PlansScreen targetUserId="them" viewerUserId="me" />);

    await waitFor(() => {
      expect(screen.getByText("You'll both be in Bangkok Sep 14–17")).toBeTruthy();
    });
    expect(screen.queryByLabelText('Connect for Bangkok')).toBeNull();
  });
});
