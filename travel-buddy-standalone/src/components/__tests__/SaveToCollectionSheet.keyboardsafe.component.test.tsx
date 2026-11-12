jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});
import { seedObservedOwnerSession, disposeObservedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
/**
 * SaveToCollectionSheet — verifies the bottom sheet is wrapped in the
 * canonical keyboard-avoiding structure (KeyboardAvoidingView with
 * platform-correct behavior) so its inline "new collection" TextInput
 * stays above the keyboard.
 */
import React from 'react';
import { Platform, KeyboardAvoidingView } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SaveToCollectionSheet } from '../SaveToCollectionSheet.tsx';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { readCollections, checkSaved, saveItem, type Collection } from '../../services/collections.ts';

jest.mock('../../services/collections.ts', () => ({
  ...jest.requireActual('../../services/collections.ts'),
  checkSaved: jest.fn(async () => ({ ok: true, saved: false, collectionIds: [] })),
  readCollections: jest.fn(async () => ({ ok: true, data: [] })),
  createCollection: jest.fn(async () => null),
  saveItem: jest.fn(async () => undefined),
}));

const expectedBehavior = Platform.OS === 'ios' ? 'padding' : 'height';

it('wraps the sheet body in a KeyboardAvoidingView', async () => {
  let tr!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    tr = TestRenderer.create(
      <SaveToCollectionSheet
        visible
        entityType={'place' as any}
        entityId="e1"
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
  });
  const kavs = tr.root.findAllByType(KeyboardAvoidingView);
  expect(kavs.length).toBe(1);
  expect(kavs[0].props.behavior).toBe(expectedBehavior);
  await act(async () => { tr.unmount(); });
});

beforeEach(() => { setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a'); });
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); });

it('separates collection-list success from unknown saved status and recovers without offering a duplicate save', async () => {
 const collection: Collection = { id: 'c1', name: 'Food', position: 0, itemCount: 2, isDefault: false, coverUrl: null, createdAt: '', updatedAt: '' };
 jest.mocked(readCollections).mockResolvedValue({ ok: true, data: [collection] });
 jest.mocked(checkSaved).mockResolvedValueOnce({ ok: false, saved: false, collectionIds: [] })
   .mockResolvedValueOnce({ ok: true, saved: true, collectionIds: ['c1'] });
 const statusRead = jest.fn();
 await render(<SaveToCollectionSheet visible entityType="place" entityId="e1" onClose={jest.fn()} onSaved={jest.fn()} onStatusRead={statusRead} />);
 await screen.findByLabelText('Try checking saved status again');
 expect(screen.queryByText('Your collections could not be loaded. Tap to try again.')).toBeNull();
 expect(screen.getByText('Food')).toBeTruthy();
 expect(screen.getByLabelText('Save to Food').props.accessibilityState.disabled).toBe(true);
 expect(screen.queryByLabelText('Save for later')).toBeNull();
 await fireEvent.press(screen.getByLabelText('Save to Food'));
 expect(saveItem).not.toHaveBeenCalled();
 expect(statusRead).not.toHaveBeenCalled();
 await fireEvent.press(screen.getByLabelText('Try checking saved status again'));
 expect((await screen.findByLabelText('Saved to Food')).props.accessibilityState.selected).toBe(true);
 expect(statusRead).toHaveBeenCalledWith(true);
 expect(screen.queryByLabelText('Try checking saved status again')).toBeNull();
});
