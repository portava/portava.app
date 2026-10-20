import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import CreateEventScreen from '../create/index.tsx';
import { Alert } from 'react-native';
import * as ExpoLocation from 'expo-location';
import { setDiscoveryViewerFromSession, invalidateDiscoveryCaches } from '../../../src/services/discoveryViewerScope.ts';
import { disposeObservedOwnerSession, seedObservedOwnerSession } from '../../../src/services/__tests__/observedOwnerSessionFixture.ts';
import { _seedPolicyForTests } from '../../../src/platform/input-assistance/services/policyStore.ts';
import { registerGeographicFields } from '../../../src/platform/input-assistance/geographic/geoFields.ts';
import { sharedSuggestionCache, SuggestionCache, inputSessionScopeKey } from '../../../src/platform/input-assistance/services/suggestionCache.ts';

let mockOwner: string | null = 'owner-a';
// The SDK token carries the same session_id the observed SIGNED_IN session does (beforeEach).
const token = () => mockOwner ? `header.${btoa(JSON.stringify({ sub: mockOwner, session_id: `${mockOwner}-session` }))}.signature` : null;
let mockDraft = {};
let mockParams = { draftId: 'existing-draft' };
let mockLegacy = false;
const mockPlace = {
  id: 'legacy-venue', type: 'place', name: 'Legacy Venue', displayName: 'Legacy Venue, Da Nang',
  city: 'Da Nang', country: 'Vietnam', countryCode: 'VN', canonicalId: 'legacy-venue',
  lat: 16.07, lng: 108.22, timezone: 'Asia/Ho_Chi_Minh', source: 'canonical',
};
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => mockParams, usePathname: () => '/events/create',
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'), useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
/** NOTE: the auth SDK is isolated to avoid its native storage and live auto-refresh timers.
 * onAuthStateChange records its listeners so beforeEach can deliver SIGNED_IN to the REAL
 * owner observer (src/services/__tests__/observedOwnerSessionFixture.ts) — the picker leases
 * the OBSERVED session; a named Discovery viewer alone is not authority. */
jest.mock('../../../src/lib/supabase.ts', () => {
  const listeners = new Set<any>();
  return {
    isSupabaseConfigured: true, authedClient: () => null,
    supabase: { auth: {
      getSession: async () => ({ data: { session: { access_token: token(), expires_at: Math.floor(Date.now() / 1000) + 3600 } } }),
      refreshSession: async () => ({ data: { session: { access_token: token() } } }),
      listeners,
      onAuthStateChange: (listener: any) => {
        listeners.add(listener);
        return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
      },
    } },
  };
});
jest.mock('../../../src/components/ui/KeyboardSafeView.tsx', () => ({
  ...jest.requireActual('../../../src/components/ui/KeyboardSafeView.tsx'),
  KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => {
    const { View } = require('react-native'); return <View>{children}</View>;
  },
}));
jest.mock('../../../src/hooks/usePlaceSearch.ts', () => ({
  ...jest.requireActual('../../../src/hooks/usePlaceSearch.ts'),
  usePlaceSearch: (text: string) => ({ results: mockLegacy && text ? [mockPlace] : [], loading: false, error: null }),
  fetchPlacesFromApi: jest.fn(),
}));
jest.mock('../../../src/hooks/useGooglePlacesAutocomplete.ts', () => ({
  ...jest.requireActual('../../../src/hooks/useGooglePlacesAutocomplete.ts'),
  useGooglePlacesAutocomplete: () => ({ places: [], loading: false }), fetchGooglePlaceDetails: jest.fn(),
}));
jest.mock('../../../src/hooks/useRecentPlaces.ts', () => ({
  ...jest.requireActual('../../../src/hooks/useRecentPlaces.ts'),
  useRecentPlaces: () => ({ recents: [], saveRecent: jest.fn() }),
}));
jest.mock('../../../src/hooks/usePopularCities.ts', () => ({
  ...jest.requireActual('../../../src/hooks/usePopularCities.ts'),
  usePopularCities: () => ({ places: [] }),
}));
jest.mock('expo-location', () => ({
  ...jest.requireActual('expo-location'),
  getForegroundPermissionsAsync: async () => ({ granted: false }), getLastKnownPositionAsync: async () => null,
  requestForegroundPermissionsAsync: jest.fn(), getCurrentPositionAsync: jest.fn(),
}));

