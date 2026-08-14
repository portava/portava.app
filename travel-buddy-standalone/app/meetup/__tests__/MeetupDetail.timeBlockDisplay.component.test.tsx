/**
 * Meetup Detail — timeBlock display regression test
 *
 * Confirms that when a meetup has only a time-of-day chip set (e.g.
 * `timeBlock = "afternoon"`) with no `startsAt` or `approximateDate`, the
 * detail screen shows "Afternoon (12–17) · date TBD" instead of the
 * unhelpful "No date set" that was shown before the fix.
 *
 * The fix landed in `artifacts/travel-buddy/app/meetup/[id].tsx` line ~702
 * (tree archived at bc1bef404); the live equivalent is `app/meetup/[id].tsx` here:
 *   `{(meetup.startsAt ?? meetup.approximateDate ?? meetup.timeBlock) ? ...}`
 *
 * Before the fix, `meetup.timeBlock` was not included in the truthiness check,
 * so a meetup with only a timeBlock fell through to the "No date set" branch.
 *
 * Run with: pnpm --filter @workspace/travel-buddy test:component
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

// ── meetups service — timeBlock-only scenario ────────────────────────────────
// NOTE: partial stub. getMeetup returns a meetup with only a timeBlock set.
jest.mock('../../../src/services/meetups', () => ({
  getMeetup: jest.fn().mockResolvedValue({
    ok: true,
    data: {
      id:              'meetup-timeblock-1',
      title:           'Coffee Catch-Up',
      status:          'active',
      locationName:    null,
      description:     null,
      // Key pre-condition: only timeBlock set, no exact date or startsAt.
      startsAt:        null,
      approximateDate: null,
      timeBlock:       'afternoon',
      isCreator:       false,
      myRsvp:          null,
      counts:          { going: 0, maybe: 0, declined: 0 },
      totalGoing:      0,
      timeOptions:     [],
      goingAttendees:  [],
      ageLimitEnabled: false,
      minAge:          null,
      maxAge:          null,
    },
  }),
  rsvpMeetup:    jest.fn(),
  voteTimeOption: jest.fn(),
  confirmTime:   jest.fn(),
  cancelMeetup:  jest.fn(),
  updateMeetup:  jest.fn(),
}));

import MeetupScreen from '../[id].tsx';

// ── Tree-walking helpers ───────────────────────────────────────────────────────

function collectAllText(node: any): string[] {
  if (typeof node === 'string') return [node];
  if (!node || typeof node !== 'object') return [];
  return (node.children ?? []).flatMap((c: any) => collectAllText(c));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Meetup Detail — timeBlock display fix', () => {
  it('shows "Afternoon (12–17) · date TBD" when only timeBlock is set — not "No date set"', async () => {
    const { toJSON } = await render(<MeetupScreen />);

    await act(async () => {});

    let tree: any;
    await waitFor(() => {
      tree = toJSON();
      const texts = collectAllText(tree);
      expect(texts.some((t) => t.includes('Coffee Catch-Up'))).toBe(true);
    }, { timeout: 4000 });

    const allTexts = collectAllText(tree);

    // The correct display for timeBlock="afternoon" with no date.
    const hasCorrectDisplay = allTexts.some(
      (t) => t.includes('Afternoon (12–17)') && t.includes('date TBD'),
    );
    expect(hasCorrectDisplay).toBe(true);

    // The old broken display must not appear.
    const hasNoDateSet = allTexts.some((t) => t === 'No date set');
    expect(hasNoDateSet).toBe(false);
  });

  it('shows exact datetime when startsAt is set — not the timeBlock fallback', async () => {
    const { getMeetup } = require('../../../src/services/meetups');
    getMeetup.mockResolvedValueOnce({
      ok: true,
      data: {
        id:              'meetup-timeblock-1',
        title:           'Coffee Catch-Up',
        status:          'active',
        locationName:    null,
        description:     null,
        startsAt:        '2026-07-15T14:30:00Z',
        approximateDate: null,
        timeBlock:       'afternoon',  // both are set; startsAt takes priority
        isCreator:       false,
        myRsvp:          null,
        counts:          { going: 0, maybe: 0, declined: 0 },
        totalGoing:      0,
        timeOptions:     [],
        goingAttendees:  [],
        ageLimitEnabled: false,
        minAge:          null,
        maxAge:          null,
      },
    });

    const { toJSON } = await render(<MeetupScreen />);
    await act(async () => {});

    let tree: any;
    await waitFor(() => {
      tree = toJSON();
      const texts = collectAllText(tree);
      expect(texts.some((t) => t.includes('Coffee Catch-Up'))).toBe(true);
    }, { timeout: 4000 });

    const allTexts = collectAllText(tree);

    // "date TBD" must not appear when startsAt is set.
    const hasDateTbd = allTexts.some((t) => t.includes('date TBD'));
    expect(hasDateTbd).toBe(false);

    // "No date set" must also not appear.
    const hasNoDateSet = allTexts.some((t) => t === 'No date set');
    expect(hasNoDateSet).toBe(false);
  });

  it('shows "No date set" only when none of startsAt, approximateDate, or timeBlock are set and user is creator', async () => {
    const { getMeetup } = require('../../../src/services/meetups');
    getMeetup.mockResolvedValueOnce({
      ok: true,
      data: {
        id:              'meetup-timeblock-1',
        title:           'Mystery Meetup',
        status:          'active',
        locationName:    null,
        description:     null,
        startsAt:        null,
        approximateDate: null,
        timeBlock:       null,  // nothing set
        isCreator:       true,  // creator sees the "No date set" + Add button
        myRsvp:          null,
        counts:          { going: 0, maybe: 0, declined: 0 },
        totalGoing:      0,
        timeOptions:     [],
        goingAttendees:  [],
        ageLimitEnabled: false,
        minAge:          null,
        maxAge:          null,
      },
    });

    const { toJSON } = await render(<MeetupScreen />);
    await act(async () => {});

    let tree: any;
    await waitFor(() => {
      tree = toJSON();
      const texts = collectAllText(tree);
      expect(texts.some((t) => t.includes('Mystery Meetup'))).toBe(true);
    }, { timeout: 4000 });

    const allTexts = collectAllText(tree);

    // "No date set" is correct when nothing is set and viewer is the creator.
    const hasNoDateSet = allTexts.some((t) => t === 'No date set');
    expect(hasNoDateSet).toBe(true);
  });
});
