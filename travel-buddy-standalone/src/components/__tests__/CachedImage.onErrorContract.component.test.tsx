/**
 * CachedImage — the parent `onError` contract
 *
 * CachedImage paints its FIRST frame on the bare, unsigned storage path so the
 * common case renders without waiting on the async sign call. For a private
 * bucket that first paint ALWAYS fails with HTTP 400. The component recovers
 * from that itself — the hydration effect swaps in the signed URL and clears
 * `failed` — but the recovery only runs if the component is still mounted.
 *
 * That is the entire bug this file pins down. Roughly 17 parents (MediaCard,
 * PostcardTile, PostCard, TripCard, EventCard, PlaceCard, BuddyCard,
 * DiscoveryWall, PulseFeedCard, …) keep their own never-reset `imgFailed` flag
 * and UNMOUNT CachedImage the moment it calls `onError`. Forwarding the
 * transient first failure upward therefore destroyed the component before it
 * could recover, and one recoverable error permanently blanked the tile.
 *
 * So `onError` means "this image is not going to load", NOT "a load attempt
 * failed". The three tests below pin all three sides of that contract:
 *
 *   1. in flight  (hydrated[uri] === undefined) → parent NOT notified
 *   2. settled to a URL that still fails        → parent notified
 *   3. settled to null (server rejected)        → parent notified
 *
 * 2 and 3 exist so the guard cannot be satisfied by simply silencing the
 * callback — a genuinely dead image must still reach the parent.
 *
 * Run with: pnpm test:component
 */

import React from 'react';
import { render, act } from '@testing-library/react-native';
import { CachedImage } from '../CachedImage.tsx';

const URI = 'post-media/user-1/photo.jpg';
const SIGNED_URL =
  'https://project.supabase.co/storage/v1/object/sign/post-media/user-1/photo.jpg?token=abc';

/**
 * Hydration state is driven by the test rather than by a timer, because the
 * contract is defined in terms of the three states of `hydrated[uri]`:
 *   undefined → sign call still in flight   (recovery may yet arrive)
 *   string    → settled to a usable URL     (this was the last chance)
 *   null      → server explicitly rejected  (final)
 *
 * The mock is a real subscribing hook rather than a plain value so a test can
 * advance hydration IN PLACE, via `setHydrated` below. Advancing it with RNTL's
 * `rerender` instead looks equivalent and is not: after a `rerender`, every
 * later `render()` in the file mounts a dead root — no effects, null tree — so
 * the remaining tests pass vacuously. See the note on `setHydrated`.
 */
let mockHydrated: Record<string, string | null> = {};
const mockListeners = new Set<() => void>();

jest.mock('../../services/mediaUrl.ts', () => ({
  useHydratedMedia: () => {
    const { useState, useEffect } = require('react');
    const [, force] = useState(0);
    useEffect(() => {
      const listener = () => force((n: number) => n + 1);
      mockListeners.add(listener);
      return () => {
        mockListeners.delete(listener);
      };
    }, []);
    return { resolved: mockHydrated, loading: false };
  },
}));

// Captures the ExpoImage `onError` so a test can fire the load failure at an
// exact point in the hydration lifecycle instead of racing it.
let mockFireImageError: (() => void) | undefined;

