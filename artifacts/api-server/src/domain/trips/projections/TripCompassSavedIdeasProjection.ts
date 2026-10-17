import type { SupabaseClient } from "@supabase/supabase-js";
import { liveEnvelope, readTripVersion, type TripProjectionEnvelope } from "../contracts/TripProjectionEnvelope.js";

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface TripCompassSavedIdea {
  id: string;
  placeId: string | null;
  name: string;
  placeType: string | null;
  notes: string | null;
  savedBy: "you" | "a crew member";
  savedAt: string;
}

export interface TripCompassSavedIdeasProjection extends TripProjectionEnvelope {
  tripId: string;
  viewerId: string;
  ideas: TripCompassSavedIdea[];
  countBasis: "returned_rows";
}

export type TripCompassSavedIdeasResult =
  | { ok: true; projection: TripCompassSavedIdeasProjection }
  | { ok: false; reason: "TRIP_PROJECTION_UNAVAILABLE" };

interface SavedIdeaRow extends Record<string, unknown> {
  id: string;
  trip_id: string;
  user_id: string;
  place_id: string | null;
  place_name: string;
  place_type: string | null;
  notes: string | null;
  saved_at: string;
}

function isSavedIdeaRow(value: unknown, tripId: string): value is SavedIdeaRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && CANONICAL_UUID.test(row.id)
    && row.trip_id === tripId
    && typeof row.user_id === "string" && CANONICAL_UUID.test(row.user_id)
    && typeof row.place_name === "string" && typeof row.saved_at === "string"
    && (row.place_id === null || typeof row.place_id === "string")
    && (row.place_type === null || typeof row.place_type === "string")
    && (row.notes === null || typeof row.notes === "string");
}

export async function buildTripCompassSavedIdeasProjection(
  sc: SupabaseClient,
  tripId: string,
  viewerId: string,
  opts: { now?: Date } = {},
): Promise<TripCompassSavedIdeasResult> {
  const unavailable = { ok: false, reason: "TRIP_PROJECTION_UNAVAILABLE" } as const;
  if (!CANONICAL_UUID.test(tripId.toLowerCase()) || !CANONICAL_UUID.test(viewerId.toLowerCase())) return unavailable;
  try {
    const version = await readTripVersion(sc, tripId).catch(() => null);
    const { data, error } = await sc.from("trip_saved_places")
      .select("id, trip_id, user_id, place_id, place_name, place_type, notes, saved_at")
      .eq("trip_id", tripId);
    if (error || !Array.isArray(data)
      || !data.every((row: unknown): row is SavedIdeaRow => isSavedIdeaRow(row, tripId.toLowerCase()))
      || new Set(data.map((row) => row.id)).size !== data.length) return unavailable;
    const ideas: TripCompassSavedIdea[] = data.map((row) => ({
      id: row.id, placeId: row.place_id, name: row.place_name, placeType: row.place_type, notes: row.notes,
      savedBy: row.user_id === viewerId ? "you" : "a crew member", savedAt: row.saved_at,
    }));
    ideas.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
    return { ok: true, projection: {
      ...liveEnvelope(version, opts.now), tripId, viewerId, ideas, countBasis: "returned_rows",
    } };
  } catch {
    return unavailable;
  }
}
