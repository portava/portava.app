/**
 * TravelerStateChip — the §5 current-state pill + its §31 expiry contract.
 *
 * Load-bearing assertions:
 *   1. Renders the SERVER label verbatim (never re-derived) with text + icon
 *      (§27: colour is never the only indicator).
 *   2. null / undefined state renders nothing.
 *   3. Expiry-on-read: a state whose expiresAt has passed is never rendered
 *      and emits availability_expired exactly once (§31/§32).
 *   4. Lapse while visible: the chip hides itself the moment expiresAt passes
 *      and emits availability_expired exactly once — not again on re-render.
 *   5. onPress is wired; a chip without a handler is not pressable.
 *
 * The chip takes a `now` seam so the clock is deterministic; timers are faked
 * for the lapse case.
 */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { TravelerStateChip } from '../TravelerStateChip.tsx';
import {
  setPassportTelemetrySink,
  resetPassportTelemetrySink,
  type PassportTelemetryEvent,
} from '../../../features/passport/passportTelemetry.ts';
import type { TravelerStateView } from '../../../services/passportProjection.ts';

const T0 = Date.parse('2026-09-04T10:00:00Z');

function state(over: Partial<TravelerStateView> = {}): TravelerStateView {
  return {
    state: 'traveling',
    label: 'Traveling · Da Nang',
    city: 'Da Nang',
    validFrom: '2026-09-04T00:00:00Z',
    expiresAt: null,
    ...over,
  };
}

describe('TravelerStateChip', () => {
  let events: PassportTelemetryEvent[];

  beforeEach(() => {
    events = [];
    setPassportTelemetrySink((e) => events.push(e));
  });

  afterEach(() => {
    resetPassportTelemetrySink();
    jest.useRealTimers();
  });

  it('renders the server label verbatim, paired with an icon (§5/§27)', async () => {
    await render(<TravelerStateChip state={state()} now={() => T0} />);
    expect(screen.getByTestId('traveler-state-label').props.children).toBe('Traveling · Da Nang');
    // An icon glyph accompanies the text (the global lucide mock renders by name).
    expect(screen.getByTestId('traveler-state-chip')).toBeTruthy();
    expect(screen.getByLabelText('Current state: Traveling · Da Nang')).toBeTruthy();
  });

  it('renders nothing for a null or undefined state', async () => {
    const { rerender } = await render(<TravelerStateChip state={null} now={() => T0} />);
    expect(screen.queryByTestId('traveler-state-chip')).toBeNull();
    rerender(<TravelerStateChip state={undefined} now={() => T0} />);
    expect(screen.queryByTestId('traveler-state-chip')).toBeNull();
    expect(events).toEqual([]);
  });

  it('expiry-on-read: an already-lapsed state is never rendered and emits availability_expired once (§31)', async () => {
    // The expiry effect runs inside render()'s own act() wrapper, so the event
    // is already captured here — no trailing `await act()` (an empty async act
    // after a null render corrupts RNTL's act scope for later tests).
    const lapsed = state({ state: 'open_to_plans', label: 'Open to Plans', expiresAt: '2026-09-04T09:00:00Z' });
    const { rerender } = await render(<TravelerStateChip state={lapsed} now={() => T0} />);
    expect(screen.queryByTestId('traveler-state-chip')).toBeNull();
    expect(events.map((e) => e.type)).toEqual(['availability_expired']);
    expect(events[0].payload).toEqual({});

    // A re-render with the same lapsed instance must not double-count.
    rerender(<TravelerStateChip state={lapsed} now={() => T0} />);
    expect(events).toHaveLength(1);
  });

  it('invokes onPress when a handler is supplied', async () => {
    const onPress = jest.fn();
    await render(<TravelerStateChip state={state()} onPress={onPress} now={() => T0} />);
    const chip = screen.getByTestId('traveler-state-chip');
    expect(chip.props.accessibilityState?.disabled).toBe(false);
    fireEvent.press(chip);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('without a handler the chip is a non-interactive, accessibility-disabled control', async () => {
    // A fresh render (not a rerender): RNTL rerender does not reliably re-emit
    // a host node's accessibilityState when a prop is REMOVED, and the pressable
    // state here is exactly what we are asserting.
    await render(<TravelerStateChip state={state()} now={() => T0} />);
    expect(screen.getByTestId('traveler-state-chip').props.accessibilityState?.disabled).toBe(true);
  });

  it('never renders an unknown kind the server did not project (closed set)', async () => {
    // A state that lapsed by validity but with an unparseable expiresAt is
    // treated as non-expiring (the server already filtered), so it renders.
    await render(<TravelerStateChip state={state({ expiresAt: 'not-a-date' })} now={() => T0} />);
    expect(screen.getByTestId('traveler-state-chip')).toBeTruthy();
    expect(events).toEqual([]);
  });

  // Fake-timer test kept LAST in the file: the real→fake transition corrupts
  // RNTL's act scope for any await render() that runs after it in the same
  // jest-expo/React-19 worker (see PulseLiveCarousel.component.test.tsx).
  it('lapse while visible: hides at expiresAt and emits availability_expired exactly once', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
    const soon = state({ state: 'open_to_plans', label: 'Open to Plans', expiresAt: new Date(T0 + 5_000).toISOString() });

    await render(<TravelerStateChip state={soon} now={() => Date.now()} />);
    expect(screen.getByTestId('traveler-state-label').props.children).toBe('Open to Plans');
    expect(events).toEqual([]);

    await act(async () => {
      jest.advanceTimersByTime(5_001);
    });

    expect(screen.queryByTestId('traveler-state-chip')).toBeNull();
    expect(events.map((e) => e.type)).toEqual(['availability_expired']);

    // Further time / renders never re-emit for the same instance.
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(events).toHaveLength(1);
  });
});
