import React from 'react';
import { Text } from 'react-native';
import { act, render, waitFor } from '@testing-library/react-native';
import { useMediaActions } from '../hooks/useMediaActions.ts';
import * as service from '../services/mediaActions.ts';
import { setDiscoveryViewerFromSession } from '../../../services/discoveryViewerScope.ts';
import { seedObservedOwnerSession, disposeObservedOwnerSession, emitObservedAuthEvent, observedOwnerSession } from '../../../services/__tests__/observedOwnerSessionFixture.ts';

jest.mock('../../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});
jest.mock('../services/mediaActions.ts', () => ({ ...jest.requireActual('../services/mediaActions.ts'),
  fetchMediaActions: jest.fn(), postMediaIntent: jest.fn(), deleteMediaIntent: jest.fn() }));

let result: ReturnType<typeof useMediaActions>;
function Mounted({ id = 'media-a', enabled = true }: { id?: string; enabled?: boolean }) {
  result = useMediaActions(id, enabled);
  return <Text>{result.actions.map(action => action.label).join(',')}</Text>;
}
function data(mediaId: string) {
  return { ok: true as const, data: { mediaId, generatedAt: null, entityRefs: [],
    actions: [{ id: 'i_want_this', label: mediaId, outcome: 'want', target: { method: 'POST' as const, endpoint: '/intent', params: {} } }] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) };
}
beforeEach(() => {
  jest.clearAllMocks();
  setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a');
  jest.mocked(service.fetchMediaActions).mockImplementation(async id => data(id));
  jest.mocked(service.postMediaIntent).mockResolvedValue({ ok: true });
  jest.mocked(service.deleteMediaIntent).mockResolvedValue({ ok: true });
});
afterEach(() => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); });

it('loads only while open and clears the old item before a replacement read completes', async () => {
  const mounted = await render(<Mounted enabled={false} />);
  expect(service.fetchMediaActions).not.toHaveBeenCalled();
  await mounted.rerender(<Mounted />);
  await waitFor(() => expect(result.status).toBe('ready'));
  const pending = deferred<ReturnType<typeof data>>();
  jest.mocked(service.fetchMediaActions).mockReturnValueOnce(pending.promise);
  await mounted.rerender(<Mounted id="media-b" />);
  expect(result.actions).toEqual([]);
  await act(async () => { pending.resolve(data('media-b')); });
  expect(result.actions[0].label).toBe('media-b');
});

it('blocks double taps synchronously, restores a failed toggle, and allows retry', async () => {
  const pending = deferred<{ ok: boolean }>();
  jest.mocked(service.postMediaIntent).mockReturnValueOnce(pending.promise);
  await render(<Mounted />);
  await act(async () => { result.toggleWant(); result.toggleWant(); });
  expect(service.postMediaIntent).toHaveBeenCalledTimes(1);
  expect(result.wanted).toBe(true); expect(result.wantPending).toBe(true);
  await act(async () => { pending.resolve({ ok: false }); });
  expect(result.wanted).toBe(false); expect(result.wantError).toMatch(/Try again/);
  await act(async () => { result.toggleWant(); });
  expect(result.wanted).toBe(true); expect(result.wantError).toBeNull();
});

it('a failed mutation from the previous item cannot undo the replacement item', async () => {
  const pending = deferred<{ ok: boolean }>();
  jest.mocked(service.postMediaIntent).mockReturnValueOnce(pending.promise);
  const mounted = await render(<Mounted />);
  await act(async () => { result.toggleWant(); });
  const signal = jest.mocked(service.postMediaIntent).mock.calls[0][2]?.signal;
  await mounted.rerender(<Mounted id="media-b" />);
  await act(async () => { result.toggleWant(); });
  await act(async () => { pending.resolve({ ok: false }); });
  expect(signal?.aborted).toBe(true);
  expect(result.wanted).toBe(true); expect(result.wantPending).toBe(false);
  expect(result.wantError).toBeNull();
});

