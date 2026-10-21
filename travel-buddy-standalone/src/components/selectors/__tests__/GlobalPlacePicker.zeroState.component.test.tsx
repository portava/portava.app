/**
 * Lead ruling PR-D2-9 (2026-10-08): the shared GlobalPlacePicker shows the
 * gateway's EMPTY-FIELD rows — the viewer's Trip destinations, saved places and
 * the field's recents — under the existing privacy rules (G200/G201: no position
 * stored, account-tagged, offline-allowed fields only).
 *
 * Before: the picker fetched the server's §14 zero-character answer (the hook
 * sends one for every `zeroStateAssistance` context) and rendered gateway rows
 * only for a TYPED query, so the answer was never seen (census §42.24, §42.31).
 *
 * Through the REAL picker and the REAL useInputAssistance hook, on the field the
 * Trip form mounts (`trip_destination`); only the transport, the provider hooks
 * and the canonical resolver are stubbed:
 *   1. the empty field shows the Trip destination first, then the field's recents;
 *   2. a TYPED answer still on screen is never listed on the empty field, nor
 *      (2b) a typed entity row the local prefix tier left there;
 *   3. picking a Trip row resolves it, records the accept and emits the binding;
 *   4. a Trip destination kept from an earlier open is shown with NO network
 *      after a cold start (G200's Trip half);
 *   5. a local recent the gateway already lists is not listed twice;
 *   6. (G136) an approximate-area row renders only for a caller that consumes it,
 *      and hands over the area with no coordinate.
 *
 * MUTATION LOG (applied alone, watched go red, restored; 5 of 5 killed):
 *   - GlobalPlacePicker.tsx: drop the zero-state block → 1, 3, 4 and 5 red.
 *   - GlobalPlacePicker.tsx: drop the `answeredText` guard → 2 red.
 *   - GlobalPlacePicker.tsx: drop the ZERO_STATE_TYPES filter → 2b red.
 *   - GlobalPlacePicker.tsx: `notShown` always true → 1, 3, 4 and 5 red (the
 *     popular seed lists Bangkok a second time).
 *   - geoSuggestions.ts: no 'Your Trips' label → 1, 4 and 5 red.
 *   - GlobalPlacePicker.tsx: area rows without the consumer check → 6 red.
 *   - geoSuggestions.ts: `approximateAreaOf` passes the centroid through → 6 red.
 */
import React from 'react';
import { cleanup, fireEvent, render, waitFor, act } from '@testing-library/react-native';

