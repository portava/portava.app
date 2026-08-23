import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "./logger.js";

export interface PreferenceEventInput {
  userId: string;
  recommendationId?: string | null;
  category: string;
  signal: string;
  tripId?: string | null;
}

export async function writePreferenceEvent(
  client: SupabaseClient<any>,
  event: PreferenceEventInput,
): Promise<void> {
  const { error } = await client.from("user_preference_events").insert({
    user_id:           event.userId,
    // `?? null` was wrong: recommendation_id is `text NOT NULL`, so every caller
    // that omitted recommendationId — which this interface explicitly invites by
    // typing it optional — produced a 23502 that the catch below swallowed as a
    // warning. The event was silently dropped. Falls back to a synthetic
    // signal:category id, following telegraphCommands' composite-id precedent.
    recommendation_id: event.recommendationId ?? `${event.signal}:${event.category}`,
    category:          event.category,
    signal:            event.signal,
    created_at:        new Date().toISOString(),
    trip_id:           event.tripId ?? null,
  });
  if (error) {
    logger.warn({ err: error }, "preferenceEvent: insert failed (best-effort)");
  }
}
