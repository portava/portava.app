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
import {
  liveMembersOfCrews,
  openCrewsInCity,
  type CrewAdmission,
  type CrewRead,
  type CrewRow,
} from "./LayoverCrewStore.js";

const logger = rootLogger.child({ service: "LayoverCrewVisibility" });

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