it('rejects old reads and writes after an A-to-B-to-A item replacement', async () => {
  const oldRead = deferred<ReturnType<typeof data>>();
  const oldWrite = deferred<{ ok: boolean }>();
  jest.mocked(service.fetchMediaActions).mockReturnValueOnce(oldRead.promise);
  jest.mocked(service.postMediaIntent).mockReturnValueOnce(oldWrite.promise);
  const mounted = await render(<Mounted />);
  await act(async () => { result.toggleWant(); });
  await mounted.rerender(<Mounted id="media-b" />);
  await mounted.rerender(<Mounted />);
  await act(async () => { oldRead.resolve(data('stale')); oldWrite.resolve({ ok: true }); });
  expect(result.actions[0].label).toBe('media-a'); expect(result.wanted).toBe(false);
});

for (const change of ['different account', 'same account new session', 'logout and login']) {
  it(`retires pending work on ${change}`, async () => {
    const pending = deferred<{ ok: boolean }>();
    jest.mocked(service.postMediaIntent).mockReturnValueOnce(pending.promise);
    await render(<Mounted />);
    await act(async () => { result.toggleWant(); });
    const signal = jest.mocked(service.postMediaIntent).mock.calls[0][2]?.signal;
    await act(async () => {
      if (change === 'logout and login') emitObservedAuthEvent('SIGNED_OUT', null);
      const owner = change === 'different account' ? 'owner-b' : 'owner-a';
      setDiscoveryViewerFromSession(owner);
      emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(owner, change === 'logout and login' ? 'session-a' : 'session-b'));
    });
    await act(async () => { pending.resolve({ ok: true }); });
    expect(signal?.aborted).toBe(true); expect(result.wanted).toBe(false); expect(result.wantPending).toBe(false);
  });
}

it('cancels an outstanding mutation when dismissed and when unmounted', async () => {
  jest.mocked(service.postMediaIntent).mockReturnValue(new Promise(() => {}));
  const mounted = await render(<Mounted />);
  await act(async () => { result.toggleWant(); });
  const first = jest.mocked(service.postMediaIntent).mock.calls[0][2]?.signal;
  await mounted.rerender(<Mounted enabled={false} />);
  expect(first?.aborted).toBe(true);
  await mounted.rerender(<Mounted />);
  await act(async () => { result.toggleWant(); });
  const second = jest.mocked(service.postMediaIntent).mock.calls[1][2]?.signal;
  await mounted.unmount(); expect(second?.aborted).toBe(true);
});

it('restores persisted interest on reopen and sends DELETE to undo it', async () => {
  jest.mocked(service.fetchMediaActions).mockImplementation(async id => ({ ...data(id), data: { ...data(id).data, wanted: true } }));
  const mounted = await render(<Mounted />);
  await waitFor(() => expect(result.wanted).toBe(true));
  await mounted.rerender(<Mounted enabled={false} />);
  await mounted.rerender(<Mounted />);
  await waitFor(() => expect(result.wanted).toBe(true));
  await act(async () => { result.toggleWant(); });
  expect(service.deleteMediaIntent).toHaveBeenCalledTimes(1);
  expect(service.postMediaIntent).not.toHaveBeenCalled();
  expect(result.wanted).toBe(false);
});

it('a read started before a mutation cannot restore an older interest state', async () => {
  const pending = deferred<ReturnType<typeof data>>();
  const mounted = await render(<Mounted />);
  await waitFor(() => expect(result.status).toBe('ready'));
  jest.mocked(service.fetchMediaActions).mockReturnValueOnce(pending.promise);
  await act(async () => { result.reload(); result.toggleWant(); });
  await act(async () => { pending.resolve({ ...data('media-a'), data: { ...data('media-a').data, wanted: false } } as ReturnType<typeof data>); });
  expect(result.wanted).toBe(true);
  await mounted.unmount();
});
