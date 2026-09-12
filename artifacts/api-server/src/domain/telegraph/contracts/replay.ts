/**
 * Telegraph §30A.18 — the replay simulator's contracts.
 *
 * "Build a Telegraph replay simulator that permutes message send, disconnect,
 * unsend, reconnect, member removal, location expiry, Plan changes, blocking,
 * translation completion, and media completion, then verifies deterministic
 * final state."
 *
 * WHAT THIS IS AND IS NOT — say it here, once, in the contract
 * -----------------------------------------------------------
 * It is a model of Telegraph's TRANSPORT, not a copy of its routes. A simulator
 * that re-implemented the handlers would prove only that two implementations of
 * the same idea agree, which is the classic way a test suite becomes a mirror.
 *
 * So every decision in this model that a SHIPPED function already makes is
 * delegated to that function:
 *
 *   history windows      services/groupChatHistoryBound.withinWindow / visibleFromOf
 *   block enforcement    lib/blockGuard.isBlockedBetween (the real fail-closed one)
 *   availability expiry  services/passport/OpenToPlansService.isVisibleTo
 *   location precision   lib/tripCrewLocation.buildCrewCard + the §27.1 lattice
 *
 * What the model owns is the part no single function owns: the ORDER things
 * happen in, and what the world looks like afterwards. That is exactly the part
 * §30A.18 is about, and it is the part no unit test can reach.
 */

/** The ten operations §30A.18 names, in its order. */
export type ReplayCommandKind =
  | "SEND"
  | "DISCONNECT"
  | "UNSEND"
  | "RECONNECT"
  | "REMOVE_MEMBER"
  | "LOCATION_EXPIRE"
  | "PLAN_CHANGE"
  | "BLOCK"
  | "TRANSLATION_COMPLETE"
  | "MEDIA_COMPLETE";

export interface ReplayCommand {
  readonly kind: ReplayCommandKind;
  /** Logical clock tick. Assigned by the engine, never by a caller. */
  readonly at: number;
  readonly actor: string;
  readonly threadId?: string;
  readonly targetUserId?: string;
  readonly messageId?: string;
  readonly planId?: string;
  /** SEND only: whether the sender attached media that is not yet processed. */
  readonly withMedia?: boolean;
}

export type ReplayEventKind =
  | "message.created"
  | "message.unsent"
  | "message.unsend_refused"
  | "message.delivered"
  | "message.seen"
  | "message.translated"
  | "media.ready"
  | "connection.dropped"
  | "connection.restored"
  | "member.removed"
  | "location.expired"
  | "plan.changed"
  | "user.blocked"
  | "send.refused";

export interface ReplayEvent {
  readonly kind: ReplayEventKind;
  readonly at: number;
  readonly actor: string;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly targetUserId?: string;
  readonly planId?: string;
  /** Why a refusal happened. Always present on a *_refused / refused event. */
  readonly reason?: string;
  /**
   * message.created only: whether the send carried media awaiting processing.
   *
   * It is on the EVENT rather than inferred at fold time, and that was a
   * finding rather than a design: the first version omitted it, and the
   * rebuildability property failed on 120 of 720 permutations with a message
   * whose media status the log could not reconstruct. A projection is only
   * rebuildable if the events carry the facts — an event that omits one is a
   * projection that can only be rebuilt by also having the state.
   */
  readonly withMedia?: boolean;
}

export interface ReplayMessage {
  readonly id: string;
  readonly threadId: string;
  readonly senderId: string;
  readonly createdAt: number;
  unsentAt: number | null;
  /** Recipients who have a receipt for this message. Order-independent. */
  seenBy: string[];
  /** Recipients the realtime layer actually reached. */
  deliveredTo: string[];
  translationStatus: "none" | "pending" | "done";
  mediaStatus: "none" | "processing" | "ready";
}

export interface ReplayMembership {
  readonly threadId: string;
  readonly userId: string;
  joinedAt: number;
  leftAt: number | null;
  /** The §14.3 window bound, as a logical tick or null for unbounded. */
  visibleFrom: number | null;
}

export interface ReplayLocationShare {
  readonly ownerId: string;
  expiresAt: number;
  level: "city_only" | "neighborhood" | "nearby";
  revoked: boolean;
}

export interface ReplayState {
  clock: number;
  messages: Record<string, ReplayMessage>;
  memberships: Record<string, ReplayMembership>;
  /** "a|b" with a < b, so a block is one entry whichever direction it came from. */
  blocks: string[];
  connected: Record<string, boolean>;
  plans: Record<string, { version: number; status: string }>;
  locationShares: Record<string, ReplayLocationShare>;
}
