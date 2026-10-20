/**
 * census-input-intelligence G90 — the Hidden Gem location field's EMPTY state
 * offers a map point and the add-new flow (§14: "Current area, map point, nearby
 * canonical places, add-new flow"), through the REAL Gem wizard, picker and hook,
 * end to end to `submitGem`. The gateway rows are `creation.ts#buildZeroStateLocationActions`,
 * field for field; neither carries a coordinate.
 *
 *   1. opening the location sheet, before any character: "Drop a pin on the map"
 *      and "Add a new Gem" are listed, from the field's own empty-text request;
 *   2. "Drop a pin" closes the sheet and opens the step's map; the pin the person
 *      places is the Gem's point at submit;
 *   3. "Add a new Gem" closes the sheet and hands the person the step's own City
 *      field; what they type is submitted, with no point;
 *   4. CONTROL — a picker whose caller does not consume them never lists them;
 *   5. CONTROL — a TYPED answer still on screen after the text is cleared never
 *      lends its failed-match "Drop a pin" row to the empty field.
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - GlobalPlacePicker.tsx: never splice the zero-state actions → 1, 2, 3 red.
 *   - GlobalPlacePicker.tsx: list them without the caller's callback → 4 red.
 *   - GlobalPlacePicker.tsx: drop the answered-text guard on the action rows → 5 red.
 *   - submit.tsx: drop `onDropPin` → 2 red; drop `onAddNew` → 3 red.
 *   - GpsLocationCapture.tsx's prop not passed (`openMapRequest`) → 2 red.
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, act, waitFor, fireEvent, cleanup, screen } from '@testing-library/react-native';

// NOTE: SDK transport stub only — the picker leases the OBSERVED auth session
// (src/services/messagingOwnerRequest.ts); a named Discovery viewer alone is
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
jest.mock('../../../src/lib/supabase.ts', () => ({ ...jest.requireActual('../../../src/lib/supabase.ts'), isSupabaseConfigured: true }));

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts reaches the
// Supabase-backed token helper at load.
jest.mock('../../../src/platform/input-assistance/services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
  requestMapSearchPage: jest.fn(),
  SUGGEST_TIMEOUT_MS: 5000,
}));
// NOTE: exhaustive-by-design stub — the module reaches Supabase through apiToken.ts at load.
jest.mock('../../../src/platform/input-assistance/services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
  recordExplicitSelection: jest.fn(),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
}));
// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    ...jest.requireActual('react-native-safe-area-context'),
    SafeAreaView: ({ children }: any) => <View>{children}</View>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('../../../src/services/hiddenGems', () => ({
  ...jest.requireActual('../../../src/services/hiddenGems'),
  submitGem: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — the photo step is passed without a photo.
jest.mock('../../../src/hooks/useMediaPicker.ts', () => ({
  useMediaPicker: () => ({ pickMedia: jest.fn() }),
}));
jest.mock('../../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeView: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
  };
});
// NOTE: exhaustive-by-design stub — GPS capture is a native flow, not under test.
// The map is a native flow: this stand-in shows whether the screen asked it to
// open (`openMapRequest`) and lets the test place a pin, as the real map's
// "Confirm" does through `onCapture`.
jest.mock('../../../src/components/location/GpsLocationCapture', () => {
  const R = require('react');
  const { Pressable, Text } = require('react-native');
  return {
    GpsLocationCapture: ({ onCapture, openMapRequest }: { onCapture: (p: unknown) => void; openMapRequest?: number }) =>
      typeof openMapRequest === 'number' && openMapRequest > 0
        ? R.createElement(Pressable, {
          testID: 'stub-map-confirm',
          onPress: () => onCapture({
            id: 'pin-1', type: 'place', name: 'Dropped pin', displayName: 'Dropped pin near Hoi An',
            country: null, countryCode: null, region: null, city: null, district: null,
            lat: 15.8777, lng: 108.3262, timezone: null, source: 'map',
          }),
        }, R.createElement(Text, null, `map open ${openMapRequest}`))
        : null,
  };
});
// NOTE: exhaustive-by-design stub — the map preview needs a native map module.
jest.mock('../../../src/components/gems/GemLocationPreview', () => ({
  GemLocationPreview: () => null,
}));
// NOTE: exhaustive-by-design stub — the picker's provider search is out of scope.
jest.mock('../../../src/hooks/usePlaceSearch.ts', () => ({
  usePlaceSearch: () => ({ results: [], loading: false, error: null }),
  fetchPlacesFromApi: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — Google autocomplete is out of scope.
jest.mock('../../../src/hooks/useGooglePlacesAutocomplete.ts', () => ({
  useGooglePlacesAutocomplete: () => ({ places: [], loading: false }),
  fetchGooglePlaceDetails: jest.fn(),
}));
// NOTE: exhaustive-by-design stub — the picker's /api/me/recent-places list.
jest.mock('../../../src/hooks/useRecentPlaces.ts', () => ({
  useRecentPlaces: () => ({ recents: [], saveRecent: jest.fn() }),
}));
// NOTE: exhaustive-by-design stub — popular falls back to the seed list.
jest.mock('../../../src/hooks/usePopularCities.ts', () => ({
  usePopularCities: () => ({ places: [] }),
}));
// NOTE: exhaustive-by-design stub — canonical resolution is a network call.
jest.mock('../../../src/lib/location/resolveCanonical.ts', () => ({
  resolveCanonicalPlace: jest.fn(async (p: any) => p),
}));
// NOTE: intentionally exhaustive — the native module is not available under jest.
jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: async () => ({ granted: false }),
  getLastKnownPositionAsync: async () => null,
}));

import SubmitGemScreen from '../submit.tsx';
import { GlobalPlacePicker } from '../../../src/components/selectors/GlobalPlacePicker';
import { submitGem } from '../../../src/services/hiddenGems';
import { requestSuggestions } from '../../../src/platform/input-assistance/services/inputAssistance.ts';
import { sharedSuggestionCache } from '../../../src/platform/input-assistance/services/suggestionCache.ts';
import { setDiscoveryViewerFromSession, _resetDiscoveryViewerScopeForTests } from '../../../src/services/discoveryViewerScope.ts';
import { disposeObservedOwnerSession, seedObservedOwnerSession } from '../../../src/services/__tests__/observedOwnerSessionFixture.ts';
import type { InputSuggestion } from '../../../src/platform/input-assistance/types/inputSuggestion.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../../src/platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../../src/platform/input-assistance/services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, {
  hidden_gem_location: { debounceMs: 0 },
  neighborhood_picker: { debounceMs: 0 },
  hidden_gem_name: { debounceMs: 0 },
});

const mockSubmit = submitGem as jest.Mock;
const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

const HOI_AN = {
  entityType: 'city', cityId: 'canon-hoian', city: 'Hoi An', country: 'Vietnam', countryCode: 'VN',
  lat: 15.8801, lng: 108.338, timezone: 'Asia/Ho_Chi_Minh',
};
/** `projection.ts#projectCanonicalCity` and `creation.ts#buildApproximateAreaRows`, field for field. */
const cityRow = {
  id: 'hidden_gem_location:city:canon-hoian', type: 'entity', context: 'hidden_gem_location', label: 'Hoi An',
  subtitle: 'Vietnam', entityType: 'city', entityId: 'canon-hoian',
  action: { type: 'set_structured_value', value: HOI_AN }, structuredValue: HOI_AN, confidence: 0.99,
  source: 'canonical', policyVersion: 'input-2026-08',
} as InputSuggestion;
const areaRow = {
  id: 'hidden_gem_location:action:approximate-area:canon-hoian', type: 'action', context: 'hidden_gem_location',
  label: 'Use approximate area', subtitle: 'Hoi An, Vietnam',
  action: { type: 'set_structured_value', value: { kind: 'approximate_area', areaType: 'city', ...HOI_AN } },
  structuredValue: { kind: 'approximate_area', areaType: 'city', ...HOI_AN }, confidence: 0.55,
  source: 'canonical', reason: 'Place the Gem by its area, not an exact point', policyVersion: 'input-2026-08',
} as InputSuggestion;
/** `neighborhoods.ts#resolveNeighborhoodRows`, field for field. */
const oldQuarter = {
  id: 'neighborhood_picker:neighborhood:z1', type: 'entity', context: 'neighborhood_picker', label: 'Old Quarter',
  subtitle: 'Hoi An, VN', entityType: 'neighborhood', entityId: 'z1',
  action: { type: 'set_structured_value', value: { entityType: 'neighborhood', neighborhoodId: 'z1', name: 'Old Quarter', city: 'Hoi An', countryCode: 'VN', timezone: 'Asia/Ho_Chi_Minh' } },
  structuredValue: { entityType: 'neighborhood', neighborhoodId: 'z1', name: 'Old Quarter', city: 'Hoi An', countryCode: 'VN', timezone: 'Asia/Ho_Chi_Minh' },
  confidence: 0.85, source: 'canonical', policyVersion: 'input-2026-08',
} as InputSuggestion;