const canonicalRow = {
  id: 'event_location:places:11111111-1111-4111-8111-111111111111',
  context: 'event_location', type: 'entity', entityType: 'place', entityId: '11111111-1111-4111-8111-111111111111',
  label: 'Canonical Sky36', subtitle: 'Da Nang', source: 'canonical', confidence: 0.99,
  action: { type: 'open_entity', entityType: 'place', entityId: '11111111-1111-4111-8111-111111111111' },
  structuredValue: {
    entityType: 'venue', venueId: '11111111-1111-4111-8111-111111111111', venue: 'Canonical Sky36',
    cityId: '22222222-2222-4222-8222-222222222222', city: 'Da Nang', country: 'Vietnam', countryCode: 'VN',
    lat: 16.07, lng: 108.22, timezone: 'Asia/Ho_Chi_Minh',
  },
  policyVersion: 'test-policy-v1',
};

const fetchMock = jest.fn();
const originalFetch = global.fetch;
const originalBase = process.env.EXPO_PUBLIC_API_BASE_URL;
let served: unknown[] = [];
let unavailable = false;
let holdRequest: ((body: any, init: RequestInit) => Promise<unknown> | undefined) | undefined;
const requests = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/input-assistance/suggest'))
  .map(([, init]) => JSON.parse(init.body));
const locationRequests = () => requests().filter(body => body.context === 'event_location');
const writes = () => fetchMock.mock.calls.filter(([url, init]) => String(url).includes('/api/events/') && init?.method && init.method !== 'GET');
const draftPayload = () => JSON.parse(writes().at(-1)![1].body);
const answer = (suggestions: unknown[]) => ({ ok: true, status: 200, json: async () => ({ suggestions, policyVersion: 'test-policy-v1', schemaVersion: 1 }) });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>(accept => { resolve = accept; });
  return { promise, resolve };
};

