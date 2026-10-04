/**
 * StampButton / useStamp — a stamp count the server could not read
 * (census-media §47).
 *
 * The media and gems feeds answer an unread stamp count as `null`. useStamp
 * stepped it as a number (null + 1 === 1), so the first tap drew a made-up
 * "1" over a count nobody had read, and a refused tap "rolled back" to it.
 * StampButton drew `visualCount > 0`, so the unread count looked like zero.
 * Pinned here:
 *
 *   1. StampButton draws an unread count as the "—" mark, and a tap (the
 *      card-local burst path, and the screen-level stamp's impact) keeps
 *      drawing it until the server answers;
 *   2. useStamp's optimistic step keeps an unread count unread;
 *   3. a successful toggle takes the server's measured count;
 *   4. a refused toggle rolls back to unread, never to a number;
 *   5. a measured count still steps by one (unchanged).
 *
 * Run with: pnpm test:component
 */
import React from 'react';
import { render, renderHook, act, fireEvent } from '@testing-library/react-native';

// NOTE: intentionally exhaustive — react-native-reanimated initialises native
// worklets on import which crash under jest-expo without special Babel config.
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual('react-native');
  return { __esModule: true, default: { View: RN.View } };
});
// NOTE: intentionally exhaustive — the local press/count animation is reanimated-only.
jest.mock('../../../hooks/useStampAnimation', () => ({
  useStampAnimation: () => ({ buttonStyle: {}, countStyle: {}, playStamp: () => {}, playUnstamp: () => {} }),
}));
// jest's host View gives every instance a no-op measure(), so the press never
// reached triggerStamp. StampButton's own Views answer measure() here, as on a
// device; every other export is react-native's own (requireActual).
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  const React = jest.requireActual('react');
  const MeasuredView = React.forwardRef((props: object, ref: unknown) => {
    React.useImperativeHandle(ref, () => ({ measure: (cb: (...a: number[]) => void) => cb(0, 0, 20, 20, 100, 100) }));
    return React.createElement(RN.View, props);
  });
  return new Proxy(RN, { get: (t: Record<string, unknown>, k: string) => (k === 'View' ? MeasuredView : t[k]) });
});
type StampArgs = { onImpact: () => void; onComplete: () => void };
let mockLastTrigger: StampArgs | null = null;
// NOTE: intentionally exhaustive — the provider module pulls in reanimated and
// haptics; the screen-level stamp is captured so a test can play its impact
// and end by hand.
jest.mock('../../../context/StampAnimationContext', () => ({
  useStampAnimationContext: () => ({ triggerStamp: (a: StampArgs) => { mockLastTrigger = a; }, isAnimating: false }),
}));

const mockStamp = jest.fn();
const mockUnstamp = jest.fn();
jest.mock('../../../services/stamps.ts', () => ({
  ...jest.requireActual('../../../services/stamps.ts'),
  stampEntity: (...a: unknown[]) => mockStamp(...a),
  unstampEntity: (...a: unknown[]) => mockUnstamp(...a),
}));

import { StampButton } from '../StampButton.tsx';
import { useStamp } from '../../../hooks/useStamp.ts';
import { UNREAD_COUNT_MARK } from '../../../lib/unreadCount.ts';

beforeEach(() => { mockStamp.mockReset(); mockUnstamp.mockReset(); });

