/**
 * Meetup detail — an age refusal of an RSVP is NAMED (census-trust §31, TV-5b).
 *
 * The server's age gate (routes/meetups.ts through lib/gateAge.ts) refuses an
 * RSVP with 403 `{ error: "age_not_eligible", reason, message }`. Before §31
 * the screen named only `dob_missing`; a verified minor (`not_verified_adult`)
 * and a person outside the host's limit both got the generic "Cannot join".
 * src/lib/__tests__/ageRefusal.test.ts pins the copy; this pins that the
 * screen shows it.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, act, waitFor, fireEvent, screen, cleanup } from '@testing-library/react-native';

jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn(), back: jest.fn() },
  useLocalSearchParams: () => ({ id: 'meetup-age-1' }),
  useFocusEffect: (cb: () => (() => void) | void) => {
    const React = require('react');
    React.useEffect(() => {
      const cleanup = cb();
      return typeof cleanup === 'function' ? cleanup : undefined;
    }, []);
  },
}));

import { router } from 'expo-router';
const routerPush = router.push as jest.Mock;

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/hooks/useNavBarCollapse', () => ({
  useNavBarScrollHandler: () => () => {},
  NavBarFiller: () => null,
  NAV_BAR_FILLER_HEIGHT: 96,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/context/SessionContext', () => ({
  useSession: () => ({ userId: 'viewer-age', isAuthed: true }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/PlanPickerController', () => ({
  usePlanPicker: () => ({ open: jest.fn(), isAdded: false }),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/RichText', () => ({
  RichText: ({ text }: { text: string }) => {
    const { Text } = require('react-native');
    return <Text>{text}</Text>;
  },
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/DateTimePickerField', () => ({
  DatePickerField: () => null,
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/services/calendar', () => ({
  addMeetupToCalendar: jest.fn().mockResolvedValue({ ok: false }),
}));

// NOTE: partial stub — getMeetup loads one age-limited meetup; rsvpMeetup is
// set per test; the rest are no-ops.
jest.mock('../../../src/services/meetups', () => ({
  getMeetup: jest.fn(async () => ({
    ok: true,
    data: {
      id: 'meetup-age-1', creatorId: 'host-1', title: 'Rooftop drinks', status: 'active', locationName: null,
      description: null, startsAt: null, approximateDate: null, timeBlock: 'evening', isCreator: false, myRsvp: null,
      counts: { going: 0, maybe: 0, declined: 0, pending: 1 }, totalGoing: 0, timeOptions: [], goingAttendees: [],
      ageLimitEnabled: true, minAge: 21, maxAge: null, tripId: null, circleOwnerId: null,
    },
  })),
  rsvpMeetup: jest.fn(), voteTimeOption: jest.fn(), confirmTime: jest.fn(), cancelMeetup: jest.fn(), updateMeetup: jest.fn(),
}));

// NOTE: intentional stub — not under test here.
jest.mock('../../../src/components/meetups/MeetupInviteMoreCard.tsx', () => ({
  MeetupInviteMoreCard: () => null,
}));

import { rsvpMeetup } from '../../../src/services/meetups';
import MeetupScreen from '../[id].tsx';

const mockRsvp = rsvpMeetup as jest.Mock;

async function pressGoing() {
  await render(<MeetupScreen />);
  await act(async () => {});
  await waitFor(() => expect(screen.getByText('Your RSVP')).toBeTruthy());
  await fireEvent.press(screen.getByText('✅'));
}

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

describe('Meetup detail — census-trust §31 (TV-5b): the RSVP age refusals are named', () => {
  it('a VERIFIED MINOR is told the identity check did not confirm 18+ — no "Cannot join", no profile nudge', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRsvp.mockResolvedValue({
      ok: false, data: null, reason: 'not_verified_adult',
      message: 'Your identity check did not confirm that you are 18 or over, so this is not available to you.',
    });
    await pressGoing();
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    const [title, body, buttons] = alert.mock.calls[0]!;
    expect(title).toBe('Age requirement');
    expect(body).toMatch(/didn't confirm that you're 18 or over/i);
    expect(buttons).toBeUndefined();
  });

  it("outside the host's limit is an AGE LIMIT, in the server's own sentence", async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRsvp.mockResolvedValue({
      ok: false, data: null, reason: 'below_min_age',
      message: 'This meetup requires users to be at least 21 years old.',
    });
    await pressGoing();
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(alert.mock.calls[0]![0]).toBe('Age limit');
    expect(alert.mock.calls[0]![1]).toBe('This meetup requires users to be at least 21 years old.');
  });

  it('a missing date of birth still offers the profile, as it did before', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRsvp.mockResolvedValue({ ok: false, data: null, reason: 'dob_missing', message: 'x y' });
    await pressGoing();
    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    const [title, , buttons] = alert.mock.calls[0]!;
    expect(title).toBe('Date of birth required');
    const go = (buttons as Array<{ text: string; onPress?: () => void }>).find((b) => b.text === 'Go to profile');
    expect(go).toBeTruthy();
    go!.onPress!();
    expect(routerPush).toHaveBeenCalledWith('/profile/edit');
  });

  it('CONTROL — a refusal that is not about age keeps the generic "Cannot join"', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockRsvp.mockResolvedValue({ ok: false, data: null, message: 'Meetup is full' });
    await pressGoing();
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Cannot join', 'Meetup is full'));
  });
});