beforeEach(() => {
  jest.useFakeTimers();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://api.test';
  mockLegacy = false;
  mockOwner = 'owner-a';
  mockParams = { draftId: 'existing-draft' };
  mockDraft = { id: 'existing-draft', title: 'Existing event', description: 'Private event notes', startsAt: '2030-06-07T20:00:00Z', visibility: 'invite_only', circleId: 'private-circle', tripId: 'private-trip' };
  served = [canonicalRow];
  unavailable = false;
  holdRequest = undefined;
  fetchMock.mockReset();
  seedObservedOwnerSession(mockOwner, `${mockOwner}-session`);
  setDiscoveryViewerFromSession(mockOwner);
  sharedSuggestionCache.clear();
  registerGeographicFields();
  _seedPolicyForTests(['event_title', 'event_location'], {
    event_title: { mode: 'free_text_assisted', allowedSuggestionTypes: ['disambiguation', 'correction'], entityTypes: ['event'], privacyClass: 'public', offlinePolicy: 'unavailable' },
    event_location: { mode: 'canonical_picker', allowedSuggestionTypes: ['entity', 'recent', 'disambiguation', 'action', 'validation'], entityTypes: ['place', 'city'], privacyClass: 'public', offlinePolicy: 'server_required', minChars: 2, debounceMs: 120, zeroStateAssistance: true, allowPersonalization: false, allowLiveContext: true, allowMemoryContext: false, allowAI: false, localSufficient: false },
  });
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (url.endsWith('/api/input-assistance/suggest')) {
      const body = JSON.parse(String(init.body ?? '{}'));
      if (body.context === 'event_location') {
        const pending = holdRequest?.(body, init);
        if (pending) return pending;
        if (unavailable) return { ok: false, status: 503, json: async () => ({ error: 'unavailable' }) };
        return answer(body.text ? served : []);
      }
      return answer([]);
    }
    if (url.endsWith('/api/events/drafts/existing-draft') && !init.method) {
      return { ok: true, status: 200, json: async () => mockDraft };
    }
    if (url.endsWith('/api/events/drafts/existing-draft') && init.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
  });
  global.fetch = fetchMock;
});
afterEach(async () => {
  await cleanup();
  disposeObservedOwnerSession();
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  global.fetch = originalFetch;
  if (originalBase === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = originalBase;
});

async function mountLocation() {
  await render(<CreateEventScreen />);
  await screen.findByText('Search for a venue, landmark, or address…');
}
async function openPicker(text = 'Canonical Sky36') {
  await fireEvent.press(screen.getByText('Search for a venue, landmark, or address…'));
  if (text) await fireEvent.changeText(screen.getByPlaceholderText('City, venue or address…'), text);
}
async function pickCanonical() {
  await screen.findByText('Canonical Sky36, Da Nang');
  await fireEvent.press(screen.getByText('Canonical Sky36, Da Nang'));
  await waitFor(() => expect(screen.queryByPlaceholderText('City, venue or address…')).toBeNull());
}
async function saveNext() {
  await fireEvent.press(screen.getByText('Next'));
  await waitFor(() => expect(writes()).toHaveLength(1));
  expect(writes()[0][1].method).toBe('PATCH');
}
async function closePicker() {
  await fireEvent.press(screen.getAllByTestId('icon-X')[0]);
}
async function tick() {
  await act(async () => { jest.advanceTimersByTime(200); });
}

test('actual Event location uses the existing Input HTTP contract, not private draft context or implicit writes', async () => {
  await mountLocation();
  await openPicker();
  await waitFor(() => expect(locationRequests()).toContainEqual(expect.objectContaining({
    fieldId: 'event.location', context: 'event_location', text: 'Canonical Sky36',
    sessionContext: { surface: 'event_create' },
  })));
  expect(screen.getByText('Canonical Sky36, Da Nang')).toBeTruthy();
  for (const request of locationRequests()) {
    expect(Object.keys(request).sort()).toEqual(['context', 'fieldId', 'limit', 'sessionContext', 'text']);
  }
  await act(async () => { jest.advanceTimersByTime(3000); });
  expect(writes()).toHaveLength(0);
  expect(ExpoLocation.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  expect(ExpoLocation.getCurrentPositionAsync).not.toHaveBeenCalled();
  await pickCanonical();
  expect(screen.getByDisplayValue('Da Nang')).toBeTruthy();
  expect(screen.getByDisplayValue('Vietnam')).toBeTruthy();
  expect(writes()).toHaveLength(0);
  await saveNext();
  expect(draftPayload()).toEqual({
    title: 'Existing event', description: 'Private event notes', startsAt: '2030-06-07T20:00:00.000Z',
    locationName: 'Canonical Sky36, Da Nang', locationLat: 16.07, locationLng: 108.22,
    timezone: 'Asia/Ho_Chi_Minh', city: 'Da Nang', country: 'Vietnam',
    joinMode: 'open', rsvpOptions: ['going', 'maybe', 'interested', 'cant_go'],
    visibility: 'invite_only', circleId: 'private-circle', tripId: 'private-trip',
    priceType: 'free', showHeaderPublicly: false,
  });
});

test.each(['Keep mine', 'Use this place'])('typed city/country require the existing %s confirmation', async choice => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await mountLocation();
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cebu City'), 'Typed city');
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Philippines'), 'Typed country');
  await openPicker();
  await pickCanonical();
  expect(screen.getByDisplayValue('Typed city')).toBeTruthy();
  expect(screen.getByDisplayValue('Typed country')).toBeTruthy();
  expect(alert).toHaveBeenCalledWith('Replace what you typed?',
    'Canonical Sky36, Da Nang is linked. Replace the location details you entered with its own?',
    expect.any(Array));
  const buttons = alert.mock.calls.at(-1)![2]!;
  expect(buttons.map(button => button.text)).toEqual(['Keep mine', 'Use this place']);
  await act(async () => { buttons.find(button => button.text === choice)?.onPress?.(); });
  await saveNext();
  expect(draftPayload()).toMatchObject({
    city: choice === 'Keep mine' ? 'Typed city' : 'Da Nang',
    country: choice === 'Keep mine' ? 'Typed country' : 'Vietnam',
    locationLat: 16.07, locationLng: 108.22,
  });
});

test('zero coordinates survive the mapper, picker and actual draft transport', async () => {
  served = [{ ...canonicalRow, structuredValue: { ...canonicalRow.structuredValue, lat: 0, lng: 0 } }];
  await mountLocation(); await openPicker(); await pickCanonical(); await saveNext();
  expect(draftPayload()).toMatchObject({ locationLat: 0, locationLng: 0 });
});

test('unknown venue city/country/zone stay absent rather than becoming venue name or subtitle', async () => {
  served = [{ ...canonicalRow, structuredValue: {
    entityType: 'venue', venueId: canonicalRow.entityId, venue: canonicalRow.label,
  } }];
  await mountLocation(); await openPicker(); await pickCanonical();
  expect(screen.getByPlaceholderText('e.g. Cebu City').props.value).toBe('');
  expect(screen.getByPlaceholderText('e.g. Philippines').props.value).toBe('');
  await saveNext();
  for (const field of ['city', 'country', 'timezone', 'locationLat', 'locationLng']) {
    expect(draftPayload()).not.toHaveProperty(field);
  }
});

test.each(['identity', 'source', 'action', 'validation', 'approximate', 'unbound validation', 'unbound approximate'])('invalid %s venue rows are not selectable canonical venues', async invalid => {
  let row: any = { ...canonicalRow };
  if (invalid === 'identity') row.structuredValue = { ...canonicalRow.structuredValue, venueId: 'different-venue' };
  if (invalid === 'source') row.source = 'provider';
  if (invalid === 'action') row = { ...row, type: 'action', action: { type: 'open_map' } };
  if (invalid === 'validation') row.type = 'validation';
  if (invalid === 'approximate') row.locationPrecision = 'approximate';
  if (invalid === 'unbound validation') row = { ...row, type: 'validation', structuredValue: undefined };
  if (invalid === 'unbound approximate') row.structuredValue = { kind: 'approximate_area', areaType: 'city', cityId: 'area', city: 'Da Nang' };
  served = [row];
  await mountLocation(); await openPicker();
  await waitFor(() => expect(locationRequests().some(body => body.text === 'Canonical Sky36')).toBe(true));
  await tick();
  expect(screen.queryByText('Canonical Sky36, Da Nang')).toBeNull();
  expect(writes()).toHaveLength(0);
});

test.each(['outage', 'missing policy', 'disabled policy'])('%s keeps legacy provider selection usable', async mode => {
  mockLegacy = true;
  unavailable = mode === 'outage';
  if (mode === 'missing policy') _seedPolicyForTests([]);
  if (mode === 'disabled policy') _seedPolicyForTests(['event_location'], { event_location: { mode: 'no_assistance', allowedSuggestionTypes: [], entityTypes: [], privacyClass: 'public', offlinePolicy: 'unavailable', minChars: Number.MAX_SAFE_INTEGER, maxSuggestions: 0, zeroStateAssistance: false } });
  await mountLocation(); await openPicker('Legacy Venue');
  await screen.findByText('Legacy Venue');
  await fireEvent.press(screen.getByText('Legacy Venue'));
  await screen.findByText('Legacy Venue, Da Nang');
  await saveNext();
  expect(draftPayload()).toMatchObject({ locationName: 'Legacy Venue, Da Nang', city: 'Da Nang', country: 'Vietnam' });
  if (mode !== 'outage') expect(locationRequests()).toHaveLength(0);
});

test('selecting an unknown venue after a known one does not retain old coordinates or zone', async () => {
  await mountLocation(); await openPicker(); await pickCanonical();
  served = [{ ...canonicalRow, entityId: '33333333-3333-4333-8333-333333333333', label: 'Unknown venue', subtitle: undefined,
    action: { type: 'open_entity', entityType: 'place', entityId: '33333333-3333-4333-8333-333333333333' },
    structuredValue: { entityType: 'venue', venueId: '33333333-3333-4333-8333-333333333333', venue: 'Unknown venue' } }];
  await fireEvent.press(screen.getByText('Canonical Sky36, Da Nang'));
  await fireEvent.changeText(screen.getByPlaceholderText('City, venue or address…'), 'Another query');
  await fireEvent.press(await screen.findByText('Unknown venue'));
  await saveNext();
  expect(draftPayload()).toMatchObject({ locationName: 'Unknown venue', city: 'Da Nang', country: 'Vietnam' });
  for (const field of ['timezone', 'locationLat', 'locationLng']) expect(draftPayload()).not.toHaveProperty(field);
});

test('empty answer is usable and the same warm query reopens without another typed HTTP request', async () => {
  await mountLocation(); await openPicker('');
  expect(screen.getByText('Use my current location')).toBeTruthy();
  await waitFor(() => expect(locationRequests()).toContainEqual(expect.objectContaining({ text: '' })));
  expect(screen.queryByText('Canonical Sky36, Da Nang')).toBeNull();
  await fireEvent.changeText(screen.getByPlaceholderText('City, venue or address…'), 'Canonical Sky36');
  await screen.findByText('Canonical Sky36, Da Nang');
  await closePicker(); await openPicker();
  await screen.findByText('Canonical Sky36, Da Nang');
  expect(locationRequests().filter(body => body.text === 'Canonical Sky36')).toHaveLength(1);
  expect(writes()).toHaveLength(0);
});

test('switching the draft target clears the old picker request', async () => {
  const pending = deferred();
  let signal: AbortSignal | null | undefined;
  holdRequest = (body, init) => {
    if (!body.text) return undefined;
    signal = init.signal;
    return pending.promise;
  };
  await mountLocation(); await openPicker();
  await waitFor(() => expect(signal).toBeDefined());
  mockParams = { draftId: 'different-draft' };
  await screen.rerender(<CreateEventScreen />);
  await act(async () => { pending.resolve(answer([canonicalRow])); });
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByText('Canonical Sky36, Da Nang')).toBeNull();
  expect(writes()).toHaveLength(0);
});

