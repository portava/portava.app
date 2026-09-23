/**
 * Telegraph — the saved-message projection, its prohibitions, and unsave.
 *
 * Spec:
 *   §10.2 "A user may explicitly save a message, voice note, place share or
 *          media item as a private Memory draft."
 *   §14.2 "Read authorization is dynamic … because membership, revocation,
 *          source-object privacy and blocking can change after a message was
 *          created."
 *   §14.3 "New members do not automatically receive pre-membership history."
 *   §7.4   an unsent/deleted message is removed from normal retrieval, search
 *          and projections.
 *   §29    no silent failure that becomes plausible empty state.
 *
 * WHAT A SAVE IS. `saved_messages` holds four columns — id, user_id,
 * message_id, saved_at (baseline/20260819_baseline_structure.sql:9788). It is
 * an INDEX ENTRY, not a copy: no body, no media url, no sender. Every field a
 * saved item shows is re-read from `messages` at projection time. That single
 * schema fact decides most of what follows, and it is the right shape — a
 * second stored copy of thread content would be a second place §7.4's removal
 * would have to reach, and a place nobody would remember to send it.
 *
 * ── THE DECISION THIS MODULE EXISTS TO WRITE DOWN ───────────────────────────
 *
 * QUESTION: a member saves a message; later their §14.3 `visible_from_at`
 * MOVES FORWARD past it — which is not hypothetical, because
 * message_thread_members' primary key is (thread_id, user_id), so a member who
 * leaves and rejoins REUSES THEIR ROW and migration 2400's trigger sets
 * `visible_from_at := now()` on the rejoin
 * (src/migrations/2400_telegraph_history_bound.sql:160-166). What do they see?
 *
 * DECISION: **THE BOUND WINS. The saved item is WITHHELD for as long as it is
 * outside the caller's current window**, and it is withheld with a reason
 * rather than silently dropped. Four reasons, in the order they carry weight:
 *
 *   1. §14.2 says authorization is re-checked AT READ, and names membership
 *      change as one of the reasons why. A save is a bookmark. If a bookmark
 *      were a grant, it would be the only permanent read grant in Telegraph,
 *      and it would be one the granting rule never sees.
 *
 *   2. Otherwise the save IS the leak §14.3 exists to stop. A member who
 *      expects to be removed could save the thread's history on the way out and
 *      read it back after rejoining — pre-membership history, delivered to a
 *      new membership interval, through a door the bound cannot see. §14.3's
 *      sentence would hold for the thread reader and be false for the product.
 *
 *   3. There is nothing else to show. The save stores no body (see above), so
 *      "honour the save" could only mean re-reading the source through the
 *      bound — which is this decision — or keeping a private copy, which
 *      re-opens §7.4.
 *
 *   4. It fails closed. `withinWindow` treats an unparseable or missing
 *      timestamp as OUTSIDE the window
 *      (src/services/groupChatHistoryBound.ts#withinWindow), so a damaged row
 *      withholds rather than discloses.
 *
 * COST, STATED RATHER THAN HIDDEN: a save can leave the list through no act of
 * the saver's. That is why `projectSavedMessages` returns `withheld` beside
 * `items` — a surface can say "no longer available to you" instead of quietly
 * showing a shorter list, which is §29's rule applied to authorization rather
 * than to schema errors.
 *
 * NOT REVERSIBLE BY ACCIDENT: this decision is pinned by
 * src/test/telegraphSavedMessages.test.ts ("a save made before the window
 * moved is withheld once it moves").
 *
 * ── WHAT A SAVED ITEM MUST NOT CARRY ────────────────────────────────────────
 * A saved message is the caller's private pointer at ONE message. It must not
 * become a SECOND DOOR onto the thread — a way to reach content the same
 * caller's thread read would refuse. So the projection carries no field that
 * RESOLVES TO SOMETHING ELSE: no reply pointer, no sequence or cursor, no
 * thread roster or title, no ciphertext, no other recipient's translation.
 * `assertNoSecondDoor` REFUSES such a payload rather than stripping it, for the
 * reason `assertNoMemoryGraphLeak` refuses rather than strips: a caller that
 * sent one was trying to do something the contract does not allow.
 *
 * ── ORDER OF REFUSAL ────────────────────────────────────────────────────────
 * Membership is judged BEFORE deletion, deliberately. A departed member must
 * not learn from their own saved list that the sender later unsent something.
 * The reason they get names their own state and nothing about the message.
 *
 * ── UNSAVE DOES NOT RE-AUTHORIZE ────────────────────────────────────────────
 * `unsaveMessage` deletes by (user_id, message_id) and checks nothing else. A
 * save the caller can no longer read is exactly the save they are most likely
 * to want gone, and a re-authorized unsave would strand it forever. The filter
 * names the caller's own id, so it can reach no other person's row. This also
 * matters more than it looks: account deletion keeps an ANONYMISED TOMBSTONE
 * profile rather than deleting profiles(id), so `saved_messages`' own
 * `ON DELETE CASCADE` to profiles never fires (src/lib/deletionDispositions.ts
 * header; the table sits in UNCLASSIFIED_BACKLOG). Unsave is today the only
 * path by which a saved_messages row leaves the database at its owner's
 * request.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { visibleFromOf, withinWindow } from "../groupChatHistoryBound.js";

// ── The projection ───────────────────────────────────────────────────────────

export const SAVED_MESSAGE_PROJECTION_VERSION = "1" as const;

/**
 * One saved message, as a surface sees it. Field for field the shape
 * `GET /me/saved-messages` already returns, so adopting this module is a
 * refactor and not a contract change.
 */
