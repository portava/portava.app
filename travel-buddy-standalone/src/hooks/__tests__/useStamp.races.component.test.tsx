import { renderHook, act } from '@testing-library/react-native';
// Exercise the real state machine with a controllable network response.
const mockStamp = jest.fn();
// NOTE: exhaustive service stub; the test controls the two mutation results and must not initialize native Supabase.
jest.mock('../../services/stamps.ts', () => ({ stampEntity:(...args: unknown[]) => mockStamp(...args), unstampEntity:jest.fn() }));
import { useStamp } from '../useStamp.ts';
beforeEach(() => mockStamp.mockReset());
it('coalesces taps before a loading render', async () => {
  let resolve!: (v: unknown) => void;
  mockStamp.mockImplementation(() => new Promise((r) => { resolve=r; }));
  const { result } = await renderHook(() => useStamp({ entityType:'post',entityId:'one',initialCount:3,initialIsStamped:false }));
  let a!: Promise<unknown>; let b!: Promise<unknown>;
  await act(async () => { a=result.current.toggle(); b=result.current.toggle(); });
  expect(mockStamp).toHaveBeenCalledTimes(1);
  expect(a).toBe(b);
  await act(async () => { resolve({ ok:true,data:{ count:4,isStamped:true } }); await a; });
  expect(result.current.count).toBe(4);
  expect(result.current.isLoading).toBe(false);
});
it('cannot apply an old entity result to a new card', async () => {
  let resolve!: (v: unknown) => void;
  mockStamp.mockImplementation(() => new Promise((r) => { resolve=r; }));
  const { result, rerender } = await renderHook<ReturnType<typeof useStamp>, { id: string }>(({ id }) => useStamp({ entityType:'post',entityId:id,initialCount:10,initialIsStamped:false }), { initialProps:{ id:'one' } });
  let pending!: Promise<unknown>;
  await act(async () => { pending=result.current.toggle(); });
  await rerender({ id:'two' });
  await act(async () => { resolve({ ok:true,data:{ count:999,isStamped:true } }); await pending; });
  expect(result.current.count).toBe(10); expect(result.current.isStamped).toBe(false); expect(result.current.isLoading).toBe(false);
});
