/**
 * useWallItemVisibility — which feed objects are currently on-screen (§11).
 *
 * The Wall's inline video needs to know when a specific item is in the viewport
 * so it can autoplay only while visible and pause when scrolled away (spec §11:
 * "scrolling away pauses playback"). WallFeed already computes viewability for
 * impression analytics; this shares that same signal with the item renderers via
 * a small context rather than threading an `isVisible` prop through every layer.
 *
 * The provider value is the SET of currently-viewable `projectionId`s. The
 * default (no provider) is an empty set, so an item rendered outside a feed
 * (e.g. a component test that does not drive viewability) reads as "not visible"
 * and stays on its still poster — never autoplaying unexpectedly.
 */
import React from 'react';

const EMPTY_VISIBLE: ReadonlySet<string> = new Set();

const WallItemVisibilityContext = React.createContext<ReadonlySet<string>>(EMPTY_VISIBLE);

export function WallItemVisibilityProvider({
  visibleIds,
  children,
}: {
  visibleIds: ReadonlySet<string>;
  children: React.ReactNode;
}) {
  return (
    <WallItemVisibilityContext.Provider value={visibleIds}>
      {children}
    </WallItemVisibilityContext.Provider>
  );
}

/** True when the projection with this id is currently in the viewport. */
export function useWallItemVisible(projectionId: string): boolean {
  return React.useContext(WallItemVisibilityContext).has(projectionId);
}