export interface SavedMessageItem {
  messageId: string;
  threadId: string;
  senderId: string | null;
  body: string | null;
  createdAt: string;
  savedAt: string;
  msgType: string;
  subtype: string | null;
  mediaUrl: string | null;
  mediaType: string | null;
  mediaThumbnailUrl: string | null;
  projectionVersion: typeof SAVED_MESSAGE_PROJECTION_VERSION;
}

/** The `messages` columns a saved item is built from. */
export interface SavedMessageSource {
  id: string;
  thread_id: string;
  sender_id?: string | null;
  body?: string | null;
  created_at: string;
  deleted_at?: string | null;
  msg_type?: string | null;
  subtype?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_thumbnail_url?: string | null;
}

/** The caller's standing in one thread, as a reader resolves it. */
export interface SavedMessageMembership {
  /** An ACTIVE membership: message_thread_members.left_at IS NULL. */
  active: boolean;
  /** The §14.3 bound for this membership, or null for unbounded. */
  visibleFrom: string | null;
  /**
   * WHOSE membership this is — the caller, for Q6's own-message exception.
   * OPTIONAL, and its absence means NO exception: a caller that does not say
   * who it is gets the plain window, which is the narrower answer.
   */
  viewerId?: string | null;
}

/**
 * Why a saved row is not in the list. Every one of these is a fact about the
 * CALLER's own standing except `source_deleted`, which is only ever reached by
 * a caller who is still authorized (see "order of refusal" in the header).
 */
export type SavedMessageWithheldReason =
  | "not_a_member"
  | "outside_history_window"
  | "source_deleted"
  | "source_unavailable";

export interface SavedMessageWithheld {
  messageId: string;
  savedAt: string;
  reason: SavedMessageWithheldReason;
}

export type SavedMessageVerdict =
  | { ok: true }
  | { ok: false; reason: SavedMessageWithheldReason };

/**
 * §14.2's re-authorization, as one decision.
 *
 * `membership` is null when the caller holds no ACTIVE membership of the
 * message's thread — a departed member's saves stay in the table and stop
 * being served.
 */
export function authorizeSavedMessage(
  source: SavedMessageSource,
  membership: SavedMessageMembership | null,
): SavedMessageVerdict {
  // Membership FIRST. See "order of refusal".
  if (!membership || !membership.active) return { ok: false, reason: "not_a_member" };
  // Q6: a save of the caller's OWN earlier message survives a rejoin. Note the
  // ORDER, which is the one this function's header insists on and which Q6 does
  // not disturb: membership is judged FIRST and an INACTIVE member is refused
  // `not_a_member` before the window — and therefore before the exception — is
  // ever consulted. A departed member reads nothing, including their own.
  if (!withinWindow(source.created_at, membership.visibleFrom,
                    { senderId: source.sender_id, viewerId: membership.viewerId })) {
    return { ok: false, reason: "outside_history_window" };
  }
  if (source.deleted_at) return { ok: false, reason: "source_deleted" };
  return { ok: true };
}

/** Build the item. Carries the source's fields and nothing that resolves elsewhere. */
export function projectSavedMessage(source: SavedMessageSource, savedAt: string): SavedMessageItem {
  return {
    messageId: source.id,
    threadId: source.thread_id,
    senderId: source.sender_id ?? null,
    body: source.body ?? null,
    createdAt: source.created_at,
    savedAt,
    msgType: source.msg_type ?? "text",
    subtype: source.subtype ?? null,
    mediaUrl: source.media_url ?? null,
    mediaType: source.media_type ?? null,
    mediaThumbnailUrl: source.media_thumbnail_url ?? null,
    projectionVersion: SAVED_MESSAGE_PROJECTION_VERSION,
  };
}

export interface SavedMessageProjectionInput {
  /** `saved_messages` rows for ONE caller, newest first or not — this sorts. */
  saved: ReadonlyArray<{ message_id: string; saved_at: string }>;
  /** The `messages` rows that were readable. A pre-filtered caller may omit deleted ones. */
  sources: ReadonlyArray<SavedMessageSource>;
  /** threadId → the caller's standing. A thread absent from this map has no active membership. */
  membershipByThread: Readonly<Record<string, SavedMessageMembership>>;
}

