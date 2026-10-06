/**
 * LayoverCrewVisibility — which crews a traveller may be OFFERED, and whether
 * they may JOIN one. The block list's half of §14, in one place.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * `LayoverCrewStore` deliberately decides nothing about who may see whom (its
 * header says so) and the route layer applied the block list to member CARDS
 * only. Crew DISCOVERY served every open crew in the city — title and meeting
 * point included — and the JOIN asked the city and the capacity, so a traveller
 * somebody had blocked was offered that person's crew, could join it, and could
 * walk to where it was meeting. A crew is a way of putting people in the same
 * physical place; on this surface "may not see each other" has to include "is
 * not offered as somebody to go and meet". census-layover §48 records the find.
 *
 * A block is symmetric (`lib/blocks.ts`): a crew is withheld from a traveller
 * when ANY live member, or its founder, blocked them or was blocked by them.
 *
 * ── FAILING CLOSED (lib/exclusionSet.ts's shapes) ────────────────────────────
 *   `openCrewsVisibleTo`  shape 3 — the answer is entirely a roster of other
 *                         people's crews, so an unreadable block list or an
 *                         unreadable member list is a REFUSAL, never the
 *                         unfiltered list and never a fabricated empty city.
 *   `blockAdmission`      shape 1 — one interaction. An unreadable block list
 *                         answers "unknown" and the store refuses the join.
 *
 * Both read the block list SCOPED to the crews' members (`readBlockExclusions`
 * with `among`), which is two `.in()` reads rather than one `.or()` over the
 * traveller's whole list — and which means a block between two OTHER people can
 * never hide a crew from somebody it does not involve.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { logger as rootLogger } from "../../lib/logger.js";
import { readBlockExclusions } from "../../lib/exclusionSet.js";
import { meetActionAvailability, type MeetActionDenial } from "../airport/LayoverCrewService.js";
import type { LayoverReturnState } from "../airport/LayoverSafetyEngine.js";
import {
  activeCrewForUser,
  crewMembers,
  liveMembersOfCrews,
  openCrewsInCity,
  type CrewAdmission,
  type CrewMemberRow,
  type CrewRead,
  type CrewRow,
} from "./LayoverCrewStore.js";

const logger = rootLogger.child({ service: "LayoverCrewVisibility" });

// ═════════════════════════════════════════════════════════════════════════════
// §14.1 / census-layover L138 — the "meet here" gate, WIRED
// ═════════════════════════════════════════════════════════════════════════════
//
// L138: *"Traveler pins must not expose an unsafe 'meet here' action without
// the social/safety gate."* `meetActionAvailability`
// (`services/airport/LayoverCrewService.ts`) has encoded that rule since the
// §14 build and had NO caller outside `src/test/`. The census graded the row
// `C ∅` — "real refusal, empty path" — because the presence list exposed no
// meet action at all.
//
// THE PATH IS NO LONGER EMPTY. Since PR #573 two surfaces offer a traveller a
// crew to go and physically meet, each carrying the crew's `meeting_point_label`
// and, on the client, a one-tap Join:
//
//   DOOR 1  `GET /api/airport/sessions/:id/crew`, not-in-a-crew branch — the
//           roster of open crews in the city (`LayoverCrewSection`).
//   DOOR 2  the §12 Compass tool `getCrewCandidates` → `compassCrewCandidates`
//           below, whose answer is handed to the MODEL and ends up in its
//           sentence.
//
// Both ran the block list and NOTHING ELSE: one of the guard's six clauses.
// The one that was missing and bites is the SAFETY gate. The sibling
// people-discovery surface on the same screen — `GET /:id/buddies` — refuses
// with `reason: "safety_gate_not_passed"` for exactly this (`LayoverBuddyGate`,
// census L273), and the crew surface consulted it nowhere. A traveller whose
// certified verdict is `no` (they cannot clear the airport and get back) or
// `stay_airside`, or who is already on the escalation ladder, was handed a list
// of landside crews to go and join, BY THE SAME SERVER that had computed that
// verdict for that session.
//
// ── WHAT IS SUPPLIED, AND WHAT CANNOT BE ────────────────────────────────────
// `meetActionAvailability` is a per-PAIR guard: one viewer, one named target.
// A crew is 2–12 people and the roster is a city. Two of its six inputs cannot
// be answered truthfully on this surface at all, and they are named in
// `CREW_MEET_DENIALS_NOT_ENFORCED` rather than invented:
//
//   `mutualConnection`          §14's crew exists so that STRANGERS on a
//                               layover can meet. There is no single target to
//                               be mutual with, and requiring a mutual
//                               connection would empty the surface for ever.
//                               Passed as the fail-closed `false`; its denial
//                               is produced and deliberately not enforced.
//   `meetingPointIsPublicVenue` `layover_crews.meeting_point_label` is free
//                               TEXT a crewmate typed ("Terminal 2 food
//                               court", 2984) and NOTHING in this repository
//                               can classify free text as a public venue.
//                               Passing `true` would be the fabrication this
//                               census keeps catching; enforcing the
//                               fail-closed `false` would withhold the label
//                               from the crew's own members, who agreed it.
//                               A `places`-backed meeting point is the honest
//                               way to wire this clause and it is a BUILD, not
//                               a classifier.
//
// Everything else is READ, and every read fails CLOSED. `supabase-js` resolves
// `{data, error}` rather than throwing, so each input below is derived from an
// outcome (`CrewRead`, `readBlockExclusions`'s `ok`) and never from `data ?? []`
// — "we could not check" must not become "there is nothing to stop us".

/** Why the meeting point, or the whole offer, was withheld. */
export type CrewMeetScope =
  /** Offering a crew the viewer is NOT in (the roster, the Compass candidates). */
  | "offer"
  /** The viewer's OWN crew (the crew card, the Compass `inCrew` answer). */
  | "member";

