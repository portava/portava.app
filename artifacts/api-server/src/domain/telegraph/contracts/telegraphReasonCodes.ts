/**
 * Telegraph §13/§14 — the refusal vocabulary, in one place.
 *
 * WHY THIS FILE EXISTS
 * ====================
 * census-telegraph T207 measured the shape of the problem: every Telegraph
 * refusal reaches the client as a bare `forbidden` / `db_error` /
 * `degraded_unavailable`, so a client cannot tell "you are not in this
 * conversation" from "this conversation is archived" from "the block table was
 * unreadable and we refused rather than guess". The BEHAVIOUR was right and the
 * REASON was unreported, which is exactly the state census-trips TR441-TR451
 * found in the trip domain before `domain/trips/contracts/tripReasonCodes.ts`
 * was written. This is the Telegraph twin of that module, deliberately built
 * the same way so the two vocabularies read alike.
 *
 * DECLARED IS NOT EMITTED
 * =======================
 * A code in this list is a name, not a capability. `src/test/
 * telegraphReasonCodes.test.ts` reads the policy module as TEXT and proves the
 * codes it emits are a SUBSET of this list, so a reason invented at a call site
 * and not declared here is a failing test rather than a silent second
 * vocabulary. It does NOT prove every code below is emitted — several are
 * declared for refusals whose subsystem does not exist yet (broadcast,
 * in-conversation payment), and the census grades those as declared-not-emitted
 * rather than as credit.
 *
 * INTERNAL-ONLY REASONS
 * =====================
 * Some reasons are true and must not be told. `TELEGRAPH_AUTH_BLOCKED` is the
 * clear case: telling a blocked sender "you are blocked" reveals the block,
 * which is the one fact the block exists to keep. The policy returns the honest
 * reason so the ROUTE can decide what to say; `isInternalTelegraphReason`
 * marks the codes that must never be put on the wire, and `redactForWire`
 * replaces them rather than leaking — because a leak here is a privacy defect
 * and the alternative (throwing) turns a privacy defect into a 500 someone
 * notices.
 */

export const TELEGRAPH_REASON_FAMILIES = [
  "TELEGRAPH_AUTH",
  "TELEGRAPH_POLICY",
  "TELEGRAPH_LIFECYCLE",
  "TELEGRAPH_HISTORY",
  "TELEGRAPH_LOCATION",
  "TELEGRAPH_SAFETY",
  "TELEGRAPH_ABUSE",
  "TELEGRAPH_MEDIA",
  "TELEGRAPH_DEGRADED",
] as const;
export type TelegraphReasonFamily = (typeof TELEGRAPH_REASON_FAMILIES)[number];

