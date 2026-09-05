/**
 * journeyGroupDecision — §36 Phase 6 "group decision": a bounded shared
 * shortlist for a trip crew, with a simple accept/decline per member.
 *
 * WHAT IT IS BUILT ON, AND WHAT IT DELIBERATELY DOES NOT CREATE
 * ============================================================
 * THE SHORTLIST IS THE PLAN. It is the trip's existing `trip_plan_items` rows
 * at status 'tentative' — the candidates the crew already shares, written
 * through the EXISTING plan write path (routes/plan.ts add-to-trip-plan). No
 * candidates table exists, because a second store would be a second answer to
 * "what is on this trip". "Bounded" is a CAP applied at the read
 * ({@link SHORTLIST_MAX}), not a new place to put things.
 *
 * THE CREW IS `trip_members`. §36's group decision introduces no social graph,
 * and nothing here reads or writes one.
 *
 * THE CONFIRM IS THE EXISTING WRITE PATH. This module computes when a decision
 * is READY ({@link tallyItem} → `readyToConfirm`); it never writes a status.
 * Promoting 'tentative' → 'confirmed' stays PATCH /api/trips/:tripId/plan/
 * items/:itemId, which already carries `canEditPlan` + `canEditPlanItem`. A
 * second status-writing path here would be a second, divergent answer to "who
 * may change this trip".
 *
 * §23 — CREW MEMBERS ARE COARSE AREAS, ENFORCED BY THE TYPE
 * ========================================================
 * {@link CrewArea} has NO lat, NO lng and NO nested position of any kind. That
 * is not an omission to be remembered at each call site; it is the reason
 * {@link toCrewArea} exists. `CrewMemberCard.exactCoords` is populated when a
 * member has granted the viewer a live share, and that grant is for the MAP,
 * not for a voting sheet — so the group-decision projection cannot express a
 * coordinate at all, and a future edit that tried to carry one would have to
 * change this type first.
 *
 * The shortlist items themselves carry no geometry either. A plan item's
 * public-safe coordinate reaches the map through the §19 gateway
 * (`trip_stop` / `meeting_point` kinds); repeating it here would be a second
 * coordinate path with its own chance of disagreeing with the first.
 *
 * PURE. Rows in, projections out. No I/O, no clock beyond what the caller
 * passes, no privacy decision that is not the removal of a field.
 */
import type { CrewMemberCard, CrewStatusLabel } from "./tripCrewLocation.js";

// ── Bounds ────────────────────────────────────────────────────────────────────

/**
 * The most shortlist candidates a crew is shown at once.
 *
 * Bounded because an unbounded shortlist is not a decision: past a dozen
 * options a group stops choosing and starts scrolling, and every extra row is
 * another set of votes nobody will cast. Overflow is REPORTED
 * ({@link ShortlistProjection.truncated}), never silently trimmed.
 */
export const SHORTLIST_MAX = 12;

/**
 * The minimum number of accepting members before a decision can be READY.
 *
 * One person accepting their own suggestion is not a group decision, so a lone
 * accept never arms the confirm. Two is the smallest number that is a group.
 */
export const MIN_ACCEPTS_FOR_READY = 2;

// ── Crew: coarse areas only (§23) ─────────────────────────────────────────────

/**
 * A crew member on the decision sheet: who they are and, at most, the coarse
 * area label the crew map already publishes. There is deliberately no
 * coordinate field — see the module header.
 */
export interface CrewArea {
  userId: string;
  name: string | null;
  /** e.g. "Riverside" / "Da Nang". Null when the member shares no area. */
  areaLabel: string | null;
  statusLabel: CrewStatusLabel;
}

/** Crew statuses that represent no shared presence at all — never surfaced. */
const HIDDEN_CREW_STATUSES: ReadonlySet<CrewStatusLabel> = new Set<CrewStatusLabel>([
  "not_shared",
  "location_hidden",
]);