/**
 * The denials this affordance produces but does NOT act on, per scope, with the
 * reason each is here. Exported and pinned by `layoverCrewMeetGate.test.ts` so
 * the set cannot grow silently: a clause quietly added here is a clause quietly
 * switched off.
 *
 *   `not_mutual`                see above — no single target, strangers by design.
 *   `meeting_point_not_public`  see above — no oracle for free text.
 *   `no_crew`                   OFFER SCOPE ONLY. The viewer is by construction
 *                               not in the crew being offered; that is what
 *                               makes it an offer. Enforcing it would delete
 *                               crew discovery, and a crew's own self-declared
 *                               venue label carries no coordinate (2984 asserts
 *                               the absence) and no identity — the roster
 *                               publishes no user id at all.
 *   `return_state_escalated`    OFFER SCOPE ONLY, and only because the guard
 *                               collapses both sides of the clause into ONE
 *                               denial. The offer surface does not read the
 *                               crews' members' sessions (`readSessionsByIds`
 *                               is capped at `CREW_READ_LIMIT` for ONE crew),
 *                               so the target half is unknown and is passed as
 *                               `null` rather than defaulted. The VIEWER half
 *                               is still enforced, by `safetyGateCleared`,
 *                               which requires `returnState === "NORMAL"` and
 *                               is strictly stronger than the guard's own
 *                               RETURN_NOW / CONNECTION_AT_RISK test. In
 *                               `member` scope the clause IS enforced on both
 *                               sides, from the crew's certified records.
 */
export const CREW_MEET_DENIALS_NOT_ENFORCED: Readonly<Record<CrewMeetScope, readonly MeetActionDenial[]>> = {
  offer: ["not_mutual", "meeting_point_not_public", "no_crew", "return_state_escalated"],
  member: ["not_mutual", "meeting_point_not_public"],
};

/** Every input to `meetActionAvailability` this surface can READ. */
export interface CrewMeetFacts {
  /**
   * A block relation between the viewer and anybody in the crew — OR a block
   * list that could not be read. Both withhold.
   */
  blocked: boolean;
  /** The crew the viewer is a live member of, or null. An unreadable membership is null. */
  sameCrewId: string | null;
  /** `buddySafetyGateFor(record).passed` for the viewer's OWN session. Uncertifiable ⇒ false. */
  safetyGateCleared: boolean;
  /** The viewer's certified return state. Uncertified ⇒ null, which the guard reads as escalated. */
  viewerReturnState: LayoverReturnState | null;
  /**
   * The crew's MOST ESCALATED certified member state — the whole crew's, because
   * one member sprinting for a gate ends the meet for everybody. Any member
   * uncertified ⇒ null. Not read in `offer` scope; see
   * `CREW_MEET_DENIALS_NOT_ENFORCED`.
   */
  crewReturnState: LayoverReturnState | null;
}