describe('StampButton — an unread count', () => {
  it('draws the mark, not nothing and not 0', async () => {
    const r = await render(<StampButton entityType="media" entityId="m1" initialCount={null} initialIsStamped={false} />);
    expect(r.getByText(UNREAD_COUNT_MARK)).toBeTruthy();
    expect(r.queryByText('0')).toBeNull();
  });

  it('a tap keeps the mark until the server answers, then draws the measured count', async () => {
    let resolve!: (v: unknown) => void;
    mockStamp.mockReturnValue(new Promise((r) => { resolve = r; }));
    const r = await render(<StampButton entityType="media" entityId="m1" initialCount={null} initialIsStamped={false} localBurst />);
    await act(async () => { fireEvent.press(r.getByRole('button')); });
    expect(r.getByText(UNREAD_COUNT_MARK)).toBeTruthy();
    expect(r.queryByText('1')).toBeNull();
    await act(async () => { resolve({ ok: true, data: { isStamped: true, count: 41 } }); });
    expect(r.getByText('41')).toBeTruthy();
  });

  it('the screen-level stamp keeps the mark at impact; the end draws the measured count', async () => {
    let resolve!: (v: unknown) => void;
    mockStamp.mockReturnValue(new Promise((r) => { resolve = r; }));
    mockLastTrigger = null;
    const r = await render(<StampButton entityType="media" entityId="m1" initialCount={null} initialIsStamped={false} />);
    await act(async () => { fireEvent.press(r.getByRole('button')); });
    expect(mockLastTrigger).not.toBeNull();
    await act(async () => { mockLastTrigger!.onImpact(); });
    expect(r.getByText(UNREAD_COUNT_MARK)).toBeTruthy();
    expect(r.queryByText('1')).toBeNull();
    await act(async () => { resolve({ ok: true, data: { isStamped: true, count: 41 } }); });
    await act(async () => { mockLastTrigger!.onComplete(); });
    expect(r.getByText('41')).toBeTruthy();
  });

  it('a measured 0 draws nothing and a measured 3 draws 3 (unchanged)', async () => {
    const zero = await render(<StampButton entityType="media" entityId="m1" initialCount={0} initialIsStamped={false} />);
    expect(zero.queryByText(UNREAD_COUNT_MARK)).toBeNull();
    expect(zero.queryByText('0')).toBeNull();
    const three = await render(<StampButton entityType="media" entityId="m1" initialCount={3} initialIsStamped={false} />);
    expect(three.getByText('3')).toBeTruthy();
  });
});

describe('useStamp — an unread count', () => {
  it('the optimistic step keeps it unread while the request is in flight', async () => {
    let resolve!: (v: unknown) => void;
    mockStamp.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = await renderHook(() =>
      useStamp({ entityType: 'media', entityId: 'm1', initialCount: null, initialIsStamped: false }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.toggle(); });
    expect(result.current.isStamped).toBe(true);
    expect(result.current.count).toBeNull();
    await act(async () => { resolve({ ok: true, data: { isStamped: true, count: 41 } }); await pending; });
    expect(result.current.count).toBe(41);
  });

  it('a successful toggle takes the measured count', async () => {
    mockStamp.mockResolvedValue({ ok: true, data: { isStamped: true, count: 41 } });
    const { result } = await renderHook(() =>
      useStamp({ entityType: 'media', entityId: 'm1', initialCount: null, initialIsStamped: false }));
    let out: unknown;
    await act(async () => { out = await result.current.toggle(); });
    expect(out).toEqual({ isStamped: true, count: 41 });
    expect(result.current.count).toBe(41);
  });

  it('a refused toggle rolls back to unread, never to a number', async () => {
    mockStamp.mockResolvedValue({ ok: false, message: 'API 503' });
    const { result } = await renderHook(() =>
      useStamp({ entityType: 'media', entityId: 'm1', initialCount: null, initialIsStamped: false }));
    let out: unknown;
    await act(async () => { out = await result.current.toggle(); });
    expect(out).toEqual({ isStamped: false, count: null });
    expect(result.current.count).toBeNull();
    expect(result.current.isStamped).toBe(false);
  });

  it('a thrown toggle rolls back to unread too', async () => {
    mockStamp.mockRejectedValue(new Error('network'));
    const { result } = await renderHook(() =>
      useStamp({ entityType: 'media', entityId: 'm1', initialCount: null, initialIsStamped: false }));
    await act(async () => { await result.current.toggle(); });
    expect(result.current.count).toBeNull();
  });

  it('a measured count still steps by one (unchanged)', async () => {
    let resolve!: (v: unknown) => void;
    mockUnstamp.mockReturnValue(new Promise((r) => { resolve = r; }));
    const { result } = await renderHook(() =>
      useStamp({ entityType: 'media', entityId: 'm1', initialCount: 5, initialIsStamped: true }));
    let pending!: Promise<unknown>;
    await act(async () => { pending = result.current.toggle(); });
    expect(result.current.count).toBe(4);
    await act(async () => { resolve({ ok: false, message: 'x' }); await pending; });
    expect(result.current.count).toBe(5);
  });
});
