/**
 * memoryParticipantVisibility — §10's person visibility ladder and §23's
 * `canSeeParticipant`, applied to the MEMORY participant surface.
 *
 * Highlights/Memories Development Architecture Spec v1 §10:
 *   Person visibility ladder
 *     NAMED -> PROFILE_LINKED -> CREW_ONLY -> ANONYMOUS_COUNT -> HIDDEN
 *   "Being tagged or referenced does not make another user a co-owner."
 *   "Blocking and account deletion must suppress future social resurfacing and
 *    unlink profile identity as policy requires."
 * §5: a participant is added to a Memory "only after participant consent".
 * §23: `canSeeParticipant(userId, memoryId, participantId)`.
 *
 * Census ids: H77 (the five-rung ladder on a Memory surface) and H209 (the
 * named predicate). Both were BUILT-BUT-WRONG on the ground that the ladder
 * existed only as a Highlights-side artifact keyed to a stored policy rung, and
 * that `memory_tags` rows "are returned to any permitted viewer".
 *
 * ── WHAT WAS ACTUALLY WRONG, MEASURED ───────────────────────────────────────
 * `GET /memories/:id` and `GET /memories/:id/tags` returned EVERY `memory_tags`
 * row — `tagged_user_id` and all — to every viewer permitted to read the
 * Memory, with no filter on `status`. So:
 *
 *   • a person who had been tagged and had NOT yet consented (`pending`) was
 *     profile-linked, by user id, to every viewer of that Memory; and
 *   • a person who had REMOVED their own tag — the one action the product gives
 *     them for saying "take me out of this" — was still shipped by user id to
 *     every viewer, because `PATCH /memories/:id/tags/:userId` writes
 *     `status: "removed"` and the read filtered nothing.
 *
 * Neither is a rung of the ladder. Both are the absence of one.
 *
 * ── THE RUNG IS DERIVED, NOT STORED, AND THAT IS DELIBERATE ─────────────────
 * The Highlights surface reads its rung out of `highlight_projection_policies`
 * (migration 2721, NOT applied), which is why every §10 row that depends on a
 * STORED rung is capped by storage nobody has deployed. This surface takes
 * nothing from 2721. Every input below is on the deployed schema today:
 *
 *   `memory_tags.status`            — the participant's own consent
 *   `memories.visibility`           — the audience the OWNER chose
 *   `memories.trip_id` + `trip_members` — who the crew is
 *   `blocks`                        — both directions
 *   `profile_privacy_settings.show_real_name` — NAMED vs PROFILE_LINKED
 *
 * The cost of that choice is stated rather than hidden: a participant cannot
 * pick their own rung here, because there is no column to pick it in. What they
 * can do is withhold or withdraw consent, and that is honoured. An owner-chosen
 * per-participant rung is 2721 and is NOT claimed by this file.
 *
 * ── ONE LADDER IN THE REPOSITORY ────────────────────────────────────────────
 * `PERSON_VISIBILITY_LADDER` and `discloseParticipant` are imported from
 * services/highlights/highlightProjectionPolicy.ts rather than re-declared.
 * Two transcriptions of a five-rung privacy ladder drift, and the drift is
 * silent: nothing fails when one file gains a rung the other does not have.
 *
 * PURE except `loadParticipantVisibility` and `canSeeParticipant`, which are the
 * only functions that touch a database.
 */
import {
  discloseParticipant,
  personVisibilityRank,
  type PersonDisclosure,
  type PersonRef,
  type PersonVisibilityRung,
} from "../highlights/highlightProjectionPolicy.js";
import { acceptedCrewOfTrip, isBlocked } from "./memoryReadPolicy.js";
import { nameVisibilitySet } from "../../lib/publicIdentity.js";

export type { PersonVisibilityRung, PersonDisclosure };

/**
 * The participant's own consent state, read off `memory_tags.status`.
 *
 * THREE-VALUED PLUS UNKNOWN, never a boolean, for the same reason
 * `highlightProjectionPolicy.consentFromRow` is: `status !== "approved"`
 * collapses "has not answered yet" and "answered no" into one thing, and they
 * earn different rungs. A value that is not one of the three the write path
 * produces is `unknown` and is refused.
 */
export type ParticipantConsent = "approved" | "pending" | "withdrawn" | "unknown";

/**
 * `POST /memories` inserts tags with `status: "pending"`;
 * `PATCH /memories/:id/tags/:userId` writes `"approved"` or `"removed"`.
 * Those three are the whole live vocabulary; `declined` / `rejected` are
 * accepted as synonyms of withdrawal so that a future write path spelling it
 * either way cannot silently fall through to `unknown` and be counted.
 */
