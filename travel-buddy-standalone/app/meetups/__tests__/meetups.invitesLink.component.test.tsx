/**
 * Meetups list — the header opens the meetup invites inbox (/meetups/invites,
 * PLAT-F31). Before this, pending meetup invites had no screen at all.
 */
const mockPush = jest.fn();
import React from 'react';
import { render, act, fireEvent } from '@testing-library/react-native';

// ── Constants ─────────────────────────────────────────────────────────────────
const IPHONE_BOTTOM  = 34;
const ANDROID_BOTTOM = 48;
/** Minimum clearance contract when a layover session is active. */
const MIN_CLEARANCE = 155;
/** Expected value on iPhone 14 with layover active: 34 + 74 + 44 + 16 = 168. */
const LAYOVER_ACTIVE_INSET = IPHONE_BOTTOM + 74 + 44 + 16; // 168

// ── Safe-area — iPhone 14 (bottom = 34 pt) ───────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: IPHONE_BOTTOM, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: (...a: any[]) => mockPush(...a), back: jest.fn() },
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
  useLocalSearchParams: () => ({}),
}));

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — clearance is provided by useLayoverAwareBottomInset,
// not by NavBarFiller.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Bottom inset — layover-aware (iPhone 14 active: 34 + 74 + 44 + 16 = 168) ─
// NOTE: intentional stub — mocking the whole module avoids the LayoverSessionContext
// dependency chain. Returns the layover-active value so the assertion scenario is
// representative of the condition the hook is designed to handle.
jest.mock('../../../src/hooks/useBottomInset', () => ({
  useBottomInset:             () => 96 + 34,              // 130 (standard Tier-1)
  useLayoverAwareBottomInset: () => 34 + 74 + 44 + 16,   // 168 (layover-active)
  usePlainBottomInset:        () => 34 + 24,              // 58
  PlainBottomFiller:          () => null,
  BOTTOM_BREATHING_ROOM:      24,
  useStickyBarInset:          () => ({ inset: 96 + 34, onBarLayout: () => {} }),
  useKeyboardVisible:         () => false,
}));

// ── LayoverSessionContext — passthrough provider + active session ──────────────
// NOTE: intentional stub — LayoverSessionProvider is rendered by the screen's
// default export; mocking it as a passthrough prevents the real useFocusEffect
// fetch from running while still letting the component tree render correctly.
// useLayoverSessionContext is not called directly (useBottomInset is mocked above)
// but is included for completeness. Must stay exhaustive: provider + hook only.
// NOTE: intentional stub — see above.
jest.mock('../../../src/context/LayoverSessionContext', () => ({
  LayoverSessionProvider: ({ children }: any) => children,
  useLayoverSessionContext: () => ({
    session: { id: 'layover-1', departureTime: '2026-07-30T22:00:00Z', manualIata: 'CDG' },
    airport: null,
    loading: false,
  }),
}));

// ── Session ───────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ configured: true, isAuthed: true, userId: 'u1' }),
}));

// ── Meetups service — non-empty so ScrollView branch renders ─────────────────
// NOTE: intentional stub — returns one upcoming meetup so the ScrollView branch
// renders (not the empty-state branch); actual meetup data is not under test here.
jest.mock('../../../src/services/meetups', () => ({
  getMyMeetups: jest.fn().mockResolvedValue({
    ok: true,
    data: {
      meetups: [
        {
          id: 'meetup-1',
          title: 'Airport Coffee',
          status: 'active',
          startsAt: new Date(Date.now() + 86400_000).toISOString(),
          approximateDate: null,
          locationName: 'Gate B42',
          isCreator: true,
          myRsvp: null,
          counts: { going: 2, maybe: 1, pending: 0 },
        },
      ],
    },
  }),
}));

// ── usePosts constant ─────────────────────────────────────────────────────────
// NOTE: intentional stub — only the FEED_FOCUS_TTL_MS constant is consumed.
jest.mock('../../../src/hooks/usePosts', () => ({
  FEED_FOCUS_TTL_MS: 0,
}));

// ── Heavy sub-components ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/MeetupCreationSheet', () => ({
  MeetupCreationSheet: () => null,
}));
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RsvpBar', () => ({
  RsvpBar: () => null,
}));

import MeetupsScreen from '../index.tsx';

describe('Meetups screen — invites inbox entry', () => {
  it('the header link opens /meetups/invites', async () => {
    const view = await render(<MeetupsScreen />);
    await act(async () => {});
    await act(async () => { fireEvent.press(view.getByTestId('meetups-invites-link')); });
    expect(mockPush).toHaveBeenCalledWith('/meetups/invites');
  });
});