export interface CrewMeetDecision {
  allowed: boolean;
  /** The denials that were ENFORCED — why it was withheld. Empty when allowed. */
  withheld: MeetActionDenial[];
  /** Every denial the guard returned, enforced or not. For logs and census reads. */
  denials: MeetActionDenial[];
}

/**
 * ONE call to the guard, per (viewer, crew), for both doors. Nothing here
 * re-implements a clause: the decision is `meetActionAvailability`'s, and the
 * only thing this adds is which of its denials this affordance can stand
 * behind — read off a named, test-pinned constant rather than an inline `if`.
 */
export function crewMeetDecision(facts: CrewMeetFacts, scope: CrewMeetScope): CrewMeetDecision {
  const { denials } = meetActionAvailability({
    blocked: facts.blocked,
    mutualConnection: false,
    sameCrewId: facts.sameCrewId,
    meetingPointIsPublicVenue: false,
    safetyGateCleared: facts.safetyGateCleared,
    viewerReturnState: facts.viewerReturnState,
    // NOT DEFAULTED. In `offer` scope the crews' members' sessions are not read,
    // so the target's state is genuinely unknown and says so.
    targetReturnState: scope === "member" ? facts.crewReturnState : null,
  });
  const unenforced = CREW_MEET_DENIALS_NOT_ENFORCED[scope];
  const withheld = denials.filter((d) => !unenforced.includes(d));
  return { allowed: withheld.length === 0, withheld, denials };
}

/**
 * The meeting-point label for the viewer's OWN crew, or why not.
 *
 * A withheld label is `null` plus named reasons — never a silently missing
 * field — and the rest of the crew answer (its shared deadline, its
 * feasibility, its size) is untouched: those are facts the member is BOUND by,
 * the same split `publishedCrewSolution` already makes between the crew's facts
 * and its people's.
 */
export function crewMeetingPointFor(
  label: string | null,
  facts: CrewMeetFacts,
): { label: string | null; withheld: MeetActionDenial[] } {
  const decision = crewMeetDecision(facts, "member");
  return decision.allowed ? { label, withheld: [] } : { label: null, withheld: decision.withheld };
}

/**
 * Open crews in `city` that `viewerId` may be offered: every one whose founder
 * and live members are all clear of the viewer's block relations.
 *
 * `ok: false` whenever any of the three reads it rests on failed — the crews,
 * their members, or the viewer's blocks. A refusal is the only honest answer
 * then: an unfiltered list could put a blocked person in front of the viewer,
 * and an empty one would tell them nobody is meeting here.
 */
export async function openCrewsVisibleTo(
  db: SupabaseClient,
  viewerId: string,
  city: string,
  nowIso: string,
): Promise<CrewRead<CrewRow[]>> {
  const open = await openCrewsInCity(db, city, nowIso);
  if (!open.ok || open.value.length === 0) return open;

  const members = await liveMembersOfCrews(db, open.value.map((c) => c.id));
  if (!members.ok) return members;

  const peopleOf = (c: CrewRow) => [c.createdBy, ...(members.value.get(c.id) ?? []).map((m) => m.userId)];
  const everyone = new Set<string>();
  for (const c of open.value) for (const id of peopleOf(c)) everyone.add(id);
  everyone.delete(viewerId);

  const blocked = await readBlockExclusions(db, viewerId, { among: [...everyone] });
  if (!blocked.ok) {
    logger.warn({ reason: blocked.reason }, "block list unreadable — refusing to offer crews rather than offering them unchecked");
    return { ok: false, reason: "read_failed" };
  }
  return {
    ok: true,
    value: open.value.filter((c) => !peopleOf(c).some((id) => id !== viewerId && blocked.ids.has(id))),
  };
}

