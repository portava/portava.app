/**
 * Telegraph §12 — `conversation_members`, as a type that does not lie.
 *
 * §12's row: "conversation_members — Membership intervals, role, visible
 * sequence bounds, delivered/seen sequences."
 *
 * The table that plays this part is `message_thread_members`
 * (baseline/20260819_baseline_structure.sql:7495-7505) plus `visible_from_at`
 * from migration 2400. It has TWO of the four properties in the shape §12 asks
 * for and two in a DIFFERENT shape or not at all, and this contract says which
 * is which rather than declaring the spec's fields and leaving them undefined:
 *
 *   intervals          joined_at / left_at            — present.
 *   role               'member' | 'admin', CHECKed    — present.
 *   visible bounds     visible_from_at, a TIMESTAMP   — half. There is no
 *                      sequence column anywhere in this repository and no
 *                      visible_UNTIL bound under any name (census T210).
 *   delivered/seen     last_read_at, a TIMESTAMP      — half. `seen` exists as
 *                      a timestamp; there is NO DELIVERED counterpart at all
 *                      (census T72).
 *
 * A contract that declared `visibleUntilSequence?: bigint` would be a field
 * every caller must treat as always-undefined, and the first caller to forget
 * would silently unbound a window. So the two missing properties are named in
 * `UNIMPLEMENTED_MEMBER_BOUNDS` — a list, readable at runtime, with the census
 * row that measured each — and they are NOT fields.
 *
 * ── WHY A TIMESTAMP AND NOT A SEQUENCE ──────────────────────────────────────
 * Migration 2400's header settles it: `created_at` is the ordering and
 * pagination key every reader already uses, there is no per-conversation
 * sequence column, and if one is ever introduced `visible_from_at` maps onto it
 * monotonically. The divergence is deliberate and recorded, not an oversight.
 *
 * THIS IS A SHAPE, NOT A GATE. The §14.3 window predicate lives in exactly one
 * place — services/groupChatHistoryBound.ts — and this module delegates to it
 * rather than re-deriving it. Two copies of an authorization rule is worse than
 * an import.
 */

import { withinWindow } from "../../../services/groupChatHistoryBound.js";

// ── Conversation type ────────────────────────────────────────────────────────

/**
 * The three the database permits, verbatim from
 * `message_threads_thread_type_check` / `thread_type_enum`
 * (src/lib/database.types.ts: "direct" | "trip" | "circle"). §12 calls the
 * aggregate `conversations`; the table is `message_threads`.
 */
export const CONVERSATION_TYPES = ["direct", "trip", "circle"] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export function isConversationType(value: unknown): value is ConversationType {
  return typeof value === "string" && (CONVERSATION_TYPES as readonly string[]).includes(value);
}

/** A DIRECT conversation is a two-party conversation. §14.3 depends on this number. */
export const DIRECT_CONVERSATION_MEMBER_COUNT = 2;

// ── Role ─────────────────────────────────────────────────────────────────────

/** `message_thread_members_role_check` permits exactly these two. */
export const MEMBERSHIP_ROLES = ["member", "admin"] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === "string" && (MEMBERSHIP_ROLES as readonly string[]).includes(value);
}

// ── The member ───────────────────────────────────────────────────────────────

/**
 * §12's "membership interval". OPEN while `leftAt` is null.
 *
 * The primary key is (thread_id, user_id), so a member who leaves and rejoins
 * REUSES THE SAME ROW: the history is one row with a moving interval, not an
 * append-only log of intervals. That is why `visibleFromAt` is re-stamped by
 * 2400's trigger on rejoin, and why nothing in this repository can answer
 * "when was this person previously a member".
 */
export interface MembershipInterval {
  joinedAt: string;
  leftAt: string | null;
}

export interface ConversationMember {
  conversationId: string;
  userId: string;
  role: MembershipRole;
  interval: MembershipInterval;
  /** §14.3 lower bound. null = unbounded (a row predating 2400, or a policy grant). */
  visibleFromAt: string | null;
  /** §12's "seen". A timestamp, not a sequence. */
  lastReadAt: string | null;
  mutedAt: string | null;
  archivedAt: string | null;
}

/**
 * The two properties §12 asks for that no column in this repository supplies.
 * Named here so a reader of the type learns it from the type.
 */
