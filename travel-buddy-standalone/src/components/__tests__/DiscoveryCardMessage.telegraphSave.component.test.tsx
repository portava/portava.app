/**
 * DiscoveryCardMessage — the Save button goes through the Telegraph
 * discovery-card command (census-discovery §95, lane W11-X3; §81.4 routed hunk
 * R1; A21).
 *
 *   C1  server flag OFF (`fallback`): today's toggleSave runs with today's
 *       payload and today's alert — the flag-off behaviour, unchanged
 *   C2  flag ON and confirmed (`saved`): toggleSave is NOT called, "Saved" is shown
 *   C3  refused / failed: toggleSave is NOT called (no second path around the
 *       server's no), and the server's reason is shown
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { DiscoveryCardMessage } from '../DiscoveryCardMessage.tsx';
import { toggleSave } from '../../services/discoveryBookmarks.ts';
import { saveDiscoveryCardViaTelegraph } from '../../services/discoveryCardSave.ts';

// NOTE: intentionally exhaustive — discoveryBookmarks pulls AsyncStorage and the
// account-scoping chain; only toggleSave is exercised by the card.
jest.mock('../../services/discoveryBookmarks.ts', () => ({
  toggleSave: jest.fn(async () => ({ added: true })),
}));

// NOTE: intentionally exhaustive — the service under the card's Save is the unit
// the service suite covers; here only its outcome drives the card.
jest.mock('../../services/discoveryCardSave.ts', () => ({
  saveDiscoveryCardViaTelegraph: jest.fn(),
}));

// NOTE: intentionally exhaustive — revocation re-resolves through the share API
// (Supabase/apiToken); a card with no threadId is never revocable anyway.
jest.mock('../../features/telegraph/sharing/useShareRevocation.ts', () => ({
  useShareRevocation: () => ({ state: 'unknown' }),
  revokedLabel: () => 'unavailable',
}));

// NOTE: intentionally exhaustive — shareApi imports the authed fetch chain.
jest.mock('../../features/telegraph/sharing/shareApi.ts', () => ({
  legacySourceTypeToObjectType: () => null,
}));

// NOTE: intentionally exhaustive — the picker opens a trips modal with its own
// service chain; the Save button is what this suite presses.
jest.mock('../discovery/TripWishlistPicker.tsx', () => ({
  TripWishlistPicker: () => null,
}));

// NOTE: intentionally exhaustive — expo-router requires a navigation provider.
jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const BODY = JSON.stringify({ sourceId: 'place-1', sourceType: 'place', title: 'Rooftop', category: 'nightlife', city: 'Lisbon' });
const tg = saveDiscoveryCardViaTelegraph as jest.Mock;
const toggle = toggleSave as jest.Mock;

beforeEach(() => {
  tg.mockReset();
  toggle.mockClear();
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => { (Alert.alert as jest.Mock).mockRestore(); });

describe('C — the card Save', () => {
  it('C1 server flag OFF: today\'s toggleSave, today\'s payload, today\'s alert', async () => {
    tg.mockResolvedValue({ kind: 'fallback' });
    await render(<DiscoveryCardMessage body={BODY} mine={false} />);
    await fireEvent.press(screen.getByTestId('discovery-card-save'));
    await waitFor(() => expect(toggle).toHaveBeenCalledTimes(1));
    expect(tg).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'place-1', title: 'Rooftop', category: 'nightlife', sourceType: 'place', city: 'Lisbon' }));
    expect(toggle.mock.calls[0][0]).toEqual(expect.objectContaining({ id: 'place-1', name: 'Rooftop', category: 'nightlife', type: 'place', address: 'Lisbon' }));
    expect(Alert.alert).toHaveBeenCalledWith('Saved', '"Rooftop" was added to your saved places.');
  });

  it('C2 flag ON and confirmed: no toggleSave, "Saved"', async () => {
    tg.mockResolvedValue({ kind: 'saved', message: '"Rooftop" was added to your saved places.' });
    await render(<DiscoveryCardMessage body={BODY} mine={false} />);
    await fireEvent.press(screen.getByTestId('discovery-card-save'));
    await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Saved', '"Rooftop" was added to your saved places.'));
    expect(toggle).not.toHaveBeenCalled();
  });

  it('C3 refused or failed: no second path around the server, and its reason is shown', async () => {
    for (const outcome of [
      { kind: 'refused', message: 'This place is no longer available to save.' },
      { kind: 'failed', message: 'That could not be saved right now. Please try again.' },
    ]) {
      tg.mockResolvedValueOnce(outcome);
      const view = await render(<DiscoveryCardMessage body={BODY} mine={false} />);
      await fireEvent.press(screen.getByTestId('discovery-card-save'));
      await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Could not save', outcome.message));
      await view.unmount();
    }
    expect(toggle).not.toHaveBeenCalled();
  });
});
