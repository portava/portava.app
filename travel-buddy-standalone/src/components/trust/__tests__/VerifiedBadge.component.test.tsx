/**
 * VerifiedBadge (census-trust TV-0e) — draws only from the server's
 * `identityBadge`, in teal (ID) or gold (ID + selfie), and a tap shows the
 * criteria and the not-an-endorsement statement (OD-TRUST-3).
 */
import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import {
  VerifiedBadge,
  readIdentityBadge,
  BADGE_TIER_COLOR,
  VERIFIED_BADGE_PUBLIC_CRITERIA,
  VERIFIED_BADGE_PUBLIC_STATEMENT,
} from '../VerifiedBadge.tsx';

describe('VerifiedBadge', () => {
  it('VB1. nothing for null, absent, a legacy boolean or an unknown tier (a badge is a claim)', async () => {
    // MUTATION: accept any truthy badge → the boolean `true` draws a badge → RED.
    for (const badge of [null, undefined, true, { tier: 'gold' }, { verified: true }, 'id']) {
      const ui = await render(<VerifiedBadge badge={badge} />);
      expect(ui.queryByTestId(/^verified-badge-/)).toBeNull();
      await ui.unmount();
    }
    expect(readIdentityBadge({ tier: 'id_selfie' })).toEqual({ tier: 'id_selfie' });
  });

  it('VB2. teal for an ID check, gold for ID + selfie, each with a label that says which', async () => {
    const teal = await render(<VerifiedBadge badge={{ tier: 'id' }} />);
    expect(teal.getByLabelText(/^ID verified\./)).toBeTruthy();
    expect(teal.getByTestId('verified-badge-id')).toBeTruthy();
    await teal.unmount();
    const gold = await render(<VerifiedBadge badge={{ tier: 'id_selfie' }} />);
    expect(gold.getByLabelText(/^ID and selfie verified\./)).toBeTruthy();
    expect(BADGE_TIER_COLOR.id).not.toEqual(BADGE_TIER_COLOR.id_selfie);
  });

  it('VB3. a tap shows every criterion and the statement; nothing offers to buy it', async () => {
    // MUTATION: drop the criteria list from the sheet → RED.
    const ui = await render(<VerifiedBadge badge={{ tier: 'id' }} />);
    expect(ui.queryByTestId('verified-badge-criteria')).toBeNull();
    await act(async () => { fireEvent.press(ui.getByTestId('verified-badge-id')); });
    for (const c of VERIFIED_BADGE_PUBLIC_CRITERIA) expect(ui.getByText(`• ${c}`)).toBeTruthy();
    expect(ui.getByText(VERIFIED_BADGE_PUBLIC_STATEMENT)).toBeTruthy();
    expect(ui.queryByText(/buy|upgrade|premium|get verified/i)).toBeNull();
  });
});
