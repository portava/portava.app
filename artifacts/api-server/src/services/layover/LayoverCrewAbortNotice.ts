/**
 * LayoverCrewAbortNotice — census-layover L144: at the §15.1 one-tap abort, the
 * traveller's crew "is notified if policy + user settings allow" (spec §15).
 *
 * ── WHAT WAS TRUE BEFORE THIS FILE ───────────────────────────────────────────
 * The abort published `posture.notifyCrew` and then answered `crewNotified: []`
 * with a hard-coded `crew_notify_not_enabled`, every time. Census §28.3 / §48.3
 * held the row at N on a decision rather than on plumbing: telling a crew that
 * one of its members turned back is a DISCLOSURE ABOUT THAT TRAVELLER, and the
 * owner has not decided it (OQ-3, PLAN-layover). Nothing here decides it either.
 * What is built is the fail-closed default the plan names, behind a flag that
 * migration 3786 seeds FALSE:
 *
 *   1. FLAG. `layover_crew_abort_notify_enabled`, read through the shared
 *      fail-closed reader. OFF / absent / unreadable: nothing is read, nothing is
 *      sent, the abort answers `crew_notify_not_enabled` exactly as before.
 *   2. PER ABORT, EXPLICIT. Only a request body carrying the literal boolean
 *      `tellCrew: true` is consent (`tellCrewRequested`). No standing setting, no
 *      default, no inference from the posture's `notifyCrew` — that boolean says
 *      the spec WOULD notify, not that this traveller agreed to. The client
 *      toggle is unticked by default and resets after every abort.
 *   3. CREW ONLY. The recipients are the other live members of the traveller's
 *      own live crew — the crew whose membership row was written for THIS
 *      session (`activeCrewForUser` + `crewMembers`, both refusing on a failed
 *      read). No buddy, no trip member, no follower: there is no layover↔booking
 *      link for the buddy half (census L144's second noun), and inventing one
 *      would be a second disclosure nobody asked for.
 *   4. THE SAME GATES AS THE CREW CARD, BOTH WAYS. A crewmate is told only if
 *      the traveller could see their card on `GET /crew` (routes/airport.ts
 *      `crewMemberCards`): no block in EITHER direction (`readBlockExclusions`,
 *      scoped to the crew), and the crewmate's own sharing allowed
 *      (`publishableUserIds`). The traveller's own sharing must be allowed too,
 *      through the SAME gate the layover surface publishes them by
 *      (`evaluateSharingGate`: `location_preferences` AND this trip's Ghost
 *      Mode, either unreadable = refused) — a traveller whose sharing is paused
 *      or off, or who is in Ghost Mode on this layover's trip, is not announced,
 *      even on request, because the standing choice is the stricter one
 *      (fix round 1, F1). The capability below asks the same gate, so the
 *      choice is not even offered to them (F2). An unreadable block list
 *      or sharing table tells NOBODY (fail closed), with a named reason. So the
 *      recipient set is never larger than the faces the traveller already sees,
 *      and a count cannot tell "hidden because blocked" from "hidden because
 *      paused".
 *   5. MINIMAL TEXT. "<name> is heading back to the airport." — the name only
 *      when the traveller shows their real name (`nameVisibilitySet`), otherwise
 *      "A crew member". No reason, no time, no place, no handle, no avatar, no
 *      actor id on the row (a client rendering the actor would undo the name
 *      rule). In-app only: the template has no push channel, so no lock-screen
 *      preview carries it.
 *   6. A COUNT, NEVER A PERSON. The abort reports how many crewmates hold the
 *      notice, never which (`bindingMemberHidden` precedent, census §48).
 *   7. NEVER FAILS OR HOLDS THE ABORT. Every failure here becomes a reason on
 *      the response; nothing throws out of `tellCrewOfAbort`, and the abort's
 *      own `ok` does not read it. The abort calls it through
 *      `tellCrewOfAbortWithin`, bounded by CREW_ABORT_NOTICE_DEADLINE_MS: a
 *      notice that has not finished by then answers `notify_timed_out`. No notice STARTS after
 *      that; one already started (its duplicate check, then its insert) may still land after the answer, which is why the app says "could not confirm in time", never "not told" (fix rounds 1-2, F3).
 *
 * ── THE ESSENTIAL-SAFETY CHANNEL IS NOT TOUCHED ──────────────────────────────
 * The return warnings of #701/#709 (census §66/§69) own `layover.return.*`,
 * source type `layover_return`, the `/airport/sessions/<id>` action url their
 * superseding read keys on, the essential flag and the bounded attempt budget.
 * This notice uses none of them: its own event type, its own source type
 * (`layover_crew_abort`), an app route as its action url, `essential` unset. A
 * crewmate's return-warning dedup and re-escalation read cannot see it, and
 * NotificationRouter's code is unchanged (the routing of every existing type is
 * pinned by routerRegression's golden).
 *
 * ── DUPLICATES ───────────────────────────────────────────────────────────────
 * One identity per (crew, aborting session) — `crewAbortNoticeSourceId`, an
 * OPAQUE digest, so the crewmate's row carries the crew they are in and nothing
 * that names the traveller or their session: a double-tapped abort inside
 * NotificationDeduplicationService's 30-minute window writes nothing new.
 * Because that service ALSO answers "duplicate" when its ledger cannot be read,
 * a duplicate refusal alone is not evidence the crewmate was told: it counts as
 * told only when this module itself READ a prior notice for that crewmate
 * (`priorNotices`). Otherwise it is counted as not told.
 */
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { readBlockExclusions } from "../../lib/exclusionSet.js";
import { nameVisibilitySet } from "../../lib/publicIdentity.js";
import { evaluateSharingGate, discloseSharingGate, publishableUserIds } from "../airport/LayoverPrivacyGuard.js";
import { NotificationService } from "../notifications/NotificationService.js";
import { NotificationRouter } from "../notifications/NotificationRouter.js";
import { activeCrewForUser, crewMembers, type CrewMemberRow } from "./LayoverCrewStore.js";

