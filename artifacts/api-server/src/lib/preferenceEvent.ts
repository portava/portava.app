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
    recommendation_id: event.recommendationId ?? null,
    category:          event.category,
    signal:            event.signal,
    created_at:        new Date().toISOString(),
    trip_id:           event.tripId ?? null,
  });
  if (error) {
    logger.warn({ err: error }, "preferenceEvent: insert failed (best-effort)");
  }
}
