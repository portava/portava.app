/**
 * census-discovery §111 (DV-83 round 14, lane W11-X2, D-W11X2-115): the Time Machine says a forecast layer it
 * was not sent could not be read, instead of drawing its absence as "nothing forecast".
 *
 *   TMU1  forecast mode with an unread notice → the notice is on screen
 *   TMUc  CONTROL: forecast mode with no notice, and NOW mode with a notice → no notice text
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { TimeMachineControl } from '../TimeMachineControl.tsx';

const NOTICE = "Events couldn't be checked for this forecast";
const NOW = new Date('2026-09-30T12:00:00Z');

describe('TimeMachineControl — an unread forecast layer (§111, D-W11X2-115)', () => {
  it('TMU1 forecast mode with an unread notice → the notice is on screen', async () => {
    await render(<TimeMachineControl offset={{ kind: 'relative', minutes: 60 } as any} onChange={() => {}} now={NOW} tz="UTC" unreadNotice={NOTICE} />);
    expect(screen.getByText(NOTICE)).toBeTruthy();
  });
  it('TMUc CONTROL: no notice → none on screen; NOW mode never shows it', async () => {
    await render(<TimeMachineControl offset={{ kind: 'relative', minutes: 60 } as any} onChange={() => {}} now={NOW} tz="UTC" />);
    expect(screen.getByText(/not observed/)).toBeTruthy();
    expect(screen.queryByText(NOTICE)).toBeNull();
    await render(<TimeMachineControl offset={{ kind: 'now' } as any} onChange={() => {}} now={NOW} tz="UTC" unreadNotice={NOTICE} />);
    expect(screen.queryByText(NOTICE)).toBeNull();
  });
});
