import { seedObservedOwnerSession, disposeObservedOwnerSession, emitObservedAuthEvent, observedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
/** Save flow through the real button and picker, including ranking attribution. */
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SaveButton } from '../SaveButton.tsx';
import * as collections from '../../services/collections.ts';
import { clearAll, getSaved } from '../../services/savedPostsCache.ts';

const mockFireRankOutcome = jest.fn();
let mockUserId = 'user-abc';
// NOTE: ranking is an external boundary; exercise the actual picker and cache.
jest.mock('../../hooks/useRankOutcome.ts', () => ({ fireRankOutcome: (...a: unknown[]) => mockFireRankOutcome(...a) }));
// NOTE: the native session provider is not needed to test account changes at this boundary.
jest.mock('../../context/SessionContext.tsx', () => ({ useSession: () => ({ userId: mockUserId }) }));
// NOTE: avoid constructing the native Supabase client; API calls below are controlled.
jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});
jest.mock('../../services/collections.ts', () => ({
  ...jest.requireActual('../../services/collections.ts'),
  readCollections: jest.fn(), createCollection: jest.fn(), saveItem: jest.fn(),
  unsaveItem: jest.fn(), checkSaved: jest.fn(),
}));

const FOOD: collections.Collection = { id: 'food', name: 'Food', coverUrl: null, position: 0, isDefault: false, itemCount: 2, createdAt: '', updatedAt: '' };
const TRIPS: collections.Collection = { ...FOOD, id: 'trips', name: 'Future Trips', itemCount: 0 };
const NEW: collections.Collection = { ...TRIPS, id: 'new', name: 'Vietnam' };
const SAVE = jest.mocked(collections.saveItem);
const CREATE = jest.mocked(collections.createCollection);
const UNSAVE = jest.mocked(collections.unsaveItem);
const changed = jest.fn();

beforeEach(() => {
  setDiscoveryViewerFromSession('user-abc'); seedObservedOwnerSession('user-abc', 'save-session');
  jest.clearAllMocks(); clearAll(); mockUserId = 'user-abc';
  jest.mocked(collections.readCollections).mockResolvedValue({ ok: true, data: [FOOD, TRIPS] });
  jest.mocked(collections.checkSaved).mockResolvedValue({ saved: false, collectionIds: [] });
  SAVE.mockReset().mockResolvedValue(true);
  CREATE.mockReset().mockResolvedValue(NEW);
  UNSAVE.mockReset().mockResolvedValue(true);
});

async function open(saved = false) {
  const view = await render(<SaveButton entityType="post" entityId="post-1" initialSaved={saved} sessionId="session-1" onSavedChange={changed} />);
  await fireEvent.press(screen.getByLabelText(saved ? 'Manage saved collections' : 'Save to collection'));
  await screen.findByText('Food');
  return view;
}

it('opens on an ordinary tap, saves into two collections, and attributes only the first save', async () => {
  await open();
  expect(SAVE).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Save to Food'));
  expect(SAVE).toHaveBeenLastCalledWith('post', 'post-1', FOOD.id);
  expect(screen.getByLabelText('Saved to Food').props.accessibilityState.selected).toBe(true);
  expect(screen.getByText('Saved to “Food”.')).toBeTruthy();
  expect(getSaved('user-abc', 'post-1')).toBe(true);
  await fireEvent.press(screen.getByLabelText('Save to Future Trips'));
  expect(SAVE).toHaveBeenLastCalledWith('post', 'post-1', TRIPS.id);
  expect(screen.getByLabelText('Saved to Food')).toBeTruthy();
  expect(screen.getByLabelText('Saved to Future Trips')).toBeTruthy();
  expect(UNSAVE).not.toHaveBeenCalled();
  expect(mockFireRankOutcome).toHaveBeenCalledTimes(1);
  expect(mockFireRankOutcome).toHaveBeenCalledWith('post-1', 'pulse', 'save', 'session-1');
});

it('creates a named collection and saves into its returned id', async () => {
  await open();
  await fireEvent.press(screen.getByLabelText('New collection'));
  await fireEvent.changeText(screen.getByLabelText('Collection name'), '  Vietnam  ');
  await fireEvent.press(screen.getByLabelText('Create and save'));
  expect(CREATE).toHaveBeenCalledWith('Vietnam');
  expect(SAVE).toHaveBeenCalledWith('post', 'post-1', NEW.id);
  expect(screen.getByLabelText('Saved to Vietnam')).toBeTruthy();
  expect(screen.getByText('Saved to “Vietnam”.')).toBeTruthy();
});

it('still allows saving before the user has created any collections', async () => {
  jest.mocked(collections.readCollections).mockResolvedValue({ ok: true, data: [] });
  await render(<SaveButton entityType="post" entityId="post-1" initialSaved={false} onSavedChange={changed} />);
  await fireEvent.press(screen.getByLabelText('Save to collection'));
  await fireEvent.press(await screen.findByLabelText('Save for later'));
  expect(SAVE).toHaveBeenCalledWith('post', 'post-1', undefined);
  expect(CREATE).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledWith(true);
  expect(screen.getByText('Saved. You can add it to a collection anytime.')).toBeTruthy();
});