const logger = rootLogger.child({ service: "LayoverCrewAbortNotice" });

/** The template (NotificationTemplateService): category `airport`, in-app only. */
export const CREW_ABORT_NOTICE_EVENT_TYPE = "layover.crew.member_heading_back";
/** Not `layover_return` / `layover_replan`: the return-warning reads must never see this row. */
export const CREW_ABORT_NOTICE_SOURCE_TYPE = "layover_crew_abort";
/** What a crewmate reads when the traveller does not show their real name. */
export const CREW_ABORT_NOTICE_FALLBACK_NAME = "A crew member";

/**
 * Why nobody (or not everybody) was told. The client renders these through a
 * table and treats an unknown one as "not told" (travel-buddy-standalone
 * layoverReturnFacts.ts `describeCrewNotification`), so adding one is safe.
 */
export const CREW_ABORT_NOTICE_REASONS = [
  "crew_notify_not_enabled",        // the flag is OFF (the seed), absent or unreadable
  "not_requested",                  // the flag is on; the traveller did not tick "tell my crew"
  "not_in_a_crew",                  // no live crew joined with THIS session
  "crew_unreadable",                // the crew or its members could not be read
  "no_crewmate_to_tell",            // nobody else in the crew the traveller may reach
  "blocks_unreadable",              // the block list could not be read — nobody is told
  "sharing_preferences_unreadable", // the sharing table could not be read — nobody is told
  "sharing_not_allowed",            // the traveller's own sharing is paused or off; their standing choice wins
  "notify_failed",                  // every write failed
  "notify_partially_failed",        // some crewmates were told, some writes failed
  "notify_timed_out",               // the bound passed first: no notice STARTS after it, but one already started may still land — unconfirmed, never "not told"
] as const;
export type CrewAbortNoticeReason = (typeof CREW_ABORT_NOTICE_REASONS)[number];

/** What the abort route hands the service: the traveller's choice and the flag, read once. */
export interface CrewAbortNoticeRequest {
  requested: boolean;
  enabled: boolean;
}

/** No choice and no flag: the answer every caller that passes nothing gets. */
export const CREW_ABORT_NOTICE_OFF: Readonly<CrewAbortNoticeRequest> = Object.freeze({ requested: false, enabled: false });

export interface CrewAbortNoticeOutcome {
  /** Crewmates who hold this notice. Never their ids. */
  notifiedCount: number;
  /** Null only when every crewmate who cleared the gates holds it. */
  reason: CrewAbortNoticeReason | null;
}