test.each(['account', 'relogin', 'unmount', 'reopen'])('a deferred form confirmation cannot change fields after %s', async change => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  await mountLocation();
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Cebu City'), 'Typed city');
  await openPicker(); await pickCanonical();
  const confirm = alert.mock.calls.at(-1)![2]!.find(button => button.text === 'Use this place')!.onPress!;
  if (change === 'unmount') await cleanup();
  if (change === 'reopen') await fireEvent.press(screen.getByText('Canonical Sky36, Da Nang'));
  if (change === 'account' || change === 'relogin') await act(async () => {
    if (change === 'account') { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); }
    else { setDiscoveryViewerFromSession(null); setDiscoveryViewerFromSession(mockOwner); }
  });
  await act(async () => { confirm(); });
  if (change !== 'unmount') expect(screen.getByPlaceholderText('e.g. Cebu City').props.value).toBe('Typed city');
  expect(writes()).toHaveLength(0);
});

test('manual free text remains available during Input outage', async () => {
  unavailable = true;
  await mountLocation(); await openPicker('Hand typed spot');
  await fireEvent.press(screen.getByText('Add as custom location'));
  await screen.findByText('Hand typed spot');
  await saveNext();
  expect(draftPayload().locationName).toBe('Hand typed spot');
});

test('a city suggestion still fills the city without acquiring venue coordinates', async () => {
  served = [{ ...canonicalRow, entityType: 'city', label: 'Da Nang', subtitle: 'Vietnam', structuredValue: undefined,
    action: { type: 'open_entity', entityType: 'city', entityId: canonicalRow.entityId } }];
  await mountLocation(); await openPicker('Da Nang');
  await fireEvent.press(await screen.findByText('Da Nang, Vietnam'));
  await saveNext();
  expect(draftPayload()).toMatchObject({ city: 'Da Nang', locationName: 'Da Nang, Vietnam' });
  expect(draftPayload()).not.toHaveProperty('locationLat');
});

