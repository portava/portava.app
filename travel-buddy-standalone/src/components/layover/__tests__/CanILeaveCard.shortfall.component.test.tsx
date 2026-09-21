/**
 * CanILeaveCard — §7.2: a layover with NO window says by how much.
 *
 * ── THE GAP THIS PINS ────────────────────────────────────────────────────────
 * A traveller whose required buffer eats their whole layover used to read
 * `usableMinutes: 0` and a sentence about not having enough time. The number
 * they were SHORT BY existed nowhere — not on the wire, not in the engine, not
 * on the screen — and it is the one fact that tells them whether a later flight
 * or a lighter bag would change the answer.
 *
 * The generalised Temporal Freedom Engine has always produced it as a
 * `TEMPORAL_CONFLICT.shortfallMinutes`; the layover surface never asked. It
 * does now, through the §7 adapter, and this file is the pin that the number
 * reaches a screen rather than stopping at the wire — which is the reachability
 * `W` census-layover has spent five passes on.
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * The assertions are about RENDERED TEXT and about the number itself, not about
 * a prop being passed. The third case is the one that matters most: a window
 * that EXISTS must render no shortfall at all, so a component that always drew
 * the line would fail rather than pass two cases out of three.
 *
 * This is a separate file rather than five cases appended to
 * CanILeaveCard.component.test.tsx for the reason §17.9 item 3 records about
 * the dashboard suites: appended cases inherit whatever the previous block left
 * standing, and these need a card rendered from a window that has no
 * `freedomWindow` at all.
 *
 * Run by hand (this workspace is not in the repo's pnpm-workspace.yaml):
 *   npx jest --testPathPattern='CanILeaveCard.shortfall'
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react-native';
import { CanILeaveCard } from '../CanILeaveCard.tsx';
import type {
  LayoverWindow,
  LeaveAdvice,
  PublicAirport,
} from '../../../services/layover.ts';

const AIRPORT: PublicAirport = {
  id: 'airport-tpe',
  iataCode: 'TPE',
  name: 'Taiwan Taoyuan International Airport',
  city: 'Taoyuan',
  country: 'Taiwan',
  countryCode: 'TW',
  timezone: 'Asia/Taipei',
  lat: 25.0797,
  lng: 121.2342,
  verified: false,
};

const ADVICE: LeaveAdvice = {
  verdict: 'no',
  reasons: ['After the required buffers you’d have ~0 min — not enough to leave and return safely.'],
  unknowns: ['Visa or transit-permit requirements for your nationality'],
  reasonCodes: ['INSUFFICIENT_USABLE_TIME'],
  disclaimer: 'Guidance only — check with your airline.',
} as unknown as LeaveAdvice;

/** A layover the buffer ate: no window, and a stated shortfall. */
function conflictWindow(shortfallMinutes: number | null): LayoverWindow {
  return {
    totalMinutes: 120,
    exitDelayMin: 65,
    usableMinutes: 0,
    earliestOutTime: '2026-09-13T04:05:00.000Z',
    hardReturnTime: '2026-09-13T02:10:00.000Z',
    returnState: 'NORMAL',
    tier: 'too_short',
    tierLabel: 'Too Short',
    breakdown: {
      baseBuffer: 120,
      immigrationExtra: 30,
      bagsExtra: 15,
      trafficExtra: 20,
      timeOfDayExtra: 0,
      liveExtra: 0,
      totalBuffer: 185,
    },
    freedomWindow: null,
    shortfallMinutes,
  } as unknown as LayoverWindow;
}

/** A layover that has a window. Nothing is short. */
const ROOMY: LayoverWindow = {
  totalMinutes: 600,
  exitDelayMin: 65,
  usableMinutes: 240,
  earliestOutTime: '2026-09-13T04:05:00.000Z',
  hardReturnTime: '2026-09-13T08:05:00.000Z',
  returnState: 'NORMAL',
  tier: 'half_day',
  tierLabel: 'Half-Day',
  breakdown: {
    baseBuffer: 120,
    immigrationExtra: 30,
    bagsExtra: 0,
    trafficExtra: 20,
    timeOfDayExtra: 0,
    liveExtra: 0,
    totalBuffer: 170,
  },
  freedomWindow: {
    beginsAt: '2026-09-13T04:05:00.000Z',
    endsAt: '2026-09-13T08:05:00.000Z',
    durationMinutes: 240,
    reservedMinutes: 170,
    certified: false,
  },
  shortfallMinutes: null,
} as unknown as LayoverWindow;

afterEach(cleanup);

describe('CanILeaveCard — the shortfall a traveller can act on', () => {
  it('names the minutes when there is no window at all', async () => {
    await render(<CanILeaveCard advice={ADVICE} window={conflictWindow(130)} airport={AIRPORT} />);
    const line = screen.getByTestId('layover-window-shortfall');
    expect(line).toBeTruthy();
    // 130 minutes, in the same duration format every other number on this card
    // uses. Asserted as text because a testID alone does not prove the figure
    // reached the traveller.
    const text = screen.getByText(/2h 10m too short/);
    expect(text).toBeTruthy();
  });

  it('renders a different figure for a different shortfall', async () => {
    await render(<CanILeaveCard advice={ADVICE} window={conflictWindow(45)} airport={AIRPORT} />);
    expect(screen.getByText(/45m too short/)).toBeTruthy();
    expect(screen.queryByText(/2h 10m too short/)).toBeNull();
  });

  it('renders NOTHING when the layover has a window — an existing window is never short', async () => {
    await render(<CanILeaveCard advice={ADVICE} window={ROOMY} airport={AIRPORT} />);
    expect(screen.queryByTestId('layover-window-shortfall')).toBeNull();
  });

  it('renders nothing when the server states no shortfall, rather than guessing one from usableMinutes 0', async () => {
    await render(<CanILeaveCard advice={ADVICE} window={conflictWindow(null)} airport={AIRPORT} />);
    expect(screen.queryByTestId('layover-window-shortfall')).toBeNull();
  });

  it('renders nothing for a zero shortfall — 0 minutes short is not a shortfall', async () => {
    await render(<CanILeaveCard advice={ADVICE} window={conflictWindow(0)} airport={AIRPORT} />);
    expect(screen.queryByTestId('layover-window-shortfall')).toBeNull();
  });
});
