/**
 * features/media — the navigating half of the §14 entry-context producers
 * (census-media §19). Each opener stages a handoff built by the pure
 * `state/entryContextHandoffs.ts` and routes to the contextual perspective
 * viewer at `/media-perspective/[id]`. Nothing here decides scope; it only
 * stages what the builder returned, so the scoping stays testable without a
 * router.
 *
 * Every opener reports whether it opened anything. A handoff that resolves to
 * nothing (no renderable media) does NOT navigate to an empty viewer — the
 * caller keeps the user where they are.
 */
import { router } from 'expo-router';
import type { MediaProjection } from '../types/media.ts';
import type { MediaExperienceProjection } from '../types/mediaExperience.ts';
import type { PeopleLensGroup } from '../types/peopleLens.ts';
import type { PlaceCurrentView } from '../types/perspective.ts';
import type { MediaMapCluster } from '../state/mediaMapStore.ts';
import { setPerspectiveViewerContext, type PerspectiveViewerHandoff } from '../state/perspectiveViewerContext.ts';
import {
  experienceHandoff,
  mapClusterHandoff,
  personHandoff,
  placeHandoff,
} from '../state/entryContextHandoffs.ts';
import { fetchPlaceView } from './mediaProjection.ts';

function stageAndOpen(handoff: PerspectiveViewerHandoff | null): boolean {
  if (!handoff) return false;
  setPerspectiveViewerContext(handoff);
  router.push(`/media-perspective/${encodeURIComponent(handoff.initialMediaId)}` as never);
  return true;
}

/** §14 Place → that place's other perspectives. */
export function openPlacePerspectives(view: PlaceCurrentView, tapped?: MediaProjection | null): boolean {
  return stageAndOpen(placeHandoff(view, tapped?.id ?? null));
}

/** §14 Event → other Event perspectives; Trip → Trip media. */
export function openExperiencePerspectives(
  experience: MediaExperienceProjection,
  tapped?: MediaProjection | null,
): boolean {
  return stageAndOpen(experienceHandoff(experience, tapped?.id ?? null));
}

/** §14 People → that person / social context. */
export function openPersonPerspectives(group: PeopleLensGroup, tapped?: MediaProjection | null): boolean {
  return stageAndOpen(personHandoff(group, tapped?.id ?? null));
}

/**
 * §14 Map → current geographic cluster. The cluster carries counts only, so the
 * place's current view is read through the same gated `GET /media/places/:id`
 * every Place open uses, then staged with kind `map`.
 */
export async function openClusterPerspectives(cluster: MediaMapCluster): Promise<boolean> {
  const res = await fetchPlaceView(cluster.placeId);
  if (!res.ok || !res.data) return false;
  return stageAndOpen(mapClusterHandoff(cluster, res.data));
}
