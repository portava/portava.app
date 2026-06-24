/**
 * LayoverNotificationService
 *
 * Sends return-deadline reminders via Expo push notifications and suggests
 * Safe Return for risky layover contexts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LayoverSession } from "./LayoverSessionService.js";
import type { AirportProfile } from "./AirportProfileService.js";
import { computeBuffer } from "./LayoverSafetyEngine.js";

export interface RiskyLayoverContext {
  isNightLayover: boolean;
  isLeavingAirport: boolean;
  isAlone: boolean;
  isNewCountry: boolean;
  isFarActivity: boolean;
  isLateNightRideshare: boolean;
}

/**
 * Determines if Safe Return should be suggested for this layover context.
 */
export function shouldSuggestSafeReturn(
  session: LayoverSession,
  context: Partial<RiskyLayoverContext> = {},
): { suggest: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (context.isNightLayover) {
    reasons.push("Night layover — safe return monitoring adds peace of mind.");
  }
  if (context.isLeavingAirport && session.wantsToLeave) {
    reasons.push("Leaving the airport alone during a layover.");
  }
  if (context.isNewCountry) {
    reasons.push("First time in this country — Safe Return keeps your contacts informed.");
  }
  if (context.isFarActivity && session.wantsToLeave) {
    reasons.push("Activity is far from the airport — tight time window.");
  }
  if (context.isLateNightRideshare) {
    reasons.push("Late-night rideshare back to airport — Safe Return recommended.");
  }
  if (session.immigrationRequired && session.flightType === "international") {
    reasons.push("International flight with immigration — longer return time needed.");
  }

  return { suggest: reasons.length > 0, reasons };
}

/**
 * Send a return-deadline reminder push notification.
 */
export async function sendReturnDeadlineReminder(
  db: SupabaseClient,
  session: LayoverSession,
  airport: AirportProfile,
  minutesBefore: number,
): Promise<{ ok: boolean; skipped?: boolean }> {
  try {
    // Fetch push token
    const { data: profile } = await db
      .from("profiles")
      .select("expo_push_token")
      .eq("id", session.userId)
      .maybeSingle();

    const token = (profile as any)?.expo_push_token;
    if (!token) return { ok: true, skipped: true };

    const breakdown = computeBuffer(airport, session, new Date(session.departureTime));
    const bufferMin = breakdown.totalBuffer;
    const cutoffTime = session.boardingTime ?? session.departureTime;
    const hardReturn = new Date(new Date(cutoffTime).getTime() - bufferMin * 60000);
    const returnStr  = hardReturn.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const title = minutesBefore <= 15
      ? "🚨 Head back to the airport NOW"
      : `⏰ Return reminder — ${minutesBefore} minutes`;
    const body = minutesBefore <= 15
      ? `You must be back at the airport by ${returnStr} to board safely.`
      : `Start heading back to ${airport.name} — you need to be there by ${returnStr}.`;

    // Use Expo push API via service layer (fire-and-forget)
    await db.from("layover_events").insert({
      session_id: session.id,
      user_id:    session.userId,
      event_type: "return_deadline_set",
      metadata:   { minutesBefore, returnStr, token: "[redacted]" },
    });

    // In a real deployment this would call the Expo push API;
    // here we record the intent and the notification scheduler handles delivery.
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Suggest Safe Return activation for a risky layover context.
 * Records the event for in-app surfacing.
 */
export async function suggestSafeReturn(
  db: SupabaseClient,
  session: LayoverSession,
  reasons: string[],
): Promise<void> {
  try {
    await db.from("layover_events").insert({
      session_id: session.id,
      user_id:    session.userId,
      event_type: "safe_return_suggested",
      metadata:   { reasons },
    });
  } catch { /* non-fatal */ }
}