/**
 * Consent is the literal boolean `true` on `tellCrew` and nothing else: not the
 * string "true", not 1, not a missing body, not the posture's `notifyCrew`.
 */
export function tellCrewRequested(body: unknown): boolean {
  return typeof body === "object" && body !== null && (body as { tellCrew?: unknown }).tellCrew === true;
}

/** The route's one call: the choice off the body, the flag off the shared fail-closed reader. */
export async function crewAbortNoticeRequest(db: SupabaseClient, body: unknown): Promise<CrewAbortNoticeRequest> {
  const requested = tellCrewRequested(body);
  const enabled = await isFlagEnabled(db, "layover_crew_abort_notify_enabled");
  return { requested, enabled };
}

type OwnCrew =
  | { kind: "crew"; crewId: string; others: CrewMemberRow[] }
  | { kind: "none" }
  | { kind: "unreadable" };

/**
 * The live crew this traveller joined WITH THIS SESSION, and its other live
 * members. A membership written for another session is not this layover's
 * crew. A failed read is `unreadable`, never `none`.
 */
async function ownCrewFor(db: SupabaseClient, userId: string, sessionId: string, nowMs: number): Promise<OwnCrew> {
  const mine = await activeCrewForUser(db, userId, new Date(nowMs).toISOString());
  if (!mine.ok) return { kind: "unreadable" };
  if (!mine.value || mine.value.membership.sessionId !== sessionId) return { kind: "none" };
  const members = await crewMembers(db, mine.value.crew.id);
  if (!members.ok) return { kind: "unreadable" };
  const seen = new Set<string>([userId]);
  const others: CrewMemberRow[] = [];
  for (const m of members.value) {
    if (seen.has(m.userId)) continue;
    seen.add(m.userId);
    others.push(m);
  }
  return { kind: "crew", crewId: mine.value.crew.id, others };
}

export type CrewAbortNoticeCapability =
  | { available: true; reason: null }
  | { available: false; reason: "crew_notify_not_enabled" | "sharing_not_allowed" | "sharing_preferences_unreadable" | "not_in_a_crew" | "crew_unreadable" | "no_crewmate_to_tell" };

/**
 * The traveller's OWN standing choices, through the layover surface's §17 gate
 * (`evaluateSharingGate`): `location_preferences` (paused, mode off) AND the
 * Ghost Mode of this layover's trip. Unreadable is refused, never "allowed".
 */
async function travellerRefusal(
  db: SupabaseClient,
  userId: string,
  tripId: string | null | undefined,
): Promise<"sharing_not_allowed" | "sharing_preferences_unreadable" | null> {
  const gate = discloseSharingGate(await evaluateSharingGate(db, { userId, tripId: tripId ?? null }));
  if (gate.degraded) return "sharing_preferences_unreadable";
  if (!gate.allowed) return "sharing_not_allowed";
  return null;
}

/**
 * Whether the "tell my crew" choice may be OFFERED on this session — published
 * on `GET /overview` so the client shows the toggle only when it can mean
 * something. It says nothing about who would be told (that is decided at the
 * abort, against the gates above); it never throws.
 */
export async function crewAbortNoticeCapability(
  db: SupabaseClient,
  userId: string,
  sessionId: string,
  nowMs: number,
  /** The session's trip, whose Ghost Mode the traveller's gate reads (F2). */
  tripId: string | null = null,
): Promise<CrewAbortNoticeCapability> {
  try {
    if (!(await isFlagEnabled(db, "layover_crew_abort_notify_enabled"))) return { available: false, reason: "crew_notify_not_enabled" };
    const refused = await travellerRefusal(db, userId, tripId);
    if (refused) return { available: false, reason: refused };
    const own = await ownCrewFor(db, userId, sessionId, nowMs);
    if (own.kind === "unreadable") return { available: false, reason: "crew_unreadable" };
    if (own.kind === "none") return { available: false, reason: "not_in_a_crew" };
    if (own.others.length === 0) return { available: false, reason: "no_crewmate_to_tell" };
    return { available: true, reason: null };
  } catch (err) {
    logger.warn({ err, sessionId }, "crew abort notice: capability read threw — not offered");
    return { available: false, reason: "crew_unreadable" };
  }
}

