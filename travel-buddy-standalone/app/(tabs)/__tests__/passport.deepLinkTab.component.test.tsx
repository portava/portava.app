/**
 * Passport — deep-link tab initialization
 *
 * A deep link (e.g. StampEarnedToast's `router.push('/(tabs)/passport?tab=stamps')`)
 * must land the Passport screen directly on the requested tab, not always on
 * the default "Postcards" tab. Also confirms an absent/invalid `tab` param
 * falls back to the default without crashing.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, screen } from '@testing-library/react-native';
import PassportScreen from '../../../app/(tabs)/passport.tsx';
import { makePassportMock, MINIMAL_OWN_PROFILE } from '../../../src/components/__tests__/testUtils.ts';

let mockSearchParams: Record<string, string | undefined> = {};

// ── expo-router — intentionally exhaustive ───────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push:     jest.fn(),
    replace:  jest.fn(),
    back:     jest.fn(),
    navigate: jest.fn(),
    dismiss:  jest.fn(),
  },
  useRouter:            () => ({ push: jest.fn(), back: jest.fn() }),
  useLocalSearchParams: () => mockSearchParams,
  usePathname:          () => '/',
  useSegments:          () => [],
  useFocusEffect: (cb: () => (() => void) | void) => {
    require('react').useEffect(() => { cb(); }, []);
  },
  useNavigation: () => ({
    navigate:    jest.fn(),
    goBack:      jest.fn(),
    setOptions:  jest.fn(),
    addListener: (_e: unknown, _cb: unknown) => () => {},
  }),
  Link:     ({ children }: { children: React.ReactNode }) => children,
  Redirect: (_props: { href: unknown }) => null,
  Stack:    { Screen: (_props: unknown) => null },
  Tabs:     { Screen: (_props: unknown) => null },
}));

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// NOTE: intentionally exhaustive — requires native camera permissions modules.
jest.mock('expo-image-picker', () => ({
  requestMediaLibraryPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
  launchImageLibraryAsync:             jest.fn().mockResolvedValue({ canceled: true }),
  MediaTypeOptions:                    { Images: 'Images' },
}));

// ── usePassport ───────────────────────────────────────────────────────────────
// NOTE: intentionally exhaustive — calls Supabase and full network stack.
jest.mock('../../../src/hooks/usePassport', () => ({
  usePassport: jest.fn(),
}));

// ── Tab content stubs — render a unique marker so the active tab is
// unambiguous without depending on internal testIDs. ─────────────────────────
jest.mock('../../../src/components/PostcardsTab', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { PostcardsTab: () => React.createElement(Text, null, 'STUB_POSTCARDS_TAB') };
});
jest.mock('../../../src/components/StampsTab', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { StampsTab: () => React.createElement(Text, null, 'STUB_STAMPS_TAB') };
});

import { usePassport } from '../../../src/hooks/usePassport';

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};
  (usePassport as jest.Mock).mockReturnValue(
    makePassportMock({ profile: MINIMAL_OWN_PROFILE }),
  );
});

describe('Passport screen — ?tab= deep-link initialization', () => {
  it('lands on the Stamps tab when opened via ?tab=stamps', async () => {
    mockSearchParams = { tab: 'stamps' };
    await render(<PassportScreen />);
    expect(screen.getByText('STUB_STAMPS_TAB')).toBeTruthy();
    expect(screen.queryByText('STUB_POSTCARDS_TAB')).toBeNull();
  });

  it('falls back to the Postcards tab when no tab param is present', async () => {
    mockSearchParams = {};
    await render(<PassportScreen />);
    expect(screen.getByText('STUB_POSTCARDS_TAB')).toBeTruthy();
    expect(screen.queryByText('STUB_STAMPS_TAB')).toBeNull();
  });

  it('falls back to the Postcards tab when given an invalid tab param', async () => {
    mockSearchParams = { tab: 'not-a-real-tab' };
    await render(<PassportScreen />);
    expect(screen.getByText('STUB_POSTCARDS_TAB')).toBeTruthy();
    expect(screen.queryByText('STUB_STAMPS_TAB')).toBeNull();
  });
});