/**
 * The §14.1 solution as one viewer may read it.
 *
 * ── THE DEADLINE IS THE CREW'S; THE IDENTITIES ARE PEOPLE'S ──────────────────
 * `sharedReturnBy`, `feasible`, `reasons` and `split` are about the whole crew
 * and are published whole: everybody in it is bound by them, seen or not.
 * `members[]` (each member's user id and personal return deadline) and
 * `bindingMemberIds` (whoever binds) are about PEOPLE. Both used to be
 * published for every member, so the block and sharing gates `crewMemberCards`
 * applies to the faces were undone by the user id printed beside them. They
 * are now published for the viewer and the crewmates in `visibleIds` — the
 * ones the member-card gate cleared — and a binding deadline that belongs to a
 * crewmate the viewer may not see is disclosed as `bindingMemberHidden: true`:
 * the count and the deadline stay honest, the person does not become
 * identifiable. census-layover §48.
 */
export function publishedCrewSolution(
  solution: {
    crewVersion: string;
    sharedReturnBy: string | null;
    bindingMemberIds: string[];
    feasible: boolean;
    reasons: string[];
    split: boolean;
    members: Array<{ userId: string; requiredReturnBy: string | null; usableMinutes: number | null; returnState: string | null }>;
  },
  viewerId: string,
  visibleIds: readonly string[],
) {
  const seen = new Set<string>([viewerId, ...visibleIds]);
  return {
    crewVersion: solution.crewVersion,
    sharedReturnBy: solution.sharedReturnBy,
    bindingMemberIds: solution.bindingMemberIds.filter((id) => seen.has(id)),
    bindingMemberHidden: solution.bindingMemberIds.some((id) => !seen.has(id)),
    feasible: solution.feasible,
    reasons: solution.reasons,
    split: solution.split,
    members: solution.members
      .filter((m) => seen.has(m.userId))
      .map((m) => ({
        userId: m.userId,
        requiredReturnBy: m.requiredReturnBy,
        usableMinutes: m.usableMinutes,
        returnState: m.returnState,
      })),
  };
}

/**
 * The block rule `joinCrew` asks at the moment it knows who is in the crew.
 * See `CrewAdmission` in LayoverCrewStore.ts for what each answer does.
 */
export function blockAdmission(db: SupabaseClient, joinerId: string): CrewAdmission {
  return async (memberIds) => {
    if (memberIds.length === 0) return "admit";
    const blocked = await readBlockExclusions(db, joinerId, { among: memberIds });
    if (!blocked.ok) {
      logger.warn({ reason: blocked.reason }, "block list unreadable — the crew join is refused rather than made unchecked");
      return "unknown";
    }
    return memberIds.some((id) => blocked.ids.has(id)) ? "refuse" : "admit";
  };
}

/**
 * What the §12 Compass tool `getCrewCandidates` may tell the model about crews
 * for one traveller — census-layover L110, §48.
 *
 * The tool used to answer `unavailable: "no_crew_storage"` for everybody, a
 * reason that stopped being true when 2984 created the crew tables. It now
 * answers from the same reads the crew card makes, under the same rules:
 *
 *   - the crews OFFERED are `openCrewsVisibleTo`'s, so a crew with somebody in
 *     a block relation with the asker never reaches the model;
 *   - ANY failed read (membership, crew, members, blocks) is `ok: false`. The
 *     route hands that to the tool as a reason, never as an empty list: an
 *     empty roster from a failed read is "nobody is meeting here", and an
 *     unfiltered one could put a blocked person in the answer;
 *   - no traveller's user id or session id is in the result. Crews are named
 *     by what the card shows — title, meeting point, size, expiry — because
 *     whatever is handed to the model can end up in its sentence.
 *
 * `city` is the route's `crewCityFor(airport, session)`; null means the
 * airport's city is unknown, which is an ANSWER (`reason: "city_unknown"`),
 * exactly as `GET /:id/crew` serves it.
 */
