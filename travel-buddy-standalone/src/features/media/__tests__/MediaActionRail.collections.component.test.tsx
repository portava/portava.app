import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { MediaActionRail } from '../components/MediaActionRail.tsx';
import * as actions from '../services/mediaActions.ts';
import * as collections from '../../../services/collections.ts';
import * as interactions from '../../../services/mediaInteractions.ts';
import type { MediaAction } from '../types/mediaActions.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, emitObservedAuthEvent, observedOwnerSession } from '../../../services/__tests__/observedOwnerSessionFixture.ts';

// SDK transport only: the session observer, action hook and collection UI are real.
jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});
jest.mock('../services/mediaActions.ts', () => ({ ...jest.requireActual('../services/mediaActions.ts'), fetchMediaActions: jest.fn(), fetchCompiledExperiencePlan: jest.fn() }));
jest.mock('../../../services/collections.ts', () => ({ ...jest.requireActual('../../../services/collections.ts'),
  readCollections: jest.fn(), checkSaved: jest.fn(), createCollection: jest.fn(), saveItem: jest.fn(), unsaveItem: jest.fn() }));
jest.mock('../../../services/mediaInteractions.ts', () => ({ ...jest.requireActual('../../../services/mediaInteractions.ts'), reportMedia: jest.fn(), saveMedia: jest.fn() }));
// NOTE: exhaustive presentation stubs; trip and Telegraph panels are tested separately.
jest.mock('../components/MediaActionPanels.tsx', () => ({ SECTION21_ACTION_ICONS: {}, TripChoicePanel: () => null,
  InvitePanel: () => null, ContributePanel: () => null, EventLinkPanel: () => null, TelegraphObjectShareSheet: () => null,
  openRailDirections: jest.fn(), saveRailRoute: jest.fn() }));
// NOTE: exhaustive stub; the navigation provider does not participate in collection writes.
jest.mock('../../../components/PlanPickerController.tsx', () => ({ usePlanPicker: () => ({ open: jest.fn() }) }));
// NOTE: exhaustive stub to avoid analytics timers; no collection transport is mocked here.
jest.mock('../../../hooks/useMediaAnalytics.ts', () => ({ useMediaAnalytics: () => ({ record: jest.fn() }) }));
// NOTE: exhaustive native inset stub for predictable layout in the renderer.
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));

const collection: collections.Collection = { id: 'food', name: 'Food', itemCount: 0, isDefault: false, position: 0, coverUrl: null, createdAt: '', updatedAt: '' };
function action(id: string, label: string, params: Record<string, unknown> = {}): MediaAction {
  return { id, label, outcome: 'save', target: { method: 'POST', endpoint: '/save', params } };
}
function serve(entries: MediaAction[]) {
  jest.mocked(actions.fetchMediaActions).mockImplementation(async mediaId => ({ ok: true, data: { mediaId, generatedAt: null, actions: entries, entityRefs: [{ kind: 'media', id: mediaId, label: null }] } }));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
beforeEach(() => {
  jest.clearAllMocks();
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a');
  serve([action('save', 'Save')]);
  jest.mocked(collections.readCollections).mockResolvedValue({ ok: true, data: [collection] });
  jest.mocked(collections.checkSaved).mockResolvedValue({ ok: true, saved: false, collectionIds: [] });
  jest.mocked(collections.saveItem).mockResolvedValue(true);
  jest.mocked(collections.unsaveItem).mockResolvedValue(true);
  jest.mocked(interactions.reportMedia).mockResolvedValue({ ok: true });
});
afterEach(async () => { await act(async () => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); }); });

it('opens the real collection picker and writes only after choosing a destination', async () => {
  const close = jest.fn();
  await render(<MediaActionRail mediaId="post-a" visible onClose={close} />);
  await fireEvent.press(await screen.findByLabelText('Save'));
  expect(close).not.toHaveBeenCalled(); expect(interactions.saveMedia).not.toHaveBeenCalled();
  expect(collections.saveItem).not.toHaveBeenCalled();
  await fireEvent.press(await screen.findByLabelText('Save to Food'));
  expect(collections.saveItem).toHaveBeenCalledWith('post', 'post-a', 'food');
  expect(screen.getByText('Saved to “Food”.')).toBeTruthy();
  await fireEvent.press(screen.getByLabelText('Done'));
  expect(close).toHaveBeenCalledTimes(1);
});

it('creates a named collection and files the media there', async () => {
  jest.mocked(collections.createCollection).mockResolvedValue({ ...collection, id: 'weekend', name: 'Weekend' });
  await render(<MediaActionRail mediaId="post-a" visible onClose={() => {}} />);
  await fireEvent.press(await screen.findByLabelText('Save'));
  await fireEvent.press(await screen.findByLabelText('New collection'));
  await fireEvent.changeText(screen.getByLabelText('Collection name'), 'Weekend');
  await fireEvent.press(screen.getByLabelText('Create and save'));
  expect(collections.createCollection).toHaveBeenCalledWith('Weekend');
  expect(collections.saveItem).toHaveBeenCalledWith('post', 'post-a', 'weekend');
  expect(screen.getByText('Saved to “Weekend”.')).toBeTruthy();
});

