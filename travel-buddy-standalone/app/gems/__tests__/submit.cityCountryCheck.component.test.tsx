/**
 * Census G149 (§23 city-country mismatch → suggest the canonical correction),
 * reached from a mounted creation form (lead ruling PR-D2-9 list).
 *
 * The server's check reads the creation DRAFT's city and country, and the hook
 * sent a draft only for an opted-in AI request, so on every mounted form the
 * check never ran. The Gem wizard now sends the City and Country its location
 * step holds, as `checkDraft`, through the REAL screen, useCreationAssistance and
 * hook:
 *   1. the name field's request carries exactly the pair — nothing else of the
 *      form — and the server's correction renders in the form's banner;
 *   2. after the Country is corrected, the name field asks again with the new
 *      pair: a verdict about one pair is never served for another (cache key).
 *
 * (`hidden_gem_name` is `sensitive_location`, so it is never cached; the cache
 * key and the effect dependency on the pair are pinned for a PUBLIC creation
 * field in hooks/__tests__/useInputAssistance.checkDraft.component.test.tsx.)
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - useInputAssistance.ts: send no draft without AI (`checkPair` dropped from
 *     the request) → 1 and 2 red.
 *   - submit.tsx: DetailsStep passes no draft → 1 and 2 red.
 *   - useCreationAssistance.ts: the draft not forwarded → 1 and 2 red.
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

import SubmitGemScreen from '../submit.tsx';
import { submitGem } from '../../../src/services/hiddenGems';
import { requestSuggestions } from '../../../src/platform/input-assistance/services/inputAssistance.ts';
import { sharedSuggestionCache } from '../../../src/platform/input-assistance/services/suggestionCache.ts';
import { checkDraftPair } from '../../../src/platform/input-assistance/hooks/useInputAssistance.ts';
import type { InputSuggestion } from '../../../src/platform/input-assistance/types/inputSuggestion.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../../src/platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../../src/platform/input-assistance/services/policyStore.ts';

_seedPolicy(_SEED_CONTEXTS, {
  hidden_gem_location: { debounceMs: 0 },
  neighborhood_picker: { debounceMs: 0 },
  hidden_gem_name: { debounceMs: 0 },
});

const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;
(submitGem as jest.Mock).mockResolvedValue({ id: 'gem-1' });

/** `validationSuite.ts#projectCityCountryCorrection`, field for field. */
const correction = {
  id: 'hidden_gem_name:validation:city-country', type: 'correction', context: 'hidden_gem_name',
  label: 'Did you mean Paris, France?', subtitle: 'Paris is in France, not Japan.',
  action: { type: 'set_structured_value', value: { kind: 'city_country_correction', city: 'Paris', country: 'France', countryCode: 'FR' } },
  structuredValue: { kind: 'city_country_correction', city: 'Paris', country: 'France', countryCode: 'FR' },
  confidence: 0.7, source: 'canonical', reason: 'Paris is in France, not Japan.', policyVersion: 'input-2026-08',
} as InputSuggestion;

function nameCalls() {
  return mockRequest.mock.calls.map(([r]: any[]) => r).filter((r: any) => r.context === 'hidden_gem_name');
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockImplementation((req: any) => Promise.resolve({
    ok: true as const, requestId: 'r', policyVersion: 'input-2026-08',
    suggestions: req.context === 'hidden_gem_name' && req.draft?.country === 'Japan' ? [correction] : [],
  }));
  sharedSuggestionCache.clear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

async function locationThenName(country: string) {
  await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('e.g. Tokyo'), 'Paris'); });
  await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('e.g. Japan'), country); });
  await act(async () => { fireEvent.press(screen.getByText('Next')); });
  await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('What locals call it'), 'Lantern Steps'); });
}

describe('G149 — the Gem form sends its city and country to the city-country check', () => {
  it('the name field sends exactly the pair, and the correction renders in the form', async () => {
    await act(async () => { render(<SubmitGemScreen />); });
    await locationThenName('Japan');
    await waitFor(() => expect(screen.getByTestId('creation-validation-banner')).toBeTruthy());
    expect(screen.getByText('Paris is in France, not Japan.')).toBeTruthy();
    const req = nameCalls().find((r: any) => r.text === 'Lantern Steps');
    expect(req).toBeTruthy();
    expect(req.draft).toEqual({ city: 'Paris', country: 'Japan' });
    expect(req.aiAssist).toBeUndefined();
  });

  it('after the Country is corrected, the name field asks again with the new pair', async () => {
    await act(async () => { render(<SubmitGemScreen />); });
    await locationThenName('Japan');
    await waitFor(() => expect(screen.getByTestId('creation-validation-banner')).toBeTruthy());
    // Back to the location step, correct the Country, forward again.
    await act(async () => { fireEvent.press(screen.getByTestId('gem-wizard-back')); });
    await act(async () => { fireEvent.changeText(screen.getByPlaceholderText('e.g. Japan'), 'France'); });
    await act(async () => { fireEvent.press(screen.getByText('Next')); });
    await waitFor(() => expect(nameCalls().some((r: any) => r.draft?.country === 'France')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('creation-validation-banner')).toBeNull());
  });

  it('checkDraftPair: only the two strings, trimmed and bounded; neither present → nothing is sent', () => {
    expect(checkDraftPair(null)).toBeNull();
    expect(checkDraftPair({ city: '  ', country: '' })).toBeNull();
    expect(checkDraftPair({ city: ' Paris ', country: null })).toEqual({ city: 'Paris' });
    expect(checkDraftPair({ city: 'x'.repeat(150), country: 'France' })).toEqual({ city: 'x'.repeat(100), country: 'France' });
    expect(Object.keys(checkDraftPair({ city: 'Paris', country: 'France', name: 'secret' } as any)!)).toEqual(['city', 'country']);
  });
});
