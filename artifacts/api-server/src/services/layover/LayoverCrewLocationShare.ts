/**
 * LayoverCrewLocationShare — WHETHER a crew location grant is in force, and WHO
 * may see a crewmate's precise location. census-layover L166 / L203 (B58 lane
 * LAY-C1). The rows are `LayoverCrewLocationGrantStore`'s (migration 3787); the
 * ladder is `services/airport/LayoverCrewService.ts`'s, called and not copied.
 *
 * ── TWO QUESTIONS, ONE SET OF FACTS ──────────────────────────────────────────
 *   `crewOwnLocationShare`        — is the VIEWER's own share in force? This is
 *                                   `yourShare` on GET /crew, and the only thing
 *                                   this lane publishes. The ladder cannot answer
 *                                   it: `locationPrecisionFor` short-circuits to
 *                                   `precise`/`self` for the viewer.
 *   `preciseCrewLocationVisible`  — may THIS viewer see THAT crewmate's precise
 *                                   location? Owner question OQ-1 at its
 *                                   fail-closed default (below). Nothing publishes
 *                                   a crewmate's rung in this lane: there is no
 *                                   position to attach it to, and #569's
 *                                   `locationRungs` printed EVERY member's user
 *                                   id, which would undo census-layover §48's
 *                                   identity gate on the crew card. The position
 *                                   read (LAY-C2) is this function's consumer.
 * Both go through `memberShareState`, so "I stopped sharing" and "my crew can no
 * longer see me" cannot disagree.
 *
 * ── THE FAIL-CLOSED DEFAULTS IMPLEMENTED (owner questions, NOT approved) ─────
 * OQ-1 (audience): precise only to a CURRENT member of the SAME crew, no block
 *   in either direction (an unreadable or thrown block read = NOT shared), a
 *   live grant FROM THE TARGET, AND a mutual follow (lead ruling D-103's shape:
 *   viewer follows target AND target follows viewer; an unread edge is no edge).
 *   Never to a non-member.
 * OQ-2 (duration): no ceiling is invented. A grant is bounded at write by the
 *   crew's life and the granter's certified hard return, and ENDS at the
 *   earliest §14.1 terminator, evaluated now:
 *     crew dissolved   — the crew is not `open` (ENDED NOW: the instant is not
 *                        stored reliably, and #569's `updated_at` derivation
 *                        erred late);
 *     airport re-entry — the granter's AIRPORT_REENTRY checkpoint observed at or
 *                        after the grant (2992's `layover_checkpoints`). An
 *                        UNREADABLE or ABSENT checkpoint store means the share
 *                        is NOT active (`reentry_unverifiable`): the terminator
 *                        cannot be shown not to have happened. So the feature is
 *                        inert until 2992 is applied and its persistence flag is
 *                        on, whatever this lane's flag says;
 *     boarding         — the session's scheduled boarding time;
 *     session expired  — the session is not live (ENDED NOW);
 *     user revoked     — `revoked_at`;
 *     the grant's TTL  — `expires_at`;
 *   and, beyond the ladder, the granter's CURRENT certified hard return: a
 *   departure edited earlier after the grant must not leave a share running
 *   past the new deadline (`hard_return_passed`; uncertified = `uncertified`).
 * Never auto-restarted: a grant made before the granter's CURRENT membership
 *   began is not in force (`granted_before_membership`), so a rejoin or a
 *   restored membership needs a new explicit grant (OD-1012-APPEAL-5 by
 *   analogy), and leaving/disbanding revokes (`LayoverCrewStore.leaveCrew`).
 * The sharing gate: a traveller whose sharing is paused, whose location mode is
 *   off or who is in the trip's ghost mode — or whose settings cannot be read —
 *   is not sharing, whatever grant exists (`sharing_gate_closed`).
 * The flag: `layover_crew_location_sharing_enabled` OFF (its seed) or absent ⇒
 *   `feature_off`: nothing is read, nothing is reported active, no audience.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { isFlagEnabled } from "../../lib/featureFlags.js";
import { readBlockExclusions } from "../../lib/exclusionSet.js";
import {
  evaluateCrewLocationShare,
  locationPrecisionFor,
  type CrewMember,
  type CrewShareEndReason,
  type CrewShareSignals,
} from "../airport/LayoverCrewService.js";
import { LAYOVER_LIVE_SESSION_STATUSES } from "../airport/LayoverSessionService.js";
import { evaluateSharingGate } from "../airport/LayoverPrivacyGuard.js";
import { readTravellerCheckpoints, type CheckpointRead } from "./LayoverCheckpointStore.js";
import {
  grantUnreadable,
  instantMs,
  newestGrantsForCrew,
  type MemberGrant,
} from "./LayoverCrewLocationGrantStore.js";

const logger = rootLogger.child({ service: "LayoverCrewLocationShare" });

/** The flag, spelled once for tests; every READ spells the literal (check:flag-polarity). */
export const CREW_LOCATION_SHARING_FLAG = "layover_crew_location_sharing_enabled";