export const UNIMPLEMENTED_MEMBER_BOUNDS: ReadonlyArray<{ property: string; census: string; why: string }> = [
  {
    property: "visibleUntilSequence",
    census: "T210",
    why: "No sequence column exists, and no upper bound exists under any name. A member's window has a floor and no ceiling.",
  },
  {
    property: "lastDeliveredSequence",
    census: "T72",
    why: "last_read_at is the SEEN half only. Nothing records delivery, so 'delivered' cannot be distinguished from 'sent'.",
  },
];

/** A `message_thread_members` row, as the readers select it. */
export interface ConversationMemberRow {
  thread_id: string;
  user_id: string;
  role?: string | null;
  joined_at?: string | null;
  left_at?: string | null;
  visible_from_at?: string | null;
  last_read_at?: string | null;
  muted_at?: string | null;
  archived_at?: string | null;
}

/**
 * Map a row to the contract.
 *
 * An unrecognised role reads as `member`, the database default and the LOWER
 * privilege — a row whose role is corrupt must not be promoted to admin by a
 * mapper.
 */
export function memberFromRow(row: ConversationMemberRow): ConversationMember {
  return {
    conversationId: row.thread_id,
    userId: row.user_id,
    role: isMembershipRole(row.role) ? row.role : "member",
    interval: { joinedAt: row.joined_at ?? "", leftAt: row.left_at ?? null },
    visibleFromAt: row.visible_from_at ?? null,
    lastReadAt: row.last_read_at ?? null,
    mutedAt: row.muted_at ?? null,
    archivedAt: row.archived_at ?? null,
  };
}

/** ACTIVE means the interval is open. Every reader's `.is('left_at', null)`, as a predicate. */
export function isActiveMember(member: Pick<ConversationMember, "interval">): boolean {
  return member.interval.leftAt === null;
}

/**
 * Whether a message created at `createdAt` is inside this member's §14.3
 * window, when the bound is in force.
 *
 * Delegates to the one window predicate. A DEPARTED member is outside every
 * window regardless of the bound: leaving ends the authorization, and a reader
 * that checked only the bound would serve a departed member the whole thread
 * the moment the flag was off.
 */
export function memberCanReadMessageAt(
  member: Pick<ConversationMember, "interval" | "visibleFromAt">,
  createdAt: string | null | undefined,
  boundEnabled: boolean,
): boolean {
  if (!isActiveMember(member)) return false;
  return withinWindow(createdAt, boundEnabled ? member.visibleFromAt : null);
}

// ── Invariants over one member ───────────────────────────────────────────────

export type MembershipViolation =
  | "missing_joined_at"
  | "left_before_joined"
  | "visible_from_before_joined"
  | "unknown_role";

export interface MembershipCheck {
  ok: boolean;
  violations: MembershipViolation[];
}

/**
 * The invariants a membership row must satisfy.
 *
 * `visible_from_before_joined` is the one worth explaining: 2400's trigger sets
 * `visible_from_at := COALESCE(explicit, joined_at, now())` on INSERT and
 * re-stamps it to `now()` on a rejoin, so a bound EARLIER than the interval's
 * start can only come from a writer that set it by hand — which is exactly how
 * a "policy grant" of pre-membership history would look, and exactly how an
 * accidental unbounding would look too. This reports it; it does not decide
 * which one it is, because only the writer knows.
 */
export function checkMembershipInvariants(member: ConversationMember): MembershipCheck {
  const violations: MembershipViolation[] = [];
  const joined = Date.parse(member.interval.joinedAt);

  if (!member.interval.joinedAt || Number.isNaN(joined)) violations.push("missing_joined_at");
  if (!isMembershipRole(member.role)) violations.push("unknown_role");

  if (!Number.isNaN(joined) && member.interval.leftAt) {
    const left = Date.parse(member.interval.leftAt);
    if (!Number.isNaN(left) && left < joined) violations.push("left_before_joined");
  }
  if (!Number.isNaN(joined) && member.visibleFromAt) {
    const vf = Date.parse(member.visibleFromAt);
    if (!Number.isNaN(vf) && vf < joined) violations.push("visible_from_before_joined");
  }

  return { ok: violations.length === 0, violations };
}