export type CompassCrewCandidates =
  | {
      ok: true;
      value:
        | {
            inCrew: true;
            crew: {
              title: string;
              meetingPointLabel: string | null;
              /** Named reasons the label above is `null`. Empty = it was served. §14.1 / L138. */
              meetingPointWithheld: MeetActionDenial[];
              expiresAt: string;
              memberCount: number;
              maxMembers: number;
              youAreOwner: boolean;
            };
            candidates: [];
          }
        | {
            inCrew: false;
            city: string | null;
            candidates: Array<{
              crewId: string;
              title: string;
              meetingPointLabel: string | null;
              maxMembers: number;
              expiresAt: string;
            }>;
            reason: "city_unknown" | "safety_gate_not_passed" | null;
            /** §14.1 / L138: the enforced denials behind a `safety_gate_not_passed` refusal. */
            meetWithheld: MeetActionDenial[];
          };
    }
  | { ok: false; reason: "layover_crew_unreadable" };

/**
 * The §14.1 gate as the Compass door receives it, from the route that holds the
 * certification machinery.
 *
 * INJECTED RATHER THAN DERIVED HERE. `crewSolverMembers` and
 * `certifyCrewMemberRecord` live in `routes/airport.ts` because
 * `src/test/layoverFeasibilityRecord.test.ts` pins `certifySessionFeasibility(`
 * in that file to one call site per named handler. Certifying a second time in
 * this service would be the divergent second derivation that ratchet exists to
 * forbid, so BOTH doors share the route's single implementation instead.
 */
export interface CompassCrewMeetGate {
  /** May this traveller be OFFERED crews at all? One decision per request. */
  offer: CrewMeetDecision;
  /** The viewer's own crew: the facts the guard needs, read by the route. */
  memberFacts: (crew: CrewRow, members: CrewMemberRow[]) => Promise<CrewMeetFacts>;
}

export async function compassCrewCandidates(
  db: SupabaseClient,
  viewerId: string,
  city: string | null,
  nowIso: string,
  meet: CompassCrewMeetGate,
): Promise<CompassCrewCandidates> {
  const unreadable = { ok: false, reason: "layover_crew_unreadable" } as const;

  const mine = await activeCrewForUser(db, viewerId, nowIso);
  if (!mine.ok) return unreadable;
  if (mine.value) {
    const { crew, membership } = mine.value;
    const members = await crewMembers(db, crew.id);
    if (!members.ok) return unreadable;
    // §14.1 / L138, the SAME decision the crew card makes — a guard on one door
    // is not a guard. The facts come from the route's single certification site.
    const point = crewMeetingPointFor(crew.meetingPointLabel, await meet.memberFacts(crew, members.value));
    return {
      ok: true,
      value: {
        inCrew: true,
        crew: {
          title: crew.title,
          meetingPointLabel: point.label,
          meetingPointWithheld: point.withheld,
          expiresAt: crew.expiresAt,
          // The crew's size is published whole on the crew card too: everybody
          // in it is bound by its deadline, seen or not (`publishedCrewSolution`).
          memberCount: members.value.length,
          maxMembers: crew.maxMembers,
          youAreOwner: membership.role === "owner",
        },
        candidates: [],
      },
    };
  }

  if (!city) return { ok: true, value: { inCrew: false, city: null, candidates: [], reason: "city_unknown", meetWithheld: [] } };

  // §14.1 / L138 — BEFORE the roster is read, not after it is published. A
  // traveller the certified record says must stay airside is told so, and the
  // model is told so, rather than being handed landside crews to go and join.
  // Symmetric with `GET /:id/buddies`'s `safety_gate_not_passed` (L273).
  if (!meet.offer.allowed) {
    return {
      ok: true,
      value: { inCrew: false, city, candidates: [], reason: "safety_gate_not_passed", meetWithheld: meet.offer.withheld },
    };
  }

  const open = await openCrewsVisibleTo(db, viewerId, city, nowIso);
  if (!open.ok) return unreadable;
  return {
    ok: true,
    value: {
      inCrew: false,
      city,
      candidates: open.value.map((c) => ({
        crewId: c.id,
        title: c.title,
        meetingPointLabel: c.meetingPointLabel,
        maxMembers: c.maxMembers,
        expiresAt: c.expiresAt,
      })),
      reason: null,
      meetWithheld: [],
    },
  };
}
