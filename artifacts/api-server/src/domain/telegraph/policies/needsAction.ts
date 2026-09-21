/**
 * Telegraph §19 — "12 unread · 1 needs action".
 *
 * census-telegraph T260: unread "is real and carefully built … **'Needs action'
 * has no representation** — nothing distinguishes a message from an unresolved
 * decision." Re-read before this file was written and still true: every field
 * `GET /me/threads` returns is about MESSAGES.
 *
 * ── WHAT COUNTS AS AN ACTION, AND WHY ONLY THESE TWO ─────────────────────────
 * "Needs action" is not "unread, but louder". It is a claim that the product
 * is WAITING ON THIS PERSON, and the only honest source for that is an object
 * that records an answer this person has not given. Two such objects exist in
 * this repository today (migration 0013):
 *
 *   1. `meetup_invites` with `status = 'pending'` for the caller — the RSVP
 *      column has a CHECK listing exactly pending/going/maybe/declined/cancelled
 *      and defaults to 'pending', so "has not answered" is a stored fact, not
 *      an inference.
 *   2. an unconfirmed `meetup_time_options` row on a meetup where the caller
 *      has no `meetup_time_votes` row — the organiser asked which evening and
 *      this person has not said.
 *
 * A meetup reaches a thread through `meetups.chat_thread_id`
 * (migrations/0013_availability_meetups.sql:160), which is what the chat
 * create-meetup path writes; that column is the ONLY link between a decision
 * and a conversation, so it is the only join this file makes.
 *
 * Nothing else is counted. Not an unanswered question in prose — deciding that
 * "so are we going?" needs an answer is a guess, and a badge built on a guess
 * teaches people to ignore the badge. Not a message request, which is not in a
 * thread yet. Not a rent-a-buddy milestone, which has its own surface.
 *
 * ── ONE MEETUP IS ONE ACTION ─────────────────────────────────────────────────
 * A poll with five evenings is one decision, not five. The count is DISTINCT
 * MEETUPS awaiting this person, so "1 needs action" means one thing to go and
 * deal with. `reasons` says which kind, without multiplying the number.
 *
 * ── AN UNKNOWN COUNT IS NOT ZERO ─────────────────────────────────────────────
 * supabase-js resolves on a database error, so an unreadable `meetup_invites`
 * returns the same `null` an empty one does. Reporting `0` for that would hide
 * a decision the traveller has to make; reporting a guess would invent one.
 * Neither is acceptable, so a failed read sets `degraded` and the caller is
 * expected to OMIT the field rather than send a number — "we do not know" is
 * renderable (show nothing), and a wrong number is not recoverable.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type NeedsActionReason = "rsvp_pending" | "time_vote_pending";

export interface ThreadNeedsAction {
  /** Distinct meetups in this thread that are waiting on the viewer. */
  count: number;
  /** Which kinds of answer are outstanding, in a stable order. */
  reasons: NeedsActionReason[];
}

export interface NeedsActionResult {
  byThread: Map<string, ThreadNeedsAction>;
  /**
   * True when any read failed. `byThread` is then EMPTY — not partially
   * filled — because a partial map is indistinguishable from "these threads
   * need nothing", which is the answer this module must never fabricate.
   */
  degraded: boolean;
}

/** Largest thread page this resolver will join across in one call. */
export const NEEDS_ACTION_MAX_THREADS = 200;

const EMPTY: NeedsActionResult = { byThread: new Map(), degraded: false };

/**
 * Which of `threadIds` are waiting on `viewerId`, and for what.
 *
 * Reads with the SERVICE client, so authorization is the caller's
 * responsibility: pass only threads the viewer is an active member of. That is
 * how `GET /me/threads` already derives its thread list, and re-deriving it
 * here would put a second membership rule next to the one that already exists.
 */