it('keeps a newly created collection available for retry when filing the item fails', async () => {
  SAVE.mockResolvedValueOnce(false);
  await open();
  await fireEvent.press(screen.getByLabelText('New collection'));
  await fireEvent.changeText(screen.getByLabelText('Collection name'), 'Vietnam');
  await fireEvent.press(screen.getByLabelText('Create and save'));
  expect(screen.getByText('Created “Vietnam” but couldn\'t save to it. Please try again.')).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
  expect(mockFireRankOutcome).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Save to Vietnam'));
  expect(CREATE).toHaveBeenCalledTimes(1);
  expect(SAVE).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledWith(true);
});

it('shows an error without changing the bookmark when a collection save fails', async () => {
  SAVE.mockResolvedValue(false);
  await open();
  await fireEvent.press(screen.getByLabelText('Save to Food'));
  expect(screen.getByText('Couldn\'t save to “Food”. Please try again.')).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
  // The successful initial status read is cached; the failed save cannot turn it on.
  expect(getSaved('user-abc', 'post-1')).toBe(false);
});

it('prevents duplicate create requests while waiting', async () => {
  let resolve!: (c: collections.Collection) => void;
  CREATE.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  await open();
  await fireEvent.press(screen.getByLabelText('New collection'));
  await fireEvent.changeText(screen.getByLabelText('Collection name'), 'Vietnam');
  await fireEvent.press(screen.getByLabelText('Create and save'));
  await fireEvent(screen.getByLabelText('Collection name'), 'submitEditing');
  expect(CREATE).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(NEW); });
  expect(SAVE).toHaveBeenCalledTimes(1);
});

it('shows existing memberships and only unsaves through the explicit remove action', async () => {
  jest.mocked(collections.checkSaved).mockResolvedValue({ saved: true, collectionIds: [FOOD.id] });
  await open(true);
  expect(screen.getByLabelText('Saved to Food')).toBeTruthy();
  expect(UNSAVE).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Remove from saved and all collections'));
  expect(UNSAVE).toHaveBeenCalledWith('post', 'post-1');
  expect(changed).toHaveBeenCalledWith(false);
  expect(getSaved('user-abc', 'post-1')).toBe(false);
  expect(mockFireRankOutcome).not.toHaveBeenCalled();
});

it('does not continue a create-and-save into another account after an account switch', async () => {
  let resolve!: (c: collections.Collection) => void;
  CREATE.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const view = await open();
  await fireEvent.press(screen.getByLabelText('New collection'));
  await fireEvent.changeText(screen.getByLabelText('Collection name'), 'Vietnam');
  await fireEvent.press(screen.getByLabelText('Create and save'));
  mockUserId = 'another-user';
  await view.rerender(<SaveButton entityType="post" entityId="post-1" initialSaved={false} onSavedChange={changed} />);
  await act(async () => { resolve(NEW); });
  expect(SAVE).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  expect(getSaved('another-user', 'post-1')).toBeUndefined();
});

it('does not replace unknown status with an unsaved bookmark or offer Save for later', async () => {
  jest.mocked(collections.checkSaved).mockResolvedValue({ ok: false, saved: false, collectionIds: [] });
  await open(true);
  expect(screen.queryByLabelText('Save for later')).toBeNull();
  expect(screen.getByTestId('save-to-collection-load-error')).toBeTruthy();
  expect(screen.getByLabelText('Save to Food').props.accessibilityState.disabled).toBe(true);
  expect(getSaved('user-abc', 'post-1')).toBeUndefined();
});

it('restores an existing unfiled save without recording a new save event', async () => {
  jest.mocked(collections.checkSaved).mockResolvedValue({ ok: true, saved: true, collectionIds: [] });
  await open();
  expect(screen.queryByLabelText('Save for later')).toBeNull();
  expect(screen.getByLabelText('Remove from saved and all collections')).toBeTruthy();
  expect(getSaved('user-abc', 'post-1')).toBe(true);
  expect(mockFireRankOutcome).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it('retires create-and-save on logout/login before a same-account rerender', async () => {
  let finish!: (value: collections.Collection) => void;
  CREATE.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await open();
  await fireEvent.press(screen.getByLabelText('New collection'));
  await fireEvent.changeText(screen.getByLabelText('Collection name'), 'Vietnam');
  await fireEvent.press(screen.getByLabelText('Create and save'));
  await act(async () => {
    emitObservedAuthEvent('SIGNED_OUT', null);
    emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('user-abc', 'save-session'));
    finish(NEW);
  });
  expect(SAVE).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled();
  expect(screen.queryByText('Save to collections')).toBeNull();
});

afterEach(async () => { await act(async () => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); }); });
