/**
 * Edit trip (app/trip/edit.tsx) — the owner's "Let people ask to join" and
 * "Show this trip in discovery" switches.
 *
 * PATCH /trips/:tripId has always accepted allowJoinRequests / showInDiscovery,
 * but no screen offered them and updateTrip never sent them, so both stayed at
 * their `false` defaults and every "Request to join" was refused by the server
 * ("This trip does not accept join requests"). The owner now sees both,
 * loaded with their current values, and saving sends them.
 *
 * Run with: npx jest app/trip/__tests__/tripEdit.joinAndDiscovery.component.test.tsx
 */
import React from 'react';
import { render, act, screen, fireEvent, waitFor } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({ id: 'trip-1' }),
}));

let mockUserId = 'owner-1';
// NOTE: intentional stub — who is signed in is the case under test.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ isAuthed: true, configured: true, userId: mockUserId }),
}));

const mockGetTrip = jest.fn();
const mockGetTripMemberRole = jest.fn();
const mockUpdateTrip = jest.fn();
jest.mock('../../../src/services/trips', () => ({
  ...jest.requireActual('../../../src/services/trips'),
  getTrip: (...a: unknown[]) => mockGetTrip(...a),
  getTripMemberRole: (...a: unknown[]) => mockGetTripMemberRole(...a),
  updateTrip: (...a: unknown[]) => mockUpdateTrip(...a),
}));

// The save resolves the stored destination canonically; here it is kept as is.
jest.mock('../../../src/lib/location/resolveCanonical', () => ({
  ...jest.requireActual('../../../src/lib/location/resolveCanonical'),
  resolveCanonicalPlace: async (p: unknown) => p,
}));

// NOTE: intentionally exhaustive — the pickers are full modals, closed throughout.
jest.mock('../../../src/components/selectors/GlobalCalendarPicker', () => ({ GlobalCalendarPicker: () => null }));
// NOTE: intentionally exhaustive — the pickers are full modals, closed throughout.
jest.mock('../../../src/components/selectors/GlobalPlacePicker', () => ({ GlobalPlacePicker: () => null }));

import EditTrip from '../edit.tsx';

const TRIP = {
  id: 'trip-1', ownerId: 'owner-1', title: 'Lisbon', destinationCity: 'Lisbon', destinationCountry: 'Portugal',
  neighborhoods: [], startDate: null, endDate: null, status: 'planning', visibility: 'public',
  travelStyle: null, openToMeet: false, coverUrl: null, coverMediaType: null, progress: 0, tripNotes: null,
  showHeaderPublicly: true, allowJoinRequests: false, showInDiscovery: true,
};

async function renderLoaded() {
  await render(<EditTrip />);
  await act(async () => {});
}

describe('Edit trip — join requests and discovery', () => {
  beforeEach(() => {
    mockUserId = 'owner-1';
    mockGetTrip.mockReset(); mockGetTripMemberRole.mockReset(); mockUpdateTrip.mockReset();
    mockUpdateTrip.mockResolvedValue({ ...TRIP });
  });

  it('the owner sees both switches with their saved values, and saving sends them', async () => {
    mockGetTrip.mockResolvedValue(TRIP);
    await renderLoaded();
    const join = screen.getByLabelText('Let people ask to join');
    const discovery = screen.getByLabelText('Show this trip in discovery');
    expect(join.props.value).toBe(false);
    expect(discovery.props.value).toBe(true);
    await act(async () => { fireEvent(join, 'valueChange', true); });
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });
    await waitFor(() => expect(mockUpdateTrip).toHaveBeenCalledTimes(1));
    expect(mockUpdateTrip.mock.calls[0]![1]).toMatchObject({ allowJoinRequests: true, showInDiscovery: true });
  });

  it('discovery lists public trips only, so a private trip offers the join switch alone', async () => {
    mockGetTrip.mockResolvedValue({ ...TRIP, visibility: 'private', showHeaderPublicly: false });
    await renderLoaded();
    expect(screen.getByLabelText('Let people ask to join')).toBeTruthy();
    expect(screen.queryByLabelText('Show this trip in discovery')).toBeNull();
  });

  it("a co-host sees neither (they are the owner's switches) and saving does not send them", async () => {
    mockUserId = 'cohost-1';
    mockGetTrip.mockResolvedValue(TRIP);
    mockGetTripMemberRole.mockResolvedValue('co_host');
    await renderLoaded();
    expect(screen.queryByLabelText('Let people ask to join')).toBeNull();
    expect(screen.queryByLabelText('Show this trip in discovery')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });
    await waitFor(() => expect(mockUpdateTrip).toHaveBeenCalledTimes(1));
    const sent = mockUpdateTrip.mock.calls[0]![1] as Record<string, unknown>;
    expect('allowJoinRequests' in sent).toBe(false);
    expect('showInDiscovery' in sent).toBe(false);
  });
});
