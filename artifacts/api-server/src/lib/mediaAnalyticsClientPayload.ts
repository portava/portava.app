import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/).optional();
const code = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional();

/** Client analytics carry bounded opaque identifiers/codes, never arbitrary
 * text or caller-supplied viewer identity. Unknown keys are rejected at ingress,
 * before the fire-and-forget recorder. Server producers retain their own schema.
 */
export const mediaAnalyticsClientPayload = z.object({
  media_id: id, post_id: id, creator_id: id, session_id: id,
  place_id: id, event_id: id, trip_id: id, gem_id: id,
  feed_type: code, mode: code, media_type: code, surface: code,
  gems_filter: code, entity_kind: code, action_id: code, from_mode: code,
  to_mode: code, failure_code: code, failure_reason: code,
  processing_status: code, source_type: code, ranking_version: code,
  watched_ms: z.number().int().min(0).max(86_400_000).optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  completion_fraction: z.number().min(0).max(1).optional(),
  is_rewatch: z.boolean().optional(),
}).strict();