// NOTE: SDK transport stub only — the picker leases the OBSERVED auth session
// (services/messagingOwnerRequest.ts); a named Discovery viewer alone is
// not authority. This records onAuthStateChange listeners so beforeEach can deliver
// SIGNED_IN to the REAL owner observer (services/__tests__/observedOwnerSessionFixture.ts).
// Plain functions, not jest.fn, so jest.restoreAllMocks() cannot strip them.
jest.mock('@supabase/supabase-js', () => {
  const listeners = new Set<any>();
  const auth = {
    getSession: async () => ({ data: { session: null } }),
    refreshSession: async () => ({ data: { session: null } }),
    listeners,
    onAuthStateChange: (listener: any) => {
      listeners.add(listener);
      return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
    },
  };
  return { ...jest.requireActual('@supabase/supabase-js'), createClient: () => ({ auth }) };
});
jest.mock('../../../lib/supabase.ts', () => ({ ...jest.requireActual('../../../lib/supabase.ts'), isSupabaseConfigured: true }));

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts reaches the
// Supabase-backed token helper at load; the picker path calls only requestSuggestions.
jest.mock('../../../platform/input-assistance/services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
  requestMapSearchPage: jest.fn(),
  SUGGEST_TIMEOUT_MS: 5000,
}));
// NOTE: exhaustive-by-design stub — the module reaches Supabase through apiToken.ts at load.
jest.mock('../../../platform/input-assistance/services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
  recordExplicitSelection: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — provider search is out of scope; the empty field never queries it.
jest.mock('../../../hooks/usePlaceSearch.ts', () => ({
  usePlaceSearch: () => ({ results: mockPlaceSearch.current, loading: false, error: null }),
  fetchPlacesFromApi: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — Google autocomplete is out of scope here.
jest.mock('../../../hooks/useGooglePlacesAutocomplete.ts', () => ({
  useGooglePlacesAutocomplete: () => ({ places: [], loading: false }),
  fetchGooglePlaceDetails: jest.fn(),
}));
const mockLocalRecents: { current: any[] } = { current: [] }; const mockPlaceSearch: { current: any[] } = { current: [] }; // census G222 (wave 4): the provider search stub answers [] for every case but the provider-dedup one
// NOTE: exhaustive-by-design stub — the picker's own /api/me/recent-places list.
jest.mock('../../../hooks/useRecentPlaces.ts', () => ({
  useRecentPlaces: () => ({ recents: mockLocalRecents.current, saveRecent: jest.fn() }),
}));
// NOTE: exhaustive-by-design stub — popular falls back to the seed list when empty.
jest.mock('../../../hooks/usePopularCities.ts', () => ({
  usePopularCities: () => ({ places: [] }),
}));
// NOTE: exhaustive-by-design stub — canonical resolution is a network call.
jest.mock('../../../lib/location/resolveCanonical.ts', () => ({
  resolveCanonicalPlace: jest.fn(async (p: any) => ({ ...p, canonicalId: p.canonicalId ?? 'canon-resolved' })),
}));
// NOTE: intentionally exhaustive — the native module is not available under jest.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: async () => ({ granted: false }),
  getLastKnownPositionAsync: async () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// NOTE: exhaustive-by-design stub — GPS is not used (allowGPS false).
jest.mock('../../../services/location.ts', () => ({
  getCurrentGps: jest.fn(),
  checkLocationPermission: jest.fn(),
  reverseGeocodeToPlace: jest.fn(),
  reverseGeocodeDetailed: jest.fn(),
  reverseGeocode: jest.fn(),
}));

import { GlobalPlacePicker } from '../GlobalPlacePicker.tsx';
import { requestSuggestions } from '../../../platform/input-assistance/services/inputAssistance.ts';
import { recordSuggestionSelection } from '../../../platform/input-assistance/services/selectionRecorder.ts';
import { registerField, unregisterField } from '../../../platform/input-assistance/contexts/fieldRegistry.ts';
import { sharedSuggestionCache } from '../../../platform/input-assistance/services/suggestionCache.ts';
import {
  attachLocalRecents,
  bindLocalRecentsAccount,
  clearLocalZeroState,
  detachLocalRecents,
  flushLocalRecents,
  _resetLocalRecentsAccountForTests,
} from '../../../platform/input-assistance/services/localZeroState.ts';
import type { LocalRecentsStorage } from '../../../platform/input-assistance/services/localRecentsStore.ts';
import type { InputSuggestion } from '../../../platform/input-assistance/types/inputSuggestion.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../../platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy, _TEST_ACCOUNT } from '../../../platform/input-assistance/services/policyStore.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import { disposeObservedOwnerSession, seedObservedOwnerSession } from '../../../services/__tests__/observedOwnerSessionFixture.ts';

// The registry's own vocabulary for the Trip form's field (policyRegistry.ts).
_seedPolicy(_SEED_CONTEXTS, {
  trip_destination: { offlinePolicy: 'cached_local', privacyClass: 'public', debounceMs: 0 },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
const mockRecord = recordSuggestionSelection as jest.MockedFunction<typeof recordSuggestionSelection>;
const FIELD = 'test.pickerZeroState.tripDestination';
const OFFLINE = { ok: false as const, aborted: false, unavailable: true, error: 'endpoint unavailable' };

/** `projection.ts#projectGeoDefault` for an upcoming Trip, field for field. */
const BINDING = {
  entityType: 'city', cityId: '', city: 'Bangkok', country: 'Thailand', countryCode: 'TH',
  lat: 13.7563, lng: 100.5018, timezone: 'Asia/Bangkok',
};
const tripRow: InputSuggestion = {
  id: 'trip_destination:default:upcoming_trip:1', type: 'recent', context: 'trip_destination', label: 'Bangkok',
  subtitle: 'Thailand', action: { type: 'set_structured_value', value: BINDING }, structuredValue: BINDING,
  entityType: 'city', destination: { route: '/city/bangkok', entityType: 'city' },
  confidence: 0.7, source: 'recent', reason: 'Upcoming Trip', policyVersion: 'input-2026-08',
} as InputSuggestion;
/** `personalization.ts` §35 recents, field for field. */
const recentRow: InputSuggestion = {
  id: 'trip_destination:recent:city:canon-hoian', type: 'recent', context: 'trip_destination', label: 'Hoi An',
  entityType: 'city', entityId: 'canon-hoian', action: { type: 'open_entity', entityType: 'city', entityId: 'canon-hoian' },
  confidence: 0.75, source: 'memory', reason: 'Recently selected', destination: { route: '/city/hoi%20an', entityType: 'city', entityId: 'canon-hoian' },
  policyVersion: 'input-2026-08',
} as InputSuggestion;

function served(rows: InputSuggestion[]) {
  return { ok: true as const, requestId: 'r', policyVersion: 'input-2026-08', suggestions: rows };
}

function picker(over: Partial<React.ComponentProps<typeof GlobalPlacePicker>> = {}) {
  return (
    <GlobalPlacePicker
      visible
      title="Destination"
      allowGPS={false}
      usedFor="trip_destination"
      assistContext="trip_destination"
      assistFieldId={FIELD}
      sessionContext={{ surface: 'trip_new' }}
      onSelect={jest.fn()}
      onClose={jest.fn()}
      {...over}
    />
  );
}

/** The order the list renders its section headers in. */
function sectionOrder(r: { queryAllByText: (t: string) => unknown[] }, labels: string[]): string[] {
  return labels.filter((l) => r.queryAllByText(l).length > 0);
}

function fakeStorage(): LocalRecentsStorage & { dump(): string } {
  const map = new Map<string, string>();
  return {
    async getItem(k: string) { return map.get(k) ?? null; },
    async setItem(k: string, v: string) { map.set(k, v); },
    async removeItem(k: string) { map.delete(k); },
    dump() { return [...map.values()].join('\n'); },
  };
}

beforeEach(() => {
  seedObservedOwnerSession(_TEST_ACCOUNT, 'zero-state-session');
  setDiscoveryViewerFromSession(_TEST_ACCOUNT);
  mockRequest.mockReset();
  mockRecord.mockReset();
  mockLocalRecents.current = []; mockPlaceSearch.current = [];
  sharedSuggestionCache.clear();
  detachLocalRecents();
  clearLocalZeroState();
  _resetLocalRecentsAccountForTests();
  bindLocalRecentsAccount(_TEST_ACCOUNT);
  registerField(FIELD, 'trip_destination', { debounceMs: 0 });
});

afterEach(async () => {
  await cleanup();
  unregisterField(FIELD);
  disposeObservedOwnerSession();
});

describe('PR-D2-9 — the picker shows the gateway’s empty-field rows', () => {
  it('the empty field shows the Trip destination first, then the field’s recents', async () => {
    mockRequest.mockResolvedValue(served([tripRow, recentRow]));
    const r = await render(picker());
    await waitFor(() => expect(r.getByText('Your Trips')).toBeTruthy());
    expect(r.getByText('Bangkok')).toBeTruthy();
    expect(r.getByText('Hoi An')).toBeTruthy();
    // The request that produced them is the empty field's own.
    expect(mockRequest.mock.calls[0][0]).toMatchObject({ context: 'trip_destination', text: '' });
    // Sections render in the server's order (§9: Trip context before a recent).
    const json = JSON.stringify(r.toJSON());
    expect(json.indexOf('Your Trips')).toBeLessThan(json.indexOf('Suggested for you'));
    expect(json.indexOf('Suggested for you')).toBeLessThan(json.indexOf('Popular on Portava'));
  });

  it('a TYPED answer still on screen is never listed on the empty field', async () => {
    // A learned row is a zero-state TYPE served for typed text ("kra" → Krabi).
    const learned: InputSuggestion = { ...recentRow, id: 'trip_destination:personalized:city:canon-krabi', type: 'personalized', label: 'Krabi', entityId: 'canon-krabi', reason: 'You usually pick this' };
    mockRequest.mockImplementation((req: any) => (req.text === 'kra' ? Promise.resolve(served([learned])) : new Promise(() => {})));
    const r = await render(picker());
    const input = r.getByPlaceholderText('Search cities, hotels, landmarks…');
    await act(async () => { fireEvent.changeText(input, 'kra'); });
    await waitFor(() => expect(r.getByText('Best matches')).toBeTruthy());
    // Clear the field: the empty field's own answer never arrives (pending).
    await act(async () => { fireEvent.changeText(input, ''); });
    await waitFor(() => expect(r.queryByText('Best matches')).toBeNull());
    expect(r.queryByText('Suggested for you')).toBeNull();
    expect(r.queryByText('Krabi')).toBeNull();
  });

  it('a typed ENTITY row the local tier left on screen is never listed on the empty field', async () => {
    const ubud: InputSuggestion = {
      id: 'trip_destination:city:canon-ubud', type: 'entity', context: 'trip_destination', label: 'Ubud',
      entityType: 'city', entityId: 'canon-ubud', action: { type: 'open_entity', entityType: 'city', entityId: 'canon-ubud' },
      confidence: 0.85, source: 'canonical', policyVersion: 'input-2026-08',
    } as InputSuggestion;
    // "ub" is answered and cached; "ubu" is shown from the local prefix tier
    // (no answer of its own yet), and the empty field's answer never arrives.
    mockRequest.mockImplementation((req: any) => (req.text === 'ub' ? Promise.resolve(served([ubud])) : new Promise(() => {})));
    const r = await render(picker());
    const input = r.getByPlaceholderText('Search cities, hotels, landmarks…');
    await act(async () => { fireEvent.changeText(input, 'ub'); });
    await waitFor(() => expect(r.getByText('Ubud')).toBeTruthy());
    await act(async () => { fireEvent.changeText(input, 'ubu'); });
    await act(async () => { fireEvent.changeText(input, ''); });
    await waitFor(() => expect(r.queryByText('Best matches')).toBeNull());
    expect(r.queryByText('Ubud')).toBeNull();
    expect(r.queryByText('Suggested for you')).toBeNull();
  });

  it('picking a Trip row resolves it, records the accept and emits its binding', async () => {
    mockRequest.mockResolvedValue(served([tripRow]));
    const onSelect = jest.fn();
    const onCanonicalBinding = jest.fn();
    const r = await render(picker({ onSelect, onCanonicalBinding }));
    await waitFor(() => expect(r.getByText('Bangkok')).toBeTruthy());
    await act(async () => { fireEvent.press(r.getByText('Bangkok')); });
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(onSelect.mock.calls[0][0]).toMatchObject({ name: 'Bangkok', type: 'city' });
    expect(onCanonicalBinding).toHaveBeenCalledTimes(1);
    expect(onCanonicalBinding.mock.calls[0][0]).toMatchObject({ city: 'Bangkok', resolved: true });
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ id: tripRow.id, reason: 'Upcoming Trip' });
  });

  it('G136: an approximate-area row renders only for a caller that consumes it, and hands over the area only', async () => {
    const HOI = { entityType: 'city', cityId: 'canon-hoian', city: 'Hoi An', country: 'Vietnam', countryCode: 'VN', lat: 15.88, lng: 108.33, timezone: 'Asia/Ho_Chi_Minh' };
    const area = {
      id: 'trip_destination:action:approximate-area:canon-hoian', type: 'action', context: 'trip_destination',
      label: 'Use approximate area', subtitle: 'Hoi An, Vietnam',
      action: { type: 'set_structured_value', value: { kind: 'approximate_area', areaType: 'city', ...HOI } },
      structuredValue: { kind: 'approximate_area', areaType: 'city', ...HOI }, confidence: 0.55, source: 'canonical', policyVersion: 'input-2026-08',
    } as InputSuggestion;
    mockRequest.mockImplementation((req: any) => Promise.resolve(served(req.text ? [area] : [])));
    // No consumer: the row is dropped, as every action row always was.
    const plain = await render(picker());
    await act(async () => { fireEvent.changeText(plain.getByPlaceholderText('Search cities, hotels, landmarks…'), 'hoi'); });
    await waitFor(() => expect(mockRequest.mock.calls.some(([r]: any[]) => r.text === 'hoi')).toBe(true));
    expect(plain.queryByTestId('place-area-canon-hoian')).toBeNull();
    await cleanup();
    sharedSuggestionCache.clear();
    // A consumer: the row renders; a tap hands over the area — no coordinate — and closes.
    const onApproximateArea = jest.fn();
    const onClose = jest.fn();
    const r = await render(picker({ onApproximateArea, onClose }));
    await act(async () => { fireEvent.changeText(r.getByPlaceholderText('Search cities, hotels, landmarks…'), 'hoi'); });
    await waitFor(() => expect(r.getByTestId('place-area-canon-hoian')).toBeTruthy());
    await act(async () => { fireEvent.press(r.getByTestId('place-area-canon-hoian')); });
    expect(onApproximateArea).toHaveBeenCalledWith({ cityId: 'canon-hoian', city: 'Hoi An', country: 'Vietnam', countryCode: 'VN', timezone: 'Asia/Ho_Chi_Minh' });
    expect(onClose).toHaveBeenCalled();
  });

  it('G200’s Trip half: a Trip destination kept from an earlier open is shown with NO network after a cold start', async () => {
    const device = fakeStorage();
    await attachLocalRecents(device);
    bindLocalRecentsAccount(_TEST_ACCOUNT);
    mockRequest.mockResolvedValue(served([tripRow]));
    const online = await render(picker());
    await waitFor(() => expect(online.getByText('Bangkok')).toBeTruthy());

    // Cold start with the network gone: only the device blob survives.
    await cleanup();
    await flushLocalRecents();
    detachLocalRecents();
    sharedSuggestionCache.clear();
    clearLocalZeroState();
    _resetLocalRecentsAccountForTests();
    await attachLocalRecents(device);
    bindLocalRecentsAccount(_TEST_ACCOUNT);
    mockRequest.mockReset();
    mockRequest.mockResolvedValue(OFFLINE);

    const offline = await render(picker());
    await waitFor(() => expect(offline.getByText('Your Trips')).toBeTruthy());
    expect(offline.getByText('Bangkok')).toBeTruthy();
    // Kept on the device, and with no position (G200/G201 ruling).
    expect(device.dump()).toContain('Upcoming Trip');
    expect(device.dump()).not.toContain('13.7563');
    expect(device.dump()).not.toContain('100.5018');
  });

  it('a local recent the gateway already lists is not listed twice', async () => {
    mockLocalRecents.current = [{
      id: 'recent-bkk', type: 'city', name: 'Bangkok', displayName: 'Bangkok, Thailand', country: 'Thailand',
      countryCode: 'TH', region: null, city: 'Bangkok', district: null, lat: 13.75, lng: 100.5, timezone: 'Asia/Bangkok', source: 'manual',
    }];
    mockRequest.mockResolvedValue(served([tripRow]));
    const r = await render(picker());
    await waitFor(() => expect(r.getByText('Your Trips')).toBeTruthy());
    expect(r.getAllByText('Bangkok')).toHaveLength(1);
    expect(r.queryByText('Recent')).toBeNull();
  });
});

// census G159 (2026-10-17): the booking paste is mounted only on a field whose
// value is ONE place (the Event location); a city field keeps its list paste in
// the Trip editor, and the legacy surfaces with no assist context get nothing.
describe('census G159 — the paste surface is only on a field that takes one place', () => {
  it('a city field (the Trip destination) has no booking paste', async () => {
    mockRequest.mockResolvedValue(served([]));
    const r = await render(picker());
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(r.queryByTestId('place-paste')).toBeNull();
  });

  it('a picker with no assist context has none either', async () => {
    const r = await render(picker({ assistContext: undefined, assistFieldId: undefined }));
    expect(r.queryByTestId('place-paste')).toBeNull();
  });

  it('a picker closed with the paste review open reopens without it', async () => {
    mockRequest.mockResolvedValue(served([]));
    const props = { assistContext: 'event_location' as const, usedFor: 'event_location' };
    const r = await render(picker(props));
    await fireEvent.press(r.getByTestId('place-paste'));
    expect(r.getByTestId('paste-input')).toBeTruthy();
    await r.rerender(picker({ ...props, visible: false }));
    await r.rerender(picker(props));
    expect(r.getByTestId('place-paste')).toBeTruthy();
    expect(r.queryByTestId('paste-input')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// census G222 / G237 / G153 (wave 4, 2026-10-17) — the provider rows the SERVER
// federated (lib/inputAssistance/providerFederation.ts) reach the picker as
// `source: 'provider'` rows: listed in their own section after the canonical
// matches, with the dataset's required attribution, each its own choice, and
// resolved canonically like any provider place when picked.
// ═════════════════════════════════════════════════════════════════════════════
import { resolveCanonicalPlace } from '../../../lib/location/resolveCanonical.ts';

const canonPlace: InputSuggestion = {
  id: 'event_location:places:p-sky36', type: 'entity', context: 'event_location', label: 'Sky36',
  entityType: 'place', entityId: 'p-sky36', action: { type: 'open_entity', entityType: 'place', entityId: 'p-sky36' },
  confidence: 0.85, source: 'canonical', policyVersion: 'input-2026-08',
} as InputSuggestion;
/** `providerFederation.ts#projectProviderCandidate`, field for field. */
function providerRow(fsqId: string, name: string): InputSuggestion {
  const place = {
    id: `foursquare-${fsqId}`, type: 'place', name, displayName: `${name}, Da Nang`, country: null, countryCode: 'VN',
    region: 'Da Nang', city: 'Da Nang', district: null, lat: 16.07, lng: 108.22, timezone: 'Asia/Ho_Chi_Minh',
    source: 'foursquare', address: '12 Bach Dang', postalCode: null, formattedAddress: '12 Bach Dang',
  };
  return {
    id: `event_location:provider:fsq_os_places:${fsqId}`, type: 'entity', context: 'event_location', label: name,
    subtitle: 'Da Nang, VN', entityType: 'place', action: { type: 'set_structured_value', value: place }, structuredValue: place,
    confidence: 0.7, source: 'provider', attribution: 'Powered by Foursquare', policyVersion: 'input-2026-08',
  } as InputSuggestion;
}

describe('census G222 — the server\'s provider rows in the picker', () => {
  const props = { assistContext: 'event_location' as const, usedFor: 'event_location' };
  async function typed(rows: InputSuggestion[], text = 'sky') {
    mockRequest.mockImplementation((req: any) => Promise.resolve(served(req.text === text ? rows : [])));
    const r = await render(picker(props));
    await act(async () => { fireEvent.changeText(r.getByPlaceholderText('Search cities, hotels, landmarks…'), text); });
    return r;
  }

  it('provider rows are listed after the canonical matches, in their own section, with the attribution', async () => {
    const r = await typed([canonPlace, providerRow('fsq-1', 'Skyline Bar')]);
    await waitFor(() => expect(r.getByText('Skyline Bar')).toBeTruthy());
    expect(r.getByTestId('place-provider-attribution')).toBeTruthy();
    expect(r.getByText('Powered by Foursquare')).toBeTruthy();
    // Tree order of the five texts (getAllByText walks the rendered tree depth-first).
    const order = r.getAllByText(/^(Best matches|Sky36|More places|Skyline Bar|Powered by Foursquare)$/).map((n: any) => n.props.children);
    expect(order).toEqual(['Best matches', 'Sky36', 'More places', 'Skyline Bar', 'Powered by Foursquare']);
  });

  it('with no provider row there is no provider section and no attribution', async () => {
    const r = await typed([canonPlace]);
    await waitFor(() => expect(r.getByText('Sky36')).toBeTruthy());
    expect(r.queryByText('More places')).toBeNull();
    expect(r.queryByTestId('place-provider-attribution')).toBeNull();
  });

  it('two provider venues that share a name are both offered — each is its own choice', async () => {
    const r = await typed([providerRow('fsq-1', 'Highlands Coffee'), providerRow('fsq-2', 'Highlands Coffee')], 'highlands');
    await waitFor(() => expect(r.getAllByText('Highlands Coffee').length).toBe(2));
  });

  it('the device\'s own provider row for the SAME record is not listed a second time', async () => {
    mockPlaceSearch.current = [{
      id: 'foursquare-fsq-1', type: 'place', name: 'Skyline Bar (Foursquare)', displayName: 'Skyline Bar, Da Nang', country: 'Vietnam',
      countryCode: 'VN', region: null, city: 'Da Nang', district: null, lat: 16.07, lng: 108.22, timezone: null, source: 'foursquare',
    }];
    const r = await typed([providerRow('fsq-1', 'Skyline Bar')]);
    await waitFor(() => expect(r.getByText('Skyline Bar')).toBeTruthy());
    expect(r.queryByText('Skyline Bar (Foursquare)')).toBeNull();
  });

  it('picking a provider row resolves it canonically, as the Foursquare place it is', async () => {
    const onSelect = jest.fn();
    mockRequest.mockImplementation((req: any) => Promise.resolve(served(req.text === 'sky' ? [providerRow('fsq-1', 'Skyline Bar')] : [])));
    const r = await render(picker({ ...props, onSelect }));
    await act(async () => { fireEvent.changeText(r.getByPlaceholderText('Search cities, hotels, landmarks…'), 'sky'); });
    await waitFor(() => expect(r.getByText('Skyline Bar')).toBeTruthy());
    await act(async () => { fireEvent.press(r.getByText('Skyline Bar')); });
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    const resolvedWith = (resolveCanonicalPlace as jest.Mock).mock.calls.at(-1)?.[0];
    expect(resolvedWith).toMatchObject({ id: 'foursquare-fsq-1', source: 'foursquare', name: 'Skyline Bar', lat: 16.07 });
    expect(onSelect.mock.calls[0][0]).toMatchObject({ name: 'Skyline Bar' });
  });
});
