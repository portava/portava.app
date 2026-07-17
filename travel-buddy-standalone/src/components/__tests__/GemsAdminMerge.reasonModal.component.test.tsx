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
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaView: ({ children }: any) => <View>{children}</View>,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
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
});
