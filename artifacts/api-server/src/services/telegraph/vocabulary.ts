/**
 * Telegraph shared vocabulary — the named enumerations §3.4, §5, §6.2, §8.1
 * and §9.1 require, in one module so every surface that speaks them agrees.
 *
 * Spec (v1 and v1_1 — v1_1's shared body is byte-identical to v1, verified in
 * `docs/architecture/census-telegraph.md` §2):
 *   §3.4  `SharedContextItem.objectType: TelegraphObjectType`,
 *         `availableActions: TelegraphAction[]`
 *   §6.2  the thirteen message kinds
 *   §8.1  the fourteen native actions
 *   §9    PREPARING -> ASSEMBLING -> ACTIVE -> RETURNING -> COMPLETE
 *         with DISRUPTED / CANCELLED as exits
 *   §9.1  the seven quick states
 *
 * WHY A VOCABULARY MODULE AND NOT A TABLE. Appendix A is explicit that the
 * spec's schema names are "architectural names, not permission to create
 * duplicate tables if equivalent canonical structures already exist". These
 * enumerations are names for things the tree already stores — a trip is
 * `trips`, a meetup is `meetups`, a check-in is `circle_presence` — so they
 * live in the type system, where a wrong value is a compile error, and not in
 * a lookup table nothing would enforce.
 *
 * Everything here is pure data and pure functions: no client, no I/O, no
 * environment. It is therefore true on every deployment of this tree.
 */

// -- §3.4 object types -------------------------------------------------------

/**
 * The object families §5 names (Social / Travel / Places / Services / Media),
 * flattened to the concrete types a Shared Context item or a share can carry.
 */
export const TELEGRAPH_OBJECT_TYPES = [
  // Travel
  "TRIP",
  "TRIP_STAGE",
  "PLAN",
  "EVENT",
  "MEETUP",
  "ROUTE",
  "BOOKING",
  // Places
  "PLACE",
  "HIDDEN_GEM",
  "MAP_PIN",
  "NEIGHBORHOOD",
  "MEETUP_POINT",
  // Social
  "PROFILE",
  "POST",
  "HIGHLIGHT",
  "MEMORY",
  "MEMORY_NOTE",
  "STAMP",
  // Services
  "BUDDY_SERVICE",
  "VISA_CARD",
  // Promoted-but-uncommitted (§3.1 bullet 4, §3.3 "UNRESOLVED / WANT TO DO")
  "WANT_TO_DO",
] as const;

export type TelegraphObjectType = (typeof TELEGRAPH_OBJECT_TYPES)[number];

export function isTelegraphObjectType(v: unknown): v is TelegraphObjectType {
  return typeof v === "string" && (TELEGRAPH_OBJECT_TYPES as readonly string[]).includes(v);
}

// -- §3.1 relationships ------------------------------------------------------

/**
 * §3.1's four eligibility clauses, as the four values
 * `SharedContextItem.relationship` can take. There is deliberately no fifth
 * value for "someone mentioned it in the thread": §3.2 forbids inferring
 * mutuality from chat, and one half of how that prohibition is enforced here
 * is that the vocabulary cannot say it. The other half is
 * `sharedContext.ts#admitCandidate`, which refuses a candidate whose evidence
 * is not one of these four.
 */
export const SHARED_RELATIONSHIPS = [
  /** §3.1 - created by me and joined/saved/attended by the other participant. */
  "CREATED_BY_ME_JOINED_BY_THEM",
  /** §3.1 - created by them and joined/saved/attended by me. */
  "CREATED_BY_THEM_JOINED_BY_ME",
  /** §3.1 - both are members/participants of the same Trip, Plan, Crew, Event or booking. */
  "BOTH_PARTICIPANTS",
  /** §3.1 - both deliberately promoted the item into a shared wishlist / Want-to-Do state. */
  "BOTH_PROMOTED",
] as const;

export type SharedRelationship = (typeof SHARED_RELATIONSHIPS)[number];

export function isSharedRelationship(v: unknown): v is SharedRelationship {
  return typeof v === "string" && (SHARED_RELATIONSHIPS as readonly string[]).includes(v);
}

// -- §8.1 native actions -----------------------------------------------------

