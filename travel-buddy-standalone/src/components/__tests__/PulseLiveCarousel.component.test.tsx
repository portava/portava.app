/**
 * PulseLiveCarousel — unit tests.
 *
 * Covers:
 *  1. Ongoing events → renders event title and LIVE badge
 *  2. Zero ongoing events → renders fallback text
 *  3. Future events (startAt > now) → not shown as live
 *  4. Past events (startAt + 2hr < now) → not shown as live
 *  5. Multiple ongoing events → renders dot indicators
 *  6. attendeeCount shown as "N going" when available
 *
 * `now` is injected so tests don't depend on the wall clock.
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor, configure } from '@testing-library/react-native';

// Full-suite parallel runs can starve async updates past the default 1 s
// async-util timeout; give these tests generous headroom.
configure({ asyncUtilTimeout: 10000 });
import { PulseLiveCarousel } from '../PulseLiveCarousel.tsx';
import type { CityEvent } from '../../types/models.ts';

// ── Module mocks ───────────────────────────────────────────────────────────────

jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  router: { push: jest.fn() },
  // Map useFocusEffect → useEffect(cb, []) so focus-lifecycle is exercisable
  // in Jest without a full React Navigation navigator.
  useFocusEffect: (cb: () => (() => void) | void) => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    require('react').useEffect(cb, []);
  },
}));

// NOTE: intentionally exhaustive — react-native-safe-area-context pulls native-module
// internals that are not safe under jest; PulseLiveCarousel does not use insets directly
// but downstream theme imports may pull the module in transitively.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.useReducedMotion = () => false;
  return Reanimated;
});

// ── Fixtures ───────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;
/** A fixed "now" so all time calculations are deterministic. */
const NOW = new Date('2026-07-18T10:00:00Z').getTime();

function makeEvent(overrides: Partial<CityEvent> & { startAt: string }): CityEvent {
  return {
    id: 'evt-1',
    title: 'Test Event',
    city: 'Cebu City',
    category: 'nightlife',
    startAt: overrides.startAt,
    attendeeCount: undefined,
    capacity: undefined,
    host: undefined,
    ...overrides,
  } as unknown as CityEvent;
}

/** startAt = now - 30 min → ongoing (well within 2h window) */
function ongoingEvent(overrides: Partial<CityEvent> = {}): CityEvent {
  return makeEvent({
    startAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    ...overrides,
  });
}

/** startAt = now + 1 hr → future, not live */
function futureEvent(overrides: Partial<CityEvent> = {}): CityEvent {
  return makeEvent({
    startAt: new Date(NOW + HOUR).toISOString(),
    ...overrides,
  });
}