export async function resolveNeedsAction(
  sc: SupabaseClient,
  params: { viewerId: string; threadIds: string[] },
): Promise<NeedsActionResult> {
  const { viewerId } = params;
  const threadIds = params.threadIds.slice(0, NEEDS_ACTION_MAX_THREADS);
  if (threadIds.length === 0 || !viewerId) return EMPTY;

  // 1. The meetups that live in these threads. `cancelled` is excluded: a
  //    cancelled meetup is not waiting on anybody, and its invite rows keep
  //    whatever status they had.
  const meetupsRes = await sc
    .from("meetups")
    .select("id, chat_thread_id, status")
    .in("chat_thread_id", threadIds)
    .neq("status", "cancelled");
  if (meetupsRes.error) return { byThread: new Map(), degraded: true };

  const threadOfMeetup = new Map<string, string>();
  for (const row of (meetupsRes.data ?? []) as any[]) {
    if (row?.id && row?.chat_thread_id) threadOfMeetup.set(row.id as string, row.chat_thread_id as string);
  }
  const meetupIds = Array.from(threadOfMeetup.keys());
  if (meetupIds.length === 0) return EMPTY;

  // 2. The viewer's own RSVP rows on those meetups.
  const invitesRes = await sc
    .from("meetup_invites")
    .select("meetup_id, status")
    .eq("user_id", viewerId)
    .in("meetup_id", meetupIds);
  if (invitesRes.error) return { byThread: new Map(), degraded: true };

  // 3. Unconfirmed time options on those meetups. `confirmed = true` means the
  //    organiser already picked, so there is nothing left to vote on.
  const optionsRes = await sc
    .from("meetup_time_options")
    .select("id, meetup_id")
    .in("meetup_id", meetupIds)
    .eq("confirmed", false);
  if (optionsRes.error) return { byThread: new Map(), degraded: true };

  const optionRows = (optionsRes.data ?? []) as any[];
  const optionIds = optionRows.map((o) => o?.id as string).filter(Boolean);

  // 4. Which of those the viewer has already voted on.
  let votedOptionIds = new Set<string>();
  if (optionIds.length > 0) {
    const votesRes = await sc
      .from("meetup_time_votes")
      .select("option_id")
      .eq("user_id", viewerId)
      .in("option_id", optionIds);
    if (votesRes.error) return { byThread: new Map(), degraded: true };
    votedOptionIds = new Set(((votesRes.data ?? []) as any[]).map((v) => v?.option_id as string).filter(Boolean));
  }

  // A meetup needs an RSVP if the viewer has a row still at 'pending'. A viewer
  // with NO row is not an invitee and is not being asked anything — absence is
  // not an outstanding answer.
  const needsRsvp = new Set<string>();
  for (const inv of (invitesRes.data ?? []) as any[]) {
    if (inv?.status === "pending" && inv?.meetup_id) needsRsvp.add(inv.meetup_id as string);
  }

  // A meetup needs a vote if it has at least one unconfirmed option the viewer
  // has not voted on — and only for a viewer who is actually an invitee, for
  // the same reason.
  const invitedMeetups = new Set(
    ((invitesRes.data ?? []) as any[]).map((i) => i?.meetup_id as string).filter(Boolean),
  );
  const needsVote = new Set<string>();
  for (const opt of optionRows) {
    const meetupId = opt?.meetup_id as string | undefined;
    if (!meetupId || !invitedMeetups.has(meetupId)) continue;
    if (!votedOptionIds.has(opt.id as string)) needsVote.add(meetupId);
  }

  const byThread = new Map<string, ThreadNeedsAction>();
  for (const meetupId of meetupIds) {
    const reasons: NeedsActionReason[] = [];
    if (needsRsvp.has(meetupId)) reasons.push("rsvp_pending");
    if (needsVote.has(meetupId)) reasons.push("time_vote_pending");
    if (reasons.length === 0) continue;

    const threadId = threadOfMeetup.get(meetupId)!;
    const existing = byThread.get(threadId);
    if (existing) {
      existing.count += 1;                       // one meetup, one action
      for (const r of reasons) if (!existing.reasons.includes(r)) existing.reasons.push(r);
    } else {
      byThread.set(threadId, { count: 1, reasons });
    }
  }

  return { byThread, degraded: false };
}
