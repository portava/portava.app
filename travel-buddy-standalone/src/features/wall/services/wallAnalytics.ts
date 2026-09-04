/**
 * wallAnalytics — the Wall's analytics seam (Wall spec §32).
 *
 * Measures the Wall as a social product AND a bridge to real-world outcomes:
 * feed open, mode selection, impressions, actions, Live For You shown/opened,
 * Context Thread shown/acted. It NEVER logs raw private message text or
 * unnecessary raw typed content (spec §32) — every event here carries only ids,
 * enums, and counts. Impression/action events also fan out to the server
 * mutation endpoints via wallApi (fire-and-forget, ids only).
 *
 * The sink is pluggable so the real telemetry pipeline (or a test spy) can be
 * injected without changing call sites.
 */

import { sendAction, sendImpression, type WallActionEvent } from './wallApi.ts';
import type { WallMode, WallProjection } from '../types/wallProjection.ts';
import type { ContextThreadKind } from '../types/contextThread.ts';
import type { LiveForYouItem } from '../types/liveForYou.ts';

/** The surrounding Portava surfaces a Wall object can bridge into (spec §32). */
export type WallHandoffSurface = 'map' | 'place' | 'trip' | 'compass' | 'buddy';

/** Distinct social engagements measured per object (spec §32). */
export type WallEngagementKind = 'stamp' | 'comment' | 'share' | 'save';

export type WallAnalyticsEvent =
  | { type: 'wall_feed_open'; mode: WallMode }
  | { type: 'wall_mode_select'; mode: WallMode }
  | { type: 'wall_impression'; objectId: string; objectType: string; session?: string }
  | { type: 'wall_action'; objectId: string; objectType: string; action: WallActionEvent }
  | { type: 'wall_engagement'; objectId: string; objectType: string; kind: WallEngagementKind }
  | { type: 'wall_live_shown'; count: number }
  | { type: 'wall_live_open'; subjectId: string; liveObjectType: string }
  | { type: 'wall_context_shown'; kind: ContextThreadKind }
  | { type: 'wall_context_acted'; kind: ContextThreadKind }
  | { type: 'wall_context_ignored'; kind: ContextThreadKind }
  | { type: 'wall_follow_from_feed'; objectId: string; objectType: string; fromDiscovery: boolean }
  | { type: 'wall_handoff'; objectId: string; objectType: string; surface: WallHandoffSurface }
  | { type: 'wall_caught_up'; mode: WallMode }
  | { type: 'wall_not_interested'; objectId: string; objectType: string }
  | { type: 'wall_real_world_outcome'; objectId: string; objectType: string; outcome: string };

export type WallAnalyticsSink = (event: WallAnalyticsEvent) => void;

const defaultSink: WallAnalyticsSink = (event) => {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.log('[wallAnalytics]', event.type, event);
  }
};

let sink: WallAnalyticsSink = defaultSink;

/** Inject a telemetry pipeline or a test spy. */
export function setWallAnalyticsSink(next: WallAnalyticsSink): void {
  sink = next;
}

/** Reset to the default (dev-log) sink. */
export function resetWallAnalyticsSink(): void {
  sink = defaultSink;
}

function emit(event: WallAnalyticsEvent): void {
  try {
    sink(event);
  } catch {
    // Analytics must never break the feed.
  }
}

export function trackFeedOpen(mode: WallMode): void {
  emit({ type: 'wall_feed_open', mode });
}

export function trackModeSelect(mode: WallMode): void {
  emit({ type: 'wall_mode_select', mode });
}

/** The rank session token, when present — used to scope impression/action. */
function sessionOf(projection: WallProjection): string | undefined {
  return projection.ranking?.session;
}

export function trackImpression(projection: WallProjection): void {
  const session = sessionOf(projection);
  emit({
    type: 'wall_impression',
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
    ...(session ? { session } : {}),
  });
  // Fire-and-forget server record — ids only, never `projection.text`.
  void sendImpression({
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
    session,
  });
}

export function trackAction(projection: WallProjection, action: WallActionEvent): void {
  const session = sessionOf(projection);
  emit({
    type: 'wall_action',
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
    action,
  });
  void sendAction(
    {
      objectId: projection.canonicalObjectId,
      objectType: projection.objectType,
      session,
    },
    action,
  );
}

export function trackLiveShown(count: number): void {
  emit({ type: 'wall_live_shown', count });
}

export function trackLiveOpen(item: LiveForYouItem): void {
  emit({ type: 'wall_live_open', subjectId: item.subjectId, liveObjectType: item.liveObjectType });
}

export function trackContextThreadShown(kind: ContextThreadKind): void {
  emit({ type: 'wall_context_shown', kind });
}

export function trackContextThreadActed(kind: ContextThreadKind): void {
  emit({ type: 'wall_context_acted', kind });
}

/** A Context Thread was shown but scrolled past without being acted on (spec §32). */
export function trackContextThreadIgnored(kind: ContextThreadKind): void {
  emit({ type: 'wall_context_ignored', kind });
}

/**
 * A distinct social engagement (stamp/comment/share/save) — measured separately
 * so the Wall is understood as a social product, not just by session length
 * (spec §32). Ids + enum only; never the post text.
 */
export function trackEngagement(projection: WallProjection, kind: WallEngagementKind): void {
  emit({
    type: 'wall_engagement',
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
    kind,
  });
}

/**
 * A follow initiated from within the feed (spec §32). `fromDiscovery` flags the
 * discovery-follow conversion — a follow that originated on a discovery
 * insertion rather than an already-followed account.
 */
export function trackFollowFromFeed(projection: WallProjection, fromDiscovery: boolean): void {
  emit({
    type: 'wall_follow_from_feed',
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
    fromDiscovery,
  });
}

/**
 * A bridge from a social object into a surrounding Portava surface — Map, Place,
 * Trip, Compass or Buddy (spec §32). Ids + surface enum only.
 */
export function trackHandoff(projection: WallProjection, surface: WallHandoffSurface): void {
  emit({
    type: 'wall_handoff',
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
    surface,
  });
}

/** The viewer reached the end of eligible content — the caught-up rate (spec §32). */
export function trackCaughtUp(mode: WallMode): void {
  emit({ type: 'wall_caught_up', mode });
}

/** A hide / not-interested signal on an object (spec §32). Ids only. */
export function trackNotInterested(projection: WallProjection): void {
  emit({
    type: 'wall_not_interested',
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
  });
}

/**
 * A real-world outcome attributed to a Wall object (e.g. a place actually
 * visited) — measured ONLY when the signal is validly consented (spec §32). When
 * `consented` is false the event is dropped entirely: the Wall never records an
 * un-consented real-world-outcome signal, and `outcome` carries a coarse enum,
 * never raw typed content.
 */
export function trackRealWorldOutcome(
  projection: WallProjection,
  outcome: string,
  consented: boolean,
): void {
  if (!consented) return;
  emit({
    type: 'wall_real_world_outcome',
    objectId: projection.canonicalObjectId,
    objectType: projection.objectType,
    outcome,
  });
}
