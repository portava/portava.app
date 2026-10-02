/**
 * CanILeaveCard — Appendix A reason codes REACH A TRAVELLER.
 *
 * ── THE GAP THIS PINS ────────────────────────────────────────────────────────
 * `advice.reasonCodes` has been on `GET /overview` and `GET /:id/safety` since
 * the server declared the vocabulary, and this client has typed the field since
 * `services/layover.ts:142` — while rendering only `advice.reasons`, the
 * free-text sentences. A code that no surface draws is a code no traveller has
 * ever seen, which is the same reachability defect the census has paid for four
 * times (the unmounted recommendation screen; the `rec.id`-gated control).
 *
 * ── WHAT WOULD TURN THIS RED ─────────────────────────────────────────────────
 * The assertions are on RENDERED TEXT, not on a prop. The paired negative is
 * the important one: a card that always drew the block would fail the "no codes
 * at all" case, so a hard-wired renderer cannot pass this file.
 *
 * Run by hand (this workspace is not in the repo's pnpm-workspace.yaml):
 *   npx jest --testPathPatterns='CanILeaveCard.reasonCodes'
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
  id: 'airport-ist',
  iataCode: 'IST',
  name: 'Istanbul Airport',
  city: 'Istanbul',
  country: 'Türkiye',
  countryCode: 'TR',
  timezone: 'Europe/Istanbul',
  lat: 41.2753,
  lng: 28.7519,
  verified: false,
} as unknown as PublicAirport;

const WINDOW: LayoverWindow = {
  totalMinutes: 480,
  exitDelayMin: 45,
  usableMinutes: 180,
  earliestOutTime: '2026-09-22T09:00:00.000Z',
  hardReturnTime: '2026-09-22T13:00:00.000Z',
  returnState: 'NORMAL',
  tier: 'half_day',
  tierLabel: 'Half day',
  breakdown: {
    baseBuffer: 120,
    immigrationExtra: 30,
    bagsExtra: 0,
    trafficExtra: 20,
    timeOfDayExtra: 0,
    liveExtra: 0,
    totalBuffer: 170,
  },
  freedomWindow: null,
  shortfallMinutes: null,
} as unknown as LayoverWindow;

function advice(reasonCodes: string[]): LeaveAdvice {
  return {
    verdict: 'tight',
    reasons: ['Your window is short once the buffers come off.'],
    unknowns: ['Visa or transit-permit requirements for your nationality'],
    reasonCodes,
    disclaimer: 'Guidance only — check with your airline.',
  } as unknown as LeaveAdvice;
}

afterEach(cleanup);

describe('Appendix A — the codes the server emits are rendered', () => {
  test('two emitted codes reach the screen as traveller-facing sentences', async () => {
    await render(
      <CanILeaveCard
        advice={advice(['ENTRY_NOT_CONFIRMED', 'AIRPORT_MATURITY_LIMITED'])}
        window={WINDOW}
        airport={AIRPORT}
      />,
    );

    expect(screen.getByTestId('layover-reason-codes')).toBeTruthy();
    expect(screen.getByTestId('layover-reason-code-ENTRY_NOT_CONFIRMED')).toBeTruthy();
    expect(screen.getByTestId('layover-reason-code-AIRPORT_MATURITY_LIMITED')).toBeTruthy();

    // The WORDS, not the token: a traveller must not be shown an enum member.
    expect(screen.getByText(/Entry permission not confirmed/)).toBeTruthy();
    expect(screen.getByText(/passport, visa or transit permit/)).toBeTruthy();
    expect(screen.getByText(/Limited data for this airport/)).toBeTruthy();
  });

  test('the order on screen is the order the server sent', async () => {
    await render(
      <CanILeaveCard
        advice={advice(['RETURN_THRESHOLD_REACHED', 'ENTRY_NOT_CONFIRMED'])}
        window={WINDOW}
        airport={AIRPORT}
      />,
    );
    const rendered = screen.getAllByTestId(/^layover-reason-code-/);
    expect(rendered.map((n) => n.props.testID)).toEqual([
      'layover-reason-code-RETURN_THRESHOLD_REACHED',
      'layover-reason-code-ENTRY_NOT_CONFIRMED',
    ]);
  });

  test('a code this build has never heard of is shown, not swallowed', async () => {
    await render(
      <CanILeaveCard
        advice={advice(['SOME_FUTURE_CODE'])}
        window={WINDOW}
        airport={AIRPORT}
      />,
    );
    // Rendered as itself. Dropping it would be silence about a stated risk;
    // inventing a sentence for it would be words the server never said.
    expect(screen.getByText('SOME_FUTURE_CODE')).toBeTruthy();
  });

  test('NO codes renders no block at all — not an empty heading', async () => {
    await render(<CanILeaveCard advice={advice([])} window={WINDOW} airport={AIRPORT} />);
    expect(screen.queryByTestId('layover-reason-codes')).toBeNull();
    // The rest of the card is untouched by the absence.
    expect(screen.getByText(/Can I leave the airport\?/)).toBeTruthy();
  });
});
