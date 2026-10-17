import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { ...jest.requireActual('expo-router').router, push: jest.fn() },
}));
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../../src/lib/supabase', () => ({
  ...jest.requireActual('../../../src/lib/supabase'),
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: null } })) } },
}));
jest.mock('../../../src/context/SessionContext', () => ({
  ...jest.requireActual('../../../src/context/SessionContext'),
  useSession: jest.fn(),
}));
jest.mock('../../../src/context/FeatureFlagsContext', () => ({
  ...jest.requireActual('../../../src/context/FeatureFlagsContext'),
  useFeatureFlags: () => ({ isEnabled: () => false }),
}));
jest.mock('../../../src/hooks/useRentABuddyFlag', () => ({
  ...jest.requireActual('../../../src/hooks/useRentABuddyFlag'),
  useRentABuddyFlag: () => ({ enabled: false }),
}));
jest.mock('../../../src/services/telegraphChat', () => ({
  ...jest.requireActual('../../../src/services/telegraphChat'),
  getTelegraphChatSettings: jest.fn(async () => null),
}));
jest.mock('../../../src/services/intelligence', () => ({
  ...jest.requireActual('../../../src/services/intelligence'),
  fetchPreferences: jest.fn(async () => ({ ok: true, data: {} })),
}));
jest.mock('../../../src/platform/input-assistance/components/InputAssistanceSettings', () => ({
  ...jest.requireActual('../../../src/platform/input-assistance/components/InputAssistanceSettings'),
  InputAssistanceSettings: () => null,
}));

import { router } from 'expo-router';
import { useSession } from '../../../src/context/SessionContext';
import Settings from '../index';

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network is forbidden in this test'));
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe('TV-7c — Settings privacy information entry', () => {
  it.each([
    { configured: true, isAuthed: true },
    { configured: true, isAuthed: false },
    { configured: false, isAuthed: false },
  ])('is reachable with flags off and session state %j', async (session) => {
    // The full SessionContextValue the provider emits: isAuthed is Boolean(userId).
    const value: ReturnType<typeof useSession> = {
      ...session,
      userId: session.isAuthed ? 'user-settings-link' : null,
      loading: false,
      signOut: jest.fn(async () => {}),
      role: null,
      roleLoaded: true,
      accountStatus: null,
      accountStatusLoaded: true,
      deletionScheduledAt: null,
      refreshAccountStatus: jest.fn(async () => {}),
    };
    jest.mocked(useSession).mockReturnValue(value);
    const screen = await render(<Settings />);

    const link = screen.getByRole('link', { name: 'Privacy information' });
    expect(link.props.accessibilityHint).toMatch(/not an approved privacy policy/i);
    await fireEvent.press(link);
    expect(router.push).toHaveBeenCalledWith('/settings/privacy-policy');
    expect(router.push).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Privacy settings')).toBeTruthy();
    await screen.unmount();
  });
});
