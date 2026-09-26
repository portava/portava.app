/**
 * features/media — the §14 ENTRY-CONTEXT producers, as pure handoff builders
 * (census-media §19: MD88 Place · MD89 Event · MD90 People · MD91 Trip · MD92 Map).
 *
 * §14's table says what the viewer's swipe collection IS for each way in:
 *
 *   Place  → other perspectives from that Place
 *   Event  → other Event perspectives
 *   People → that person / social context
 *   Trip   → Trip media
 *   Map    → current geographic cluster
 *
 * Before this module the only producer was the World shell's Place open, so
 * `setPerspectiveViewerContext` had exactly one caller passing exactly one kind
 * (census F8). Each builder below takes the projection the OPENING surface
 * already holds — nothing is re-fetched to decide scope — and returns the
 * handoff the contextual viewer consumes. Each one scopes the collection to its
 * own entity: a People open carries only that person's media, a Trip open only
 * that trip's, and never a global feed (§46.2).
 *
 * Pure and framework-free (no router, no network) so the scoping is testable.
 * The navigating half lives in `entryContextOpeners.ts`.
 */
import type { MediaProjection } from '../types/media.ts';
import type { MediaExperienceProjection } from '../types/mediaExperience.ts';
import type { PeopleLensGroup } from '../types/peopleLens.ts';
import type { PlaceCurrentView } from '../types/perspective.ts';
import type { PerspectiveViewerHandoff } from './perspectiveViewerContext.ts';
import type { MediaMapCluster } from './mediaMapStore.ts';

function renderable(media: readonly MediaProjection[] | null | undefined): MediaProjection[] {
  return (media ?? []).filter((m) => !!m && typeof m.id === 'string' && m.id !== '');
}

/** The tapped id when it is in the collection, else the collection's first. */
function initialId(media: MediaProjection[], tappedId: string | null | undefined): string | null {
  if (tappedId && media.some((m) => m.id === tappedId)) return tappedId;
  return media[0]?.id ?? null;
}

/** §14 Place → that Place's other perspectives, grouped by its perspective groups. */
export function placeHandoff(view: PlaceCurrentView, tappedId?: string | null): PerspectiveViewerHandoff | null {
  const media = renderable(view.heroMedia);
  const first = initialId(media, tappedId);
  if (!first) return null;
  return {
    input: { kind: 'place', entityId: view.placeId, entityLabel: view.placeName, groups: view.groups, media },
    initialMediaId: first,
  };
}

/**
 * §14 Map → the current geographic cluster. A Media Map cluster IS a canonical
 * place (`GET /media/map` is keyed by one), so the collection is that place's
 * current view — scoped exactly like a Place open, entered with kind `map` so
 * the viewer (and telemetry) know the user came from the map.
 */
export function mapClusterHandoff(
  cluster: MediaMapCluster,
  view: PlaceCurrentView,
  tappedId?: string | null,
): PerspectiveViewerHandoff | null {
  if (view.placeId !== cluster.placeId) return null; // never stage another place's media under this cluster
  const media = renderable(view.heroMedia);
  const first = initialId(media, tappedId);
  if (!first) return null;
  return {
    input: {
      kind: 'map',
      entityId: cluster.placeId,
      entityLabel: view.placeName ?? cluster.label,
      groups: view.groups,
      media,
    },
    initialMediaId: first,
  };
}

/**
 * The canonical kind of an experience: the server's `kind` when it sent one,
 * else inferred ONLY from which canonical id it carries. An experience that
 * names neither is not an Event or a Trip, and gets no entry context.
 */
export function experienceKindOf(e: MediaExperienceProjection): 'event' | 'trip' | null {
  if (e.kind === 'event' || e.kind === 'trip') return e.kind;
  if (e.tripId && !e.eventId) return 'trip';
  if (e.eventId && !e.tripId) return 'event';
  return null;
}

/**
 * §14 Event → other Event perspectives; Trip → Trip media. The experience
 * projection (`GET /media/experiences/:id`) already resolved the event or trip
 * through its OWN visibility gate, so its hero media is the collection. The
 * kind comes from the projection, never from the caller.
 */
export function experienceHandoff(
  experience: MediaExperienceProjection,
  tappedId?: string | null,
): PerspectiveViewerHandoff | null {
  const kind = experienceKindOf(experience);
  if (!kind) return null;
  const media = renderable(experience.heroMedia);
  const first = initialId(media, tappedId);
  if (!first) return null;
  return {
    input: {
      kind,
      entityId: experience.id,
      entityLabel: experience.title,
      groups: null,
      media,
    },
    initialMediaId: first,
  };
}

/**
 * §14 People → that person / social context. Scoped to ONE contributor: media
 * the People lens grouped under this person is the collection, and anything
 * attributed to someone else is dropped rather than paged into their context.
 */
export function personHandoff(group: PeopleLensGroup, tappedId?: string | null): PerspectiveViewerHandoff | null {
  const personId = group.contributor?.id ?? null;
  if (!personId) return null;
  const media = renderable(group.media).filter((m) => (m.contributor?.id ?? personId) === personId);
  const first = initialId(media, tappedId);
  if (!first) return null;
  return {
    input: {
      kind: 'people',
      entityId: personId,
      entityLabel: group.contributor.displayName,
      groups: null,
      media,
    },
    initialMediaId: first,
  };
}
