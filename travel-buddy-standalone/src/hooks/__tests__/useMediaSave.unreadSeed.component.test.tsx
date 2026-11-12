/**
 * useMediaSave.seed — an unread saved state is never written as "not saved"
 * (census-media §47).
 *
 * The Watch and Gems feeds answer the viewer's saved state as `null` when its
 * read failed. seed() wrote whatever it got into the store, and GemsFeed
 * coerced `hasSaved ?? false` before calling it, so an unread state became a
 * stored false that a later, measured answer could not replace (seed skips
 * ids it already holds). Pinned here:
 *
 *   1. seed() leaves an unread (null) id out of the store;
 *   2. a later measured answer for that id is then taken;
 *   3. measured true/false are stored as before.
 *
 * Run with: pnpm test:component
 */
import { renderHook, act } from '@testing-library/react-native';
import { seedObservedOwnerSession, disposeObservedOwnerSession, emitObservedAuthEvent, observedOwnerSession } from '../../services/__tests__/observedOwnerSessionFixture.ts';
import { setDiscoveryViewerFromSession } from '../../services/discoveryViewerScope.ts';
import { saveMedia } from '../../services/mediaInteractions.ts';

jest.mock('../../lib/supabase.ts', () => {
  const listeners = new Set();
  return { isSupabaseConfigured: true, supabase: { auth: { listeners, onAuthStateChange: (listener: unknown) => {
    listeners.add(listener); return { data: { subscription: { unsubscribe: () => listeners.delete(listener) } } };
  } } } };
});

// NOTE: intentional exhaustive stub — the save API is not under test.
jest.mock('../../services/mediaInteractions.ts', () => ({
  saveMedia: jest.fn(async () => ({ ok: true })),
  unsaveMedia: jest.fn(async () => ({ ok: true })),
}));

import { useMediaSave } from '../useMediaSave.ts';
beforeEach(() => { setDiscoveryViewerFromSession('owner-a'); seedObservedOwnerSession('owner-a', 'session-a'); jest.mocked(saveMedia).mockClear().mockResolvedValue({ ok: true }); });
afterEach(async () => { await act(async () => { disposeObservedOwnerSession(); setDiscoveryViewerFromSession(null); }); });

it('applies collection status immediately without letting an old feed seed overwrite it', async () => {
  const { result } = await renderHook(() => useMediaSave());
  await act(async () => { result.current.seed([{ id: 'a', savedByMe: false }]); result.current.setSaved('a', true); });
  await act(async () => { result.current.seed([{ id: 'a', savedByMe: false }]); });
  expect(result.current.isSaved('a')).toBe(true);
  await act(async () => { result.current.setSaved('a', false); });
  expect(result.current.isSaved('a')).toBe(false);
});

it('cannot roll back a confirmed collection save when an older toggle fails', async () => {
  let finish!: (value: { ok: boolean }) => void;
  jest.mocked(saveMedia).mockReturnValueOnce(new Promise(done => { finish = done; }));
  const { result } = await renderHook(() => useMediaSave());
  await act(async () => { void result.current.toggleSave('a'); void result.current.toggleSave('a'); });
  expect(saveMedia).toHaveBeenCalledTimes(1);
  await act(async () => { result.current.setSaved('a', true); finish({ ok: false }); });
  expect(result.current.isSaved('a')).toBe(true);
});

for (const replacement of ['different account', 'same account new session']) {
  it(`discards an old toggle and callbacks on ${replacement}`, async () => {
    let finish!: (value: { ok: boolean }) => void;
    jest.mocked(saveMedia).mockReturnValueOnce(new Promise(done => { finish = done; }));
    const { result } = await renderHook(() => useMediaSave());
    const old = result.current;
    await act(async () => { void old.toggleSave('a'); });
    await act(async () => {
      const owner = replacement === 'different account' ? 'owner-b' : 'owner-a';
      setDiscoveryViewerFromSession(owner);
      emitObservedAuthEvent('SIGNED_IN', observedOwnerSession(owner, 'session-b'));
    });
    expect(result.current.savedSet).toEqual({});
    await act(async () => { result.current.setSaved('a', true); old.setSaved('old', true); old.seed([{ id: 'old-seed', savedByMe: true }]); finish({ ok: false }); });
    expect(result.current.savedSet).toEqual({ a: true });
  });
}

describe('useMediaSave.seed — unread saved state', () => {
  it('an unread state is not stored, so it is not read as "not saved"', async () => {
    const { result } = await renderHook(() => useMediaSave());
    await act(async () => { result.current.seed([{ id: 'a', savedByMe: null }]); });
    expect('a' in result.current.savedSet).toBe(false);
  });

  it('a later measured answer for that id is taken', async () => {
    const { result } = await renderHook(() => useMediaSave());
    await act(async () => { result.current.seed([{ id: 'a', savedByMe: null }]); });
    await act(async () => { result.current.seed([{ id: 'a', savedByMe: true }]); });
    expect(result.current.savedSet.a).toBe(true);
  });

  it('measured true and false are stored as before', async () => {
    const { result } = await renderHook(() => useMediaSave());
    await act(async () => { result.current.seed([{ id: 'a', savedByMe: true }, { id: 'b', savedByMe: false }]); });
    expect(result.current.savedSet).toEqual({ a: true, b: false });
  });
});