export function consentFromTagStatus(status: unknown): ParticipantConsent {
  if (typeof status !== "string") return "unknown";
  switch (status.toLowerCase()) {
    case "approved": return "approved";
    case "pending": return "pending";
    case "removed":
    case "declined":
    case "rejected": return "withdrawn";
    default: return "unknown";
  }
}

/** Every fact the rung decision needs, and nothing else. */
export interface ParticipantFacts {
  /** Owner of the Memory the tag is on. */
  readonly memoryOwnerId: string;
  /** `memories.visibility` — the audience the owner chose. */
  readonly memoryVisibility: string | null | undefined;
  /** The user asking. */
  readonly viewerId: string;
  /** The user who was tagged. */
  readonly participantId: string;
  /** `memory_tags.status` for this pair, or null when there is no tag row. */
  readonly tagStatus: unknown;
  /** Viewer is accepted crew of the Memory's trip (owner counts as crew). */
  readonly viewerIsCrew: boolean;
  /** A block exists between viewer and participant, in either direction. */
  readonly viewerBlocked: boolean;
  /** The participant has opted in to `show_real_name`. */
  readonly participantNameAllowed: boolean;
}

/**
 * §23 `canSeeParticipant`, as a pure decision.
 *
 * THE ORDER OF THESE BRANCHES IS THE POLICY. It is written as a single fixed
 * sequence, with the hardest rule first, so that two readings of the same facts
 * cannot produce two answers:
 *
 *  1. BLOCK → HIDDEN. §10: blocking must "unlink profile identity". It outranks
 *     everything below, including the participant's own approval and the
 *     viewer's ownership of the Memory: an owner who has blocked, or been
 *     blocked by, the person they tagged does not get their identity back by
 *     owning the row the tag sits on.
 *  2. The participant themself → NAMED. You are never anonymised to yourself,
 *     and a person must be able to see the tag they are being asked to approve.
 *  3. No tag row at all → HIDDEN. Absence is not a rung; there is nobody to
 *     disclose and nothing to count.
 *  4. An unrecognised `status` → HIDDEN. FAIL CLOSED. A status this code cannot
 *     parse is not consent, and it is not a count either.
 *  5. WITHDRAWN → HIDDEN, not ANONYMOUS_COUNT. This is the branch most likely
 *     to be argued with, so: a person who removed their tag asked to be taken
 *     out. "Somebody else was there, we won't say who" is still a disclosure
 *     about them on a Memory they have left, and the product's only exit door
 *     has to actually lead outside. The OWNER's own view is not affected —
 *     branch 6 is above this one only for the owner, deliberately, so that the
 *     owner can still see and re-manage the row they wrote.
 *  6. The Memory's OWNER → PROFILE_LINKED, or NAMED when the participant has
 *     opted in. The owner chose this participant; hiding them from the owner
 *     would break tag management without protecting anyone, since the owner
 *     typed the id. Never more than PROFILE_LINKED on the name axis: owning a
 *     Memory does not grant the name of someone who has not published it.
 *  7. PENDING → ANONYMOUS_COUNT. §5 admits a participant "only after
 *     participant consent", so before consent a third party learns that a
 *     person was present and nothing that identifies them. This is the rung
 *     that used to be a bare `tagged_user_id`.
 *  8. A crew-scoped Memory → CREW_ONLY. The owner narrowed the audience to the
 *     trip; the participant list narrows with it. `discloseParticipant` turns
 *     CREW_ONLY into HIDDEN for a viewer who is not crew, which is why this
 *     returns the rung rather than a boolean.
 *  9. Otherwise → NAMED when the participant has opted in to their real name,
 *     else PROFILE_LINKED. This is `lib/publicIdentity.ts`'s universal rule,
 *     which is the pair of rungs this surface already had.
 */
export function participantRungFor(facts: ParticipantFacts): PersonVisibilityRung {
  const consent = consentFromTagStatus(facts.tagStatus);
  const named = facts.participantNameAllowed ? "NAMED" : "PROFILE_LINKED";

  if (facts.viewerBlocked) return "HIDDEN";                                    // 1
  if (facts.viewerId === facts.participantId) return "NAMED";                  // 2
  if (facts.tagStatus == null) return "HIDDEN";                                // 3
  if (consent === "unknown") return "HIDDEN";                                  // 4
  if (facts.viewerId === facts.memoryOwnerId) {                                // 6 (before 5, for the owner only)
    return consent === "withdrawn" ? "HIDDEN" : named;
  }
  if (consent === "withdrawn") return "HIDDEN";                                // 5
  if (consent === "pending") return "ANONYMOUS_COUNT";                         // 7
  if (facts.memoryVisibility === "trip_crew") return "CREW_ONLY";              // 8
  return named;                                                                // 9
}