test('a canonical city selection cannot inherit a previous venue point or zone', async () => {
  await mountLocation(); await openPicker(); await pickCanonical();
  served = [{ ...canonicalRow, entityType: 'city', label: 'Da Nang', subtitle: 'Vietnam', structuredValue: undefined,
    action: { type: 'open_entity', entityType: 'city', entityId: canonicalRow.entityId } }];
  await fireEvent.press(screen.getByText('Canonical Sky36, Da Nang'));
  await fireEvent.changeText(screen.getByPlaceholderText('City, venue or address…'), 'Da Nang');
  await fireEvent.press(await screen.findByText('Da Nang, Vietnam'));
  await saveNext();
  for (const field of ['timezone', 'locationLat', 'locationLng']) expect(draftPayload()).not.toHaveProperty(field);
});

test.each(['query', 'clear', 'close', 'unmount', 'account', 'relogin', 'privacy scope'])('late Input reply cannot repopulate after %s', async change => {
  const pending = deferred();
  let oldSignal: AbortSignal | null | undefined;
  holdRequest = (body, init) => {
    if (body.text !== 'Canonical Sky36') return undefined;
    oldSignal = init.signal;
    return pending.promise;
  };
  await mountLocation(); await openPicker();
  await waitFor(() => expect(oldSignal).toBeDefined());
  if (change === 'query' || change === 'clear') {
    await fireEvent.changeText(screen.getByPlaceholderText('City, venue or address…'), change === 'query' ? 'New query' : '');
    served = [];
  } else if (change === 'close') await closePicker();
  else if (change === 'unmount') await cleanup();
  else await act(async () => {
    if (change === 'account') { mockOwner = 'owner-b'; setDiscoveryViewerFromSession(mockOwner); }
    if (change === 'relogin') { setDiscoveryViewerFromSession(null); setDiscoveryViewerFromSession(mockOwner); }
    if (change === 'privacy scope') invalidateDiscoveryCaches();
  });
  await act(async () => { pending.resolve(answer([canonicalRow])); });
  expect(oldSignal?.aborted).toBe(true);
  const cacheKey = SuggestionCache.key(`event.location::scope:${inputSessionScopeKey({ surface: 'event_create' })}`, 'Canonical Sky36', null, null);
  expect(sharedSuggestionCache.get(cacheKey)).toBeNull();
  if (change !== 'unmount') expect(screen.queryByText('Canonical Sky36, Da Nang')).toBeNull();
  expect(writes()).toHaveLength(0);
});