/** The traveller's name as a crewmate may read it, or the fallback. Any failure is the fallback. */
async function senderLabel(db: SupabaseClient, userId: string): Promise<string> {
  try {
    const allowed = await nameVisibilitySet(db, [userId]);
    if (!allowed.has(userId)) return CREW_ABORT_NOTICE_FALLBACK_NAME;
    const { data, error } = await db.from("profiles").select("id, name").eq("id", userId).maybeSingle();
    if (error) {
      logger.warn({ err: error, userId }, "crew abort notice: name unreadable — the fallback is used");
      return CREW_ABORT_NOTICE_FALLBACK_NAME;
    }
    const name = typeof (data as { name?: unknown } | null)?.name === "string" ? String((data as { name: string }).name).trim() : "";
    return name.length > 0 ? name : CREW_ABORT_NOTICE_FALLBACK_NAME;
  } catch (err) {
    logger.warn({ err, userId }, "crew abort notice: name read threw — the fallback is used");
    return CREW_ABORT_NOTICE_FALLBACK_NAME;
  }
}

/**
 * Crewmates who already hold this notice (any age), or null when that could not
 * be read. Only used to interpret a "duplicate" refusal — see DUPLICATES above.
 */
async function priorNotices(db: SupabaseClient, recipientIds: string[], sourceId: string): Promise<Set<string> | null> {
  try {
    const { data, error } = await db
      .from("notifications")
      .select("user_id")
      .eq("source_type", "layover_crew_abort")
      .eq("source_id", sourceId)
      .eq("event_type", "layover.crew.member_heading_back")
      .in("user_id", recipientIds);
    if (error || !Array.isArray(data)) return null;
    return new Set((data as Array<{ user_id?: unknown }>).map((r) => String(r.user_id)));
  } catch {
    return null;
  }
}

/**
 * The duplicate identity of one traveller's abort notice to one crew. The crew
 * id is the recipient's own crew; the session is hashed so the row a crewmate
 * can read does not carry the traveller's session id.
 */
export function crewAbortNoticeSourceId(crewId: string, sessionId: string): string {
  return `${crewId}:${createHash("sha256").update(`${crewId}:${sessionId}`).digest("hex").slice(0, 16)}`;
}

function untold(reason: CrewAbortNoticeReason): CrewAbortNoticeOutcome {
  return { notifiedCount: 0, reason };
}

/**
 * Tell the traveller's crew they are heading back — only when the flag is on,
 * the traveller asked on THIS abort, and per crewmate only through the gates in
 * the header. Never throws; never decides the abort's `ok`.
 */
export async function tellCrewOfAbort(
  db: SupabaseClient,
  input: {
    userId: string; sessionId: string; nowMs: number; request: CrewAbortNoticeRequest;
    /** The session's trip, whose Ghost Mode gates the traveller (F1). */
    tripId?: string | null;
    /** True once the caller stopped waiting (`tellCrewOfAbortWithin`): nothing is written after that. */
    cancelled?: () => boolean;
  },
): Promise<CrewAbortNoticeOutcome> {
  const { userId, sessionId, nowMs, request } = input;
  if (!request.enabled) return untold("crew_notify_not_enabled");
  if (!request.requested) return untold("not_requested");
  try {
    const refused = await travellerRefusal(db, userId, input.tripId);
    if (refused) return untold(refused);
    const own = await ownCrewFor(db, userId, sessionId, nowMs);
    if (own.kind === "unreadable") return untold("crew_unreadable");
    if (own.kind === "none") return untold("not_in_a_crew");
    if (own.others.length === 0) return untold("no_crewmate_to_tell");

    const otherIds = own.others.map((m) => m.userId);
    const blocked = await readBlockExclusions(db, userId, { among: otherIds });
    if (!blocked.ok) return untold("blocks_unreadable");

    // Every crewmate's sharing is read, blocked or not, so the two gates below
    // are independent: each one alone keeps a crewmate off the list. (The
    // traveller's own gate ran first, above, and includes Ghost Mode.)
    const sharing = await publishableUserIds(db, otherIds);
    if (sharing.kind === "degraded") return untold("sharing_preferences_unreadable");
    const allowed = new Set(sharing.value.allowed);
    const recipients = own.others.filter((m) => !blocked.ids.has(m.userId) && allowed.has(m.userId));
    if (recipients.length === 0) return untold("no_crewmate_to_tell");

    const actor = await senderLabel(db, userId);
    const sourceId = crewAbortNoticeSourceId(own.crewId, sessionId);
    const prior = await priorNotices(db, recipients.map((m) => m.userId), sourceId);
    // Past the bound the caller has answered the traveller: no notice STARTS now. Notices started before it (below,
    // all at once) may still land after the answer; the answer says "could not confirm", not "not told".
    if (input.cancelled?.()) return untold("notify_timed_out");
    const service = new NotificationService(db);
    const results = await Promise.all(recipients.map(async (m): Promise<boolean> => {
      try {
        const { row, refusal } = await service.createDetailed({
          userId: m.userId,
          eventType: CREW_ABORT_NOTICE_EVENT_TYPE,
          params: { actor },
          actionUrl: `/layover/${m.sessionId}`,
          sourceType: CREW_ABORT_NOTICE_SOURCE_TYPE,
          sourceId,
        });
        if (row) {
          void new NotificationRouter(db).route(row).catch((err) => {
            logger.warn({ err, crewId: own.crewId }, "crew abort notice: routing failed (the row exists)");
          });
          return true;
        }
        return refusal === "duplicate" && prior !== null && prior.has(m.userId);
      } catch (err) {
        logger.warn({ err, crewId: own.crewId }, "crew abort notice: create threw");
        return false;
      }
    }));
    const told = results.filter(Boolean).length;
    if (told === results.length) return { notifiedCount: told, reason: null };
    return { notifiedCount: told, reason: told === 0 ? "notify_failed" : "notify_partially_failed" };
  } catch (err) {
    logger.warn({ err, sessionId }, "crew abort notice threw — nobody is reported told");
    return untold("notify_failed");
  }
}