/**
 * The rung AND the resulting disclosure for one participant, in one call.
 *
 * `discloseParticipant` is the ladder's own renderer — it is what drops the
 * user id at ANONYMOUS_COUNT and collapses CREW_ONLY to HIDDEN for a
 * non-crew viewer. Calling it here rather than in the routes means a route
 * cannot accidentally ship a rung's name beside data that rung forbids.
 */
export function discloseMemoryParticipant(
  person: PersonRef,
  facts: ParticipantFacts,
): { readonly rung: PersonVisibilityRung; readonly disclosure: PersonDisclosure } {
  const rung = participantRungFor(facts);
  return { rung, disclosure: discloseParticipant(person, rung, { viewerIsCrew: facts.viewerIsCrew }) };
}

/** The per-Memory context a batch of participant decisions shares. */
export interface ParticipantVisibilityContext {
  readonly memoryOwnerId: string;
  readonly memoryVisibility: string | null | undefined;
  readonly viewerId: string;
  readonly viewerIsCrew: boolean;
  /** Participant ids blocked in either direction. */
  readonly blockedIds: ReadonlySet<string>;
  /** Participant ids that have opted in to `show_real_name`. */
  readonly nameAllowedIds: ReadonlySet<string>;
}

/**
 * Load the shared context for every participant of ONE Memory, in a fixed
 * number of queries regardless of how many people are tagged.
 *
 * FAIL CLOSED IN BOTH DIRECTIONS, and they are different directions:
 *   • an unreadable `blocks` read treats EVERY participant as blocked, so the
 *     whole list collapses to HIDDEN rather than being served unfiltered. That
 *     is the same stance `loadBlockedIds` takes on the feed.
 *   • an unreadable `trip_members` read treats the viewer as NOT crew, so a
 *     crew-scoped participant list discloses nobody.
 *   • `nameVisibilitySet` already fails closed to an empty set, which lands on
 *     PROFILE_LINKED rather than NAMED.
 * None of the three can turn a refusal into a disclosure.
 */
export async function loadParticipantVisibility(
  sc: any,
  memory: { readonly owner_id: string; readonly visibility?: string | null; readonly trip_id?: string | null },
  viewerId: string,
  participantIds: readonly string[],
): Promise<ParticipantVisibilityContext> {
  const ids = [...new Set(participantIds.filter((x) => typeof x === "string" && x.length > 0))];

  const blockedIds = new Set<string>();
  await Promise.all(
    ids.map(async (pid) => {
      // isBlocked is itself fail-closed: a failed lookup answers "blocked".
      if (await isBlocked(sc, viewerId, pid)) blockedIds.add(pid);
    }),
  );

  let viewerIsCrew = false;
  if (memory.trip_id) {
    const crew = await acceptedCrewOfTrip(sc, memory.trip_id);
    viewerIsCrew = crew.ok ? crew.ids.has(viewerId) : false;
  }

  const nameAllowedIds = await nameVisibilitySet(sc, ids);

  return {
    memoryOwnerId: memory.owner_id,
    memoryVisibility: memory.visibility ?? null,
    viewerId,
    viewerIsCrew,
    blockedIds,
    nameAllowedIds,
  };
}

/** Assemble the per-participant facts from a shared context and one tag row. */
export function factsFor(
  ctx: ParticipantVisibilityContext,
  participantId: string,
  tagStatus: unknown,
): ParticipantFacts {
  return {
    memoryOwnerId: ctx.memoryOwnerId,
    memoryVisibility: ctx.memoryVisibility,
    viewerId: ctx.viewerId,
    participantId,
    tagStatus,
    viewerIsCrew: ctx.viewerIsCrew,
    viewerBlocked: ctx.blockedIds.has(participantId),
    participantNameAllowed: ctx.nameAllowedIds.has(participantId),
  };
}

/** What a route serves for one Memory's participant list. */
export interface ParticipantListProjection {
  /** The participants this viewer may see, at the rung they may see them. */
  readonly participants: ReadonlyArray<{
    readonly userId: string;
    readonly status: string | null;
    readonly createdAt?: string | null;
    readonly rung: PersonVisibilityRung;
    readonly name: string | null;
    readonly handle: string | null;
  }>;
  /**
   * How many further people the Memory names that this viewer may know about
   * but not identify. ANONYMOUS_COUNT is a COUNT; it is the only rung that
   * survives as a number instead of a row.
   */
  readonly anonymousCount: number;
  /** The strictest rung applied to anyone on this list, for logs. */
  readonly strictestApplied: PersonVisibilityRung | null;
}

