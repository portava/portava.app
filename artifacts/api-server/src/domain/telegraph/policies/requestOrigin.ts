/**
 * Telegraph §22 — contextual origin on a message request.
 *
 * §22, verbatim: "Requests carry contextual origin: Event, Trip, Nearby, Bump,
 * Buddy, profile."
 *
 * ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
 * census T278: "`message_requests` has no origin column at all — only
 * `preview_text`. A recipient cannot be told why a stranger is reaching out."
 * Re-read against this tree and still true.
 *
 * The harm is a safety harm, not a convenience one. "Someone you have never met
 * wants to message you" and "someone in the trip crew you joined yesterday
 * wants to message you" call for different answers, and the recipient was
 * getting the first sentence for both.
 *
 * ── AN ORIGIN IS A CLAIM UNTIL THE SERVER PROVES IT ──────────────────────────
 * The sender asserts the origin. A sender who wants to look safe asserts
 * "Trip". Storing that indistinguishably from a verified one would have the
 * product tell a recipient something it does not know — which is worse than
 * telling them nothing, because they would act on it.
 *
 * So `verified` is a separate fact, it defaults to false, and only ONE of the
 * six can be established today:
 *
 *   trip   — verifiable. Both parties are accepted members of that trip, which
 *            `isAcceptedTripMember` answers against the real roster.
 *   event  — NOT verified. Attendance lives in another lane's tables and this
 *            module will not reach into them to guess.
 *   buddy  — NOT verified. A booking links two people, but a buddy request
 *            usually PRECEDES the booking, so "no booking" is not "false".
 *   nearby — NOT verifiable, ever, by anything here. Proximity at request time
 *            is not retained, and reconstructing it would be a location read
 *            §15 does not authorize for this purpose.
 *   bump   — NOT verifiable; there is no bump primitive in this repository.
 *   profile— NOT verified, and it is the least interesting claim: "I found you"
 *            tells a recipient nothing they did not already know.
 *
 * An unverifiable origin is still worth recording. "They say they found you via
 * Nearby" is information; what it must not be is "They found you via Nearby".
 *
 * ── THE COLUMNS ARE NEVER NAMED WITHOUT THE FLAG ─────────────────────────────
 * PostgREST answers an unknown column with 42703 and fails the WHOLE statement,
 * so a select list that names `origin_type` on a database without 2813 breaks
 * the message-request list entirely. Same shape as `membershipSelect` in
 * groupChatHistoryBound: the caller passes what it would have selected anyway.
 */
import { isFlagEnabled } from "../../../lib/featureFlags.js";
import { isAcceptedTripMember } from "../../../lib/tripMembership.js";

export const REQUEST_ORIGIN_FLAG = "telegraph_request_origin_enabled";

/** §22's six, in §22's order. The CHECK in migration 2813 is this list. */
export const REQUEST_ORIGINS = ["event", "trip", "nearby", "bump", "buddy", "profile"] as const;
export type RequestOrigin = (typeof REQUEST_ORIGINS)[number];

/** The one origin this server can establish. Everything else is a claim. */
export const VERIFIABLE_ORIGINS: readonly RequestOrigin[] = ["trip"];

export interface OriginClaim {
  type: RequestOrigin;
  id: string | null;
}

export interface ResolvedOrigin extends OriginClaim {
  /** True only when the SERVER established it. Never copied from the request. */
  verified: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRequestOrigin(value: unknown): value is RequestOrigin {
  return typeof value === "string" && (REQUEST_ORIGINS as readonly string[]).includes(value);
}

export async function requestOriginEnabled(sc: any): Promise<boolean> {
  return isFlagEnabled(sc, REQUEST_ORIGIN_FLAG);
}

/**
 * Read an origin claim off a request body.
 *
 * Returns null for anything that is not one of §22's six. An unrecognised
 * origin is DROPPED rather than stored as-is: the column has a CHECK, so
 * storing free text would fail the insert and lose the whole request — and a
 * recipient-facing reason a stranger can write anything into is a second
 * `preview_text`, not an origin.
 */
export function parseOriginClaim(body: unknown): OriginClaim | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as Record<string, unknown>)["origin"];
  if (!raw || typeof raw !== "object") return null;
  const type = (raw as Record<string, unknown>)["type"];
  if (!isRequestOrigin(type)) return null;
  const id = (raw as Record<string, unknown>)["id"];
  return { type, id: typeof id === "string" && UUID_RE.test(id) ? id : null };
}

/**
 * Establish what can be established, and mark the rest as claimed.
 *
 * Fails CLOSED into `verified: false`: a membership read that errors means "we
 * could not prove it", which is the same answer as "it is not true" for the
 * only thing this value is used for — whether to show a recipient a fact or a
 * claim.
 *
 * THE `catch` BELOW IS A SECOND WALL AND IT IS CURRENTLY UNREACHABLE, which is
 * said here rather than left to be discovered: `isAcceptedTripMember` has its
 * own try/catch and answers `false` on both an error and a throw, so nothing
 * propagates this far. A deliberate mutation of the catch to `verified: true`
 * turned NO test red — measured, not assumed. It stays because the day that
 * helper starts throwing (a rewrite, a different client), the failure mode
 * without it is a verified origin from an exception, and that is the one
 * outcome this module exists to prevent.
 */
export async function resolveRequestOrigin(
  sc: any,
  params: { senderId: string; recipientId: string; claim: OriginClaim | null },
): Promise<ResolvedOrigin | null> {
  const { senderId, recipientId, claim } = params;
  if (!claim) return null;
  if (!VERIFIABLE_ORIGINS.includes(claim.type) || !claim.id) {
    return { ...claim, verified: false };
  }

  try {
    // Both ends. A sender who is in the trip and a recipient who is not means
    // the trip is not a shared context, which is the whole content of the claim.
    const [senderIn, recipientIn] = await Promise.all([
      isAcceptedTripMember(sc, claim.id, senderId),
      isAcceptedTripMember(sc, claim.id, recipientId),
    ]);
    return { ...claim, verified: senderIn === true && recipientIn === true };
  } catch {
    return { ...claim, verified: false };
  }
}

/**
 * The origin columns of an insert, or nothing at all.
 *
 * Returns an EMPTY object when the flag is off, so the insert statement is
 * byte-identical to the one that ran before 2813 rather than merely equivalent.
 */
export function originInsertColumns(origin: ResolvedOrigin | null, enabled: boolean): Record<string, unknown> {
  if (!enabled || !origin) return {};
  return {
    origin_type: origin.type,
    origin_id: origin.id,
    origin_verified: origin.verified,
  };
}

/** Add the origin columns to a select list, or return it untouched. */
export function originSelect(baseColumns: string, enabled: boolean): string {
  return enabled ? `${baseColumns}, origin_type, origin_id, origin_verified` : baseColumns;
}

/**
 * What the recipient is told, as a shape that keeps the distinction.
 *
 * `verified` travels to the client because the client has to render two
 * different sentences. Flattening it into one string here would move the
 * decision into a place with less information.
 */
export function originForWire(row: Record<string, unknown>, enabled: boolean): ResolvedOrigin | null {
  if (!enabled) return null;
  const type = row["origin_type"];
  if (!isRequestOrigin(type)) return null;
  const id = row["origin_id"];
  return {
    type,
    id: typeof id === "string" ? id : null,
    verified: row["origin_verified"] === true,
  };
}
