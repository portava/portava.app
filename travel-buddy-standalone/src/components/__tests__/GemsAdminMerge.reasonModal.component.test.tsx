/**
 * Gem moderation — Duplicates tab merge modal test.
 *
 * "Merge…" used iOS-only Alert.prompt (a silent no-op on Android/web). It
 * now uses ReasonPromptModal to collect the canonical gem ID (required).
 */
import React from 'react';
import { render, act, waitFor, screen, fireEvent } from '@testing-library/react-native';
import AdminModerationScreen from '../../../app/gems/admin.tsx';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children }: any) => <View>{children}</View>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
// NOTE: intentionally exhaustive — requireActual pulls native-module internals
// that are not safe under jest.
jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
jest.mock('../../lib/supabase', () => ({
  ...jest.requireActual('../../lib/supabase'),
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: 'tok' } } })) } },
}));
jest.mock('../../hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as any;
}

const dupGem = { id: 'gem-dup', name: 'Copy Cafe', city: 'Lisbon', category: 'cafe' };

describe('Gems admin merge modal', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('duplicate-candidates')) return jsonResponse({ gems: [dupGem] });
      if (url.includes('/pending')) return jsonResponse({ queue: [] });
      return jsonResponse({});
    });
    global.fetch = fetchMock as any;
  });

  it('merges a duplicate via the modal with a required canonical ID', async () => {
    await act(async () => { render(<AdminModerationScreen />); });

    await act(async () => { fireEvent.press(screen.getByText('Duplicates')); });
    await waitFor(() => expect(screen.getByText('Merge…')).toBeTruthy());

    expect(screen.queryByTestId('reason-modal')).toBeNull();
    await act(async () => { fireEvent.press(screen.getByText('Merge…')); });
    expect(screen.getByTestId('reason-modal')).toBeTruthy();

    // Canonical ID required — disabled confirm does nothing.
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/merge'))).toBe(false);

    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'gem-canonical'); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes('/api/admin/hidden-gems/gem-dup/merge'));
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as any).body)).toEqual({ canonicalGemId: 'gem-canonical' });
    });
  });

  it('double-tapping the modal confirm merges exactly once', async () => {
    await act(async () => { render(<AdminModerationScreen />); });

    await act(async () => { fireEvent.press(screen.getByText('Duplicates')); });
    await waitFor(() => expect(screen.getByText('Merge…')).toBeTruthy());

    await act(async () => { fireEvent.press(screen.getByText('Merge…')); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'gem-canonical'); });

    // Fast double-tap before the modal closes.
    await act(async () => {
      const btn = screen.getByTestId('reason-confirm-btn');
      fireEvent.press(btn);
      fireEvent.press(btn);
    });

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/merge')).length).toBe(1));
  });

  it('a second merge after the first completes is allowed — the guard is in-flight only, not a one-shot lock', async () => {
    await act(async () => { render(<AdminModerationScreen />); });

    await act(async () => { fireEvent.press(screen.getByText('Duplicates')); });
    await waitFor(() => expect(screen.getByText('Merge…')).toBeTruthy());

    // First merge completes.
    await act(async () => { fireEvent.press(screen.getByText('Merge…')); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'gem-canonical'); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });
    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/merge')).length).toBe(1));

    // Second merge in the same session must still work.
    await waitFor(() => expect(screen.getByText('Merge…')).toBeTruthy());
    await act(async () => { fireEvent.press(screen.getByText('Merge…')); });
    await act(async () => { fireEvent.changeText(screen.getByTestId('reason-input'), 'gem-canonical-2'); });
    await act(async () => { fireEvent.press(screen.getByTestId('reason-confirm-btn')); });

    await waitFor(() =>
      expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/merge')).length).toBe(2));
  });
});
