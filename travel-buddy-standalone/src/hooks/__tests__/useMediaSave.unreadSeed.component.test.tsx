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

// NOTE: intentional exhaustive stub — the save API is not under test.
jest.mock('../../services/mediaInteractions.ts', () => ({
  saveMedia: jest.fn(async () => ({ ok: true })),
  unsaveMedia: jest.fn(async () => ({ ok: true })),
}));

import { useMediaSave } from '../useMediaSave.ts';

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