/**
 * Project one crew card to a coarse area.
 *
 * Written as an explicit field list rather than a spread-and-delete: a spread
 * would carry `exactCoords` in at runtime and rely on the TYPE to hide it,
 * which JSON serialization does not honour. Naming the four fields means a
 * coordinate cannot arrive by accident.
 */
export function toCrewArea(card: CrewMemberCard): CrewArea {
  return {
    userId: card.userId,
    name: card.name,
    areaLabel: card.areaLabel,
    statusLabel: card.statusLabel,
  };
}

/**
 * Project a crew map to coarse areas. Ghost-mode members and members sharing
 * nothing are dropped entirely; the rest keep their label and nothing sharper.
 */
export function toCrewAreas(cards: readonly CrewMemberCard[] | undefined): CrewArea[] {
  const out: CrewArea[] = [];
  for (const c of cards ?? []) {
    if (c.ghostMode) continue;
    if (HIDDEN_CREW_STATUSES.has(c.statusLabel)) continue;
    out.push(toCrewArea(c));
  }
  return out;
}

// ── Rows ──────────────────────────────────────────────────────────────────────

/** The `trip_plan_items` columns the shortlist reads. No lat/lng: see the header. */
export interface ShortlistItemRow {
  id: string;
  trip_id: string;
  title: string | null;
  category: string | null;
  status: string | null;
  starts_at: string | null;
  location_name: string | null;
  sort_order: number | null;
  created_at: string | null;
}

/** One `trip_plan_item_votes` row (migration 2292). */
export interface VoteRow {
  plan_item_id: string;
  user_id: string;
  vote: string | null;
}

export type Vote = "accept" | "decline";

export function isVote(v: unknown): v is Vote {
  return v === "accept" || v === "decline";
}

/**
 * The status a shortlist candidate must be in.
 *
 * 'tentative' and nothing else: a 'confirmed' item is already decided, and a
 * 'done'/'cancelled' item is history. Voting on either would let the sheet
 * re-open a decision the plan considers made.
 */
export const SHORTLIST_STATUS = "tentative";

// ── Tally ─────────────────────────────────────────────────────────────────────

export interface ShortlistTally {
  accepts: number;
  declines: number;
  /** Eligible members who have not voted at all. */
  pending: number;
  /** The VIEWER'S own vote, or null when they have not voted. */
  myVote: Vote | null;
  /**
   * TRUE when the crew has actually agreed: at least MIN_ACCEPTS_FOR_READY
   * accepts, no declines, and nobody left to hear from.
   */
  readyToConfirm: boolean;
  /** Why not, when `readyToConfirm` is false. Null when it is true. */
  blockedBy: "declined" | "awaiting_votes" | "too_few_accepts" | null;
}

export interface ShortlistItem {
  id: string;
  title: string;
  category: string | null;
  startsAt: string | null;
  /** A place NAME, never a coordinate — the geometry is the gateway's job. */
  locationName: string | null;
  tally: ShortlistTally;
}

export interface ShortlistProjection {
  items: ShortlistItem[];
  /** Coarse crew areas (§23). No geometry — the type cannot express one. */
  crew: CrewArea[];
  /** Eligible voters: the trip's accepted members. */
  eligibleVoters: number;
  /** Candidates that existed beyond SHORTLIST_MAX and were not shown. */
  truncated: number;
}

/**
 * Tally one candidate.
 *
 * A DECLINE IS A HARD BLOCK, not a subtracted point. A group decision where
 * one member said no is not "5 – 1 in favour"; it is unresolved, and calling
 * it ready would use the majority to overrule somebody who is on the trip. So
 * `readyToConfirm` requires zero declines, and `blockedBy` says which of the
 * three ways it failed.
 *
 * Votes from users who are no longer eligible members are IGNORED, not counted
 * — a removed member's old vote must not keep deciding the trip.
 */
