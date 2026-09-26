/**
 * Telegraph §14.3 — group formation: the rule, executable, before the
 * operation exists.
 *
 * §14.3, sentences two and three:
 *   "Adding a third person to a DM creates a new group; it does not expose the
 *    old DM history. Explicitly selected Plans/Places may be carried forward as
 *    new share objects."
 *
 * ── THE OPERATION DOES NOT EXIST. VERIFIED, NOT ASSUMED ─────────────────────
 * census T212 records this as an UNGUARDED ABSENCE, and it was re-verified
 * against this branch before a line of this file was written:
 *
 *   - No route adds a member to any thread. Every write to
 *     `message_thread_members` in the tree is one of four things: a two-party
 *     thread CREATE (routes/messaging.ts, the open-thread and accept-request
 *     handlers, both inserting exactly the two parties), a trip/circle
 *     membership SYNC (services/groupChatSync.ts, lib/chatSync.ts), a
 *     `left_at` / `last_read_at` / `muted_at` update, or 2400's trigger.
 *   - `thread_type` admits exactly three values — `direct`, `trip`, `circle`
 *     (message_threads_thread_type_check; src/lib/database.types.ts
 *     `thread_type_enum`). **There is no type a group formed from a DM could
 *     be created as.** The operation is not merely unrouted; the schema has no
 *     value for its result.
 *
 * Both facts are pinned by src/test/telegraphGroupTransport.test.ts, so the
 * verification re-runs on every test run instead of decaying into a claim.
 *
 * ── SO WHY WRITE THE RULE ───────────────────────────────────────────────────
 * Because T212's own last sentence is the danger: "The rule is currently
 * unviolated only because the operation is missing, and T211 shows the read
 * path would leak the moment it were added." The whole cost of §14.3 is paid on
 * the day someone adds the operation, in a change whose author is thinking
 * about adding people and not about history bounds. This module is the rule
 * they will find already written, already tested, and already shaped so the
 * wrong plan cannot be expressed:
 *
 *   - `GroupFormationPlan` has NO field for a source message, a history range,
 *     a cursor or a transcript. A group that cannot NAME the old DM's messages
 *     cannot inherit them.
 *   - Every new member's §14.3 floor is the SAME instant — the formation — so
 *     "does not expose the old DM history" is a property of the plan rather
 *     than of the reader that later applies it.
 *   - A carried-forward object references the CANONICAL Plan or Place, never
 *     the message that shared it. A message id would be a pointer back into the
 *     DM, resolvable by a person who was never in it.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────
 * It is NOT a capability, and it moves no census verdict. T212 and T213 grade
 * the OPERATION, and there still is none: nothing calls this, by design, and
 * the two blockers above have to be cleared by an owner before anything can.
 * A decider with no caller is worth exactly what it is — the rule, ready — and
 * claiming more for it would be the "architecture exists because the folder
 * exists" failure check:telegraph-package-boundaries was written to catch.
 */

import {
  DIRECT_CONVERSATION_MEMBER_COUNT,
  isConversationType,
  type ConversationType,
} from "../contracts/conversationMembership.js";

// ── What stands between this rule and a caller ───────────────────────────────

export interface GroupFormationBlocker {
  id: string;
  what: string;
  evidence: string;
}

/** Re-verified 2026-09-22 against `claude/portava-continuation-uqta94`. */
export const GROUP_FORMATION_BLOCKERS: readonly GroupFormationBlocker[] = [
  {
    id: "no_add_participant_operation",
    what: "No route adds a member to an existing thread, so there is nothing to form a group FROM a DM with.",
    evidence: "census T212; every message_thread_members writer in the tree is a create, a sync, or a left_at/last_read_at/muted_at update.",
  },
  {
    id: "no_conversation_type_for_a_formed_group",
    what: "thread_type permits only direct | trip | circle. A group formed from a DM has no type it could be created as.",
    evidence: "message_threads_thread_type_check; src/lib/database.types.ts thread_type_enum.",
  },
] as const;

// ── The carry-forward (§14.3 sentence three) ─────────────────────────────────

/** §14.3 names exactly two kinds. Not "anything the user tapped". */
export const CARRY_FORWARD_KINDS = ["PLAN", "PLACE"] as const;
export type CarryForwardKind = (typeof CARRY_FORWARD_KINDS)[number];

/** What a user EXPLICITLY selected to bring along. */
export interface CarryForwardSelection {
  kind: CarryForwardKind;
  /** The CANONICAL object's id — a Plan id, a Place id. Never a message id. */
  objectId: string;
}

/**
 * A carried-forward object in the new conversation.
 *
 * `shareProjectionVersion` is present for the same reason every other Telegraph
 * share carries one: the new group gets a PROJECTION of the object, re-derived
 * under the new audience, not the old thread's frozen card.
 */