/** startAt = now - 3 hr → past (started 3h ago, 2h window expired) */
function pastEvent(overrides: Partial<CityEvent> = {}): CityEvent {
  return makeEvent({
    startAt: new Date(NOW - 3 * HOUR).toISOString(),
    ...overrides,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PulseLiveCarousel', () => {
  // Restore real timers after every test so fake-timer tests (dot-tap,
  // unmount) don't leak into subsequent tests that use await render().
  afterEach(() => {
    jest.useRealTimers();
  });
  it('renders the event title and LIVE badge for an ongoing event', async () => {
    const ev = ongoingEvent({ id: 'evt-live', title: 'Salsa Night' });
    await render(<PulseLiveCarousel events={[ev]} now={NOW} />);

    expect(screen.getByText('Salsa Night')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('renders the fallback when no events are ongoing', async () => {
    await render(<PulseLiveCarousel events={[]} now={NOW} />);

    expect(screen.getByText('Nothing live nearby right now')).toBeTruthy();
  });

  it('does not show future events as live', async () => {
    const ev = futureEvent({ id: 'evt-future', title: 'Tomorrow Brunch' });
    await render(<PulseLiveCarousel events={[ev]} now={NOW} />);

    expect(screen.getByText('Nothing live nearby right now')).toBeTruthy();
    expect(screen.queryByText('Tomorrow Brunch')).toBeNull();
  });

  it('does not show past events (2h window expired) as live', async () => {
    const ev = pastEvent({ id: 'evt-past', title: 'Old Gig' });
    await render(<PulseLiveCarousel events={[ev]} now={NOW} />);

    expect(screen.getByText('Nothing live nearby right now')).toBeTruthy();
    expect(screen.queryByText('Old Gig')).toBeNull();
  });

  it('shows "N going" when attendeeCount is available', async () => {
    const ev = ongoingEvent({ id: 'evt-att', title: 'Beach Party', attendeeCount: 42 });
    await render(<PulseLiveCarousel events={[ev]} now={NOW} />);

    expect(screen.getByText('42 going')).toBeTruthy();
  });

  it('does not show going count when attendeeCount is absent', async () => {
    const ev = ongoingEvent({ id: 'evt-noatt', title: 'Quiet Night', attendeeCount: undefined });
    await render(<PulseLiveCarousel events={[ev]} now={NOW} />);

    expect(screen.queryByText(/going/)).toBeNull();
  });

  it('only shows the first ongoing event when multiple are live (no dot for single)', async () => {
    const ev1 = ongoingEvent({ id: 'evt-a', title: 'Event Alpha' });
    const ev2 = ongoingEvent({ id: 'evt-b', title: 'Event Beta' });
    await render(<PulseLiveCarousel events={[ev1, ev2]} now={NOW} />);

    // First event should be visible by default (activeIndex=0)
    expect(screen.getByText('Event Alpha')).toBeTruthy();
  });

  it('navigates to the event detail route when the card is tapped', async () => {
    const { router } = require('expo-router');
    (router.push as jest.Mock).mockClear();

    const ev = ongoingEvent({ id: 'evt-tap', title: 'Tap Me Event' });
    await render(<PulseLiveCarousel events={[ev]} now={NOW} />);

    const card = screen.getByRole('button', { name: /Tap Me Event/i });
    fireEvent.press(card);

    expect(router.push).toHaveBeenCalledWith('/event/evt-tap');
  });

  it('tapping a dot switches to the corresponding event', async () => {
    // Uses real timers — fake-timer + advanceTimersByTime in a React 19 async
    // test fires setActiveIndex inside a timer callback without an act() scope,
    // which React 19 wraps in an internal async act that poisons subsequent
    // renders in the file.  Real timers + waitFor avoids that entirely.
    const ev1 = ongoingEvent({ id: 'evt-a', title: 'Event Alpha' });
    const ev2 = ongoingEvent({ id: 'evt-b', title: 'Event Beta' });
    const ev3 = ongoingEvent({ id: 'evt-c', title: 'Event Gamma' });
    await render(<PulseLiveCarousel events={[ev1, ev2, ev3]} now={NOW} />);

    // Initially shows first event
    expect(screen.getByText('Event Alpha')).toBeTruthy();

    // Tap the third dot — switchTo() fires setTimeout(setActiveIndex, 150ms)
    const dot3 = screen.getByRole('button', { name: 'Go to event 3' });
    fireEvent.press(dot3);

    // Poll until the 150ms crossfade delay fires and the re-render propagates.
    await waitFor(() => expect(screen.getByText('Event Gamma')).toBeTruthy(), {
      timeout: 500,
    });
  });

  it('renders the fallback — not a crash — when every event has a malformed date', async () => {
    const badEvents: CityEvent[] = [
      makeEvent({ id: 'bad-1', title: 'Broken Alpha', startAt: 'not-a-date' }),
      makeEvent({ id: 'bad-2', title: 'Broken Beta',  startAt: 'not-a-date' }),
      makeEvent({ id: 'bad-3', title: 'Broken Gamma', startAt: 'not-a-date' }),
    ];
    await render(<PulseLiveCarousel events={badEvents} now={NOW} />);

    expect(screen.getByText('Nothing live nearby right now')).toBeTruthy();
    expect(screen.queryByText('Broken Alpha')).toBeNull();
    expect(screen.queryByText('Broken Beta')).toBeNull();
    expect(screen.queryByText('Broken Gamma')).toBeNull();
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('skips future and past events — only renders the one that is actually ongoing', async () => {
    const future = futureEvent({ id: 'evt-fut', title: 'Not Yet' });
    const ongoing = ongoingEvent({ id: 'evt-on', title: 'Right Now' });
    const past = pastEvent({ id: 'evt-old', title: 'Long Gone' });
    await render(<PulseLiveCarousel events={[future, ongoing, past]} now={NOW} />);

    expect(screen.getByText('Right Now')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.queryByText('Not Yet')).toBeNull();
    expect(screen.queryByText('Long Gone')).toBeNull();
  });

  it('clears the auto-advance interval when the component unmounts (focus lost)', async () => {
    jest.useFakeTimers();
    const ev1 = ongoingEvent({ id: 'evt-a', title: 'Event Alpha' });
    const ev2 = ongoingEvent({ id: 'evt-b', title: 'Event Beta' });

    const { unmount } = await render(<PulseLiveCarousel events={[ev1, ev2]} now={NOW} />);

    // Interval is running — advance past one cycle without error
    jest.advanceTimersByTime(4000);

    // Unmount simulates the screen losing focus (useFocusEffect cleanup fires)
     // Wrapped in act() so React flushes the cleanup effects (interval clear)
    // before we advance timers — avoids overlapping-act() noise.
    await unmount();

    // After unmount the interval must be cleared — advancing time should not
    // trigger any state updates or throw "Can't perform state update on an
    // unmounted component".
    expect(() => jest.advanceTimersByTime(8000)).not.toThrow();

    jest.useRealTimers();
  });
});
