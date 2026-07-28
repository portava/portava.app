/**
 * viewerContext — lightweight module-level singleton that passes the grid
 * items list to the media viewer so it can page between adjacent items.
 *
 * Set by GridFeed immediately before navigating to /media-viewer/[id].
 * Read by the viewer on mount (as a snapshot via useState initialiser).
 * Cleared after the viewer reads it so stale context never leaks.
 *
 * NOT a React context — avoids re-render churn and works across navigation
 * boundaries without provider nesting.
 */

export interface ViewerContextItem {
  id: string;
  posterUrl: string | null;
  thumbnailUrl: string | null;
  mediaType: 'image' | 'video';
  /** True when the post was GPS-verified at the tagged location at upload time. */
  locationVerified?: boolean;
  /** Human-readable location name for the verified stamp overlay. */
  locationName?: string | null;
}

interface ViewerContextState {
  items: ViewerContextItem[];
  initialIndex: number;
}

let _state: ViewerContextState = { items: [], initialIndex: 0 };

/**
 * Call before navigating to /media-viewer/[id] so the viewer can page
 * between all grid items, not just the tapped one.
 */
export function setViewerContext(
  items: ViewerContextItem[],
  initialId: string,
): void {
  const idx = items.findIndex((i) => i.id === initialId);
  _state = { items, initialIndex: idx === -1 ? 0 : idx };
}

/**
 * Read by the viewer on mount.  Returns a snapshot; subsequent calls
 * return the same data until the next setViewerContext call.
 */
export function getViewerContext(): ViewerContextState {
  return _state;
}

/** Call once the viewer has consumed the context so it doesn't persist. */
export function clearViewerContext(): void {
  _state = { items: [], initialIndex: 0 };
}