/** How long the abort waits for the crew notice before answering without it. */
export const CREW_ABORT_NOTICE_DEADLINE_MS = 2_500;

/**
 * `tellCrewOfAbort`, bounded (fix round 1, F3). The abort is the traveller's
 * "head back now"; it must not wait on six reads and N writes. Past the bound
 * the answer is `notify_timed_out` (nobody is reported told). A notifier still running
 * starts no notice after that, but notices it had already started may land after the answer. With the flag off or
 * no request there is nothing to bound: those answers read nothing.
 */
export async function tellCrewOfAbortWithin(
  db: SupabaseClient,
  input: { userId: string; sessionId: string; nowMs: number; request: CrewAbortNoticeRequest; tripId?: string | null },
  deadlineMs: number = CREW_ABORT_NOTICE_DEADLINE_MS,
): Promise<CrewAbortNoticeOutcome> {
  if (!input.request.enabled) return tellCrewOfAbortAuthorized(db, input); // census L144 (lane B2-CREW): an unticked abort may still be authorized (a live crew share, an emergency contact), so only the flag short-circuits
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<CrewAbortNoticeOutcome>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      logger.warn({ sessionId: input.sessionId, deadlineMs }, "crew abort notice missed its bound — the abort answers without it");
      resolve(untold("notify_timed_out"));
    }, deadlineMs);
  });
  try {
    return await Promise.race([tellCrewOfAbortAuthorized(db, { ...input, cancelled: () => timedOut }).catch((err: unknown): CrewAbortNoticeOutcome => { logger.warn({ err, sessionId: input.sessionId }, "crew abort notice threw — nobody is reported told"); return untold("notify_failed"); }), bound]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE AUTHORIZATION RULE, MADE EXPLICIT — LAYOVER 165, lane B2-CREW (census-layover L144)
// ─────────────────────────────────────────────────────────────────────────────
//
// Owner decision 2026-10-18: "Abort notifications may be sent to the crew ONLY under established user authorization
// or emergency-sharing rules." Before this, the rule was implicit in the order of `tellCrewOfAbort`'s early returns
// and had one basis (the per-abort tick). It is now ONE pure function, `crewAbortNoticeAuthorization`, decided per
// recipient, with exactly three bases and a named denial for everything else:
//
//   explicit_request              the traveller ticked "tell my crew" on THIS abort (`tellCrew: true`) — their
//                                 authorization for this very notice. Their standing §17 sharing gate must also be
//                                 open (paused / location off / Ghost Mode on this trip = the standing refusal wins),
//                                 and the crewmate's own sharing must publish them (the crew card's gate).
//   standing_crew_location_share  the traveller is, at the moment of the abort, LIVE-SHARING their location with THIS
//                                 crew (3996 grant, evaluated with every §14.1 terminator). They already authorized
//                                 the crew to know where they are; "heading back to the airport" discloses less than
//                                 that share does. Same two sharing gates as above.
//   emergency_contact             EMERGENCY-SHARING RULE: the crewmate is an in-app contact the traveller nominated on
//                                 an ACTIVE Safe Return session (safe_return_contacts.contact_user_id). Safe Return's
//                                 own basis is vital interest during an active session (lib/locationPurposes.ts
//                                 `safety_return`), so neither sharing preference is consulted for that person.
//
// BLOCKS ALWAYS WIN: a block in either direction denies every basis, and an unreadable block list tells nobody.
// THE FLAG (3786) still decides first: OFF / absent / unreadable tells nobody on any basis.

export type CrewAbortAuthorizationBasis = "explicit_request" | "standing_crew_location_share" | "emergency_contact";
export type CrewAbortAuthorizationDenial = "crew_notify_not_enabled" | "blocked" | "sharing_not_allowed" | "recipient_not_publishable" | "not_requested";

export interface CrewAbortAuthorizationInput {
  flagEnabled: boolean;
  /** `tellCrew: true` on this abort. */
  requested: boolean;
  /** The traveller's own §17 gate: open and READ (a degraded gate is false). */
  travellerSharingAllowed: boolean;
  /** A live 3996 share from the traveller to THIS crew at the abort instant. */
  liveCrewShare: boolean;
  recipient: {
    /** A block either way between the traveller and this crewmate. */
    blocked: boolean;
    /** The crewmate's own sharing preference publishes them (the crew card's gate). */
    publishable: boolean;
    /** The crewmate is an in-app contact on the traveller's ACTIVE Safe Return session. */
    emergencyContact: boolean;
  };
}

export type CrewAbortAuthorization =
  | { allowed: true; basis: CrewAbortAuthorizationBasis }
  | { allowed: false; denial: CrewAbortAuthorizationDenial };

/** Pure. The ONLY place the abort notice decides whether one crewmate may be told. */
export function crewAbortNoticeAuthorization(input: CrewAbortAuthorizationInput): CrewAbortAuthorization {
  if (!input.flagEnabled) return { allowed: false, denial: "crew_notify_not_enabled" };
  if (input.recipient.blocked) return { allowed: false, denial: "blocked" };
  if (input.recipient.emergencyContact) return { allowed: true, basis: "emergency_contact" };
  if (!input.requested && !input.liveCrewShare) return { allowed: false, denial: "not_requested" };
  if (!input.travellerSharingAllowed) return { allowed: false, denial: "sharing_not_allowed" };
  if (!input.recipient.publishable) return { allowed: false, denial: "recipient_not_publishable" };
  return { allowed: true, basis: input.requested ? "explicit_request" : "standing_crew_location_share" };
}

/**
 * Does the traveller hold a LIVE crew location share to this crew right now? Behind the crew-location flag (3996's
 * `layover_crew_location_enabled`): OFF / unreadable / any failed read = no standing authorization (never assumed).
 */
async function liveCrewShareOf(
  db: SupabaseClient,
  input: { userId: string; sessionId: string; crew: { id: string; status: string; expiresAt: string }; nowMs: number },
): Promise<boolean> {
  if (!(await isFlagEnabled(db, "layover_crew_location_enabled"))) return false;
  const { data, error } = await db
    .from("layover_crew_location_grants")
    .select("crew_id, user_id, session_id, purpose, precision, label, lat, lng, granted_at, expires_at")
    .eq("crew_id", input.crew.id)
    .eq("user_id", input.userId)
    .limit(1);
  if (error) {
    logger.warn({ err: error.message, crewId: input.crew.id }, "crew abort notice: crew location share unreadable — no standing authorization assumed");
    return false;
  }
  const g = ((data ?? []) as Array<Record<string, any>>)[0];
  if (!g || String(g.session_id) !== input.sessionId) return false;
  const grant = { grantedByUserId: input.userId, crewId: input.crew.id, grantedAtMs: Date.parse(g.granted_at), expiresAtMs: Date.parse(g.expires_at) };
  const signals = await abortCrewShareSignals(db, input, g);
  const share = evaluateCrewLocationShare(grant, signals, input.nowMs);
  return share.active;
}

/**
 * Which of these crewmates did the traveller nominate as in-app contacts on an ACTIVE Safe Return session? Any failed
 * read = nobody (the emergency basis is never assumed).
 */
async function activeSafeReturnContactsAmong(db: SupabaseClient, userId: string, candidateIds: string[]): Promise<Set<string>> {
  const none = new Set<string>();
  if (candidateIds.length === 0) return none;
  const { data: sessions, error } = await db
    .from("safe_return_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .limit(5);
  if (error) {
    logger.warn({ err: error.message }, "crew abort notice: Safe Return sessions unreadable — no emergency basis assumed");
    return none;
  }
  const ids = ((sessions ?? []) as Array<{ id?: unknown }>).map((s) => String(s.id));
  if (ids.length === 0) return none;
  const { data: contacts, error: cErr } = await db
    .from("safe_return_contacts")
    .select("contact_user_id").eq("contact_method", "in_app")
    .in("session_id", ids)
    .in("contact_user_id", candidateIds);
  if (cErr) {
    logger.warn({ err: cErr.message }, "crew abort notice: Safe Return contacts unreadable — no emergency basis assumed");
    return none;
  }
  return new Set(((contacts ?? []) as Array<{ contact_user_id?: unknown }>).map((c) => String(c.contact_user_id)));
}

export interface CrewAbortNoticeAuthorizedOutcome extends CrewAbortNoticeOutcome {
  /** How many crewmates were told on each basis. Counts, never people. */
  bases: Partial<Record<CrewAbortAuthorizationBasis, number>>;
}

/**
 * `tellCrewOfAbort` under the explicit rule above. Same recipients' crew, same minimal text, same duplicate identity,
 * same "a count, never a person" outcome. NO try/catch in here (it holds a block read, and `readBlockExclusions`
 * never rejects); the bounded caller turns any other throw into `notify_failed`.
 */
export async function tellCrewOfAbortAuthorized(
  db: SupabaseClient,
  input: {
    userId: string; sessionId: string; nowMs: number; request: CrewAbortNoticeRequest;
    tripId?: string | null;
    cancelled?: () => boolean;
  },
): Promise<CrewAbortNoticeAuthorizedOutcome> {
  const { userId, sessionId, nowMs, request } = input;
  const told = (reason: CrewAbortNoticeReason | null, n = 0, bases: CrewAbortNoticeAuthorizedOutcome["bases"] = {}): CrewAbortNoticeAuthorizedOutcome => ({ notifiedCount: n, reason, bases });
  if (!request.enabled) return told("crew_notify_not_enabled");

  const mine = await activeCrewForUser(db, userId, new Date(nowMs).toISOString());
  if (!mine.ok) return told("crew_unreadable");
  if (!mine.value || mine.value.membership.sessionId !== sessionId) return told(request.requested ? "not_in_a_crew" : "not_requested");
  const members = await crewMembers(db, mine.value.crew.id);
  if (!members.ok) return told("crew_unreadable");
  const seen = new Set<string>([userId]);
  const others: CrewMemberRow[] = [];
  for (const m of members.value) { if (!seen.has(m.userId)) { seen.add(m.userId); others.push(m); } }
  if (others.length === 0) return told(request.requested ? "no_crewmate_to_tell" : "not_requested");
  const otherIds = others.map((m) => m.userId);

  const blocked = await readBlockExclusions(db, userId, { among: otherIds });
  if (!blocked.ok) return told("blocks_unreadable");

  const emergency = await activeSafeReturnContactsAmong(db, userId, otherIds);
  const liveShare = await liveCrewShareOf(db, { userId, sessionId, crew: mine.value.crew, nowMs });
  const userBasis = request.requested || liveShare;

  // The user bases need both standing gates read; an unreadable one is a refusal for those bases only.
  let travellerAllowed = false;
  let publishable = new Set<string>();
  let gateReason: CrewAbortNoticeReason | null = null;
  if (userBasis) {
    const gate = discloseSharingGate(await evaluateSharingGate(db, { userId, tripId: input.tripId ?? null }));
    if (gate.degraded) gateReason = "sharing_preferences_unreadable";
    else if (!gate.allowed) gateReason = "sharing_not_allowed";
    else travellerAllowed = true;
    if (travellerAllowed) {
      const sharing = await publishableUserIds(db, otherIds);
      if (sharing.kind === "degraded") { gateReason = "sharing_preferences_unreadable"; travellerAllowed = false; }
      else publishable = new Set(sharing.value.allowed);
    }
  }

  const recipients: Array<{ m: CrewMemberRow; basis: CrewAbortAuthorizationBasis }> = [];
  for (const m of others) {
    const a = crewAbortNoticeAuthorization({
      flagEnabled: request.enabled,
      requested: request.requested,
      travellerSharingAllowed: travellerAllowed,
      liveCrewShare: liveShare,
      recipient: { blocked: blocked.ids.has(m.userId), publishable: publishable.has(m.userId), emergencyContact: emergency.has(m.userId) },
    });
    if (a.allowed) recipients.push({ m, basis: a.basis });
  }
  if (recipients.length === 0) return told(gateReason ?? (userBasis ? "no_crewmate_to_tell" : "not_requested"));

  const actor = await senderLabel(db, userId);
  const sourceId = crewAbortNoticeSourceId(mine.value.crew.id, sessionId);
  const prior = await priorNotices(db, recipients.map((r) => r.m.userId), sourceId);
  if (input.cancelled?.()) return told("notify_timed_out");
  const service = new NotificationService(db);
  const crewId = mine.value.crew.id;
  const results = await Promise.all(recipients.map(async ({ m, basis }): Promise<CrewAbortAuthorizationBasis | null> => {
    const { row, refusal } = await service.createDetailed({
      userId: m.userId,
      eventType: CREW_ABORT_NOTICE_EVENT_TYPE,
      params: { actor },
      actionUrl: `/layover/${m.sessionId}`,
      sourceType: CREW_ABORT_NOTICE_SOURCE_TYPE,
      sourceId,
    }).catch((err: unknown) => { logger.warn({ err, crewId }, "crew abort notice: create threw"); return { row: null, refusal: "threw" as const }; });
    if (row) {
      void new NotificationRouter(db).route(row).catch((err) => { logger.warn({ err, crewId }, "crew abort notice: routing failed (the row exists)"); });
      return basis;
    }
    return refusal === "duplicate" && prior !== null && prior.has(m.userId) ? basis : null;
  }));
  const bases: CrewAbortNoticeAuthorizedOutcome["bases"] = {};
  for (const b of results) if (b) bases[b] = (bases[b] ?? 0) + 1;
  const n = results.filter(Boolean).length;
  if (n === results.length) return told(null, n, bases);
  return told(n === 0 ? "notify_failed" : "notify_partially_failed", n, bases);
}
import { evaluateCrewLocationShare } from "../airport/LayoverCrewService.js"; // census-layover L144 (lane B2-CREW): appended at the tail so no cited line above moves; ESM hoists it

import { crewShareSignalsFor, type CrewGrantRow } from "./LayoverCrewLocation.js";
import { readSharerSessions } from "./LayoverCrewLocationStore.js";
import { landsideSuppressionFor } from "./LayoverCheckpointStore.js";

/** Standing authorization ends at the same boundaries as the live location card, even before its next purge. */
async function abortCrewShareSignals(
  db: SupabaseClient,
  input: { userId: string; sessionId: string; crew: { id: string; status: string; expiresAt: string }; nowMs: number },
  row: Record<string, any>,
) {
  const sessions = await readSharerSessions(db, [input.sessionId]);
  const suppression = await landsideSuppressionFor(db, input.sessionId, input.nowMs);
  const reentryAtMs = suppression.state === "unknown" ? input.nowMs : suppression.state === "suppressed" ? Date.parse(suppression.reportedAt) : null;
  const grant: CrewGrantRow = {
    crewId: row.crew_id, userId: row.user_id, sessionId: row.session_id, purpose: row.purpose,
    precision: row.precision, label: row.label, lat: row.lat, lng: row.lng, grantedAt: row.granted_at, expiresAt: row.expires_at,
  };
  return crewShareSignalsFor({
    grant, crew: input.crew, membershipLive: true, nowMs: input.nowMs,
    sharerSession: sessions.ok ? sessions.value.get(input.sessionId) ?? null : null,
    reentryAtMs: reentryAtMs !== null && !Number.isFinite(reentryAtMs) ? input.nowMs : reentryAtMs,
  });
}
