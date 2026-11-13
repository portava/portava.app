import type { MediaEventPayload } from '../hooks/useMediaAnalytics.ts';

const IDS = new Set(['media_id', 'post_id', 'creator_id', 'session_id', 'place_id', 'event_id', 'trip_id', 'gem_id']);
const CODES = new Set(['feed_type', 'mode', 'media_type', 'surface', 'gems_filter', 'entity_kind', 'action_id', 'from_mode', 'to_mode', 'failure_code', 'failure_reason', 'processing_status', 'source_type', 'ranking_version']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Validate before queueing/transmission. TypeScript alone cannot prevent a
 * caller from sending draft text under an unknown key or a raw error message.
 * Mirrors the server's mediaAnalyticsClientPayload contract; unknown fields
 * and malformed values reject the whole event. Viewer identity is server-owned.
 */
export function mediaAnalyticsPayload(raw: MediaEventPayload): MediaEventPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    let valid = false;
    if (IDS.has(key)) valid = typeof value === 'string' && ID.test(value);
    else if (CODES.has(key)) valid = typeof value === 'string' && CODE.test(value);
    else if (key === 'watched_ms') valid = Number.isSafeInteger(value) && value >= 0 && value <= 86_400_000;
    else if (key === 'position') valid = Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
    else if (key === 'completion_fraction') valid = typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
    else if (key === 'is_rewatch') valid = typeof value === 'boolean';
    if (!valid) return null;
    out[key] = value as string | number | boolean;
  }
  return out;
}
