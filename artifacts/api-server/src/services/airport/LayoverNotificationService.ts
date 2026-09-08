/**
 * LayoverNotificationService
 *
 * Sends return-deadline reminders via Expo push notifications and suggests
 * Safe Return for risky layover contexts.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";

const logger = rootLogger.child({ service: "LayoverNotificationService" });
import type { LayoverSession } from "./LayoverSessionService.js";
import type { AirportProfile } from "./AirportProfileService.js";
import { certifySessionFeasibility, certificationHeader } from "./LayoverFeasibility.js";
import { formatLocalTime } from "./AirportTime.js";

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
 * Compose the return-deadline reminder and record the intent.
 *
 * ── OWNER BOUNDARY — READ BEFORE CHANGING THIS FUNCTION ─────────────────────
 * WHETHER THIS REMINDER IS SERVER-PUSHED OR SCHEDULED LOCALLY BY THE CLIENT IS
 * AN OPEN OWNER DECISION, recorded as `LAYOVER_RETURN_REMINDER_DELIVERY` in
 * docs/architecture/blocker-ledger.md. Measured 2026-09-08: this function has
 * ZERO references anywhere in the repository, tests included, while
 * `POST /:id/return-deadline` persists `return_reminder_at` and the client
 * schedules an OS-level local notification. Nothing here decides that question:
 * no push is sent, no delivery path is added, and the event row it writes is
 * the same one it always wrote. What changed is only what was WRONG.
 *
 * ── TWO DEFECTS FIXED, NEITHER OF THEM A DELIVERY DECISION ──────────────────
 * 1. THE CLOCK WAS THE SERVER'S. `hardReturn.toLocaleTimeString(...)` formats
 *    in the SERVER PROCESS's timezone — UTC in every deployment — so the body
 *    of "🚨 Head back to the airport NOW" named a time eight hours from the
 *    truth for a traveller in Taipei. Every other layover surface formats this
 *    instant with `formatLocalTime(airport.timezone, …)`; this one did not.
 * 2. AN UNREADABLE `profiles` WAS REPORTED AS "NO PUSH TOKEN". supabase-js
 *    RESOLVES on a database error, so `const { data: profile } = await` could
 *    not tell a failed read from a user who has never registered a device, and
 *    both returned `{ ok: true, skipped: true }` — a claim about the traveller
 *    made from a read that never happened. The `try/catch` around it was dead
 *    code for the same reason. `error` is now bound and a failure answers
 *    `{ ok: false, reason: "push_token_unreadable" }`.
 *
 * The deadline is also no longer derived here: it comes from the certified
 * record (spec §1, one canonical operational truth), which is the same
 * `computeReturnDeadline` this function used to call directly — identical
 * numbers, one derivation.
 */
export type ReturnReminderResult =
  | { ok: true; skipped?: boolean; reason?: "no_push_token"; title: string; body: string }
  | { ok: false; reason: "push_token_unreadable" | "event_write_failed" };

export async function sendReturnDeadlineReminder(
  db: SupabaseClient,
  session: LayoverSession,
  airport: AirportProfile,
  minutesBefore: number,
  nowMs: number = Date.now(),
): Promise<ReturnReminderResult> {
  const record = certifySessionFeasibility(airport, session, { nowMs });
  const hardReturn = record.deadline.hardReturnTime;
  const returnStr = formatLocalTime(airport.timezone ?? "UTC", hardReturn);

  const title = minutesBefore <= 15
    ? "🚨 Head back to the airport NOW"
    : `⏰ Return reminder — ${minutesBefore} minutes`;
  const body = minutesBefore <= 15
    ? `You must be back at the airport by ${returnStr} to board safely.`
    : `Start heading back to ${airport.name} — you need to be there by ${returnStr}.`;

  // No try/catch: supabase-js resolves on database AND network errors, so a
  // catch here would be dead code that only ever fired on a wiring bug.
  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("expo_push_token")
    .eq("id", session.userId)
    .maybeSingle();

  if (profileError) {
    logger.warn(
      { err: profileError, sessionId: session.id },
      "expo_push_token unreadable — refusing rather than reporting 'this traveller has no device'",
    );
    return { ok: false, reason: "push_token_unreadable" };
  }

  const token = (profile as any)?.expo_push_token;
  if (!token) return { ok: true, skipped: true, reason: "no_push_token", title, body };

  // Record the INTENT only. Delivery is the open owner decision above; nothing
  // here calls a push provider. The token is never written to the row.
  const { error } = await db.from("layover_events").insert({
    session_id: session.id,
    user_id:    session.userId,
    event_type: "return_deadline_set",
    metadata:   {
      minutesBefore,
      returnStr,
      hardReturnTime: hardReturn.toISOString(),
      ...certificationHeader(record),
    },
  });
  if (error) {
    logger.warn({ err: error, sessionId: session.id }, "return reminder intent event write failed");
    return { ok: false, reason: "event_write_failed" };
  }
  return { ok: true, title, body };
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
  // non-fatal
  const { error } = await db.from("layover_events").insert({
    session_id: session.id,
    user_id:    session.userId,
    event_type: "safe_return_suggested",
    metadata:   { reasons },
  });
  if (error) logger.warn({ err: error, sessionId: session.id }, "safe_return_suggested event failed (non-fatal)");
}
