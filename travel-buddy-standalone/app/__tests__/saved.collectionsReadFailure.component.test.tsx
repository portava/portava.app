jest.mock('../../src/lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});
import { seedObservedOwnerSession, disposeObservedOwnerSession, emitObservedAuthEvent, observedOwnerSession } from '../../src/services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../src/services/discoveryViewerScope.ts';
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
import { render, screen, fireEvent, act } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { Collection, CollectionItem, CollectionsRead } from '../../src/services/collections.ts';

// NOTE: intentionally exhaustive — useFocusEffect runs the load once on mount
// (there is no navigator focus event under jest); router is a stub.
jest.mock('expo-router', () => {
  const R = require('react');
  return {
    useFocusEffect: (cb: () => void) => { R.useEffect(cb, [cb]); },
    router: { back: jest.fn(), push: jest.fn() },
  };
});

const mockRead = jest.fn();
const mockItems = jest.fn();
const mockSave = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
jest.mock('../../src/services/collections', () => ({
  ...jest.requireActual('../../src/services/collections'),
  readCollections: (...a: unknown[]) => mockRead(...a),
  createCollection: (...a: unknown[]) => mockCreate(...a),
  updateCollection: (...a: unknown[]) => mockUpdate(...a),
  deleteCollection: (...a: unknown[]) => mockDelete(...a),
  saveItem: (...a: unknown[]) => mockSave(...a),
  getCollectionItems: (...a: unknown[]) => mockItems(...a),
  checkSaved: jest.fn(async () => ({ saved: true, collectionIds: ['c-1'] })),
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

beforeEach(() => { setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a'); mockRead.mockReset(); mockItems.mockReset(); mockSave.mockReset().mockResolvedValue(true); mockCreate.mockReset(); mockUpdate.mockReset(); mockDelete.mockReset(); jest.mocked(router.push).mockClear(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
type Page = { ok: true; items: CollectionItem[]; hasMore: boolean; nextCursor: string | null };
const item = (id: string): CollectionItem => ({ id, entityType: 'memory', entityId: id, title: `Memory ${id}`, coverUrl: null, savedAt: '' });

describe('Collection management', () => {
  it('prefills a suggested collection, submits once, and lets a failed create be retried', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [] });
    const request = deferred<Collection | null>();
    mockCreate.mockReturnValueOnce(request.promise).mockResolvedValueOnce(COL);
    mockItems.mockResolvedValue({ ok: true, items: [], hasMore: false, nextCursor: null });
    await render(<SavedScreen />);
    await fireEvent.press(await screen.findByText('Food'));
    expect(mockCreate).not.toHaveBeenCalled();
    const input = screen.getByPlaceholderText('Collection name');
    expect(input.props.value).toBe('Food');
    await act(async () => { void input.props.onSubmitEditing(); void input.props.onSubmitEditing(); });
    expect(mockCreate).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(null); });
    expect(screen.getByText('Couldn’t create this collection. Try again.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Create'));
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Nothing saved here yet')).toBeTruthy();
  });

  it('does not open an old create result after its modal was dismissed and reopened', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [] });
    const request = deferred<Collection | null>(); mockCreate.mockReturnValue(request.promise);
    await render(<SavedScreen />);
    await fireEvent.press(await screen.findByText('Food'));
    await act(async () => { void screen.getByPlaceholderText('Collection name').props.onSubmitEditing(); });
    await fireEvent.press(screen.getByLabelText('Close new collection'));
    await fireEvent.press(screen.getByText('Nightlife'));
    await act(async () => { request.resolve(COL); });
    expect(screen.getByPlaceholderText('Collection name').props.value).toBe('Nightlife');
    expect(mockItems).not.toHaveBeenCalled();
  });

  it('keeps a failed rename editable, locks rapid submissions and then replaces the saved name', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [COL] });
    const request = deferred<Collection | null>();
    mockUpdate.mockReturnValueOnce(request.promise).mockResolvedValueOnce({ ...COL, name: 'Weekend food' });
    await render(<SavedScreen />);
    await fireEvent.press(await screen.findByLabelText('Rename Food'));
    await fireEvent.changeText(screen.getByPlaceholderText('Collection name'), 'Weekend food');
    const submit = screen.getByPlaceholderText('Collection name').props.onSubmitEditing;
    await act(async () => { void submit(); void submit(); });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(null); });
    expect(screen.getByText('Couldn’t rename this collection. Try again.')).toBeTruthy();
    await fireEvent.press(screen.getByText('Save'));
    expect(screen.getByText('Weekend food')).toBeTruthy();
    expect(screen.queryByText('Rename collection')).toBeNull();
  });

  it('keeps a collection after a failed delete and removes it only on a successful retry', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [COL] });
    const request = deferred<boolean>();
    mockDelete.mockReturnValueOnce(request.promise).mockResolvedValueOnce(true);
    await render(<SavedScreen />);
    const button = await screen.findByLabelText('Delete Food');
    await fireEvent.press(button); await fireEvent.press(button);
    expect(mockDelete).toHaveBeenCalledTimes(1);
    await act(async () => { request.resolve(false); });
    expect(screen.getByText('Food')).toBeTruthy();
    expect(screen.getByText('Couldn’t delete this collection. Try again.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Delete Food'));
    expect(screen.getByText('No collections yet')).toBeTruthy();
  });

  it('locks the pagination cursor and merges overlapping pages without duplicate rows', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [COL] });
    const more = deferred<Page>();
    mockItems.mockResolvedValueOnce({ ok: true, items: [item('one')], hasMore: true, nextCursor: 'cursor1' }).mockReturnValueOnce(more.promise);
    await render(<SavedScreen />);
    await fireEvent.press(await screen.findByText('Food'));
    const next = screen.getByTestId('saved-collection-items').props.onEndReached;
    await act(async () => { void next(); void next(); });
    expect(mockItems).toHaveBeenCalledTimes(2);
    await act(async () => { more.resolve({ ok: true, items: [item('one'), item('two')], hasMore: false, nextCursor: null }); });
    expect(screen.getAllByText('Memory one')).toHaveLength(1);
    await fireEvent.press(screen.getByText('Memory two'));
    expect(router.push).toHaveBeenCalledWith('/memory/two');
  });

  it('refreshes the open collection after organizing and drops an older pagination result', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [COL, { ...COL, id: 'c-2', name: 'Vietnam' }] });
    const more = deferred<Page>();
    mockItems.mockResolvedValueOnce({ ok: true, items: [item('one')], hasMore: true, nextCursor: 'cursor1' })
      .mockReturnValueOnce(more.promise).mockResolvedValueOnce({ ok: true, items: [], hasMore: false, nextCursor: null });
    await render(<SavedScreen />);
    await fireEvent.press(await screen.findByText('Food'));
    await act(async () => { void screen.getByTestId('saved-collection-items').props.onEndReached(); });
    await fireEvent.press(screen.getByLabelText('Add Memory one to collection'));
    await fireEvent.press(await screen.findByLabelText('Save to Vietnam'));
    await fireEvent.press(screen.getByLabelText('Done'));
    expect(mockItems).toHaveBeenCalledTimes(3);
    await act(async () => { more.resolve({ ok: true, items: [item('stale')], hasMore: false, nextCursor: null }); });
    expect(screen.getByText('Nothing saved here yet')).toBeTruthy();
    expect(screen.queryByText('Memory stale')).toBeNull();
  });

  it('replaces private screen state on a new same-account session before an old read finishes', async () => {
    const old = deferred<CollectionsRead>();
    mockRead.mockReturnValueOnce(old.promise).mockResolvedValue({ ok: true, data: [{ ...COL, name: 'Current session' }] });
    await render(<SavedScreen />);
    await act(async () => { emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-a', 'session-new')); });
    expect(screen.getByText('Current session')).toBeTruthy();
    await act(async () => { old.resolve({ ok: true, data: [{ ...COL, name: 'Old session' }] }); });
    expect(screen.queryByText('Old session')).toBeNull();
  });
});

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

  it('shows failed collection contents as an error and lets an existing item be filed elsewhere', async () => {
    mockRead.mockResolvedValue({ ok: true, data: [COL, { ...COL, id: 'c-2', name: 'Vietnam' }] });
    mockItems.mockResolvedValueOnce({ ok: false }).mockResolvedValue({
      ok: true,
      items: [{ id: 'i-1', entityType: 'place', entityId: 'p-1', title: 'Night market', coverUrl: null, savedAt: '' }],
      hasMore: false, nextCursor: null,
    });
    await render(<SavedScreen />);
    await fireEvent.press(await screen.findByText('Food'));
    expect(screen.getByText('This collection could not be loaded. Please try again.')).toBeTruthy();
    expect(screen.queryByText('Nothing saved here yet')).toBeNull();
    await fireEvent.press(screen.getByLabelText('Retry'));
    await fireEvent.press(await screen.findByLabelText('Add Night market to collection'));
    await fireEvent.press(await screen.findByLabelText('Save to Vietnam'));
    expect(mockSave).toHaveBeenCalledWith('place', 'p-1', 'c-2');
    expect(screen.getByText('Saved to “Vietnam”.')).toBeTruthy();
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

it('clears private collections immediately on account replacement and ignores the old read', async () => {
  let finish!: (value: unknown) => void;
  mockRead.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ok: true, data: [{ ...COL, name: 'New owner collection' }] });
  await render(<SavedScreen />);
  await act(async () => { setDiscoveryViewerFromSession('owner-b'); });
  await screen.findByText('New owner collection');
  await act(async () => { finish({ ok: true, data: [{ ...COL, name: 'Private old collection' }] }); });
  expect(screen.queryByText('Private old collection')).toBeNull();
  expect(screen.getByText('New owner collection')).toBeTruthy();
});

afterEach(async () => { await act(async () => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); }); });