/** `projection.ts#projectGeoDefault` on the neighbourhood field's empty answer. */
const tripDefault = {
  id: 'neighborhood_picker:default:upcoming_trip:1', type: 'recent', context: 'neighborhood_picker', label: 'Bangkok',
  subtitle: 'Thailand', entityType: 'city', action: { type: 'replace_text', text: 'Bangkok' }, replacementText: 'Bangkok',
  confidence: 0.7, source: 'recent', reason: 'Upcoming Trip', policyVersion: 'input-2026-08',
} as InputSuggestion;

function served(rows: InputSuggestion[]) {
  return Promise.resolve({ ok: true as const, requestId: 'r', policyVersion: 'input-2026-08', suggestions: rows });
}

beforeEach(() => {
  seedObservedOwnerSession('gem-fixture-owner', 'gem-zero-state-actions-session');
  setDiscoveryViewerFromSession('gem-fixture-owner');
  mockRequest.mockReset();
  mockRequest.mockImplementation((req: any) => {
    if (req.context === 'neighborhood_picker' && req.text === '') return served([tripDefault]);
    if (req.context === 'hidden_gem_location' && /hoi/i.test(req.text)) return served([cityRow, areaRow]);
    if (req.context === 'neighborhood_picker' && /old/i.test(req.text)) return served([oldQuarter]);
    return served([]);
  });
  mockSubmit.mockReset();
  mockSubmit.mockResolvedValue({ id: 'gem-1' });
  sharedSuggestionCache.clear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  _resetDiscoveryViewerScopeForTests();
  disposeObservedOwnerSession();
  jest.restoreAllMocks();
});

