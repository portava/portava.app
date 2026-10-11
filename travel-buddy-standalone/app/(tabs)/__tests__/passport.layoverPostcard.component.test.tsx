/**
 * Passport — the postcard of a COMPLETED layover (census-layover L275, lead ruling LP-2).
 *
 * The layover screen may not host the composer (census-layover L168: nothing the
 * layover surface reaches asks for photos). It hands off BY ROUTE:
 * `/(tabs)/passport?layoverPostcard=<session id>`. Passport, which owns
 * postcards, opens its own composer for that layover — passing the id and
 * nothing else; the server decides the place and refuses anyone else's or an
 * unfinished layover (api-server src/test/layoverPostcard.test.ts).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import PassportScreen from '../../../app/(tabs)/passport.tsx';
import { makePassportMock, MINIMAL_OWN_PROFILE } from '../../../src/components/__tests__/testUtils.ts';

let mockSearchParams: Record<string, string | undefined> = {};
const mockSetParams = jest.fn();

// ── expo-router — intentionally exhaustive ───────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: {
    push:      jest.fn(),
    replace:   jest.fn(),
    back:      jest.fn(),
    navigate:  jest.fn(),
    dismiss:   jest.fn(),
    setParams: (...a: unknown[]) => mockSetParams(...a),
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

// NOTE: intentionally exhaustive — calls Supabase and full network stack.
jest.mock('../../../src/hooks/usePassport', () => ({
  usePassport: jest.fn(),
  isProfileStaleSince: jest.fn(() => false),
  markProfileStale: jest.fn(),
}));

// NOTE: intentionally exhaustive — the composer has its own suite
// (PostcardComposer.layover.component.test.tsx); here the claim is WHEN
// Passport opens it and WHAT it hands it. Each instance records its props.
jest.mock('../../../src/components/PostcardComposer', () => {
  const React = require('react');
  const { View, Pressable, Text } = require('react-native');
  return {
    PostcardComposer: (p: any) => {
      if (p.layover) (global as any).__layoverComposer = p;
      if (!p.visible) return null;
      return React.createElement(View, { testID: p.layover ? 'layover-composer' : 'plain-composer' },
        React.createElement(Pressable, { testID: 'composer-close', onPress: p.onClose }, React.createElement(Text, null, 'close')));
    },
  };
});

import { usePassport } from '../../../src/hooks/usePassport';

const SESSION = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

beforeEach(() => {
  jest.clearAllMocks();
  mockSearchParams = {};
  (global as any).__layoverComposer = null;
  (usePassport as jest.Mock).mockReturnValue(makePassportMock({ profile: MINIMAL_OWN_PROFILE }));
});

test('LP-2 — ?layoverPostcard=<id> opens Passport\'s composer for that layover, with the id only', async () => {
  mockSearchParams = { layoverPostcard: SESSION };
  await render(<PassportScreen />);
  expect(screen.getByTestId('layover-composer')).toBeTruthy();
  expect((global as any).__layoverComposer.layover).toEqual({ sessionId: SESSION, city: null });
});

test('LP-2 — closing it closes it and clears the param', async () => {
  mockSearchParams = { layoverPostcard: SESSION };
  await render(<PassportScreen />);
  await act(async () => { fireEvent.press(screen.getByTestId('composer-close')); });
  expect(screen.queryByTestId('layover-composer')).toBeNull();
  expect(mockSetParams).toHaveBeenCalledWith({ layoverPostcard: undefined });
});

test('without the param no layover composer opens', async () => {
  await render(<PassportScreen />);
  expect(screen.queryByTestId('layover-composer')).toBeNull();
  expect((global as any).__layoverComposer).toBeNull();
});

test('a param that is not one uuid opens nothing', async () => {
  mockSearchParams = { layoverPostcard: 'not-a-session' };
  await render(<PassportScreen />);
  expect(screen.queryByTestId('layover-composer')).toBeNull();
});
