/**
 * Create event (app/events/create/index.tsx) reports the task its Input fields
 * served (§45 / OD-INPUT-1, census G320).
 *
 * Before: publishing an event whose location the `event.location` picker served
 * reported nothing — the screen kept no record of which field served it.
 *
 * The harness is create.locationAssistance's (the REAL picker over a faked
 * `fetch`, the REAL observed owner session); the outcome path is the REAL
 * reporter behind the REAL consent gate, read off a telemetry sink spy.
 *
 *   E1  a picked location and a published event: one `downstream_task_completed`
 *       (event.location, event_created, ok), nothing credited (event_location
 *       keeps no per-user memory);
 *   E2  a refused publish: ok:false;
 *   E3  a location that came with the draft was not served here: nothing;
 *   E4  without consent: nothing at all;
 *   E5  a structured value applied from the title also served it: event.title
 *       is reported beside event.location.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import CreateEventScreen from '../create/index.tsx';
import { Alert } from 'react-native';
import * as ExpoLocation from 'expo-location';
import { setDiscoveryViewerFromSession, invalidateDiscoveryCaches } from '../../../src/services/discoveryViewerScope.ts';
import { disposeObservedOwnerSession, seedObservedOwnerSession } from '../../../src/services/__tests__/observedOwnerSessionFixture.ts';
import { _seedPolicyForTests } from '../../../src/platform/input-assistance/services/policyStore.ts';
import { registerGeographicFields } from '../../../src/platform/input-assistance/geographic/geoFields.ts';
import { sharedSuggestionCache } from '../../../src/platform/input-assistance/services/suggestionCache.ts';
import { applyOutcomeConsent, beginOutcomeAccount, setOutcomePoster, type TaskOutcomeBody } from '../../../src/platform/input-assistance/services/outcomeLearning.ts';
import { setTelemetrySink, resetTelemetrySink, type InputTelemetryEvent } from '../../../src/platform/input-assistance/services/inputTelemetry.ts';
import { router } from 'expo-router';

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
// The structured-value flag on, read the way every client gate is (create.structuredValues's stand-in).
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  ...jest.requireActual('../../../src/context/FeatureFlagsContext'),
  useFeatureFlags: () => ({ isEnabled: (k: string) => k === 'input_structured_values_enabled', isLivePlacesEnabled: () => false, loading: false }),
}));
// The Privacy step reads the viewer's circles and trips; neither is under test here.
jest.mock('../../../src/services/circles.ts', () => ({
  ...jest.requireActual('../../../src/services/circles.ts'), getMyCircles: async () => [],
}));
jest.mock('../../../src/services/trips.ts', () => ({
  ...jest.requireActual('../../../src/services/trips.ts'), listMyTrips: async () => [],
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
let publishAnswer: unknown = { ok: true, status: 200, json: async () => ({ id: 'ev-1' }) };
let titleRows: unknown[] = [];
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
  publishAnswer = { ok: true, status: 200, json: async () => ({ id: 'ev-1' }) };
  titleRows = [];
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
      return answer(body.context === 'event_title' && body.text ? titleRows : []);
    }
    if (url.endsWith('/api/events/drafts/existing-draft') && !init.method) {
      return { ok: true, status: 200, json: async () => mockDraft };
    }
    if (url.endsWith('/api/events/drafts/existing-draft') && init.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.endsWith('/api/events/drafts/existing-draft/publish') && init.method === 'POST') {
      return publishAnswer;
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

let events: InputTelemetryEvent[] = [];
let posts: TaskOutcomeBody[] = [];
const outcomes = () => events.filter((e) => e.name === 'downstream_task_completed');

beforeEach(() => {
  (router.replace as jest.Mock).mockClear();
  events = [];
  posts = [];
  setTelemetrySink((e) => { events.push(e); });
  setOutcomePoster(async (b) => { posts.push(b); return true; });
  beginOutcomeAccount('owner-a');
  applyOutcomeConsent('owner-a', true);
});
afterEach(() => {
  resetTelemetrySink();
  setOutcomePoster(null);
  beginOutcomeAccount(null);
});

async function toPreviewAndPublish() {
  for (let i = 0; i < 5; i++) {
    await fireEvent.press(screen.getByText('Next'));
    await tick();
  }
  await fireEvent.press(screen.getByText('Skip to preview'));
  await tick();
  await fireEvent.press(screen.getByText('Publish event'));
  await act(async () => { await Promise.resolve(); });
  await tick();
}

test('E1: a picked location and a published event — reported once for event.location, nothing credited', async () => {
  await mountLocation(); await openPicker(); await pickCanonical();
  await toPreviewAndPublish();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/event/ev-1'));
  expect(outcomes().map((e) => [e.fieldId, e.context, e.props])).toEqual([
    ['event.location', 'event_location', { task: 'event_created', ok: true }],
  ]);
  expect(posts).toEqual([]);
});

test('E2: a refused publish is reported ok:false', async () => {
  publishAnswer = { ok: false, status: 400, json: async () => ({ message: 'Start time must be in the future' }) };
  await mountLocation(); await openPicker(); await pickCanonical();
  await toPreviewAndPublish();
  await screen.findByText('Start time must be in the future');
  expect(router.replace).not.toHaveBeenCalled();
  expect(outcomes().map((e) => [e.fieldId, e.props])).toEqual([['event.location', { task: 'event_created', ok: false }]]);
  expect(posts).toEqual([]);
});

test('E3: a location that came with the draft was not served on this screen — nothing is reported', async () => {
  mockDraft = { ...mockDraft, locationName: 'Saved Venue', maxAttendees: 10, priceType: 'free' };
  await render(<CreateEventScreen />);
  await screen.findByText('Publish event');
  await fireEvent.press(screen.getByText('Publish event'));
  await act(async () => { await Promise.resolve(); });
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/event/ev-1'));
  expect(outcomes()).toEqual([]);
});

test('E4: without outcome-learning consent nothing leaves the device', async () => {
  beginOutcomeAccount('owner-a');
  await mountLocation(); await openPicker(); await pickCanonical();
  await toPreviewAndPublish();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/event/ev-1'));
  expect(outcomes()).toEqual([]);
  expect(posts).toEqual([]);
});

test('E5: a structured value applied from the title served the event too — event.title is reported beside event.location', async () => {
  const TIME = { kind: 'event_time', date: '2030-06-07', startTime: '20:00', endDate: '2030-06-07', endTime: '23:00' };
  _seedPolicyForTests(['event_title', 'event_location'], {
    event_title: { mode: 'free_text_assisted', allowedSuggestionTypes: ['ai_suggestion', 'disambiguation', 'correction', 'structured_value'], entityTypes: ['event'], minChars: 1, offlinePolicy: 'unavailable', privacyClass: 'public' },
    event_location: { mode: 'canonical_picker', allowedSuggestionTypes: ['entity', 'recent', 'disambiguation', 'action', 'validation'], entityTypes: ['place', 'city'], privacyClass: 'public', offlinePolicy: 'server_required', minChars: 2, debounceMs: 120, zeroStateAssistance: true, allowPersonalization: false, allowLiveContext: true, allowMemoryContext: false, allowAI: false, localSufficient: false },
  });
  titleRows = [{
    id: `event_title:structured_value:${JSON.stringify(TIME)}`, type: 'structured_value', context: 'event_title',
    label: 'Fri 7 Jun · 8:00 PM – 11:00 PM', subtitle: 'Set as the date and time',
    action: { type: 'set_structured_value', value: TIME }, structuredValue: TIME,
    source: 'local', confidence: 0.7, policyVersion: 'test-policy-v1',
  }];
  await mountLocation();
  await fireEvent.press(screen.getByText('Back')); await tick();
  await fireEvent.press(screen.getByText('Back')); await tick();
  await fireEvent.changeText(screen.getByPlaceholderText('e.g. Sunset hike at Mount Batang'), 'Rooftop drinks Fri 8-11pm');
  await tick();
  await fireEvent.press(await screen.findByTestId('structured-value-event_time'));
  await fireEvent.press(screen.getByText('Next')); await tick();
  await fireEvent.press(screen.getByText('Next')); await tick();
  await openPicker(); await pickCanonical();
  await toPreviewAndPublish();
  await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/event/ev-1'));
  expect(outcomes().map((e) => [e.fieldId, e.context, e.props])).toEqual([
    ['event.location', 'event_location', { task: 'event_created', ok: true }],
    ['event.title', 'event_title', { task: 'event_created', ok: true }],
  ]);
  expect(posts).toEqual([]);
});
