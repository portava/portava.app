/**
 * LayoverSessionService
 *
 * Creates and manages layover sessions. Handles lifecycle transitions
 * (active → completed / cancelled / expired) and emits layover_events rows.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "LayoverSessionService" });

export interface LayoverSessionInput {
  userId: string;
  airportId?: string | null;
  tripId?: string | null;
  arrivalTime: string;
  departureTime: string;
  boardingTime?: string | null;
  flightType?: "domestic" | "international";
  immigrationRequired?: boolean;
  checkedBags?: boolean;
  loungeAccess?: boolean;
  wantsToLeave?: boolean;
  comfortLevel?: "safe_only" | "moderate" | "adventurous";
  vibeChips?: string[];
  manualAirportName?: string | null;
  manualCity?: string | null;
  manualCountry?: string | null;
  manualIata?: string | null;
  canonicalCityId?: string | null;
}

export interface LayoverSession {
  id: string;
  userId: string;
  airportId: string | null;
  tripId: string | null;
  arrivalTime: string;
  departureTime: string;
  boardingTime: string | null;
  layoverMinutes: number;
  flightType: "domestic" | "international";
  immigrationRequired: boolean;
  checkedBags: boolean;
  loungeAccess: boolean;
  wantsToLeave: boolean;
  comfortLevel: "safe_only" | "moderate" | "adventurous";
  vibeChips: string[];
  manualAirportName: string | null;
  manualCity: string | null;
  manualCountry: string | null;
  manualIata: string | null;
  canonicalCityId: string | null;
  shareCityStatus: boolean;
  returnReminderAt: string | null;
  status: "active" | "completed" | "cancelled" | "expired";
  createdAt: string;
  updatedAt: string;
}

function rowToSession(row: any): LayoverSession {
  const arrival  = new Date(row.arrival_time).getTime();
  const depart   = new Date(row.departure_time).getTime();
  const computed = Math.max(0, Math.round((depart - arrival) / 60000));
  return {
    id:                 row.id,
    userId:             row.user_id,
    airportId:          row.airport_id ?? null,
    tripId:             row.trip_id ?? null,
    arrivalTime:        row.arrival_time,
    departureTime:      row.departure_time,
    boardingTime:       row.boarding_time ?? null,
    layoverMinutes:     row.layover_minutes ?? computed,
    flightType:         row.flight_type ?? "domestic",
    immigrationRequired: Boolean(row.immigration_required),
    checkedBags:        Boolean(row.checked_bags),
    loungeAccess:       Boolean(row.lounge_access),
    wantsToLeave:       row.wants_to_leave !== false,
    comfortLevel:       row.comfort_level ?? "moderate",
    vibeChips:          row.vibe_chips ?? [],
    manualAirportName:  row.manual_airport_name ?? null,
    manualCity:         row.manual_city ?? null,
    manualCountry:      row.manual_country ?? null,
    manualIata:         row.manual_iata ?? null,
    canonicalCityId:    row.canonical_city_id ?? null,
    shareCityStatus:    Boolean(row.share_city_status),
    returnReminderAt:   row.return_reminder_at ?? null,
    status:             row.status ?? "active",
    createdAt:          row.created_at,
    updatedAt:          row.updated_at,
  };
}

async function emitEvent(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // non-fatal
  const { error } = await db.from("layover_events").insert({
    session_id: sessionId,
    user_id:    userId,
    event_type: eventType,
    metadata,
  });
  if (error) logger.warn({ err: error, sessionId, eventType }, "layover event write failed (non-fatal)");
}

export async function createSession(
  db: SupabaseClient,
  input: LayoverSessionInput,
): Promise<LayoverSession | null> {
  try {
    const { data, error } = await db
      .from("layover_sessions")
      .insert({
        user_id:             input.userId,
        airport_id:          input.airportId   ?? null,
        trip_id:             input.tripId       ?? null,
        arrival_time:        input.arrivalTime,
        departure_time:      input.departureTime,
        boarding_time:       input.boardingTime ?? null,
        flight_type:         input.flightType   ?? "domestic",
        immigration_required: input.immigrationRequired ?? false,
        checked_bags:        input.checkedBags  ?? false,
        lounge_access:       input.loungeAccess ?? false,
        wants_to_leave:      input.wantsToLeave ?? true,
        comfort_level:       input.comfortLevel ?? "moderate",
        vibe_chips:          input.vibeChips    ?? [],
        manual_airport_name: input.manualAirportName ?? null,
        manual_city:         input.manualCity        ?? null,
        manual_country:      input.manualCountry     ?? null,
        manual_iata:         input.manualIata         ?? null,
        canonical_city_id:   input.canonicalCityId    ?? null,
        status:              "active",
      })
      .select("*")
      .maybeSingle();

    if (error || !data) return null;
    const session = rowToSession(data);
    await emitEvent(db, session.id, input.userId, "session_created", {
      flightType: session.flightType,
      layoverMinutes: session.layoverMinutes,
    });
    return session;
  } catch {
    return null;
  }
}

export async function updateSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  updates: Partial<Omit<LayoverSessionInput, "userId">>,
): Promise<LayoverSession | null> {
  try {
    const patch: any = { updated_at: new Date().toISOString() };
    if (updates.arrivalTime        !== undefined) patch.arrival_time         = updates.arrivalTime;
    if (updates.departureTime      !== undefined) patch.departure_time       = updates.departureTime;
    if (updates.boardingTime       !== undefined) patch.boarding_time        = updates.boardingTime;
    if (updates.flightType         !== undefined) patch.flight_type          = updates.flightType;
    if (updates.immigrationRequired !== undefined) patch.immigration_required = updates.immigrationRequired;
    if (updates.checkedBags        !== undefined) patch.checked_bags         = updates.checkedBags;
    if (updates.loungeAccess       !== undefined) patch.lounge_access        = updates.loungeAccess;
    if (updates.wantsToLeave       !== undefined) patch.wants_to_leave       = updates.wantsToLeave;
    if (updates.comfortLevel       !== undefined) patch.comfort_level        = updates.comfortLevel;
    if (updates.vibeChips          !== undefined) patch.vibe_chips           = updates.vibeChips;
    if (updates.airportId          !== undefined) patch.airport_id           = updates.airportId;
    if (updates.tripId             !== undefined) patch.trip_id              = updates.tripId;
    if (updates.manualAirportName  !== undefined) patch.manual_airport_name  = updates.manualAirportName;
    if (updates.manualCity         !== undefined) patch.manual_city          = updates.manualCity;
    if (updates.manualCountry      !== undefined) patch.manual_country       = updates.manualCountry;

    const { data, error } = await db
      .from("layover_sessions")
      .update(patch)
      .eq("id", sessionId)
      .eq("user_id", userId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();

    if (error || !data) return null;
    const session = rowToSession(data);
    await emitEvent(db, session.id, userId, "session_updated");
    return session;
  } catch {
    return null;
  }
}

export async function endSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  reason: "completed" | "cancelled",
): Promise<LayoverSession | null> {
  try {
    const { data, error } = await db
      .from("layover_sessions")
      .update({ status: reason, updated_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .in("status", ["active"])
      .select("*")
      .maybeSingle();

    if (error || !data) return null;
    const session = rowToSession(data);
    const eventType = reason === "completed" ? "session_completed" : "session_cancelled";
    await emitEvent(db, session.id, userId, eventType);
    return session;
  } catch {
    return null;
  }
}

export async function getSession(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<LayoverSession | null> {
  try {
    const { data } = await db
      .from("layover_sessions")
      .select("*")
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();
    return data ? rowToSession(data) : null;
  } catch {
    return null;
  }
}

export async function getActiveSession(
  db: SupabaseClient,
  userId: string,
): Promise<LayoverSession | null> {
  try {
    const { data } = await db
      .from("layover_sessions")
      .select("*")
      .eq("user_id", userId)
      .eq("status", "active")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ? rowToSession(data) : null;
  } catch {
    return null;
  }
}

/** List a user's sessions, newest first. Optional status filter. */
export async function listSessions(
  db: SupabaseClient,
  userId: string,
  status?: "active" | "completed" | "cancelled" | "expired",
  limit = 20,
): Promise<LayoverSession[]> {
  try {
    let query = db
      .from("layover_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (status) query = query.eq("status", status);
    const { data } = await query;
    return (data ?? []).map(rowToSession);
  } catch {
    return [];
  }
}

/** Toggle opt-in city-level layover visibility for a session. */
export async function setShareStatus(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  enabled: boolean,
): Promise<LayoverSession | null> {
  try {
    const { data, error } = await db
      .from("layover_sessions")
      .update({ share_city_status: enabled, updated_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .eq("status", "active")
      .select("*")
      .maybeSingle();
    if (error || !data) return null;
    const session = rowToSession(data);
    await emitEvent(db, sessionId, userId, "share_toggled", { enabled });
    return session;
  } catch {
    return null;
  }
}

/** Persist the return reminder instant the user asked for. */
export async function setReturnReminder(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  remindAtIso: string,
): Promise<boolean> {
  try {
    const { error } = await db
      .from("layover_sessions")
      .update({ return_reminder_at: remindAtIso, updated_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("user_id", userId)
      .eq("status", "active");
    return !error;
  } catch {
    return false;
  }
}

/** Mark expired sessions (departure in past) as expired — called by scheduler or inline. */
export async function expireOldSessions(
  db: SupabaseClient,
): Promise<number> {
  try {
    const { data } = await db
      .from("layover_sessions")
      .update({ status: "expired", updated_at: new Date().toISOString() })
      .eq("status", "active")
      .lt("departure_time", new Date().toISOString())
      .select("id, user_id");

    const rows = (data ?? []) as any[];
    for (const row of rows) {
      await emitEvent(db, row.id, row.user_id, "session_expired");
    }
    return rows.length;
  } catch {
    return 0;
  }
}

export async function emitLayoverEvent(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
  eventType: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await emitEvent(db, sessionId, userId, eventType, metadata);
}
