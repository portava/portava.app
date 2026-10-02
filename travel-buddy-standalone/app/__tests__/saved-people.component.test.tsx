/**
 * Saved people — GET /me/saves on screen. TM-social, PLAT-F16.
 *
 * Saved profiles were written (Save profile) and never listed. The screen's
 * states must be true: loading, error with retry (never an empty list), a real
 * empty state, and the list — without anyone in a block relation with me.
 * A failed unsave keeps the row and says so.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import SavedPeopleScreen from '../saved-people.tsx';

jest.mock('expo-router', () => {
  const React = require('react');
  return {
    ...jest.requireActual('expo-router'),
    router: { push: jest.fn(), back: jest.fn() },
    useFocusEffect: (cb: () => void) => { React.useEffect(() => { cb(); }, [cb]); },
  };
});
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../src/hooks/useNavBarCollapse', () => ({
  ...jest.requireActual('../../src/hooks/useNavBarCollapse'),
  NavBarFiller: () => null,
  useNavBarScrollHandler: () => () => {},
}));
jest.mock('../../src/services/saves', () => ({
  ...jest.requireActual('../../src/services/saves'),
  getMySavedProfiles: jest.fn(),
  unsaveProfile: jest.fn(),
}));
jest.mock('../../src/context/BlockedIdsContext', () => ({
  ...jest.requireActual('../../src/context/BlockedIdsContext'),
  useBlockedIds: () => ({ blockedIds: new Set(['blk']), blockerIds: new Set() }),
}));

const saves = require('../../src/services/saves');
const P = (id: string, handle: string) => ({ id, handle, name: null, avatarUrl: null, savedAt: '2026-01-01' });

jest.setTimeout(20000);

describe('Saved people screen', () => {
  let alertSpy: jest.SpyInstance;
  beforeEach(() => { jest.clearAllMocks(); alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {}); });
  afterEach(() => alertSpy.mockRestore());

  it('lists saved people, minus anyone in a block relation', async () => {
    saves.getMySavedProfiles.mockResolvedValue({ ok: true, data: [P('a', 'ann'), P('blk', 'blocked')] });
    const { findByText, queryByText } = await render(<SavedPeopleScreen />);
    await findByText('@ann');
    expect(queryByText('@blocked')).toBeNull();
  });

  it('a failed read is an error with a retry, never "No saved people yet"', async () => {
    saves.getMySavedProfiles
      .mockResolvedValueOnce({ ok: false, error: 'Your block list could not be read' })
      .mockResolvedValueOnce({ ok: true, data: [P('a', 'ann')] });
    const { findByText, queryByText, getByLabelText } = await render(<SavedPeopleScreen />);
    await findByText("We couldn't load your saved people.");
    expect(queryByText('No saved people yet')).toBeNull();
    await fireEvent.press(getByLabelText('Retry'));
    await findByText('@ann');
  });

  it('a real empty list is the empty state', async () => {
    saves.getMySavedProfiles.mockResolvedValue({ ok: true, data: [] });
    const { findByText } = await render(<SavedPeopleScreen />);
    await findByText('No saved people yet');
  });

  it('unsave removes the row only when the server confirms', async () => {
    saves.getMySavedProfiles.mockResolvedValue({ ok: true, data: [P('a', 'ann'), P('b', 'bo')] });
    saves.unsaveProfile.mockResolvedValueOnce({ ok: false, error: 'Failed to unsave profile' }).mockResolvedValueOnce({ ok: true });
    const { findByText, getByTestId, queryByText } = await render(<SavedPeopleScreen />);
    await findByText('@ann');
    await fireEvent.press(getByTestId('saved-person-remove-a'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Could not remove', 'Failed to unsave profile'));
    expect(queryByText('@ann')).toBeTruthy();
    await fireEvent.press(getByTestId('saved-person-remove-a'));
    await waitFor(() => expect(queryByText('@ann')).toBeNull());
    expect(saves.unsaveProfile).toHaveBeenLastCalledWith('a');
    expect(queryByText('@bo')).toBeTruthy();
  });
});
