/**
 * Visual Generation Analytics
 *
 * Lightweight structured-logging helper for visual generation events.
 * Calls logger.info() with a fixed `event` key and safe metadata.
 *
 * Contract: NO prompt text, signed URLs, secrets, or PII may appear in
 * any metadata object passed to emitVisualEvent.
 */

import { logger } from "../logger.js";

export type VisualEventName =
  | "visual_generation_requested"
  | "visual_generation_queued"
  | "visual_generation_started"
  | "visual_generation_completed"
  | "visual_generation_failed"
  | "visual_generation_blocked"
  | "visual_generation_reused"
  | "visual_generation_accepted"
  | "visual_generation_regenerated"
  | "visual_generation_replaced"
  | "visual_generation_removed";

export interface VisualEventMetadata {
  entity_type: string;
  entity_id: string;
  purpose: string;
  style?: string | null;
  status: string;
  visual_id?: string;
  /** Elapsed ms from job claim to completion (completed events only). */
  duration_ms?: number;
  /** How many provider attempts have been made (completed/failed/blocked). */
  attempt_count?: number;
  /** DB failure_code — never a prompt, URL, or secret. */
  failure_code?: string | null;
  provider?: string | null;
}

/**
 * Emit a structured analytics log line for a visual generation lifecycle event.
 * Call at every status transition; never pass prompts, URLs, or secrets.
 */
export function emitVisualEvent(
  eventName: VisualEventName,
  metadata: VisualEventMetadata,
): void {
  logger.info({ event: eventName, ...metadata });
}