/** Read the flag. OFF on any error (`isFlagEnabled` fails closed). */
export async function crewLocationSharingEnabled(db: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(db, "layover_crew_location_sharing_enabled");
}

/** Why a share is, or is not, in force. Open-ended on the wire; closed here. */
export type ShareReason =
  | "live_scoped_grant"
  | `no_live_grant:${CrewShareEndReason}`
  | "grant_unreadable"
  | "not_a_member"
  | "membership_unreadable"
  | "granted_before_membership"
  | "session_not_in_crew"
  | "session_unreadable"
  | "reentry_unverifiable"
  | "uncertified"
  | "hard_return_passed"
  | "sharing_gate_closed";

/** Everything `memberShareState` needs, read by the caller. Pure in, pure out. */
export interface MemberShareFacts {
  /** The member's NEWEST grant for this crew (revoked or not), or null. */
  held: MemberGrant | null;
  crew: { id: string; status: string };
  /** Their LIVE membership of this crew, or null when they are not a member. */
  membership: { sessionId: string; joinedAt?: string | null } | null;
  /** The session the grant was made from (status, boarding), or null if unreadable. */
  session: { id: string; status: string; boardingTime: string | null } | null;
  /** Their CURRENT certified hard return, or null when uncertified. */
  hardReturnMs: number | null;
  /** The first AIRPORT_REENTRY at/after the grant, or `ok: false` when unverifiable. */
  reentry: { ok: true; atMs: number | null } | { ok: false };
  /** `evaluateSharingGate(...).allowed && !degraded`. */
  sharingAllowed: boolean;
}

/** §14.1's terminators for one member, as `evaluateCrewLocationShare` takes them. */
export function shareSignalsFor(f: MemberShareFacts, nowMs: number): CrewShareSignals {
  const signals: CrewShareSignals = {};
  // Not `open` = dissolved, and ENDED NOW: the dissolution instant is not
  // stored reliably, and an earlier guess could only ever err in the unsafe
  // (later) direction. `closed` has no writer today; it is read as ended.
  if (f.crew.status !== "open") signals.crewDissolvedAtMs = nowMs;
  if (f.session) {
    if (!(LAYOVER_LIVE_SESSION_STATUSES as readonly string[]).includes(f.session.status)) signals.sessionExpiredAtMs = nowMs;
    const boarding = instantMs(f.session.boardingTime);
    if (boarding !== null) signals.boardingAtMs = boarding;
  }
  if (f.reentry.ok && f.reentry.atMs !== null) signals.airportReentryAtMs = f.reentry.atMs;
  if (f.held && f.held.revokedAtMs !== null) signals.revokedAtMs = f.held.revokedAtMs;
  return signals;
}

/**
 * Is this member's share in force, and why (not)? The ladder's own terminators
 * first — so a share that ran out reports what ended it, not a later structural
 * reason — then every fail-closed condition above. `endsAtMs` is the earliest
 * KNOWN future end while active (TTL, boarding, hard return), else null.
 */
export function memberShareState(
  f: MemberShareFacts,
  nowMs: number,
): { active: boolean; reason: ShareReason; endsAtMs: number | null } {
  const ended = (reason: ShareReason) => ({ active: false, reason, endsAtMs: null });
  if (!f.held || f.held.grant.crewId !== f.crew.id) return ended("no_live_grant:never_granted");
  if (grantUnreadable(f.held)) return ended("grant_unreadable");

  const signals = shareSignalsFor(f, nowMs);
  const verdict = evaluateCrewLocationShare(f.held.grant, signals, nowMs);
  if (!verdict.active) return ended(`no_live_grant:${verdict.endedBy ?? "never_granted"}`);

  if (!f.membership) return ended("not_a_member");
  if (f.membership.sessionId !== f.held.sessionId) return ended("session_not_in_crew");
  const joinedMs = instantMs(f.membership.joinedAt ?? null);
  if (joinedMs === null) return ended("membership_unreadable");
  if (f.held.grant.grantedAtMs < joinedMs) return ended("granted_before_membership");
  if (!f.session) return ended("session_unreadable");
  if (!f.reentry.ok) return ended("reentry_unverifiable");
  if (f.hardReturnMs === null || !Number.isFinite(f.hardReturnMs)) return ended("uncertified");
  if (f.hardReturnMs <= nowMs) return ended("hard_return_passed");
  if (!f.sharingAllowed) return ended("sharing_gate_closed");

  const ends = [f.held.grant.expiresAtMs, f.hardReturnMs, signals.boardingAtMs]
    .filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > nowMs);
  return { active: true, reason: "live_scoped_grant", endsAtMs: ends.length > 0 ? Math.min(...ends) : null };
}

