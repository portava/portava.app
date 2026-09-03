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
import { useCallback, useEffect, useRef } from 'react';
import { freshToken } from '../services/apiToken.ts';

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
  | 'media_arrival';

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
  ranking_version?: string;
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
  const queue = useRef<Array<{ type: MediaEventType; payload: MediaEventPayload }>>([]);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dedupRef = useRef<Map<string, number>>(new Map());
  const unmountedRef = useRef(false);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      // Flush on unmount (best-effort)
      if (queue.current.length > 0) void flush();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (queue.current.length === 0) return;

    const events = queue.current.splice(0);
    try {
      const token = await freshToken();
      if (!token) return;
      const base = process.env.EXPO_PUBLIC_API_BASE_URL ?? '';
      // Best-effort — ignore errors
      await fetch(`${base}/api/media/analytics/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ events }),
      });
    } catch {
      // Silently swallow — analytics must never affect the user experience
    }
  }, []);

  const record = useCallback(
    (type: MediaEventType, payload: MediaEventPayload = {}) => {
      // Dedup check for impression/view events
      const deduplicatedTypes: MediaEventType[] = ['impression', 'qualified_view', 'completion'];
      if (deduplicatedTypes.includes(type)) {
        const key = `${type}:${payload.media_id ?? payload.post_id ?? ''}`;
        const last = dedupRef.current.get(key);
        if (last && Date.now() - last < DEDUP_WINDOW_MS) return;
        dedupRef.current.set(key, Date.now());
      }

      queue.current.push({
        type,
        payload: { ...payload, session_id: payload.session_id ?? sessionId },
      });

      if (queue.current.length >= BATCH_SIZE_MAX) {
        void flush();
        return;
      }

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), DEBOUNCE_MS);
    },
    [flush, sessionId],
  );

  return { record, flush };
}
