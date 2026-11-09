/**
 * Create trip (app/trip/new.tsx) — the picked destination's point reaches the trip.
 *
 * POST /trips stores only the city and country, so every trip made in the app had
 * no destination_lat/lng and never appeared on the map. The screen now sends the
 * pick's point, canonical id and zone in a follow-up PATCH (lib/tripDestinationGeo.ts).
 *
 * Pinned: the PATCH carries the binding's point; a pick with no point sends nothing;
 * a PATCH that fails still opens the created trip and says the pin was not saved.
 *
 * Run with: pnpm --dir travel-buddy-standalone run test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, screen, act } from '@testing-library/react-native';
import NewTrip from '../../../app/trip/new.tsx';

// NOTE: intentionally exhaustive — expo-router pulls native navigation internals.
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
  router: { replace: (...a: unknown[]) => mockReplace(...a), push: jest.fn() },
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context has native internals.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — SessionContext uses supabase internals.
jest.mock('../../context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'user-1' }),
}));

// NOTE: intentionally exhaustive — StampEarnedToast has async native deps.
jest.mock('../../components/stamps/StampEarnedToast', () => ({
  useStampToast: () => ({ checkForNewStamps: jest.fn() }),
}));

// NOTE: intentionally exhaustive — tripIntel imports apiToken/supabase which
// lazy-init SecureStore native modules that stay open after test teardown.
jest.mock('../../services/tripIntel', () => ({
  draftTripFromText: jest.fn(),
}));

// NOTE: intentionally exhaustive — trips imports supabase + apiToken native deps.
const mockCreateTrip = jest.fn();
const mockUpdateTrip = jest.fn();
jest.mock('../../services/trips', () => ({
  createTrip: (...a: unknown[]) => mockCreateTrip(...a),
  updateTrip: (...a: unknown[]) => mockUpdateTrip(...a),
}));

// NOTE: intentionally exhaustive — tripDestinations imports apiToken native deps.
const mockAddDestination = jest.fn();
jest.mock('../../services/tripDestinations', () => ({
  addDestination: (...a: unknown[]) => mockAddDestination(...a),
  reorderDestinations: jest.fn(),
}));

// NOTE: intentionally exhaustive — GlobalPlacePicker pulls expo-location native internals. The stand-in
// hands back the pick this test sets, the way the real picker reports a selection.
let mockPick: { place: any; binding: any } = { place: null, binding: null };
jest.mock('../../components/selectors/GlobalPlacePicker', () => {
  const ReactActual = jest.requireActual('react');
  const { Pressable } = jest.requireActual('react-native');
  return {
    GlobalPlacePicker: (p: any) => ReactActual.createElement(Pressable, {
      testID: 'mock-place-pick',
      onPress: () => { p.onCanonicalBinding?.(mockPick.binding); p.onSelect?.(mockPick.place); },
    }),
  };
});

// NOTE: intentionally exhaustive — GlobalCalendarPicker pulls calendar native modules.
jest.mock('../../components/selectors/GlobalCalendarPicker', () => ({
  GlobalCalendarPicker: () => null,
}));

// NOTE: intentionally exhaustive — KeyboardSafeScrollView wraps a native scroll view.
jest.mock('../../components/ui/KeyboardSafeView', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return { KeyboardSafeScrollView: ScrollView };
});

// NOTE: intentionally exhaustive — ScreenHeader pulls navigation context.
jest.mock('../../components/ScreenHeader', () => ({
  ScreenHeader: () => null,
}));

// NOTE: intentionally exhaustive — DestinationListEditor pulls its own native deps.
jest.mock('../../components/trip/DestinationListEditor', () => ({
  DestinationListEditor: () => null,
}));



const CEBU_PLACE = {
  id: 'nominatim-1', type: 'city', name: 'Cebu City', displayName: 'Cebu City, Philippines', country: 'Philippines',
  countryCode: 'PH', region: null, city: 'Cebu City', district: null, lat: 10.31, lng: 123.89, timezone: null, source: 'nominatim',
};
const CEBU_BINDING = {
  entityType: 'city', entityId: 'loc_cebu', canonicalId: 'loc_cebu', displayName: 'Cebu City', city: 'Cebu City',
  country: 'Philippines', countryCode: 'PH', neighborhood: null, lat: 10.3157, lng: 123.8854, timezone: 'Asia/Manila', resolved: true,
};

async function pickAndCreate() {
  await render(<NewTrip />);
  await act(async () => { await fireEvent.changeText(screen.getByPlaceholderText('Visayas, June'), 'Cebu week'); });
  await act(async () => { await fireEvent.press(screen.getByTestId('mock-place-pick')); });
  await act(async () => { await fireEvent.press(screen.getByText('Create trip')); });
  await act(async () => {});
}

describe('Create trip — the destination point is saved', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTrip.mockResolvedValue({ id: 'trip-new' });
    mockUpdateTrip.mockResolvedValue({ id: 'trip-new' });
    alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  });
  afterEach(() => alertSpy.mockRestore());

  it("sends the canonical binding's point, id and zone to the new trip", async () => {
    mockPick = { place: CEBU_PLACE, binding: CEBU_BINDING };
    await pickAndCreate();
    expect(mockCreateTrip).toHaveBeenCalledTimes(1);
    expect(mockUpdateTrip).toHaveBeenCalledWith('trip-new', {
      destinationLat: 10.3157, destinationLng: 123.8854, destinationPlaceId: 'loc_cebu', timezone: 'Asia/Manila',
    });
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('a pick with no point and no id sends no PATCH', async () => {
    mockPick = { place: { ...CEBU_PLACE, lat: null, lng: null, source: 'manual' }, binding: null };
    await pickAndCreate();
    expect(mockCreateTrip).toHaveBeenCalledTimes(1);
    expect(mockUpdateTrip).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
  });

  it('a failed PATCH still opens the created trip and says the pin was not saved', async () => {
    mockPick = { place: CEBU_PLACE, binding: null };
    mockUpdateTrip.mockRejectedValue(new Error('Network request failed'));
    await pickAndCreate();
    expect(mockReplace).toHaveBeenCalledWith('/trip/trip-new');
    expect(screen.queryByText('Network request failed')).toBeNull();
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toBe('Map pin not saved');
  });
});
