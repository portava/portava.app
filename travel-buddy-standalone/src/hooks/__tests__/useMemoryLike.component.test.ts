/**
 * HM-F09 — the like on a Memory writes `memory_likes`, the table its count is read from.
 *
 * WHAT WAS WRONG. `app/memory/[id].tsx` rendered a StampButton seeded with
 * `memory.likeCount` / `memory.likedByMe` — both read from `memory_likes` by
 * `GET /memories/:id` — while the button's own toggle wrote an ENTITY STAMP
 * (`POST /api/stamps`, a different table). A tap moved a number the next load
 * overwrote, and `likeMemory` / `unlikeMemory` had no caller at all.
 *
 * `useMemoryLike` is a `UseStampReturn` backed by `POST|DELETE
 * /memories/:id/like`, handed to StampButton as its `controlledStamp`, so the
 * stamp gesture stays and the write lands where the count comes from.
 *
 * Pinned: the like and unlike go to the memory like routes; the server's count
 * wins; a refused write rolls back to the state the server still holds; a
 * count the server could not read (null) keeps the optimistic count rather than
 * showing zero.
 *
 * Run with: pnpm test:component
 */
import { renderHook, act } from '@testing-library/react-native';

const mockLike = jest.fn();
const mockUnlike = jest.fn();

jest.mock('../../services/memories.ts', () => ({
  ...jest.requireActual('../../services/memories.ts'),
  likeMemory: (...a: unknown[]) => mockLike(...a),
  unlikeMemory: (...a: unknown[]) => mockUnlike(...a),
}));

import { useMemoryLike } from '../useMemoryLike.ts';

const MID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => { mockLike.mockReset(); mockUnlike.mockReset(); });

it('liking calls likeMemory and takes the server count', async () => {
  mockLike.mockResolvedValue({ ok: true, likeCount: 7 });
  const { result } = await renderHook(() => useMemoryLike(MID, 4, false));
  let out: { isStamped: boolean; count: number | null } | undefined;
  await act(async () => { out = await result.current.toggle(); });
  expect(mockLike).toHaveBeenCalledWith(MID);
  expect(mockUnlike).not.toHaveBeenCalled();
  expect(out).toEqual({ isStamped: true, count: 7 });
  expect(result.current.isStamped).toBe(true);
  expect(result.current.count).toBe(7);
});

it('unliking calls unlikeMemory', async () => {
  mockUnlike.mockResolvedValue({ ok: true, likeCount: 2 });
  const { result } = await renderHook(() => useMemoryLike(MID, 3, true));
  await act(async () => { await result.current.toggle(); });
  expect(mockUnlike).toHaveBeenCalledWith(MID);
  expect(result.current.isStamped).toBe(false);
  expect(result.current.count).toBe(2);
});

it('a refused like rolls back to what the server still holds', async () => {
  mockLike.mockResolvedValue({ ok: false });
  const { result } = await renderHook(() => useMemoryLike(MID, 4, false));
  let out: { isStamped: boolean; count: number | null } | undefined;
  await act(async () => { out = await result.current.toggle(); });
  expect(out).toEqual({ isStamped: false, count: 4 });
  expect(result.current.isStamped).toBe(false);
  expect(result.current.count).toBe(4);
});

it('an unreadable count (null) keeps the optimistic count, never zero', async () => {
  mockLike.mockResolvedValue({ ok: true, likeCount: null });
  const { result } = await renderHook(() => useMemoryLike(MID, 4, false));
  await act(async () => { await result.current.toggle(); });
  expect(result.current.isStamped).toBe(true);
  expect(result.current.count).toBe(5);
});

it('re-seeds when the Memory reloads with new server values', async () => {
  const { result, rerender } = await renderHook(
    ({ c, l }: { c: number; l: boolean }) => useMemoryLike(MID, c, l),
    { initialProps: { c: 1, l: false } },
  );
  expect(result.current.count).toBe(1);
  await rerender({ c: 9, l: true });
  expect(result.current.count).toBe(9);
  expect(result.current.isStamped).toBe(true);
});