/**
 * The whole participant list for one viewer.
 *
 * HIDDEN participants are dropped and NOT counted. That asymmetry with
 * ANONYMOUS_COUNT is the point of having two rungs: a pending participant is
 * "someone, unidentified"; a withdrawn or blocked one is nobody at all, and
 * folding them into the count would leak the fact of their withdrawal as an
 * arithmetic difference.
 */
export function projectParticipants(
  ctx: ParticipantVisibilityContext,
  tags: ReadonlyArray<{ readonly tagged_user_id: string; readonly status?: unknown; readonly created_at?: string | null }>,
  profilesById: ReadonlyMap<string, { readonly name?: string | null; readonly handle?: string | null }> = new Map(),
): ParticipantListProjection {
  const participants: Array<{
    userId: string; status: string | null; createdAt?: string | null;
    rung: PersonVisibilityRung; name: string | null; handle: string | null;
  }> = [];
  let anonymousCount = 0;
  let strictest: PersonVisibilityRung | null = null;

  for (const t of tags) {
    const pid = String(t.tagged_user_id ?? "");
    if (!pid) continue;
    const profile = profilesById.get(pid);
    const facts = factsFor(ctx, pid, t.status ?? null);
    const { rung, disclosure } = discloseMemoryParticipant(
      { userId: pid, handle: profile?.handle ?? null, name: profile?.name ?? null },
      facts,
    );
    if (strictest === null || personVisibilityRank(rung) > personVisibilityRank(strictest)) strictest = rung;

    if (disclosure.rung === "HIDDEN") continue;
    if (disclosure.rung === "ANONYMOUS_COUNT") { anonymousCount += 1; continue; }
    participants.push({
      userId: disclosure.userId,
      status: typeof t.status === "string" ? t.status : null,
      ...(t.created_at !== undefined ? { createdAt: t.created_at ?? null } : {}),
      rung: disclosure.rung,
      name: disclosure.name,
      handle: disclosure.handle,
    });
  }

  return { participants, anonymousCount, strictestApplied: strictest };
}

/**
 * §23's predicate, with the spec's own signature:
 * `canSeeParticipant(userId, memoryId, participantId)`.
 *
 * Returns the RUNG rather than a boolean, because §10's answer to "may this
 * viewer see this participant" is not yes/no — it is one of five, and three of
 * the five are partial. A caller that wants the boolean asks for
 * `rung !== "HIDDEN"`, and asks it in one place.
 *
 * Reads the Memory itself: the predicate's contract is (userId, memoryId,
 * participantId), so it must not depend on the caller having already loaded the
 * row correctly. A Memory that cannot be read is HIDDEN — an unreadable subject
 * is not permission.
 */
export async function canSeeParticipant(
  sc: any,
  viewerId: string,
  memoryId: string,
  participantId: string,
): Promise<PersonVisibilityRung> {
  let memory: { owner_id: string; visibility?: string | null; trip_id?: string | null } | null = null;
  try {
    const { data, error } = await sc
      .from("memories")
      .select("id, owner_id, visibility, trip_id, state")
      .eq("id", memoryId)
      .neq("state", "deleted")
      .maybeSingle();
    if (error) return "HIDDEN";
    memory = (data as any) ?? null;
  } catch {
    return "HIDDEN";
  }
  if (!memory) return "HIDDEN";

  let tagStatus: unknown = null;
  try {
    const { data, error } = await sc
      .from("memory_tags")
      .select("tagged_user_id, status")
      .eq("memory_id", memoryId)
      .eq("tagged_user_id", participantId)
      .maybeSingle();
    // An unreadable memory_tags cannot prove consent. §28.11: never turn a
    // projection failure into a plausible-looking empty answer — here the
    // plausible-looking answer would be "no tag", which is also HIDDEN, so the
    // two coincide; the branch is written out anyway so that a later rung added
    // for "no tag" cannot accidentally inherit the error case.
    if (error) return "HIDDEN";
    tagStatus = (data as any)?.status ?? null;
  } catch {
    return "HIDDEN";
  }

  const ctx = await loadParticipantVisibility(sc, memory, viewerId, [participantId]);
  return participantRungFor(factsFor(ctx, participantId, tagStatus));
}