/** Details → Photo → Privacy → Review → Submit, from the location step. */
async function finishWizard() {
  await act(async () => { fireEvent.press(screen.getByText('Next')); });
  await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('What locals call it'), 'Lantern Steps'); });
  await act(async () => { fireEvent.press(screen.getByText('Food')); });
  await act(async () => { fireEvent.press(screen.getByText('Next')); }); // → Photo
  await act(async () => { fireEvent.press(screen.getByText('Next')); }); // → Privacy
}

async function submitFromPrivacy() {
  await act(async () => { fireEvent.press(screen.getByText('Next')); }); // → Review
  await act(async () => { fireEvent.press(screen.getByText('Submit Gem')); });
  await waitFor(() => expect(mockSubmit).toHaveBeenCalledTimes(1));
  return mockSubmit.mock.calls[0][0];
}


/** `creation.ts#buildZeroStateLocationActions`, field for field. */
const pinRow = {
  id: 'hidden_gem_location:zero:drop-pin', type: 'action', context: 'hidden_gem_location', label: 'Drop a pin on the map',
  subtitle: 'Place it yourself — nothing is located for you', action: { type: 'drop_pin' }, confidence: 0.5,
  source: 'local', reason: 'Pin it on the map', policyVersion: 'input-2026-08',
} as InputSuggestion;
const addRow = {
  id: 'hidden_gem_location:zero:create-hidden_gem', type: 'action', context: 'hidden_gem_location', label: 'Add a new Gem',
  subtitle: 'Not listed? Enter where it is yourself',
  action: { type: 'set_structured_value', value: { kind: 'create_entity', entityType: 'hidden_gem', name: '' } },
  structuredValue: { kind: 'create_entity', entityType: 'hidden_gem', name: '' }, confidence: 0.4,
  source: 'local', reason: 'Not listed yet', policyVersion: 'input-2026-08',
} as InputSuggestion;

function serveEmptyGem() {
  const prior = mockRequest.getMockImplementation();
  mockRequest.mockImplementation((req: any) => {
    if (req.context === 'hidden_gem_location' && req.text === '') return served([pinRow, addRow]);
    return prior!(req);
  });
}

async function openEmptySheet() {
  await act(async () => { render(<SubmitGemScreen />); });
  await fireEvent.press(screen.getByTestId('gem-pick-place'));
  await waitFor(() => expect(screen.getByTestId('place-zero-pin')).toBeTruthy());
}