export const TELEGRAPH_REASON_CODES = [
  // ── TELEGRAPH_AUTH_* — who you are relative to the conversation ───────────
  "TELEGRAPH_AUTH_UNAUTHENTICATED",      // no verified user
  "TELEGRAPH_AUTH_NOT_MEMBER",           // no active message_thread_members row
  "TELEGRAPH_AUTH_LEFT_THREAD",          // membership row exists with left_at set
  "TELEGRAPH_AUTH_BLOCKED",              // INTERNAL ONLY — see header
  "TELEGRAPH_AUTH_NOT_TRIP_MEMBER",      // trip thread, viewer not an accepted crew member
  "TELEGRAPH_AUTH_NOT_SENDER",           // acting on a message someone else sent
  "TELEGRAPH_AUTH_NOT_THREAD_ADMIN",     // role is 'member' where 'admin' is required

  // ── TELEGRAPH_POLICY_* — the conversation's own rules ─────────────────────
  "TELEGRAPH_POLICY_THREAD_ARCHIVED",    // message_threads.status <> 'active'
  "TELEGRAPH_POLICY_RECIPIENT_PRIVACY",  // profiles.message_privacy refuses this pair
  "TELEGRAPH_POLICY_REQUEST_REQUIRED",   // a message_request must be accepted first
  "TELEGRAPH_POLICY_DM_INVITE_FORMS_NEW_GROUP", // §14.3: adding a third party makes a NEW group
  "TELEGRAPH_POLICY_MEMBERSHIP_DERIVED", // trip/circle rosters come from the source domain
  "TELEGRAPH_POLICY_NO_IN_CHAT_PAYMENT", // §20: no chat mutation of price/terms
  "TELEGRAPH_POLICY_NO_BROADCAST",       // §14.1 canBroadcast — no broadcast primitive exists
  "TELEGRAPH_POLICY_E2EE_PLAINTEXT_REFUSED", // an E2EE thread will not store a plaintext body

  // ── TELEGRAPH_LIFECYCLE_* — the message's own state ───────────────────────
  "TELEGRAPH_LIFECYCLE_ALREADY_DELETED",
  "TELEGRAPH_LIFECYCLE_ALREADY_UNSENT",
  "TELEGRAPH_LIFECYCLE_SEEN_BY_RECIPIENT",   // §7.4: an unsend after a recipient has seen it
  "TELEGRAPH_LIFECYCLE_UNSEND_WINDOW_CLOSED",
  "TELEGRAPH_LIFECYCLE_NOT_EDITABLE",

  // ── TELEGRAPH_HISTORY_* — §14.3 window bounds ────────────────────────────
  "TELEGRAPH_HISTORY_BEFORE_WINDOW",     // the row is older than visible_from
  "TELEGRAPH_HISTORY_AFTER_WINDOW",      // the row is newer than visible_until
  "TELEGRAPH_HISTORY_BOUND_UNKNOWN",     // the bound could not be read

  // ── TELEGRAPH_LOCATION_* — §15 purpose-bound location ────────────────────
  "TELEGRAPH_LOCATION_NO_ACTIVE_GRANT",  // no live share covers this conversation
  "TELEGRAPH_LOCATION_PRECISION_CEILING",// the grant's precision is below EXACT
  "TELEGRAPH_LOCATION_PURPOSE_MISMATCH", // §15.1: a grant may not be reused for another purpose
  "TELEGRAPH_LOCATION_EXPIRED",

  // ── TELEGRAPH_SAFETY_* — trust and safety state ──────────────────────────
  "TELEGRAPH_SAFETY_TRUST_RESTRICTED",   // trust_restrictions denies the capability
  "TELEGRAPH_SAFETY_ACCOUNT_SUSPENDED",
  "TELEGRAPH_SAFETY_MODE_ELEVATED",      // safety mode is SAFETY_ATTENTION or SAFETY_EVENT

  // ── TELEGRAPH_ABUSE_* — §22 controls ─────────────────────────────────────
  "TELEGRAPH_ABUSE_RATE_LIMITED",
  "TELEGRAPH_ABUSE_OFF_APP_SOLICITATION",
  "TELEGRAPH_ABUSE_SCAM_SIGNAL",
  "TELEGRAPH_ABUSE_UNTRUSTED_LINK",

  // ── TELEGRAPH_MEDIA_* — §16 ──────────────────────────────────────────────
  "TELEGRAPH_MEDIA_KIND_NOT_ALLOWED",
  "TELEGRAPH_MEDIA_STRANGER_NOT_ACCEPTED", // §22 stranger media, not yet accepted

  // ── TELEGRAPH_DEGRADED_* — we could not decide ───────────────────────────
  "TELEGRAPH_DEGRADED_MEMBERSHIP_UNREADABLE",
  "TELEGRAPH_DEGRADED_BLOCKS_UNREADABLE",
  "TELEGRAPH_DEGRADED_THREAD_UNREADABLE",
  "TELEGRAPH_DEGRADED_TRUST_UNREADABLE",
  "TELEGRAPH_DEGRADED_SCHEMA_ABSENT",    // the column/table this answer needs is not migrated
] as const;

export type TelegraphReason = (typeof TELEGRAPH_REASON_CODES)[number];

const CODES = new Set<string>(TELEGRAPH_REASON_CODES);

/** Is `code` a declared Telegraph reason? Used by the route and by the test. */
export function isTelegraphReason(code: string): code is TelegraphReason {
  return CODES.has(code);
}

/** The family prefix of a reason, for metrics that group by family. */
export function telegraphReasonFamily(code: TelegraphReason): TelegraphReasonFamily {
  const parts = code.split("_");
  return `${parts[0]}_${parts[1]}` as TelegraphReasonFamily;
}

/**
 * Reasons that are TRUE and must never be sent to a client.
 *
 * Only one today, and it is the important one: revealing a block reveals the
 * blocker's decision to the person it was made about.
 */
export const INTERNAL_ONLY_TELEGRAPH_REASONS: ReadonlySet<TelegraphReason> = new Set([
  "TELEGRAPH_AUTH_BLOCKED",
]);

export function isInternalTelegraphReason(code: TelegraphReason): boolean {
  return INTERNAL_ONLY_TELEGRAPH_REASONS.has(code);
}

/**
 * The wire form of a reason: internal-only codes become the indistinguishable
 * public code, everything else passes through.
 *
 * `TELEGRAPH_AUTH_BLOCKED` becomes `TELEGRAPH_AUTH_NOT_MEMBER`, which is the
 * answer a non-member already gets — so a blocked user and a stranger see the
 * same refusal and neither learns which they are.
 */
export function redactForWire(code: TelegraphReason): TelegraphReason {
  return isInternalTelegraphReason(code) ? "TELEGRAPH_AUTH_NOT_MEMBER" : code;
}
