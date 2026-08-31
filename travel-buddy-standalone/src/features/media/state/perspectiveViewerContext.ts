/**
 * perspectiveViewerContext — lightweight module-level singleton that hands the
 * entry-context perspective collection to the contextual perspective viewer
 * route (spec §14), exactly as src/lib/viewerContext.ts does for the generic
 * media viewer.
 *
 * A mosaic (place / experience) sets this immediately before navigating to
 * /media-perspective/[id]; the route reads it once on mount (as a snapshot via
 * a useState initialiser) and clears it so stale context never leaks into a
 * later open. It is deliberately NOT a React context — it survives the
 * navigation boundary without provider nesting or re-render churn.
 *
 * The payload carries only plain, serialisable projection data (the same shape
 * the mapper already produced), so the viewer never re-fetches to render the
 * context it was opened with. A deep-link with no context set reads null, and
 * the viewer degrades to a clean empty state (§33/§39) rather than crashing.
 */
import type { BuildPerspectiveCollectionInput } from './perspectiveViewer.ts';

export interface PerspectiveViewerHandoff {
  /** Raw inputs for buildPerspectiveCollection (kind, entity, groups, media). */
  input: BuildPerspectiveCollectionInput;
  /** The media the user tapped — the viewer opens on it. */
  initialMediaId: string;
}

let _handoff: PerspectiveViewerHandoff | null = null;

/** Call immediately before navigating to /media-perspective/[id]. */
export function setPerspectiveViewerContext(handoff: PerspectiveViewerHandoff): void {
  _handoff = handoff;
}

/** Read by the viewer on mount. Returns null when nothing was staged (deep-link). */
export function getPerspectiveViewerContext(): PerspectiveViewerHandoff | null {
  return _handoff;
}

/** Call once the viewer has consumed the context so it does not persist. */
export function clearPerspectiveViewerContext(): void {
  _handoff = null;
}