it('shows a save failure in the picker and lets the same destination be retried', async () => {
  jest.mocked(collections.saveItem).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const close = jest.fn();
  await render(<MediaActionRail mediaId="post-a" visible onClose={close} />);
  await fireEvent.press(await screen.findByLabelText('Save'));
  await fireEvent.press(await screen.findByLabelText('Save to Food'));
  expect(screen.getByTestId('save-to-collection-error')).toBeTruthy(); expect(close).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Save to Food'));
  expect(screen.getByText('Saved to “Food”.')).toBeTruthy();
});

it('forgets an open collection choice when the media changes or the rail closes', async () => {
  const mounted = await render(<MediaActionRail mediaId="post-a" visible onClose={() => {}} />);
  await fireEvent.press(await screen.findByLabelText('Save'));
  expect(screen.getByText('Save to collections')).toBeTruthy();
  await mounted.rerender(<MediaActionRail mediaId="post-b" visible onClose={() => {}} />);
  expect(screen.queryByText('Save to collections')).toBeNull();
  await fireEvent.press(await screen.findByLabelText('Save'));
  await fireEvent.press(await screen.findByLabelText('Save to Food'));
  expect(collections.saveItem).toHaveBeenCalledWith('post', 'post-b', 'food');
  await mounted.rerender(<MediaActionRail mediaId="post-b" visible={false} onClose={() => {}} />);
  await mounted.rerender(<MediaActionRail mediaId="post-b" visible onClose={() => {}} />);
  expect(screen.queryByText('Save to collections')).toBeNull();
});

it('drops private collection state on same-account session replacement', async () => {
  await render(<MediaActionRail mediaId="post-a" visible onClose={() => {}} />);
  await fireEvent.press(await screen.findByLabelText('Save'));
  expect(screen.getByText('Food')).toBeTruthy();
  await act(async () => { emitObservedAuthEvent('SIGNED_IN', observedOwnerSession('owner-a', 'session-b')); });
  expect(screen.queryByText('Food')).toBeNull();
  expect(collections.saveItem).not.toHaveBeenCalled();
});

it('keeps a failed report open with a retry and accepts only a confirmed success', async () => {
  serve([action('report', 'Report')]);
  jest.mocked(interactions.reportMedia).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
  const close = jest.fn();
  await render(<MediaActionRail mediaId="post-a" visible onClose={close} />);
  await fireEvent.press(await screen.findByLabelText('Report'));
  expect(screen.getByText('Couldn’t send this report. Try again.')).toBeTruthy(); expect(close).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByLabelText('Report')); expect(close).toHaveBeenCalledTimes(1);
});

it('does not close the replacement media when an old report finishes', async () => {
  serve([action('report', 'Report')]);
  const pending = deferred<interactions.MediaActionResult>();
  jest.mocked(interactions.reportMedia).mockReturnValueOnce(pending.promise);
  const close = jest.fn();
  const mounted = await render(<MediaActionRail mediaId="post-a" visible onClose={close} />);
  await fireEvent.press(await screen.findByLabelText('Report'));
  const signal = jest.mocked(interactions.reportMedia).mock.calls[0][3]?.signal;
  await mounted.rerender(<MediaActionRail mediaId="post-b" visible onClose={close} />);
  expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve({ ok: true }); });
  expect(close).not.toHaveBeenCalled(); expect(screen.getByLabelText('Report')).toBeTruthy();
});

it('locks repeated plan requests and ignores a result after dismissal', async () => {
  serve([action('do_this_experience', 'Do this', { compile: true, experienceId: 'trip-a' })]);
  const pending = deferred<Awaited<ReturnType<typeof actions.fetchCompiledExperiencePlan>>>();
  jest.mocked(actions.fetchCompiledExperiencePlan).mockReturnValueOnce(pending.promise);
  const close = jest.fn();
  await render(<MediaActionRail mediaId="post-a" visible onClose={close} />);
  await fireEvent.press(await screen.findByLabelText('Do this'));
  await fireEvent.press(screen.getByLabelText('Do this'));
  expect(actions.fetchCompiledExperiencePlan).toHaveBeenCalledTimes(1);
  expect(actions.fetchCompiledExperiencePlan).toHaveBeenCalledWith('trip-a', { source: 'experience', signal: expect.any(AbortSignal) });
  const signal = jest.mocked(actions.fetchCompiledExperiencePlan).mock.calls[0][1].signal;
  await fireEvent.press(screen.getByLabelText('Close'));
  expect(signal?.aborted).toBe(true);
  await act(async () => { pending.resolve({ ok: true, data: null }); });
  expect(screen.queryByText('This experience has no plan you can add right now.')).toBeNull();
});
