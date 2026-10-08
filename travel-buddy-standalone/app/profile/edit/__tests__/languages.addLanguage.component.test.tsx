/**
 * The Languages screen's "add a language" field — the first mount of a
 * `language` field (lead ruling PR-D2-9; census G224/G212 under PR-D2-5).
 *
 * G224 asked that a field whose answer the shipped list already holds send no
 * request; G212 that a static dictionary be preferred. Both were built and
 * guarded (parity test) but no screen mounted a `language` or `interest` field.
 * Through the REAL screen, the REAL SmartInput and hook and the REAL shipped
 * language list, with a seeded authority table and a stubbed transport:
 *   1. typing a language the list holds shows it with NO request;
 *   2. picking it adds a selected chip (even one that is not a preset) and the
 *      save sends it;
 *   3. a query the list cannot answer still asks the server;
 *   4. picking a language already chosen adds nothing.
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - languages.tsx: drop the SmartInput mount → 1, 2, 3 and 4 red.
 *   - languages.tsx: no extra (non-preset) chips → 2 and 4 red.
 *   - languages.tsx: `withLanguage` appends without the duplicate check → 4 and 5 red.
 *   - useInputAssistance.ts: drop the sufficiency branch → 1, 2 and 4 red (a request goes
 *     out and the transport answers nothing).
 */
import React from 'react';
import { render, act, waitFor, fireEvent, cleanup, screen } from '@testing-library/react-native';

// NOTE: exhaustive-by-design stub — services/inputAssistance.ts reaches the
// Supabase-backed token helper at load; SmartInput calls only requestSuggestions.
jest.mock('../../../../src/platform/input-assistance/services/inputAssistance.ts', () => ({
  requestSuggestions: jest.fn(),
  requestMapSearchPage: jest.fn(),
  SUGGEST_TIMEOUT_MS: 5000,
}));
// NOTE: exhaustive-by-design stub — the module reaches Supabase through apiToken.ts at load.
jest.mock('../../../../src/platform/input-assistance/services/selectionRecorder.ts', () => ({
  recordSuggestionSelection: jest.fn(),
  recordExplicitSelection: jest.fn(),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true) },
  useNavigation: () => ({ addListener: () => jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../../src/services/profile', () => ({
  ...jest.requireActual('../../../../src/services/profile'),
  getMyProfile: jest.fn(),
  updateMyProfile: jest.fn(),
}));
jest.mock('../../../../src/components/ui/KeyboardSafeView', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    KeyboardSafeView: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
    KeyboardSafeScrollView: ({ children }: { children: React.ReactNode }) => R.createElement(View, null, children),
  };
});
// NOTE: exhaustive stub — useBottomInset imports native inset hooks that are
// unavailable in jest-expo JSDOM; only PlainBottomFiller is used by SettingsUI.
jest.mock('../../../../src/hooks/useBottomInset', () => ({
  PlainBottomFiller: () => null,
  useBottomInset: () => 0,
  useLayoverAwareBottomInset: () => 0,
}));

import LanguagesScreen, { withLanguage } from '../languages.tsx';
import { getMyProfile, updateMyProfile } from '../../../../src/services/profile.ts';
import { requestSuggestions } from '../../../../src/platform/input-assistance/services/inputAssistance.ts';
import { sharedSuggestionCache } from '../../../../src/platform/input-assistance/services/suggestionCache.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../../../src/platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../../../src/platform/input-assistance/services/policyStore.ts';

// The REAL registry's served shape for `language` after lead ruling PR-D2-5
// (`lib/inputAssistance/policyRegistry.ts`).
_seedPolicy(_SEED_CONTEXTS, {
  language: {
    offlinePolicy: 'static_dictionary', privacyClass: 'viewer_scoped', allowPersonalization: false,
    allowLiveContext: false, allowMemoryContext: false, allowAI: false, minChars: 1, maxSuggestions: 8,
    localSufficient: true, entityTypes: ['language'], allowedSuggestionTypes: ['entity'], debounceMs: 0,
  },
});

const mockGet = getMyProfile as jest.Mock;
const mockUpdate = updateMyProfile as jest.Mock;
const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

function profile(langs: string[]) {
  return { id: 'user-1', handle: 'traveler', username: 'traveler', spokenLanguages: langs };
}

async function openScreen(langs: string[] = ['English']) {
  mockGet.mockResolvedValue({ ok: true, data: profile(langs) });
  await act(async () => { render(<LanguagesScreen />); });
  await waitFor(() => expect(screen.getByText('French')).toBeTruthy());
  return screen.getByTestId('language-add-input');
}

beforeEach(() => {
  mockRequest.mockReset();
  mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [] } as any);
  sharedSuggestionCache.clear();
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('Languages — the mounted `language` field (PR-D2-9, G224/G212)', () => {
  it('typing a language the shipped list holds shows it with NO request', async () => {
    const input = await openScreen();
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'mala'); });
    await waitFor(() => expect(screen.getByText('Malay')).toBeTruthy());
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('picking it adds a selected chip — a non-preset one too — and the save sends it', async () => {
    mockUpdate.mockResolvedValue({ ok: true, data: profile(['English', 'Malay']) });
    const input = await openScreen();
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'mala'); });
    await waitFor(() => expect(screen.getByText('Malay')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('Malay')); });
    // The field is cleared, the overlay closes, and the pick remains as a
    // SELECTED chip although Malay is not one of the presets.
    expect(screen.getByTestId('language-add-input').props.value).toBe('');
    await waitFor(() => expect(screen.getAllByText('Malay')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Malay' }).props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({ spokenLanguages: ['English', 'Malay'] });
  });

  it('a query the list cannot answer still asks the server', async () => {
    const input = await openScreen();
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'klingon'); });
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(mockRequest.mock.calls[0][0]).toMatchObject({ context: 'language', fieldId: 'profile.languages', text: 'klingon' });
  });

  it('picking a language already chosen adds nothing', async () => {
    mockUpdate.mockResolvedValue({ ok: true, data: profile(['English', 'Malay']) });
    const input = await openScreen(['English', 'Malay']);
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'mala'); });
    // "Malay" is now both a suggestion row and a chip; the field (and its
    // overlay) renders above the chip grid, so the row is the first match.
    await waitFor(() => expect(screen.getAllByText('Malay').length).toBe(2));
    await act(async () => { fireEvent.press(screen.getAllByText('Malay')[0]); });
    // The chip is still there, still selected, and still the only Malay chip.
    expect(screen.getByTestId('language-add-input').props.value).toBe('');
    await waitFor(() => expect(screen.getAllByText('Malay')).toHaveLength(1));
    // Nothing changed, so nothing is saved.
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('withLanguage: case-insensitive once, and never past the profile cap of 20', () => {
    expect(withLanguage(['English'], 'english')).toEqual(['English']);
    expect(withLanguage(['English'], '  ')).toEqual(['English']);
    const twenty = Array.from({ length: 20 }, (_, i) => `L${i}`);
    expect(withLanguage(twenty, 'Malay')).toBe(twenty);
  });
});