export interface CarriedForwardObject {
  kind: CarryForwardKind;
  objectId: string;
  shareProjectionVersion: "1";
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface GroupFormationInput {
  /** The DM being left behind. */
  sourceConversationId: string;
  sourceConversationType: ConversationType | string;
  /** The source's member ids. A `direct` conversation has exactly two. */
  sourceMemberUserIds: readonly string[];
  /** The people being brought in. At least one, none already present. */
  addedUserIds: readonly string[];
  /** Explicitly selected. An empty list is valid — carrying nothing forward is allowed. */
  carryForward?: readonly CarryForwardSelection[];
  /** Formation instant, ISO-8601. Injected so the rule is testable. */
  nowIso: string;
}

export interface GroupFormationPlan {
  /** PROVENANCE ONLY. Never a history source; there is no field that could make it one. */
  sourceConversationId: string;
  /** The source pair plus the added people, deduplicated, source order first. */
  memberUserIds: string[];
  /**
   * Every member's §14.3 floor, and it is the SAME instant for all of them —
   * including the two who were in the DM. That is the sentence: the new group
   * does not expose the old DM history, to anybody, not even to the people who
   * lived it. Their copy of it is still in the DM, which still exists.
   */
  visibleFromAt: string;
  carriedForward: CarriedForwardObject[];
  /** Structural, always true, asserted by `assertNoSourceHistory`. */
  carriesNoSourceHistory: true;
}

export type GroupFormationRefusal =
  | "source_not_direct"
  | "source_not_two_party"
  | "no_added_members"
  | "added_member_already_in_source"
  | "carry_forward_kind_unsupported"
  | "carry_forward_references_a_message"
  | "invalid_formation_time";

export type GroupFormationResult =
  | { ok: true; plan: GroupFormationPlan }
  | { ok: false; refusal: GroupFormationRefusal; detail: string };

/** Field names that would turn a selection into a pointer back into the DM. */
const MESSAGE_POINTER_FIELDS = [
  "messageId",
  "message_id",
  "sourceMessageId",
  "source_message_id",
  "messageIds",
  "replyToId",
  "cursor",
  "beforeId",
  "afterId",
  "transcript",
  "messages",
  "history",
] as const;

/**
 * §14.3's group formation, as a decision.
 *
 * Returns a PLAN, not a write. Nothing here touches a database: the plan is
 * what a future add-participant operation would execute, and keeping it a value
 * is what lets the rule be tested without the operation existing.
 */
export function planGroupFormation(input: GroupFormationInput): GroupFormationResult {
  if (!isConversationType(input.sourceConversationType) || input.sourceConversationType !== "direct") {
    return {
      ok: false,
      refusal: "source_not_direct",
      detail:
        `§14.3 forms a group out of a DM. "${String(input.sourceConversationType)}" is not a direct conversation; ` +
        "a trip or circle thread gets its members from its trip or circle.",
    };
  }

  const sourceMembers = Array.from(new Set(input.sourceMemberUserIds));
  if (sourceMembers.length !== DIRECT_CONVERSATION_MEMBER_COUNT) {
    return {
      ok: false,
      refusal: "source_not_two_party",
      detail:
        `A direct conversation has exactly ${DIRECT_CONVERSATION_MEMBER_COUNT} members; this one presented ` +
        `${sourceMembers.length}. Refusing rather than guessing which of them the group is formed from.`,
    };
  }

  const added = Array.from(new Set(input.addedUserIds));
  if (added.length === 0) {
    return { ok: false, refusal: "no_added_members", detail: "Group formation adds at least one person." };
  }
  const alreadyIn = added.find((id) => sourceMembers.includes(id));
  if (alreadyIn) {
    return {
      ok: false,
      refusal: "added_member_already_in_source",
      detail:
        `${alreadyIn} is already in the direct conversation. Re-adding a party is not group formation, and ` +
        "treating it as one would create a second conversation between the same two people.",
    };
  }

  const at = Date.parse(input.nowIso);
  if (!input.nowIso || Number.isNaN(at)) {
    return {
      ok: false,
      refusal: "invalid_formation_time",
      detail:
        "The formation instant IS every member's §14.3 floor. An unparseable one would produce a window " +
        "predicate that admits everything, so it is refused rather than defaulted.",
    };
  }

  const carriedForward: CarriedForwardObject[] = [];
  for (const selection of input.carryForward ?? []) {
    for (const field of MESSAGE_POINTER_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(selection as object, field)) {
        return {
          ok: false,
          refusal: "carry_forward_references_a_message",
          detail:
            `A carried-forward object may not carry "${field}". §14.3 carries the Plan or the Place forward as a ` +
            "NEW share object; a message pointer would be a door into the DM for someone who was never in it.",
        };
      }
    }
    if (!(CARRY_FORWARD_KINDS as readonly string[]).includes(selection.kind)) {
      return {
        ok: false,
        refusal: "carry_forward_kind_unsupported",
        detail: `§14.3 carries forward Plans and Places. "${String(selection.kind)}" is neither.`,
      };
    }
    carriedForward.push({ kind: selection.kind, objectId: selection.objectId, shareProjectionVersion: "1" });
  }

  return {
    ok: true,
    plan: {
      sourceConversationId: input.sourceConversationId,
      memberUserIds: [...sourceMembers, ...added],
      visibleFromAt: input.nowIso,
      carriedForward,
      carriesNoSourceHistory: true,
    },
  };
}

export type SourceHistoryResult = { ok: true } | { ok: false; field: string };

/**
 * REFUSES a formation plan that names the source conversation's content.
 *
 * `planGroupFormation` cannot produce such a plan — the type has no field for
 * it. This exists for the plan that did not come from there: a hand-built one,
 * a deserialized one, a plan a future route accepted from a client.
 */
export function assertNoSourceHistory(plan: unknown): SourceHistoryResult {
  if (!plan || typeof plan !== "object") return { ok: true };
  for (const field of MESSAGE_POINTER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(plan, field)) return { ok: false, field };
  }
  return { ok: true };
}