describe('G90 — the empty Gem location field: map point and add-new', () => {
  it('lists "Drop a pin on the map" and "Add a new Gem" before any character, from the field\'s own empty request', async () => {
    serveEmptyGem();
    await openEmptySheet();
    expect(screen.getByText('Drop a pin on the map')).toBeTruthy();
    expect(screen.getByText('Add a new Gem')).toBeTruthy();
    expect(screen.getByTestId('place-zero-add')).toBeTruthy();
    const call = mockRequest.mock.calls.map(([r]: any[]) => r).find((r: any) => r.context === 'hidden_gem_location');
    expect(call).toMatchObject({ fieldId: 'gem.location', text: '' });
  });

  it('"Drop a pin" closes the sheet and opens the map; the placed pin is the Gem\'s point at submit', async () => {
    serveEmptyGem();
    await openEmptySheet();
    expect(screen.queryByTestId('stub-map-confirm')).toBeNull();
    await fireEvent.press(screen.getByTestId('place-zero-pin'));
    await waitFor(() => expect(screen.queryByTestId('place-zero-pin')).toBeNull());
    expect(screen.getByText('map open 1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('stub-map-confirm'));
    await fireEvent.changeText(screen.getByPlaceholderText('e.g. Tokyo'), 'Hoi An');
    await finishWizard();
    const payload = await submitFromPrivacy();
    expect(payload).toMatchObject({ city: 'Hoi An', latitude: 15.8777, longitude: 108.3262 });
  });

  it('"Add a new Gem" closes the sheet and hands over the City field; what is typed is submitted, with no point', async () => {
    serveEmptyGem();
    await openEmptySheet();
    await fireEvent.press(screen.getByTestId('place-zero-add'));
    await waitFor(() => expect(screen.queryByTestId('place-zero-add')).toBeNull());
    expect(screen.getByTestId('gem-add-new-hint')).toBeTruthy();
    expect(screen.queryByTestId('stub-map-confirm')).toBeNull();
    await fireEvent.changeText(screen.getByPlaceholderText('e.g. Tokyo'), 'Hoi An');
    expect(screen.queryByTestId('gem-add-new-hint')).toBeNull();
    await finishWizard();
    const payload = await submitFromPrivacy();
    expect(payload).toMatchObject({ city: 'Hoi An' });
    expect(payload.latitude).toBeUndefined();
    expect(payload.longitude).toBeUndefined();
  });

  it('CONTROL: a picker whose caller does not consume them never lists them', async () => {
    serveEmptyGem();
    await act(async () => {
      render(<GlobalPlacePicker visible onSelect={() => {}} onClose={() => {}} assistContext="hidden_gem_location" assistFieldId="gem.location" />);
    });
    await waitFor(() => expect(mockRequest.mock.calls.some(([r]: any[]) => r.context === 'hidden_gem_location' && r.text === '')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('place-zero-pin')).toBeNull();
    expect(screen.queryByTestId('place-zero-add')).toBeNull();
    expect(screen.queryByText('Drop a pin on the map')).toBeNull();
  });

  it('CONTROL: a TYPED answer still on screen after clearing never lends its "Drop a pin" row to the empty field', async () => {
    /** `validationSuite.ts#buildAddressFallbacks`' failed-match drop-pin row, field for field. */
    const typedPin = {
      id: 'hidden_gem_location:validation:drop-pin', type: 'action', context: 'hidden_gem_location', label: 'Drop a pin on the map',
      action: { type: 'drop_pin' }, confidence: 0.5, source: 'local', reason: "We couldn't match that address", policyVersion: 'input-2026-08',
    } as InputSuggestion;
    mockRequest.mockImplementation((req: any) => {
      if (req.context === 'hidden_gem_location' && req.text === '') return new Promise(() => {}); // the empty field's answer never lands
      if (req.context === 'hidden_gem_location' && req.text === 'zzz') return served([typedPin]);
      return served([]);
    });
    await act(async () => { render(<SubmitGemScreen />); });
    await fireEvent.press(screen.getByTestId('gem-pick-place'));
    const input = screen.getByPlaceholderText('City, area or venue…');
    await fireEvent.changeText(input, 'zzz');
    await waitFor(() => expect(mockRequest.mock.calls.some(([r]: any[]) => r.context === 'hidden_gem_location' && r.text === 'zzz')).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    await fireEvent.changeText(input, '');
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('place-zero-pin')).toBeNull();
  });
});
