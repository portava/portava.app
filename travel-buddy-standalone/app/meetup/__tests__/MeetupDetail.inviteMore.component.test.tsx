/**
 * Meetup detail — the invite-more card is MOUNTED with the loaded meetup
 * (PLAT-F31). The card is a marker here; who sees it (organiser only, not on a
 * cancelled meetup) and what it does are pinned in
 * src/components/meetups/__tests__/MeetupInviteMoreCard.component.test.tsx.
 */
import React from 'react';
import { render, act, waitFor } from '@testing-library/react-native';

// ── Safe-area ─────────────────────────────────────────────────────────────────
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

// ── expo-router ───────────────────────────────────────────────────────────────
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'meetup-timeblock-1' }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

// ── Nav-bar collapse ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// ── Session ───────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'viewer-meetup-tb', isAuthed: true }),
}));

// ── PlanPickerController ──────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({
    open: jest.fn(),
    isAdded: false,
  }),
}));

// ── RichText ─────────────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RichText', () => ({
  RichText: ({ text }: any) => {
    const { Text } = require('react-native');
    return <Text>{text}</Text>;
  },
}));

// ── DateTimePickerField ───────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/DateTimePickerField', () => ({
  DatePickerField: () => null,
}));

// ── Calendar service ──────────────────────────────────────────────────────────
// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/calendar', () => ({
  addMeetupToCalendar: jest.fn().mockResolvedValue({ ok: false }),
}));

let mockIsCreator = true;
// NOTE: partial stub — only getMeetup is read on mount; the rest are no-ops.
jest.mock('../../../src/services/meetups', () => ({
  getMeetup: jest.fn(async () => ({
    ok: true,
    data: {
      id: 'meetup-invite-1', creatorId: 'u1', title: 'Coffee', status: 'active', locationName: null, description: null,
      startsAt: null, approximateDate: null, timeBlock: 'afternoon', isCreator: mockIsCreator, myRsvp: null,
      counts: { going: 0, maybe: 0, declined: 0, pending: 1 }, totalGoing: 0, timeOptions: [], goingAttendees: [],
      ageLimitEnabled: false, minAge: null, maxAge: null, tripId: null, circleOwnerId: null,
    },
  })),
  rsvpMeetup: jest.fn(), voteTimeOption: jest.fn(), confirmTime: jest.fn(), cancelMeetup: jest.fn(), updateMeetup: jest.fn(),
}));

// NOTE: intentional stub — a marker carrying the meetup the card was given.
jest.mock('../../../src/components/meetups/MeetupInviteMoreCard.tsx', () => {
  const { Text } = require('react-native');
  return { MeetupInviteMoreCard: ({ meetup }: any) => <Text>{`marker:invite-more:${meetup.id}:${meetup.isCreator}`}</Text> };
});

import MeetupScreen from '../[id].tsx';

describe('Meetup detail — invite more', () => {
  it('mounts the invite-more card with the loaded meetup', async () => {
    mockIsCreator = true;
    const view = await render(<MeetupScreen />);
    await act(async () => {});
    await waitFor(() => expect(view.getByText('marker:invite-more:meetup-invite-1:true')).toBeTruthy());
  });
});
