/**
 * The Gem wizard's location step mounts two registered-but-unmounted fields
 * (lead ruling PR-D2-9):
 *   - the location picker is `hidden_gem_location` (census G136) — "Use
 *     approximate area" places the Gem by its city, never a point;
 *   - the Neighbourhood field is `neighborhood_picker` (census G66).
 *
 * Through the REAL screen, picker, SmartInput and hook, with the transport,
 * provider hooks and media stubbed, end to end to `submitGem`:
 *   1. picking "Use approximate area" fills City and Country, chooses the
 *      Approximate privacy level, and the Gem is submitted with NO coordinate;
 *   2. the picker asks the gateway on the Gem location field;
 *   3. a neighbourhood pick fills the Neighbourhood and an empty City, and is
 *      submitted;
 *   4. a neighbourhood pick never overwrites a City already typed.
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - submit.tsx: drop `onApproximateArea` from the picker → 1 red.
 *   - submit.tsx: drop `assistContext` from the picker → 1 and 2 red.
 *   - submit.tsx: `applyApproximateArea` keeps the default privacy level → 1 red.
 *   - submit.tsx: the Neighbourhood field without assistance (`assist={false}`) → 3 and 4 red.
 *   - submit.tsx: `applyNeighbourhoodPick` fills City unconditionally → 4 red.
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, act, waitFor, fireEvent, cleanup, screen } from '@testing-library/react-native';

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
jest.mock('../../../src/components/location/GpsLocationCapture', () => ({
  GpsLocationCapture: () => null,
}));
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

import SubmitGemScreen, { applyNeighbourhoodPick } from '../submit.tsx';
import { submitGem } from '../../../src/services/hiddenGems';
import { requestSuggestions } from '../../../src/platform/input-assistance/services/inputAssistance.ts';
import { sharedSuggestionCache } from '../../../src/platform/input-assistance/services/suggestionCache.ts';
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

function served(rows: InputSuggestion[]) {
  return Promise.resolve({ ok: true as const, requestId: 'r', policyVersion: 'input-2026-08', suggestions: rows });
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation((req: any) => {
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

describe('Gem wizard — the registered location fields, mounted (PR-D2-9)', () => {
  it('G136: "Use approximate area" fills City and Country, chooses Approximate, and submits no point', async () => {
    await act(async () => { render(<SubmitGemScreen />); });
    await act(async () => { fireEvent.press(screen.getByTestId('gem-pick-place')); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('City, area or venue…'), 'hoi an'); });
    await waitFor(() => expect(screen.getByTestId('place-area-canon-hoian')).toBeTruthy());
    expect(screen.getByText('Hoi An, Vietnam · no exact point')).toBeTruthy();
    await act(async () => { fireEvent.press(screen.getByTestId('place-area-canon-hoian')); });

    // The sheet closed, and the step's fields hold the area.
    await waitFor(() => expect(screen.queryByTestId('place-area-canon-hoian')).toBeNull());
    expect(screen.getByDisplayValue('Hoi An')).toBeTruthy();
    expect(screen.getByDisplayValue('Vietnam')).toBeTruthy();

    await finishWizard();
    const payload = await submitFromPrivacy();
    expect(payload).toMatchObject({ city: 'Hoi An', country: 'Vietnam', sensitivityLevel: 'approximate' });
    expect(payload.latitude).toBeUndefined();
    expect(payload.longitude).toBeUndefined();
  });

  it('G136: the picker asks the gateway on the Gem location field', async () => {
    await act(async () => { render(<SubmitGemScreen />); });
    await act(async () => { fireEvent.press(screen.getByTestId('gem-pick-place')); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('City, area or venue…'), 'hoi an'); });
    await waitFor(() => expect(mockRequest.mock.calls.some(([r]: any[]) => r.context === 'hidden_gem_location' && r.text === 'hoi an')).toBe(true));
    expect(mockRequest.mock.calls.find(([r]: any[]) => r.context === 'hidden_gem_location')![0]).toMatchObject({ fieldId: 'gem.location' });
  });

  it('G66: a neighbourhood pick fills the Neighbourhood and an empty City, and is submitted', async () => {
    await act(async () => { render(<SubmitGemScreen />); });
    const hood = screen.getByTestId('gem-neighborhood-input');
    await act(async () => { fireEvent(hood, 'focus'); fireEvent.changeText(hood, 'old q'); });
    await waitFor(() => expect(screen.getByText('Old Quarter')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('Old Quarter')); });
    expect(screen.getByTestId('gem-neighborhood-input').props.value).toBe('Old Quarter');
    expect(screen.getByDisplayValue('Hoi An')).toBeTruthy();
    expect(mockRequest.mock.calls.find(([r]: any[]) => r.context === 'neighborhood_picker')![0]).toMatchObject({ fieldId: 'geo.neighborhood' });

    await finishWizard();
    const payload = await submitFromPrivacy();
    expect(payload).toMatchObject({ city: 'Hoi An', neighborhood: 'Old Quarter', sensitivityLevel: 'public' });
  });

  it('G66: a neighbourhood pick never overwrites a City already typed', async () => {
    await act(async () => { render(<SubmitGemScreen />); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('e.g. Tokyo'), 'Hội An'); });
    const hood = screen.getByTestId('gem-neighborhood-input');
    await act(async () => { fireEvent(hood, 'focus'); fireEvent.changeText(hood, 'old q'); });
    await waitFor(() => expect(screen.getByText('Old Quarter')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('Old Quarter')); });
    expect(screen.getByDisplayValue('Hội An')).toBeTruthy();
    expect(screen.queryByDisplayValue('Hoi An')).toBeNull();
  });

  it('applyNeighbourhoodPick: a CITY row in this field fills an empty City and leaves the Neighbourhood as typed', () => {
    const calls: Array<[string, string]> = [];
    applyNeighbourhoodPick({ ...cityRow, context: 'neighborhood_picker' }, '', (k, v) => calls.push([k, v]));
    expect(calls).toEqual([['city', 'Hoi An']]);
  });
});
