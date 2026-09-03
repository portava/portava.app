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

export type WallAnalyticsEvent =
  | { type: 'wall_feed_open'; mode: WallMode }
  | { type: 'wall_mode_select'; mode: WallMode }
  | { type: 'wall_impression'; objectId: string; objectType: string; session?: string }
  | { type: 'wall_action'; objectId: string; objectType: string; action: WallActionEvent }
  | { type: 'wall_live_shown'; count: number }
  | { type: 'wall_live_open'; subjectId: string; liveObjectType: string }
  | { type: 'wall_context_shown'; kind: ContextThreadKind }
  | { type: 'wall_context_acted'; kind: ContextThreadKind };

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