/**
 * The first AIRPORT_REENTRY observed at or after the grant. A re-entry from
 * BEFORE the grant ended an earlier outing, not this share. `persistence_disabled`
 * (2992 not applied / its flag off) and `read_failed` are both UNVERIFIABLE.
 */
export function reentryAfter(read: CheckpointRead, grantedAtMs: number): { ok: true; atMs: number | null } | { ok: false } {
  if (!read.ok) return { ok: false };
  let first: number | null = null;
  for (const c of read.checkpoints) {
    if (c.type !== "AIRPORT_REENTRY") continue;
    const at = instantMs(c.observedAt);
    if (at === null) return { ok: false }; // an unreadable observation cannot be shown not to be the re-entry
    if (at < grantedAtMs) continue;
    if (first === null || at < first) first = at;
  }
  return { ok: true, atMs: first };
}

type CrewInput = { id: string; status: string };
type MemberInput = { userId: string; sessionId: string; joinedAt?: string | null };
type SessionInput = { id: string; status: string; boardingTime: string | null; tripId?: string | null };

/** The facts for ONE member, read only as far as they can matter. */
async function readMemberFacts(
  db: SupabaseClient,
  input: {
    userId: string;
    crew: CrewInput;
    members: ReadonlyArray<MemberInput>;
    solved: ReadonlyArray<CrewMember>;
    sessionsById: ReadonlyMap<string, SessionInput>;
    held: MemberGrant | null;
    nowMs: number;
  },
): Promise<MemberShareFacts> {
  const membership = input.members.find((m) => m.userId === input.userId) ?? null;
  const base: MemberShareFacts = {
    held: input.held,
    crew: input.crew,
    membership: membership ? { sessionId: membership.sessionId, joinedAt: membership.joinedAt ?? null } : null,
    session: null,
    hardReturnMs: null,
    reentry: { ok: false },
    sharingAllowed: false,
  };
  // No grant, or an unreadable one: nothing else can make it live, so read nothing else.
  if (!input.held || grantUnreadable(input.held)) return base;

  const s = input.sessionsById.get(input.held.sessionId) ?? null;
  base.session = s ? { id: s.id, status: s.status, boardingTime: s.boardingTime ?? null } : null;
  const record = input.solved.find((m) => m.userId === input.userId && m.sessionId === input.held!.sessionId)?.record ?? null;
  const hard = record ? record.deadline.hardReturnTime.getTime() : null;
  base.hardReturnMs = hard !== null && Number.isFinite(hard) ? hard : null;

  // If the ladder has already ended it, the slower reads cannot revive it.
  if (!evaluateCrewLocationShare(input.held.grant, shareSignalsFor(base, input.nowMs), input.nowMs).active) return base;

  try {
    base.reentry = reentryAfter(await readTravellerCheckpoints(db, input.held.sessionId, input.nowMs), input.held.grant.grantedAtMs);
  } catch (err) {
    logger.warn({ err }, "crew location share: checkpoint read threw — re-entry unverifiable, share not active");
    base.reentry = { ok: false };
  }
  try {
    const gate = await evaluateSharingGate(db, { userId: input.userId, tripId: s?.tripId ?? null });
    base.sharingAllowed = gate.allowed && !gate.degraded;
  } catch (err) {
    logger.warn({ err }, "crew location share: sharing gate threw — not sharing");
    base.sharingAllowed = false;
  }
  return base;
}

/** `yourShare` on the crew payload. */
export type OwnShareWire =
  | { available: false; live: false; reason: "feature_off"; expiresAt: null }
  | { available: true; live: boolean; reason: ShareReason; expiresAt: string | null };

/**
 * Whether the VIEWER is sharing their precise location with their crew.
 *
 * `yourShare: null` means UNKNOWN — the grant table could not be read — and
 * always travels with `location_grants_unreadable` in `degradedReasons`. It is
 * never "not sharing". With the flag OFF nothing is read and the answer is
 * `available: false`: the control is not offered.
 */