jest.mock('expo-image', () => {
  const ReactLib = require('react');
  const { View } = require('react-native');
  return {
    Image: ({ source, onError, testID }: any) => {
      mockFireImageError = onError;
      return ReactLib.createElement(View, { testID: testID ?? 'expo-image', source });
    },
  };
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Advance hydration on the MOUNTED component, standing in for the sign call
 * resolving. Deliberately not `rerender`: RNTL v14 leaves the renderer unable
 * to mount any further root after a rerender, so a test that used it would
 * still pass while the next test silently asserted against a dead component.
 */
async function setHydrated(next: Record<string, string | null>) {
  await act(async () => {
    mockHydrated = next;
    mockListeners.forEach((listener) => listener());
  });
}

/**
 * Firing the image error must go through an ASYNC act: a synchronous
 * `act(() => …)` returns before React 19's scheduler commits the resulting
 * `setFailed(true)`, so the tree would still show the image and the test would
 * silently assert against a pre-update render.
 */
async function fireImageError() {
  await act(async () => {
    mockFireImageError?.();
  });
}

/**
 * The fallback branch and the image branch share `testID`, so presence alone
 * proves nothing. Only the image carries a `source` prop — its absence means
 * the component really did latch `failed` and swap to MediaFallback, which is
 * how each test confirms the failure was processed rather than never wired up.
 */
function isShowingFallback(view: { getByTestId: (id: string) => any }, testID: string) {
  return view.getByTestId(testID).props.source === undefined;
}

beforeEach(() => {
  mockHydrated = {};
  mockFireImageError = undefined;
});

describe('CachedImage — parent onError contract', () => {
  it('does NOT call the parent onError on a transient failure while hydration is still in flight', async () => {
    mockHydrated = {}; // hydrated[URI] === undefined — sign call in flight
    const onErrorSpy = jest.fn();

    const view = await render(
      <CachedImage source={{ uri: URI }} onError={onErrorSpy} testID="tile" />,
    );
    await flush();

    // The bare private-bucket path 400s, exactly as it does in production.
    await fireImageError();

    // The component absorbed the failure locally...
    expect(isShowingFallback(view, 'tile')).toBe(true);
    // ...and crucially did not tell the parent, which would have unmounted it
    // and prevented the signed-URL recovery below from ever running.
    expect(onErrorSpy).not.toHaveBeenCalled();

    // The recovery this guard exists to protect: the signed URL lands, the
    // component clears `failed` and repaints. It only gets here because it
    // survived the transient failure above.
    await setHydrated({ [URI]: SIGNED_URL });
    await flush();

    expect(isShowingFallback(view, 'tile')).toBe(false);
    expect(view.getByTestId('tile').props.source?.uri).toBe(SIGNED_URL);
    expect(onErrorSpy).not.toHaveBeenCalled();

    view.unmount();
  });

  it('calls the parent onError once hydration has settled to a URL that still fails', async () => {
    mockHydrated = {};
    const onErrorSpy = jest.fn();

    const view = await render(
      <CachedImage source={{ uri: URI }} onError={onErrorSpy} testID="tile" />,
    );
    await flush();

    // First failure — transient, suppressed (as above; restated here so this
    // test runs the whole real-world sequence rather than starting mid-way).
    await fireImageError();
    expect(onErrorSpy).not.toHaveBeenCalled();

    // The sign call settles to a real URL; CachedImage clears `failed` and
    // retries with it. This is the last recovery available to the component.
    await setHydrated({ [URI]: SIGNED_URL });
    await flush();
    expect(isShowingFallback(view, 'tile')).toBe(false); // retrying, not latched

    // The signed URL fails too. Nothing is left to recover with, so the
    // failure is final and the parent must hear about it.
    await fireImageError();
    expect(onErrorSpy).toHaveBeenCalledTimes(1);
    expect(isShowingFallback(view, 'tile')).toBe(true);

    view.unmount();
  });

  it('calls the parent onError when hydration resolves null (server rejected the URL)', async () => {
    mockHydrated = { [URI]: null };
    const onErrorSpy = jest.fn();

    const view = await render(
      <CachedImage source={{ uri: URI }} onError={onErrorSpy} testID="tile" />,
    );
    await flush();

    // No image load error is fired here at all — a null resolve is a server
    // rejection, which is final on its own and propagates from the hydration
    // effect via onErrorRef rather than from the ExpoImage callback.
    expect(onErrorSpy).toHaveBeenCalledTimes(1);
    expect(isShowingFallback(view, 'tile')).toBe(true);

    view.unmount();
  });
});
