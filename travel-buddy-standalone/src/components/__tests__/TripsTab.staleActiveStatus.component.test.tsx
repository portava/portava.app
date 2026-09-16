/**
 * TripsTab — stale 'active' status badge tests
 *
 * Confirms that TripCard derives its display status from the trip's end date
 * rather than the raw stored `status` column, so a trip whose end date has
 * already passed never shows a stale "Active" badge.
 *
 * Scenarios:
 *   1. status='active' + past endDate → badge shows "Completed"
 *   2. status='active' + future endDate → badge shows "Active"
 *
 * Run with: pnpm --dir travel-buddy-standalone test -- --watchAll=false
 *
 * ## Mock strategy
 *
 * useBottomInset is mocked at the hook boundary to avoid dragging in reanimated
 * native binaries (makeMutable crashes in the jest-expo runner).
 * VideoThumbnail is mocked because it imports expo-image which requires native
 * binaries unavailable under jest-expo.
 * expo-router and lucide-react-native are already aliased via moduleNameMapper.
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { TripsTab } from '../TripsTab.tsx';
import type { TripRow } from '../../services/trips.ts';

// NOTE: intentionally exhaustive — useBottomInset.ts imports useNavBarCollapse
// which calls makeMutable() (reanimated) at module scope; requireActual would
// execute that import chain and crash the JSDOM suite.
jest.mock('../../hooks/useBottomInset.ts', () => ({
  usePlainBottomInset: () => 130,
  PlainBottomFiller: () => null,
  BOTTOM_BREATHING_ROOM: 24,
  useStickyBarInset: () => ({ inset: 130, onBarLayout: () => {} }),
  useKeyboardVisible: () => false,
  useBottomInset: () => 130,
}));

// NOTE: intentionally exhaustive — VideoThumbnail imports expo-image which
// uses native ExpoView and ImageModule internals unavailable under jest-expo.
// A null stub is sufficient because these tests only inspect badge text.
jest.mock('../ui/VideoThumbnail.tsx', () => ({
  VideoThumbnail: () => null,
}));

// ── Fixture factory ───────────────────────────────────────────────────────────

/** A date `days` from the real clock, as the 'YYYY-MM-DD' TripRow expects. */
function isoDaysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function makeTrip(overrides: Partial<TripRow> = {}): TripRow {
  return {
    id: 'trip-1',
    ownerId: 'owner-1',
    title: 'Tokyo Adventure',
    destinationCity: 'Tokyo',
    destinationCountry: 'Japan',
    neighborhoods: [],
    startDate: '2025-03-01',
    endDate: '2025-03-15',
    status: 'active',
    visibility: 'public',
    travelStyle: null,
    openToMeet: true,
    coverUrl: null,
    coverMediaType: null,
    progress: 0,
    tripType: null,
    timezone: null,
    destinationLat: 35.68,
    destinationLng: 139.69,
    destinationPlaceId: null,
    tripNotes: null,
    showOnProfile: true,
    showInDiscovery: true,
    allowFriendSuggestions: true,
    allowTripCrewInvites: true,
    allowJoinRequests: false,
    showExactDates: true,
    showDestinationCity: true,
    delayedPostingDefault: false,
    preciseLocationVisible: false,
    planEditPermission: null,
    // Required by TripRow; absent from these defaults, so the factory's return
    // type had it as `boolean | undefined` and could not satisfy TripRow.
    showHeaderPublicly: false,
    ...overrides,
  };
}

// ── Tests — past trip with stale 'active' status ───────────────────────────────

describe('TripsTab — stale active status: past endDate shows Completed', () => {
  it('renders "Completed" badge when status is active but endDate is in the past', async () => {
    // endDate is well in the past; the stored status was never updated.
    const trip = makeTrip({ id: 'past-trip', status: 'active', endDate: '2024-06-01' });
    await render(<TripsTab trips={[trip]} isOwner />);

    // TripCard derives displayStatus = 'completed' → badge text = 'Completed'.
    expect(screen.getByText('Completed')).toBeTruthy();
  });

  it('does NOT render "Active" when status is active but endDate is in the past', async () => {
    const trip = makeTrip({ id: 'past-trip', status: 'active', endDate: '2024-06-01' });
    await render(<TripsTab trips={[trip]} isOwner />);

    expect(screen.queryByText('Active')).toBeNull();
  });
});

// ── Tests — active trip with future endDate still shows Active ─────────────────

describe('TripsTab — active status: future endDate still shows Active', () => {
  it('renders "Active" badge when status is active and endDate is in the future', async () => {
    // Two future-active trips are needed: the soonest is promoted to the
    // featured card (which shows an "Ongoing" pill from the bucket label,
    // not from tripStatusLabel), while the second trip stays in the list
    // and is rendered as a TripCard with its derived badge.
    //
    // The windows are dated from the REAL clock. TripCard derives the badge by
    // comparing the end date to `new Date()`, and this suite renders the
    // component — there is no clock to inject. Pinned to 2027-01-15 and
    // 2027-02-15, "future endDate" stopped being true on those dates and this
    // assertion would have started reporting the derivation as broken at the
    // exact moment the derivation was right. Its sibling
    // TripsTab.playBadge.component.test.tsx died that way on 2026-09-16.
    //
    // `status: 'active'` stays a literal, and the contradiction is deliberate:
    // the stored column is the STALE one this file exists to prove is ignored.
    const featured = makeTrip({
      id: 'future-trip-a',
      status: 'active',
      startDate: isoDaysFromNow(30),
      endDate: isoDaysFromNow(44),
    });
    const inList = makeTrip({
      id: 'future-trip-b',
      status: 'active',
      startDate: isoDaysFromNow(60),
      endDate: isoDaysFromNow(74),
    });

    await render(<TripsTab trips={[featured, inList]} isOwner />);

    // The list TripCard derives displayStatus = 'active' → badge text = 'Active'.
    expect(screen.getByText('Active')).toBeTruthy();
  });
});