export async function crewOwnLocationShare(
  db: SupabaseClient,
  input: {
    viewerId: string;
    crew: CrewInput;
    members: ReadonlyArray<MemberInput>;
    solved: ReadonlyArray<CrewMember>;
    sessionsById: ReadonlyMap<string, SessionInput>;
    nowMs: number;
  },
): Promise<{ yourShare: OwnShareWire | null; degradedReasons: string[] }> {
  if (!(await isFlagEnabled(db, "layover_crew_location_sharing_enabled"))) {
    return { yourShare: { available: false, live: false, reason: "feature_off", expiresAt: null }, degradedReasons: [] };
  }
  const grants = await newestGrantsForCrew(db, input.crew.id);
  if (!grants.ok) return { yourShare: null, degradedReasons: ["location_grants_unreadable"] };

  const facts = await readMemberFacts(db, { ...input, userId: input.viewerId, held: grants.value.get(input.viewerId) ?? null });
  const state = memberShareState(facts, input.nowMs);
  return {
    yourShare: {
      available: true,
      live: state.active,
      reason: state.reason,
      // Only while live: a past expiry on a dead grant reads as a countdown that has already run out.
      expiresAt: state.active && state.endsAtMs !== null ? new Date(state.endsAtMs).toISOString() : null,
    },
    degradedReasons: [],
  };
}

export type AudienceReason =
  | "live_scoped_grant"
  | "self"
  | "feature_off"
  | "not_in_a_crew_together"
  | "blocked"
  | "blocks_unreadable"
  | "not_mutual"
  | "follows_unreadable"
  | "location_grants_unreadable"
  | ShareReason
  | string;

/** D-103's mutual follow from the two RAW edges. An unread edge is no edge; any failure is `null`. */
async function mutualFollow(db: SupabaseClient, viewerId: string, targetId: string): Promise<boolean | null> {
  try {
    const [vt, tv] = await Promise.all([
      db.from("user_follows").select("follower_id").eq("follower_id", viewerId).eq("following_id", targetId).limit(1),
      db.from("user_follows").select("follower_id").eq("follower_id", targetId).eq("following_id", viewerId).limit(1),
    ]);
    if (vt.error || tv.error) return null;
    if (!Array.isArray(vt.data) || !Array.isArray(tv.data)) return null;
    return vt.data.length > 0 && tv.data.length > 0;
  } catch {
    return null;
  }
}

/**
 * OQ-1 at its fail-closed default: may `viewerId` see `targetId`'s PRECISE
 * location? Every gate must pass; every unreadable input is a NO.
 *
 * The final answer is `locationPrecisionFor`'s, so the ladder's own guarantee —
 * no argument combination yields `precise` without a live, target-issued,
 * crew-scoped grant — is the last word here as well as the first.
 */
export async function preciseCrewLocationVisible(
  db: SupabaseClient,
  input: {
    viewerId: string;
    targetId: string;
    crew: CrewInput;
    members: ReadonlyArray<MemberInput>;
    solved: ReadonlyArray<CrewMember>;
    sessionsById: ReadonlyMap<string, SessionInput>;
    nowMs: number;
  },
): Promise<{ visible: boolean; reason: AudienceReason }> {
  const no = (reason: AudienceReason) => ({ visible: false, reason });
  if (!(await isFlagEnabled(db, "layover_crew_location_sharing_enabled"))) return no("feature_off");
  if (input.viewerId === input.targetId) return { visible: true, reason: "self" };

  // Both CURRENT members of THIS crew, and the crew itself still open. Never to a non-member.
  const isMember = (id: string) => input.members.some((m) => m.userId === id);
  if (input.crew.status !== "open" || !isMember(input.viewerId) || !isMember(input.targetId)) {
    return no("not_in_a_crew_together");
  }

  // No block in EITHER direction. A failed or THROWN read is not "nobody is blocked".
  let blocked: boolean;
  try {
    const set = await readBlockExclusions(db, input.viewerId, { among: [input.targetId] });
    if (!set.ok) return no("blocks_unreadable");
    blocked = set.ids.has(input.targetId);
  } catch (err) {
    logger.warn({ err }, "crew location audience: block read threw — not shared");
    return no("blocks_unreadable");
  }
  if (blocked) return no("blocked");

  const mutual = await mutualFollow(db, input.viewerId, input.targetId);
  if (mutual === null) return no("follows_unreadable");
  if (!mutual) return no("not_mutual");

  const grants = await newestGrantsForCrew(db, input.crew.id);
  if (!grants.ok) return no("location_grants_unreadable");
  const held = grants.value.get(input.targetId) ?? null;
  const facts = await readMemberFacts(db, { ...input, userId: input.targetId, held });
  const state = memberShareState(facts, input.nowMs);
  if (!state.active) return no(state.reason);

  const ladder = locationPrecisionFor({
    viewerUserId: input.viewerId,
    targetUserId: input.targetId,
    sameCrewId: input.crew.id,
    blocked: false, // read above, both directions, fail-closed
    grant: held!.grant,
    signals: shareSignalsFor(facts, input.nowMs),
    nowMs: input.nowMs,
  });
  if (ladder.precision !== "precise") return no(ladder.reason);
  return { visible: true, reason: "live_scoped_grant" };
}
