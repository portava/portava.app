/**
 * Saved and the Save-to sheet — a failed collections read is not "no collections".
 *
 * readCollections() replaces getCollections(), which answered a failed read
 * with []. The Saved screen then said "No collections yet" and offered starter
 * chips that create a collection on one tap (duplicates of collections that
 * exist), and the Save-to sheet listed nothing to save into.
 *
 *   S1  Saved: a failed read shows the error, not the empty state or the
 *       starter chips, and Try again loads the collections;
 *   S2  Saved: a real empty read is still the empty state;
 *   S3  Save-to sheet: a failed read says so, and tapping it retries.
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — useFocusEffect runs the load once on mount
// (there is no navigator focus event under jest); router is a stub.
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useFocusEffect: (cb: () => void) => { R.useEffect(cb, []); },
    router: { back: jest.fn(), push: jest.fn() },
  };
});

const mockRead = jest.fn();
jest.mock('../../src/services/collections', () => ({
  ...jest.requireActual('../../src/services/collections'),
  readCollections: (...a: unknown[]) => mockRead(...a),
  createCollection: jest.fn(),
  saveItem: jest.fn(),
}));
// NOTE: intentionally exhaustive — the saved-posts list is not opened here.
jest.mock('../../src/components/SavedPostsList', () => ({ SavedPostsList: () => null }));
// NOTE: intentionally exhaustive — header chrome is not under test.
jest.mock('../../src/components/ui/AppHeader', () => ({ AppHeader: () => null }));
// NOTE: intentionally exhaustive — the nav-bar collapse needs Reanimated internals.
jest.mock('../../src/hooks/useNavBarCollapse', () => ({ useNavBarScrollHandler: () => jest.fn(), NavBarFiller: () => null }));

import SavedScreen from '../saved';
import { SaveToCollectionSheet } from '../../src/components/SaveToCollectionSheet';

const COL = { id: 'c-1', name: 'Food', coverUrl: null, position: 0, isDefault: false, itemCount: 3, createdAt: '2026-01-01', updatedAt: '2026-01-01' };

beforeEach(() => { mockRead.mockReset(); });

describe('Saved — a failed collections read', () => {
  it('S1: shows the error, not the empty state or starter chips, and Try again loads', async () => {
    mockRead.mockResolvedValueOnce({ ok: false, data: [] }).mockResolvedValueOnce({ ok: true, data: [COL] });
    await render(<SavedScreen />);
    await screen.findByTestId('collections-load-error');
    expect(screen.getByText('Your collections could not be loaded. They are still saved.')).toBeTruthy();
    expect(screen.queryByText('No collections yet')).toBeNull();
    expect(screen.queryByText('Starter ideas')).toBeNull();

    await fireEvent.press(screen.getByLabelText('Retry'));
    await screen.findByText('Food');
    expect(mockRead).toHaveBeenCalledTimes(2);
  });

  it('S2: a real empty read is still the empty state', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [] });
    await render(<SavedScreen />);
    await screen.findByText('No collections yet');
    expect(screen.queryByTestId('collections-load-error')).toBeNull();
  });
});

describe('Save-to sheet — a failed collections read', () => {
  it('S3: says the collections did not load, and tapping it retries', async () => {
    mockRead.mockResolvedValueOnce({ ok: false, data: [] }).mockResolvedValueOnce({ ok: true, data: [COL] });
    await render(
      <SaveToCollectionSheet visible entityType={'place' as never} entityId="p-1" onClose={() => {}} onSaved={() => {}} />,
    );
    await screen.findByTestId('save-to-collection-load-error');
    await fireEvent.press(screen.getByLabelText('Try loading your collections again'));
    await screen.findByText('Food');
    expect(screen.queryByTestId('save-to-collection-load-error')).toBeNull();
  });
});
