/**
 * The Interests screen's "find an interest" field — the first mount of an
 * `interest` field (lead ruling PR-D2-10; census G224/G212 under PR-D2-5).
 *
 * The ruling maps the shipped interest list onto the PROFILE's interest keys;
 * an entry without a key is not offered. Through the REAL screen, SmartInput,
 * hook and shipped list, with a seeded authority table and a stubbed transport:
 *   1. a profile interest is found with NO request, under the profile's label;
 *   2. picking it selects that interest's chip, and the save sends its KEY;
 *   3. a shipped word with no profile key ("Hiking") is not offered locally —
 *      the field asks the server, which (parity guard) offers nothing either;
 *   4. picking an interest already chosen changes nothing.
 *
 * MUTATION LOG (applied alone, watched go red, restored):
 *   - interests.tsx: drop the SmartInput mount → 1, 2, 3 and 4 red.
 *   - interests.tsx: store the LABEL instead of interestKeyForLabel's key → 2 red.
 *   - data/interests.ts: "Hiking" offered again → 3 red.
 *   - interests.tsx: `withInterest` without the duplicate check → 4 red.
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

import InterestsScreen, { withInterest } from '../interests.tsx';
import { getMyProfile, updateMyProfile } from '../../../../src/services/profile.ts';
import { requestSuggestions } from '../../../../src/platform/input-assistance/services/inputAssistance.ts';
import { sharedSuggestionCache } from '../../../../src/platform/input-assistance/services/suggestionCache.ts';
import { INPUT_CONTEXTS as _SEED_CONTEXTS } from '../../../../src/platform/input-assistance/types/inputContext.ts';
import { _seedPolicyForTests as _seedPolicy } from '../../../../src/platform/input-assistance/services/policyStore.ts';

// The REAL registry's served shape for `interest` after lead ruling PR-D2-5.
_seedPolicy(_SEED_CONTEXTS, {
  interest: {
    offlinePolicy: 'static_dictionary', privacyClass: 'viewer_scoped', allowPersonalization: false,
    allowLiveContext: false, allowMemoryContext: false, allowAI: false, minChars: 1, maxSuggestions: 8,
    localSufficient: true, entityTypes: ['interest'], allowedSuggestionTypes: ['entity'], debounceMs: 0,
  },
});

const mockGet = getMyProfile as jest.Mock;
const mockUpdate = updateMyProfile as jest.Mock;
const mockRequest = requestSuggestions as jest.MockedFunction<typeof requestSuggestions>;

function profile(interests: string[]) {
  return { id: 'user-1', handle: 'traveler', username: 'traveler', interests };
}

async function openScreen(interests: string[] = ['food']) {
  mockGet.mockResolvedValue({ ok: true, data: profile(interests) });
  await act(async () => { render(<InterestsScreen />); });
  await waitFor(() => expect(screen.getByText('Nightlife')).toBeTruthy());
  return screen.getByTestId('interest-find-input');
}

beforeEach(() => {
  mockRequest.mockReset();
  // The server's interest field offers nothing for a word with no profile key.
  mockRequest.mockResolvedValue({ ok: true, requestId: 'r', policyVersion: 'input-2026-08', suggestions: [] } as any);
  sharedSuggestionCache.clear();
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
});

describe('Interests — the mounted `interest` field (PR-D2-10)', () => {
  it('a profile interest is found with NO request, under the profile’s label', async () => {
    const input = await openScreen();
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'nightl'); });
    await waitFor(() => expect(screen.getAllByText('Nightlife')).toHaveLength(2)); // the row and its chip
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('picking it selects that interest’s chip, and the save sends its KEY', async () => {
    mockUpdate.mockResolvedValue({ ok: true, data: profile(['food', 'nightlife']) });
    const input = await openScreen();
    expect(screen.getByRole('checkbox', { name: 'Nightlife' }).props.accessibilityState).toMatchObject({ selected: false });
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'nightl'); });
    await waitFor(() => expect(screen.getAllByText('Nightlife')).toHaveLength(2));
    // The field (and its overlay) renders above the chip grid: the row is the first match.
    await act(async () => { fireEvent.press(screen.getAllByText('Nightlife')[0]); });
    expect(screen.getByTestId('interest-find-input').props.value).toBe('');
    await waitFor(() => expect(screen.getAllByText('Nightlife')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Nightlife' }).props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });
    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
    expect(mockUpdate).toHaveBeenCalledWith({ interests: ['food', 'nightlife'] });
  });

  it('a shipped word with no profile key ("Hiking") is not offered: the field asks the server, which offers nothing', async () => {
    const input = await openScreen();
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'hiking'); });
    await waitFor(() => expect(mockRequest).toHaveBeenCalled());
    expect(mockRequest.mock.calls[0][0]).toMatchObject({ context: 'interest', fieldId: 'profile.interests', text: 'hiking' });
    expect(screen.queryByText('Hiking')).toBeNull();
  });

  it('picking an interest already chosen changes nothing', async () => {
    const input = await openScreen(['food', 'nightlife']);
    await act(async () => { fireEvent(input, 'focus'); fireEvent.changeText(input, 'nightl'); });
    await waitFor(() => expect(screen.getAllByText('Nightlife')).toHaveLength(2));
    await act(async () => { fireEvent.press(screen.getAllByText('Nightlife')[0]); });
    await waitFor(() => expect(screen.getAllByText('Nightlife')).toHaveLength(1));
    expect(screen.getByRole('checkbox', { name: 'Nightlife' }).props.accessibilityState).toMatchObject({ selected: true });
    await act(async () => { fireEvent.press(screen.getByText('Save changes')); });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('withInterest: only a profile key, once, never past the profile cap of 20', () => {
    expect(withInterest(['food'], 'food')).toEqual(['food']);
    expect(withInterest(['food'], 'hiking')).toEqual(['food']);
    expect(withInterest(['food'], null)).toEqual(['food']);
    const twenty = Array.from({ length: 20 }, (_, i) => `k${i}`);
    expect(withInterest(twenty, 'nightlife')).toBe(twenty);
  });
});