export interface SavedMessageProjection {
  items: SavedMessageItem[];
  withheld: SavedMessageWithheld[];
}

/**
 * The whole read, as one pure function: re-authorize each save, project the
 * survivors, and NAME what was withheld.
 *
 * A saved row whose message is not in `sources` gets `source_unavailable`
 * rather than a guess. A caller that filters `deleted_at IS NULL` in SQL —
 * which `GET /me/saved-messages` does — collapses deletion into that reason,
 * and that collapse is the safe direction: it names no cause to anyone.
 */
export function projectSavedMessages(input: SavedMessageProjectionInput): SavedMessageProjection {
  const sourceById = new Map<string, SavedMessageSource>();
  for (const s of input.sources) sourceById.set(s.id, s);

  const items: SavedMessageItem[] = [];
  const withheld: SavedMessageWithheld[] = [];

  for (const row of input.saved) {
    const source = sourceById.get(row.message_id);
    if (!source) {
      withheld.push({ messageId: row.message_id, savedAt: row.saved_at, reason: "source_unavailable" });
      continue;
    }
    const verdict = authorizeSavedMessage(source, input.membershipByThread[source.thread_id] ?? null);
    if (!verdict.ok) {
      withheld.push({ messageId: row.message_id, savedAt: row.saved_at, reason: verdict.reason });
      continue;
    }
    items.push(projectSavedMessage(source, row.saved_at));
  }

  items.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
  return { items, withheld };
}

/**
 * Turn membership rows into the map `projectSavedMessages` wants.
 *
 * `rows` are already filtered to ACTIVE memberships by the reader's own
 * `.is('left_at', null)`; a row carrying an explicit `left_at` is still judged
 * here, so a caller that forgets the filter is not silently wrong.
 */
export function membershipViewFromRows(
  rows: ReadonlyArray<{ thread_id: string; left_at?: string | null; visible_from_at?: string | null }>,
  boundEnabled: boolean,
): Record<string, SavedMessageMembership> {
  const view: Record<string, SavedMessageMembership> = {};
  for (const r of rows) {
    view[r.thread_id] = {
      active: r.left_at == null,
      visibleFrom: visibleFromOf(r, boundEnabled),
    };
  }
  return view;
}

// ── The prohibition ──────────────────────────────────────────────────────────

/**
 * Every field name that would make a saved item a second door onto the thread.
 *
 * Each one RESOLVES TO SOMETHING the caller's own thread read would have to
 * authorize separately: another message, a page of the thread, the roster, or
 * a payload only another recipient is entitled to.
 */
export const SAVED_MESSAGE_SECOND_DOOR_FIELDS = [
  // A pointer at another message.
  "replyToId",
  "reply_to_id",
  "replyToMessageId",
  "replyTo",
  "quotedMessage",
  // A handle for paging the thread from here.
  "sequence",
  "cursor",
  "beforeId",
  "afterId",
  "nextCursor",
  // The thread itself, rather than the one message.
  "participants",
  "members",
  "threadTitle",
  "thread_title",
  // Payloads belonging to somebody else's read.
  "ciphertext",
  "translatedBodyJson",
  "translated_body_json",
] as const;

export type SecondDoorResult = { ok: true } | { ok: false; field: string };

/** REFUSES a saved-item payload carrying any second door. Refuses; does not strip. */
export function assertNoSecondDoor(payload: unknown): SecondDoorResult {
  if (!payload || typeof payload !== "object") return { ok: true };
  for (const field of SAVED_MESSAGE_SECOND_DOOR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) return { ok: false, field };
  }
  return { ok: true };
}

// ── Unsave ───────────────────────────────────────────────────────────────────

export type UnsaveOutcome =
  | { status: "unsaved" }
  | { status: "not_saved" }
  | { status: "error"; message: string };

/**
 * Remove ONE of the caller's own saves. Idempotent: unsaving something that is
 * not saved is `not_saved`, not an error.
 *
 * Deliberately NOT re-authorized — see the module header. The filter names the
 * caller's own user id, so this can reach no other person's row.
 *
 * supabase-js RESOLVES on a database failure rather than throwing, so the
 * error is bound and judged. Reporting a failed delete as `not_saved` would
 * tell the owner their save is gone while it is still in the table, and they
 * would have no reason to try again.
 */
export async function unsaveMessage(
  sc: SupabaseClient,
  userId: string,
  messageId: string,
): Promise<UnsaveOutcome> {
  const { data, error } = await sc
    .from("saved_messages")
    .delete()
    .eq("user_id", userId)
    .eq("message_id", messageId)
    .select("message_id");

  if (error) return { status: "error", message: error.message ?? "delete failed" };
  const removed = Array.isArray(data) ? data.length : data ? 1 : 0;
  return removed > 0 ? { status: "unsaved" } : { status: "not_saved" };
}
