/**
 * useMediaAnalytics — client-side hook for firing media analytics events.
 *
 * Design constraints:
 * • Batched + debounced: events are queued and flushed together to avoid
 *   flooding the API.
 * • Safe payloads: private captions, raw GPS coordinates, ranking vectors,
 *   and secrets are never included.
 * • Best-effort only: failures are silently swallowed; analytics must never
 *   affect the user experience.
 * • Dedup: identical events within the dedup window are dropped.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useFeatureFlags } from '../context/FeatureFlagsContext.tsx';
import { captureMessagingOwnerRequest, type MessagingOwnerRequest } from '../services/messagingOwnerRequest.ts';
import { fetchOwnedApi } from '../services/ownedApiRequest.ts';
import { mediaAnalyticsPayload } from '../services/mediaAnalyticsPayload.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export type MediaEventType =
  | 'mode_switch'
  | 'impression'
  | 'qualified_view'
  | 'completion'
  | 'rewatch'
  | 'like'
  | 'comment'
  | 'save'
  | 'share'
  | 'profile_open'
  | 'place_open'
  | 'event_open'
  | 'trip_open'
  | 'grid_tile_open'
  | 'gems_filter_change'
  | 'add_to_trip'
  | 'directions_tap'
  | 'wrong_place_report'
  | 'upload_start'
  | 'processing_complete'
  | 'processing_failure'
  | 'playback_failure'
  // §45 North-Star outcome transitions — the media → real-world OUTCOME linkage.
  // These measure usefulness (§44/§26), not engagement; they are emitted through
  // features/media/telemetry/mediaTelemetry.ts, which maps a media action to the
  // one transition it represents and carries only coarse metadata.
  | 'media_place_open'
  | 'media_compass'
  | 'media_route'
  | 'media_trip_add'
  | 'media_plan'
  | 'media_contribution'
  | 'media_correction'
  | 'media_arrival' | 'visual_opportunity_open' | 'gem_open'; // + §44 client outcome signals (census-media §21); server-only ones (invite_sent, …) the batch endpoint refuses

export interface MediaEventPayload {
  media_id?: string;
  post_id?: string;
  creator_id?: string;
  viewer_id?: string;
  session_id?: string;
  feed_type?: string;
  mode?: string;
  media_type?: string;
  watched_ms?: number;
  completion_fraction?: number;
  surface?: string;
  position?: number;
  place_id?: string;
  event_id?: string;
  trip_id?: string;
  gems_filter?: string;
  /** Coarse entity kind for §45 north-star events: 'media' | 'place' | 'trip' | 'gem'. */
  entity_kind?: string;
  /** The media action id a §45 north-star event was mapped from. */
  action_id?: string;
  from_mode?: string;
  to_mode?: string;
  failure_code?: string;
  failure_reason?: string;
  processing_status?: string;
  source_type?: string;
  is_rewatch?: boolean;
  ranking_version?: string; gem_id?: string; // gem_id: opaque hidden-gem id (§44 Hidden Gem opened)
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Events are flushed after this many milliseconds of inactivity. */
const DEBOUNCE_MS = 2_000;
/** Maximum pending events before an immediate flush. */
const BATCH_SIZE_MAX = 10;
/** Dedup window for identical (type, media_id) pairs. */
const DEDUP_WINDOW_MS = 5_000;

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useMediaAnalytics(sessionId?: string) {
  const { isEnabled } = useFeatureFlags();
  const enabled = isEnabled('MEDIA_ANALYTICS_ENABLED');
  const enabledNow = useRef(enabled);
  useLayoutEffect(() => { enabledNow.current = enabled; }, [enabled]);
  const queue = useRef<Array<{ type: MediaEventType; payload: MediaEventPayload }>>([]);
  const owner = useRef<MessagingOwnerRequest | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dedupRef = useRef<Map<string, number>>(new Map());
  const mounted = useRef(true);
  const inFlight = useRef<AbortController | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);
  const discard = useCallback(() => {
    clearTimer();
    queue.current = [];
    dedupRef.current.clear();
    owner.current = null;
    inFlight.current?.abort();
  }, [clearTimer]);

  const flush = useCallback(async function flushBatch(): Promise<void> {
    clearTimer();
    const capturedOwner = owner.current;
    if (!enabledNow.current || !capturedOwner?.isCurrent()) { discard(); return; }
    if (inFlight.current || queue.current.length === 0) return;
    const events = queue.current.splice(0, BATCH_SIZE_MAX);
    const controller = new AbortController();
    inFlight.current = controller;
    try {
      await fetchOwnedApi('/api/media/analytics/batch', {
        method: 'POST', body: { events }, owner: capturedOwner,
        signal: controller.signal, isCurrent: () => enabledNow.current,
      });
    } catch {
      // Best effort; never retry an ambiguously accepted analytics batch.
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
      // One in-flight batch per hook. A one-shot delay drains any arrivals;
      // there is no periodic network work while the queue is empty.
      if (queue.current.length && enabledNow.current && owner.current?.isCurrent()) {
        clearTimer();
        timerRef.current = setTimeout(() => void flushBatch(), DEBOUNCE_MS);
      }
    }
  }, [clearTimer, discard]);

  useEffect(() => {
    if (!enabled) discard();
  }, [enabled, discard]);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') void flush();
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      clearTimer();
      void flush();
    };
  }, [clearTimer, flush]);

  const record = useCallback(
    (type: MediaEventType, payload: MediaEventPayload = {}) => {
      if (!mounted.current || !enabledNow.current) return;
      const safePayload = mediaAnalyticsPayload({ ...payload, session_id: payload.session_id ?? sessionId });
      if (!safePayload) return;
      const capturedOwner = captureMessagingOwnerRequest();
      if (!capturedOwner?.isCurrent()) { discard(); return; }
      // A logout/login, even to the same account, invalidates the old epoch.
      // Capture at the action, never when a later batch obtains its token.
      if (!owner.current?.isCurrent()) discard();
      owner.current = capturedOwner;
      if (['impression', 'qualified_view', 'completion'].includes(type)) {
        const key = `${type}:${payload.media_id ?? payload.post_id ?? ''}`;
        const at = Date.now();
        const last = dedupRef.current.get(key);
        if (last !== undefined && at >= last && at - last < DEDUP_WINDOW_MS) return;
        dedupRef.current.delete(key);
        dedupRef.current.set(key, at);
        if (dedupRef.current.size > 128) dedupRef.current.delete(dedupRef.current.keys().next().value!);
      }
      // Bound memory under a stalled transport. Dropping telemetry is preferable
      // to retaining a growing action history or delaying the product action.
      if (queue.current.length >= 50) return;
      queue.current.push({ type, payload: safePayload });
      clearTimer();
      if (queue.current.length >= BATCH_SIZE_MAX) void flush();
      else timerRef.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [clearTimer, discard, flush, sessionId],
  );

  return { record, flush };
}