/** §8.1's fourteen native actions, verbatim and in the spec's order. */
export const TELEGRAPH_ACTIONS = [
  "ADD_TO_TRIP",
  "CREATE_PLAN",
  "JOIN_PLAN",
  "LEAVE_PLAN",
  "MEET_HERE",
  "SHARE_PLACE",
  "SHARE_ROUTE",
  "VOTE",
  "SHARE_AVAILABILITY",
  "SHARE_LOCATION",
  "SPLIT_RIDE",
  "CHECK_IN_SAFE",
  "RETURN_TO_GROUP",
  "DO_THIS_NOW",
] as const;

export type TelegraphAction = (typeof TELEGRAPH_ACTIONS)[number];

export function isTelegraphAction(v: unknown): v is TelegraphAction {
  return typeof v === "string" && (TELEGRAPH_ACTIONS as readonly string[]).includes(v);
}

// -- §6.2 message kinds ------------------------------------------------------

/** §6.2's thirteen message kinds, verbatim and in the spec's order. */
export const TELEGRAPH_MESSAGE_KINDS = [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "MEDIA_ALBUM",
  "GIF",
  "VOICE",
  "MEMORY_NOTE",
  "PORTAVA_OBJECT",
  "LOCATION",
  "ACTION",
  "ANNOUNCEMENT",
  "SYSTEM",
  "SAFETY",
] as const;

export type TelegraphMessageKind = (typeof TELEGRAPH_MESSAGE_KINDS)[number];

export function isTelegraphMessageKind(v: unknown): v is TelegraphMessageKind {
  return typeof v === "string" && (TELEGRAPH_MESSAGE_KINDS as readonly string[]).includes(v);
}

/**
 * The wire spelling of a kind in `messages.msg_type`.
 *
 * `messages.msg_type` is `text NOT NULL DEFAULT 'text'` with NO CHECK
 * constraint (`baseline/20260819_baseline_structure.sql:7565`), so a new kind
 * needs no DDL — which is why these rows are not capped by a migration no
 * database has. The two pre-existing spellings are lower-case (`'text'`,
 * `'system'`) and are preserved exactly, because messages already in the table
 * carry them and the existing renderer switches on them.
 */
export function msgTypeOf(kind: TelegraphMessageKind): string {
  return kind.toLowerCase();
}

/** Inverse of `msgTypeOf`; unknown/legacy spellings read back as TEXT. */
export function kindOfMsgType(msgType: string | null | undefined): TelegraphMessageKind {
  if (typeof msgType !== "string") return "TEXT";
  const upper = msgType.toUpperCase();
  return isTelegraphMessageKind(upper) ? upper : "TEXT";
}

// -- §9 coordination states --------------------------------------------------

/** §9's five progress states plus the two terminal exits. */
export const COORDINATION_STATES = [
  "PREPARING",
  "ASSEMBLING",
  "ACTIVE",
  "RETURNING",
  "COMPLETE",
  "DISRUPTED",
  "CANCELLED",
] as const;

export type CoordinationState = (typeof COORDINATION_STATES)[number];

export function isCoordinationState(v: unknown): v is CoordinationState {
  return typeof v === "string" && (COORDINATION_STATES as readonly string[]).includes(v);
}

// -- §9.1 quick states -------------------------------------------------------

/** §9.1's seven quick states, verbatim. */
export const COORDINATION_QUICK_STATES = [
  "ON_MY_WAY",
  "ARRIVED",
  "RUNNING_LATE",
  "CANT_MAKE_IT",
  "START_WITHOUT_ME",
  "HEADING_BACK",
  "NEED_HELP",
] as const;

export type CoordinationQuickState = (typeof COORDINATION_QUICK_STATES)[number];

export function isCoordinationQuickState(v: unknown): v is CoordinationQuickState {
  return typeof v === "string" && (COORDINATION_QUICK_STATES as readonly string[]).includes(v);
}

/**
 * §9.1's closing sentence: "User-declared status must remain distinguishable
 * from system-derived ETA or location-derived estimates."
 *
 * Every quick state in this vocabulary is USER_DECLARED, and the type has no
 * constructor for a derived one: a derived estimate is carried in a separate
 * field by whatever produced it (`circle_presence.approximate_label`,
 * `venue_label`), never merged into the declared status. A future derived
 * status would have to add a value here, and that addition is the review.
 */
export const QUICK_STATE_PROVENANCE = "USER_DECLARED" as const;