export function tallyItem(
  votes: readonly VoteRow[],
  eligible: ReadonlySet<string>,
  viewerId: string,
): ShortlistTally {
  let accepts = 0;
  let declines = 0;
  let myVote: Vote | null = null;
  const voted = new Set<string>();

  for (const v of votes) {
    if (!isVote(v.vote)) continue;
    if (!eligible.has(v.user_id)) continue;
    if (voted.has(v.user_id)) continue; // the unique index makes this belt-and-braces
    voted.add(v.user_id);
    if (v.vote === "accept") accepts += 1;
    else declines += 1;
    if (v.user_id === viewerId) myVote = v.vote;
  }

  const pending = Math.max(0, eligible.size - voted.size);
  let blockedBy: ShortlistTally["blockedBy"] = null;
  if (declines > 0) blockedBy = "declined";
  else if (pending > 0) blockedBy = "awaiting_votes";
  else if (accepts < MIN_ACCEPTS_FOR_READY) blockedBy = "too_few_accepts";

  return { accepts, declines, pending, myVote, readyToConfirm: blockedBy === null, blockedBy };
}

/**
 * Order the shortlist: soonest first, then the plan's own sort order, then
 * creation time, then id. Never by vote count — ordering by popularity would
 * make the sheet argue for an outcome instead of presenting the options.
 */
function compareCandidates(a: ShortlistItemRow, b: ShortlistItemRow): number {
  const at = a.starts_at ? Date.parse(a.starts_at) : Number.POSITIVE_INFINITY;
  const bt = b.starts_at ? Date.parse(b.starts_at) : Number.POSITIVE_INFINITY;
  const aTime = Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
  const bTime = Number.isFinite(bt) ? bt : Number.POSITIVE_INFINITY;
  if (aTime !== bTime) return aTime - bTime;
  const ao = a.sort_order ?? 0;
  const bo = b.sort_order ?? 0;
  if (ao !== bo) return ao - bo;
  const ac = a.created_at ? Date.parse(a.created_at) : 0;
  const bc = b.created_at ? Date.parse(b.created_at) : 0;
  if (ac !== bc) return ac - bc;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BuildShortlistInput {
  rows: readonly ShortlistItemRow[];
  votes: readonly VoteRow[];
  /** Accepted trip members — the eligible voters, from `trip_members`. */
  eligibleMemberIds: readonly string[];
  viewerId: string;
  /** Crew cards from getCrewMap. Coordinates on them are DROPPED here. */
  crew?: readonly CrewMemberCard[];
}

/**
 * Build the bounded shared shortlist.
 *
 * Rows at any status other than 'tentative' are dropped (see
 * {@link SHORTLIST_STATUS}), rows with no usable title are dropped (an option
 * nobody can read is not an option), and the overflow past
 * {@link SHORTLIST_MAX} is counted rather than hidden.
 */
export function buildShortlist(input: BuildShortlistInput): ShortlistProjection {
  const eligible = new Set(input.eligibleMemberIds);

  const votesByItem = new Map<string, VoteRow[]>();
  for (const v of input.votes) {
    const list = votesByItem.get(v.plan_item_id);
    if (list) list.push(v);
    else votesByItem.set(v.plan_item_id, [v]);
  }

  const candidates = input.rows
    .filter((r) => r.status === SHORTLIST_STATUS)
    .filter((r) => typeof r.title === "string" && r.title.trim() !== "")
    .slice()
    .sort(compareCandidates);

  const shown = candidates.slice(0, SHORTLIST_MAX);

  return {
    items: shown.map((r) => ({
      id: r.id,
      title: (r.title as string).trim(),
      category: r.category ?? null,
      startsAt: r.starts_at ?? null,
      locationName: r.location_name ?? null,
      tally: tallyItem(votesByItem.get(r.id) ?? [], eligible, input.viewerId),
    })),
    crew: toCrewAreas(input.crew),
    eligibleVoters: eligible.size,
    truncated: Math.max(0, candidates.length - shown.length),
  };
}
