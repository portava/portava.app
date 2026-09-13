/**
 * Telegraph share authorization — the fail-closed gate for §26's private-source
 * case, §29's Memory prohibition and §30A.10's capability contract.
 *
 * THE PROBLEM THIS CLOSES
 * -----------------------
 * The census recorded three of this area's requirements as UNGUARDED ABSENCES:
 * "no Memory share path exists, so the case cannot arise and nothing guards it"
 * (T317, T358), and "a source object shared in Telegraph cannot grant broader
 * access than its authorized share projection" (T445). An absence is not a
 * guarantee — it is the absence of a violation, which is a different thing and
 * lasts exactly until someone adds the fourth share producer. Four already
 * exist, each hand-rolling its own payload (T35), and none of them asks anyone
 * whether the object may be shared at all.
 *
 * WHAT THIS IS
 * ------------
 * A pure decision function plus a producer registry. It decides one question —
 * may THIS object family be projected into a conversation for THESE viewers? —
 * and it is fail-closed on every axis:
 *
 *   - An object family it does not recognise is REFUSED. A new share producer
 *     cannot obtain an allow by inventing a family name.
 *   - A PRIVATE_SOURCE family (Memory, private trip, DM content, private
 *     Highlight) is refused unless the caller presents a derivative
 *     authorization that the OWNING DOMAIN issued, scoped to Telegraph
 *     sharing, and not expired at the instant of the decision.
 *   - A grant whose issuing domain is not the source's domain is refused.
 *     That is §29's "no semantic ID substitution across domains" applied to
 *     authorization: a Memories grant cannot authorize a Trips object because
 *     the ids look alike.
 *   - A share with no resolvable source id is refused, because a card that
 *     cannot name its source can never be revoked with it.
 *
 * WHAT MAKES IT MORE THAN A FUNCTION NOBODY CALLS
 * ----------------------------------------------
 * `src/scripts/checkTelegraphShareProducers.ts` enumerates every message
 * msg_type / subtype literal in both trees and requires each to be declared in
 * TELEGRAPH_SHARE_PRODUCERS below. A producer declared PRIVATE_SOURCE must name
 * the module that calls this policy, and the guard verifies the call is really
 * there. So a Memory share cannot be added without either routing through this
 * gate or turning CI red — which is the difference between a prohibition that
 * is constructed and one that merely has not been violated yet.
 */

/**
 * How much authorization a share of this object family needs.
 *
 * The names describe the SOURCE's disclosure state, not the card's appearance,
 * because that is the thing the decision turns on.
 */
export type ShareObjectFamily =
  /** Already visible to anyone who can see the source surface. Sharing discloses nothing new. */
  | "PUBLIC"
  /** Visible only to an audience the source domain controls; a share needs that domain's grant. */
  | "AUDIENCE_SCOPED"
  /** Private canonical content — Memories, private Highlights, DM content, private trips. */
  | "PRIVATE_SOURCE"
  /** Telegraph's own operational chrome (call receipts, system notices). Carries no source object. */
  | "OPERATIONAL";

/** A derivative authorization issued BY the owning domain FOR a Telegraph share. */
export interface ShareDerivativeGrant {
  /** The domain that issued it — must equal the source object's domain. */
  readonly issuedByDomain: string;
  /** The derivative's own id. Never the private source's id. */
  readonly derivativeId: string;
  /** Scope the grant was issued for. Anything but "telegraph_share" is refused. */
  readonly scope: string;
  /** ISO instant the grant stops being valid, or null for a grant with no expiry. */
  readonly expiresAt: string | null;
}

export interface ShareAuthorizationRequest {
  /** Declared family. An unrecognised value is refused, not defaulted. */
  readonly family: string;
  /** The domain that owns the canonical object ("memories", "trips", "discovery", …). */
  readonly sourceDomain: string;
  /** Canonical id of the source object, or null when the producer cannot resolve one. */
  readonly sourceId: string | null;
  /** The conversation's current audience. An empty audience is refused. */
  readonly viewerIds: readonly string[];
  /** The owning domain's grant, when the family requires one. */
  readonly derivativeGrant?: ShareDerivativeGrant | null;
  /** Decision instant; injectable so expiry is testable without waiting. */
  readonly nowMs?: number;
}

export type ShareRefusalReason =
  | "unknown_family"
  | "no_source_id"
  | "empty_audience"
  | "private_source_without_derivative"
  | "audience_scoped_without_grant"
  | "grant_wrong_scope"
  | "grant_domain_mismatch"
  | "grant_expired"
  | "grant_names_source_id";

export type ShareAuthorization =
  | { readonly allowed: true; readonly family: ShareObjectFamily; readonly disclosedId: string }
  | { readonly allowed: false; readonly reason: ShareRefusalReason };

const KNOWN_FAMILIES: readonly ShareObjectFamily[] = [
  "PUBLIC",
  "AUDIENCE_SCOPED",
  "PRIVATE_SOURCE",
  "OPERATIONAL",
];

function isKnownFamily(v: string): v is ShareObjectFamily {
  return (KNOWN_FAMILIES as readonly string[]).includes(v);
}

/**
 * Decide whether an object may be projected into a Telegraph conversation.
 *
 * Total and synchronous on purpose: an authorization decision that can throw is
 * an authorization decision whose failure mode is a caller's `catch`, and this
 * repository has measured what that costs. Every refusal is a returned value.
 */
export function authorizeTelegraphShare(
  req: ShareAuthorizationRequest,
): ShareAuthorization {
  const now = req.nowMs ?? Date.now();

  if (!isKnownFamily(req.family)) return { allowed: false, reason: "unknown_family" };
  const family = req.family;

  // Operational chrome carries no source object and discloses nothing about
  // one, so it is the single family that needs neither an id nor a grant. It
  // still needs an audience: a receipt addressed to nobody is a bug, not a
  // share.
  if (!req.viewerIds || req.viewerIds.length === 0) {
    return { allowed: false, reason: "empty_audience" };
  }
  if (family === "OPERATIONAL") {
    return { allowed: true, family, disclosedId: req.sourceId ?? "" };
  }

  if (!req.sourceId) return { allowed: false, reason: "no_source_id" };

  if (family === "PUBLIC") {
    return { allowed: true, family, disclosedId: req.sourceId };
  }

  const grant = req.derivativeGrant ?? null;
  if (!grant) {
    return {
      allowed: false,
      reason:
        family === "PRIVATE_SOURCE"
          ? "private_source_without_derivative"
          : "audience_scoped_without_grant",
    };
  }
  if (grant.scope !== "telegraph_share") return { allowed: false, reason: "grant_wrong_scope" };
  if (grant.issuedByDomain !== req.sourceDomain) {
    return { allowed: false, reason: "grant_domain_mismatch" };
  }
  if (grant.expiresAt !== null) {
    const exp = Date.parse(grant.expiresAt);
    // An unparseable expiry is an expiry we cannot honour. Refuse rather than
    // treat NaN as "never expires", which is what a naive comparison does.
    if (!Number.isFinite(exp) || exp <= now) return { allowed: false, reason: "grant_expired" };
  }
  // §30A.20: "A source object shared in Telegraph cannot grant broader access
  // than its authorized share projection." A derivative that names the PRIVATE
  // source's own id is not a derivative — it is the source wearing a grant, and
  // anything holding the card would hold the canonical id.
  if (grant.derivativeId === req.sourceId) {
    return { allowed: false, reason: "grant_names_source_id" };
  }

  // What travels is the DERIVATIVE's id, never the private source's.
  return { allowed: true, family, disclosedId: grant.derivativeId };
}

// ── Producer registry (§30A.10) ───────────────────────────────────────────────

export interface ShareProducerDeclaration {
  /** The messages.msg_type or messages.subtype literal, exactly as written. */
  readonly literal: string;
  /** Which column carries it. */
  readonly column: "msg_type" | "subtype";
  readonly family: ShareObjectFamily;
  /** The domain that owns whatever the card points at, or null for chrome. */
  readonly sourceDomain: string | null;
  /**
   * For PRIVATE_SOURCE and AUDIENCE_SCOPED producers: the repo-relative module
   * that must call authorizeTelegraphShare before the card is written. The
   * guard verifies the call exists in that file.
   */
  readonly authorizedBy: string | null;
  readonly note: string;
}

/**
 * Every message type literal either tree writes or renders.
 *
 * Seeded by enumerating the tree, not by memory: the guard re-derives the same
 * set on every run and fails on anything it finds that is not declared here.
 * A literal is listed once even when several files write it.
 */
export const TELEGRAPH_SHARE_PRODUCERS: readonly ShareProducerDeclaration[] = [
  // ── Chrome and plain content ───────────────────────────────────────────────
  { literal: "text", column: "msg_type", family: "OPERATIONAL", sourceDomain: null, authorizedBy: null,
    note: "Sender-authored prose. No source object." },
  { literal: "media", column: "msg_type", family: "OPERATIONAL", sourceDomain: null, authorizedBy: null,
    note: "Sender's own upload, authorized by thread membership and the media pipeline, not by a source domain." },
  { literal: "system", column: "msg_type", family: "OPERATIONAL", sourceDomain: null, authorizedBy: null,
    note: "Telegraph's own notices. The card SHAPE is carried by subtype, which is declared separately below." },
  // ── Source-object cards ────────────────────────────────────────────────────
  { literal: "card", column: "msg_type", family: "PUBLIC", sourceDomain: "discovery", authorizedBy: null,
    note: "Hidden-gem card written by routes/hiddenGems.ts. The gem is already publicly listable." },
  { literal: "booking_card", column: "msg_type", family: "AUDIENCE_SCOPED", sourceDomain: "rent_a_buddy",
    authorizedBy: null,
    note: "Written by routes/rentABuddy.ts into the booking's OWN thread, whose membership is the booking's two parties — the audience is the grant. Declared so a producer that writes one into any other thread is a change this registry records." },
  { literal: "circle_status_card", column: "msg_type", family: "AUDIENCE_SCOPED", sourceDomain: "circles",
    authorizedBy: null,
    note: "Written by routes/circle.ts into the circle's own thread; circle membership is the audience." },
  { literal: "highlight_reply", column: "msg_type", family: "AUDIENCE_SCOPED", sourceDomain: "highlights",
    authorizedBy: null,
    note: "A reply to a Highlight the sender could already see. Declared AUDIENCE_SCOPED because a private Highlight's reply must not become a share of the Highlight." },
  { literal: "discovery_card", column: "subtype", family: "PUBLIC", sourceDomain: "discovery", authorizedBy: null,
    note: "Place / gem card. Public discovery surface." },
  { literal: "post_card", column: "subtype", family: "PUBLIC", sourceDomain: "posts", authorizedBy: null,
    note: "Public post." },
  { literal: "compass_card", column: "subtype", family: "PUBLIC", sourceDomain: "compass", authorizedBy: null,
    note: "Compass answer card; carries no private source object." },
  { literal: "event_context_card", column: "subtype", family: "PUBLIC", sourceDomain: "events", authorizedBy: null,
    note: "Public event." },
  { literal: "hidden_gem", column: "subtype", family: "PUBLIC", sourceDomain: "discovery", authorizedBy: null,
    note: "Public gem." },
  { literal: "meetup", column: "subtype", family: "AUDIENCE_SCOPED", sourceDomain: "meetups", authorizedBy: null,
    note: "Meetup card written into the thread whose members are the invitees." },
  { literal: "meetup_confirmed", column: "subtype", family: "AUDIENCE_SCOPED", sourceDomain: "meetups",
    authorizedBy: null, note: "Meetup lifecycle notice." },
  { literal: "meetup_cancelled", column: "subtype", family: "AUDIENCE_SCOPED", sourceDomain: "meetups",
    authorizedBy: null, note: "Meetup lifecycle notice." },
  { literal: "call_started", column: "subtype", family: "OPERATIONAL", sourceDomain: null, authorizedBy: null,
    note: "Call receipt written by the signaling layer when a call begins." },
  { literal: "call_ended", column: "subtype", family: "OPERATIONAL", sourceDomain: null, authorizedBy: null,
    note: "Crew-call receipt written by the call store adapter on room teardown." },
  { literal: "e2ee_welcome", column: "subtype", family: "OPERATIONAL", sourceDomain: null, authorizedBy: null,
    note: "The MLS-style Welcome blob for an end-to-end-encrypted thread. Carries key material, never a source object — and the server cannot read it, which is the point." },
  { literal: "layover_suggestion", column: "subtype", family: "OPERATIONAL", sourceDomain: null, authorizedBy: null,
    note: "census-layover L271. The label on a plain-text message the TRAVELLER composed — \"On a layover in X with about Nh to spare — any quick tips?\" — posted by POST /airport/sessions/:id/telegraph into the linked trip's own thread. OPERATIONAL rather than AUDIENCE_SCOPED because the family names the SOURCE's disclosure state and this message HAS no source object: it carries the sender's own sentence and no canonical id, so there is nothing a grant could scope and nothing a revocation could reach. The audience question it might seem to raise is answered one layer up and not by this registry — the route resolves a threadId only for an ACCEPTED member of the trip, so the message can only land in a conversation the sender is already in." },
];

/**
 * Producers whose message type is COMPUTED rather than written as a literal.
 *
 * A scanner that only reads string literals cannot see these, and a registry
 * that silently missed them would be worth less than no registry: it would read
 * as complete. This repository already makes the same admission one level down
 * — checkWriterlessReads declares that a dynamic `.from(expr)` anywhere makes
 * writer attribution INCOMPLETE and errs toward silence — so the same discipline
 * is applied here. Each dynamic site is declared, with the set of values it can
 * produce, and `src/scripts/checkTelegraphShareProducers.ts` fails on a dynamic
 * site in a file that is not listed.
 *
 * The second entry is the finding this rule exists to surface.
 */
export interface DynamicShareProducer {
  /** Repo-relative file containing the computed assignment. */
  readonly file: string;
  /** The expression, verbatim, so a change to it is visible in the diff. */
  readonly expression: string;
  readonly family: ShareObjectFamily;
  readonly sourceDomain: string | null;
  /** Every value the expression can produce, as far as it is bounded. */
  readonly produces: readonly string[];
  /**
   * False when the site computes a message-type-shaped value but writes no
   * message — a parser, a client cache, a re-send of a value the server already
   * assigned. Recorded rather than filtered out, because a scanner cannot tell
   * the two apart and a ledger that silently dropped the ones it guessed were
   * harmless would be guessing.
   */
  readonly writesMessages: boolean;
  readonly note: string;
}

export const TELEGRAPH_DYNAMIC_SHARE_PRODUCERS: readonly DynamicShareProducer[] = [
  {
    file: "artifacts/api-server/src/lib/threadMessage.ts",
    expression: "subtype: params.subtype ?? null",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: ["layover_suggestion"],
    writesMessages: true,
    note:
      "DECLARED WHEN THE GUARD CAUGHT IT, which is the guard working: the L271 " +
      "fix added a second plain-text write path and the subtype travels as a " +
      "parameter, so a literal scan cannot see it. The caller set is the whole " +
      "argument — `postPlainThreadMessage` has exactly one caller today, the " +
      "layover Telegraph route, passing the single literal above; `grep -c " +
      "postPlainThreadMessage` over src/ is the check to re-run before trusting " +
      "this `produces` list. OPERATIONAL because the helper writes " +
      "`msg_type: \"text\"` with a body and no canonical object id, and it " +
      "REFUSES an end-to-end-encrypted thread outright rather than downgrading " +
      "it — so it cannot become a path that puts private content anywhere this " +
      "policy would have had an opinion about. A caller that wants to share a " +
      "canonical object must not reach for this helper: it does not authorize, " +
      "and its own header says so.",
  },
  {
    file: "artifacts/api-server/src/routes/telegraphShare.ts",
    expression: "msg_type: msgTypeOf(\"PORTAVA_OBJECT\") | subtype: objectType.toLowerCase() | subtype: m.subtype",
    family: "PRIVATE_SOURCE",
    sourceDomain: null,
    produces: [
      "post", "trip", "trip_stage", "event", "meetup", "plan", "place", "map_pin",
      "meetup_point", "hidden_gem", "memory", "memory_note", "profile", "booking",
      "buddy_service",
    ],
    writesMessages: true,
    note:
      "DECLARED BY THE INTEGRATOR when the §1–§11 lane met this guard, and " +
      "classified PRIVATE_SOURCE because two of its fifteen object types — MEMORY " +
      "and MEMORY_NOTE — name `memories`, which IS in PRIVATE_BY_DEFAULT_DOMAINS. " +
      "sourceDomain is null because one producer spans fifteen domains and picking " +
      "one would be a fiction. WHAT THE ROUTE ACTUALLY DOES, stated because it is " +
      "not what this family's name promises: it does NOT call " +
      "authorizeTelegraphShare. Its gate is the per-object loader in " +
      "services/telegraph/shareables.ts, which refuses a memory the viewer cannot " +
      "already see — not owner, not public, not in allowed_user_ids returns " +
      "UNAVAILABLE(\"private\") and no message is written — and the body it persists " +
      "is a REFERENCE plus a title/city/timestamp projection, never the object's " +
      "content. So no private content crosses today. WHAT IS MISSING, and this is " +
      "the finding: rules 3 and 4 of check:telegraph-share-producers (the " +
      "private-domain family rule and the authorizedBy policy requirement) run over " +
      "TELEGRAPH_SHARE_PRODUCERS only and do NOT reach this list, so nothing " +
      "enforces the classification above. Routing this route through the policy " +
      "would refuse every memory share outright — no derivative grant exists " +
      "anywhere in this tree — which is a product decision, not an integration " +
      "fix, and it is left to the owner rather than taken here.",
  },
  {
    file: "artifacts/api-server/src/routes/telegraphKinds.ts",
    expression:
      "subtype: (row.subtype as string) ?? null | msg_type: validated.msgType | " +
      "subtype: validated.subtype | subtype: m.subtype",
    family: "AUDIENCE_SCOPED",
    sourceDomain: null,
    produces: [
      "media_album", "gif", "location", "action", "announcement", "safety", "memory_note",
    ],
    writesMessages: true,
    note:
      "DECLARED BY THE INTEGRATOR. The §6.2 typed-kind route. msg_type is " +
      "msgTypeOf(kind), the lowercase of one of the seven SENDABLE_ENVELOPE_KINDS, " +
      "so the set is bounded by that constant and listed above. The subtype is " +
      "computed by subtypeFor() from the validated payload and is bounded only by " +
      "the payload schemas — SAFETY takes payload.kind, LOCATION its precision, " +
      "ACTION and GIF a lowercased action or provider — which is why a literal " +
      "scan cannot see it. AUDIENCE_SCOPED, not PRIVATE_SOURCE: every payload here " +
      "is AUTHORED IN THE MESSAGE by the sender and validated by a zod schema; " +
      "none is loaded out of another domain's store. MEMORY_NOTE is the one to " +
      "watch and it is the sender's own note, written as state draft / visibility " +
      "only_me, with assertNoMemoryGraphLeak refusing rather than stripping.",
  },
  {
    file: "artifacts/api-server/src/services/telegraph/messageKinds.ts",
    expression: "subtype: subtypeFor(kind, parsed.data)",
    family: "AUDIENCE_SCOPED",
    sourceDomain: null,
    produces: [],
    writesMessages: false,
    note:
      "DECLARED BY THE INTEGRATOR. This is the VALIDATOR the route above calls, " +
      "not a writer: validateKindMessage returns { msgType, subtype } and touches " +
      "no table. writesMessages false. `produces` is empty rather than guessed " +
      "because subtypeFor's range is the union of four payload fields, and the two " +
      "that are free strings (SAFETY's kind, LOCATION's precision) are bounded by " +
      "their zod schemas, not by this file.",
  },
  {
    file: "artifacts/api-server/src/routes/telegraphCoordination.ts",
    expression: "msg_type: validated.msgType | subtype: validated.subtype | subtype: m.subtype",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: [
      "coordination", "decision", "vote", "rendezvous", "commitment",
      "commitment_response", "action_proposal", "acknowledgement",
    ],
    writesMessages: true,
    note:
      "DECLARED BY THE INTEGRATOR. The §9 coordination route. msg_type is the " +
      "lowercase of one of the seven COORDINATION_KINDS, listed above. " +
      "OPERATIONAL because a coordination message carries no source object at all " +
      "— it carries a state the sender is asserting about themselves (on my way, " +
      "arrived, running late) or a decision the thread is taking together. There " +
      "is nothing to disclose that the thread does not already own.",
  },
  {
    file: "artifacts/api-server/src/services/telegraph/coordination.ts",
    expression: "subtype: coordinationSubtype(kind, data)",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: [],
    writesMessages: false,
    note:
      "DECLARED BY THE INTEGRATOR. The validator behind the route above; returns a " +
      "shape and writes nothing. `produces` is empty because coordinationSubtype " +
      "lowercases a value from the payload — one of COORDINATION_QUICK_STATES for " +
      "COORDINATION, or the action / response / resolutionRule fields — and those " +
      "sets live in vocabulary.ts, not here.",
  },
  {
    file: "artifacts/api-server/src/services/telegraphReportEvidence.ts",
    expression:
      "msg_type: (msg as any).msg_type ?? null | subtype: (msg as any).subtype ?? null | " +
      "subtype: m.subtype ?? null",
    family: "OPERATIONAL",
    sourceDomain: "moderation",
    produces: [],
    writesMessages: false,
    note:
      "DECLARED BY THE INTEGRATOR when the §12–§22 lane met this guard. This site " +
      "does not PRODUCE a message type: it COPIES one off a message that already " +
      "exists, into telegraph_report_evidence, so a moderator can still see what " +
      "was reported after the sender deletes it (§22). It reads `messages` and " +
      "writes only the evidence table — writesMessages is false, and `produces` is " +
      "empty because the set is not this site's to bound: it is whatever the " +
      "reported message already carried, which is exactly the eighteen literals " +
      "and nine computed values this registry declares elsewhere. Recorded rather " +
      "than filtered out, because a scanner cannot tell a copier from a producer " +
      "and a registry that quietly dropped the ones someone judged harmless would " +
      "be guessing. OPERATIONAL / moderation because an evidence row is a " +
      "restricted internal artifact and is never projected into a conversation.",
  },
  {
    file: "artifacts/api-server/src/lib/liveReferenceMessages.ts",
    expression: "msg_type: LIVE_REFERENCE_MSG_TYPE | subtype: LIVE_REFERENCE_MSG_SUBTYPE",
    family: "PUBLIC",
    sourceDomain: "sensing",
    produces: ["card", "live_reference"],
    writesMessages: true,
    note:
      "DECLARED BY THE INTEGRATOR, not by the lane that wrote this registry: the " +
      "Sensing lane's §4 live references and this registry were built in separate " +
      "worktrees, and the guard found the producer the moment they met — which is " +
      "the guard doing its job, not a gap in either lane. Both values are module " +
      "constants (`lib/liveReference.ts` LIVE_REFERENCE_MSG_TYPE = 'card', " +
      "LIVE_REFERENCE_MSG_SUBTYPE = 'live_reference'), so the pair is bounded at " +
      "exactly one, but they are read through identifiers and a literal scan " +
      "cannot see them. PUBLIC because a live reference carries no copy of the " +
      "source object: it carries a REFERENCE the recipient resolves against the " +
      "current state through the one gated read path, and nothing person-shaped " +
      "— no contributor, no count, no cohort. The recipient sees what they are " +
      "already entitled to see when they resolve it, which is what makes the " +
      "share itself disclose nothing new.",
  },
  {
    file: "artifacts/api-server/src/lib/calls/callStoreAdapter.ts",
    expression: "subtype: `call_${session.status}`",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: ["call_ended", "call_missed", "call_declined", "call_canceled"],
    writesMessages: true,
    note:
      "Bounded by the call session status vocabulary. Operational chrome: the row " +
      "carries a rendered history line, never a source object.",
  },
  {
    file: "artifacts/api-server/src/routes/messaging.ts",
    expression: "subtype: req.body?.subtype (any string the client sends)",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: [],
    writesMessages: true,
    note:
      "UNBOUNDED, AND THIS IS THE FINDING. POST /threads/:threadId/messages takes " +
      "`subtype` straight from the request body with no vocabulary check — the only " +
      "constraint applied is that msgType collapses to 'system' or 'text'. So a " +
      "client can stamp any subtype it likes onto a message, including one a " +
      "renderer will dispatch on. It cannot forge the PAYLOAD authorization (the " +
      "body is whatever the sender wrote, and every card's data comes from that " +
      "same body), so this is a rendering-shape hole rather than an access-control " +
      "one — but it is exactly the seam a capability registry is supposed to close, " +
      "and it is why `produces` is empty here rather than enumerated. Recorded " +
      "against census T35/T41/T429: there is no versioned structured-message schema " +
      "and no validation of the discriminator that selects a renderer.",
  },
  {
    file: "artifacts/api-server/src/routes/circle.ts",
    expression: "subtype: cardSubtype",
    family: "AUDIENCE_SCOPED",
    sourceDomain: "circles",
    produces: ["arrived", "meeting_point"],
    writesMessages: true,
    note:
      "One helper writes both circle status cards, with the subtype passed in by " +
      "its two callers. The same value is also written INSIDE the body JSON, so " +
      "the discriminator is duplicated — which is why 'arrived' and 'meeting_point' " +
      "appear in the client's parser and nowhere in a literal server assignment.",
  },
  {
    file: "artifacts/api-server/src/routes/highlights.ts",
    expression: "subtype: id",
    family: "AUDIENCE_SCOPED",
    sourceDomain: "highlights",
    produces: [],
    writesMessages: true,
    note:
      "A FINDING, not a classification. The subtype column — the discriminator a " +
      "renderer dispatches on — is set to the HIGHLIGHT'S ID. That is an identifier " +
      "in a vocabulary field: it can never match a renderer case, and it puts a " +
      "highlights-domain id into a messaging-domain discriminator, which is the " +
      "shape §29's 'no semantic ID substitution across domains' forbids. The row " +
      "still renders, because msg_type is the real discriminator here " +
      "('highlight_reply'), so nothing is visibly broken — which is why it has " +
      "survived. Recorded so it is a decision rather than an accident.",
  },
  {
    file: "artifacts/api-server/src/routes/rentABuddy.ts",
    expression: "subtype: `booking_status_${newStatus}`",
    family: "AUDIENCE_SCOPED",
    sourceDomain: "rent_a_buddy",
    produces: [],
    writesMessages: true,
    note:
      "Bounded by the booking status vocabulary, which lives in the Rent-a-Buddy " +
      "domain and is enforced by its own CHECK constraint rather than here. " +
      "Written into the booking's own thread, whose membership is the audience.",
  },
  {
    file: "artifacts/api-server/src/services/notifications/NotificationRouter.ts",
    expression: "subtype: notification.eventType",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: [],
    writesMessages: true,
    note:
      "The notification taxonomy's event type becomes the message subtype, so the " +
      "subtype vocabulary of a Telegraph thread is, in practice, the ~80-entry " +
      "notification event vocabulary. Operational: the body is a rendered " +
      "notification string and carries no source object. Recorded because it means " +
      "no fixed subtype enumeration can ever be complete for this column.",
  },
  {
    file: "travel-buddy-standalone/src/components/CircleStatusCardMessage.logic.ts",
    expression: "subtype: subtype!",
    family: "AUDIENCE_SCOPED",
    sourceDomain: "circles",
    produces: [],
    writesMessages: false,
    note:
      "A PARSER, not a producer: it reads the subtype out of a card's body JSON " +
      "and returns it. Listed because the scanner cannot tell a parse from a write " +
      "and a ledger that quietly dropped what it guessed was harmless would be " +
      "guessing.",
  },
  {
    file: "travel-buddy-standalone/src/hooks/useMessaging.ts",
    expression: "subtype: opts?.subtype ?? null | subtype: failed.subtype ?? undefined",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: [],
    writesMessages: false,
    note:
      "The client send hook and its failed-send retry, passing a caller-supplied " +
      "subtype through to the API. It is the other end of the unvalidated " +
      "`subtype` on POST /threads/:threadId/messages — the client half of the same " +
      "seam, which is why closing that one closes both.",
  },
  {
    file: "travel-buddy-standalone/src/services/messaging.ts",
    expression: "subtype: m.subtype ?? null | subtype: E2EE_WELCOME_SUBTYPE",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: ["e2ee_welcome"],
    writesMessages: false,
    note:
      "Mapping a server message into the client model, plus the E2EE Welcome " +
      "constant on the send path. Carries key material, never a source object.",
  },
  {
    file: "travel-buddy-standalone/src/lib/e2ee/e2eeThread.ts",
    expression: "subtype: E2EE_WELCOME_SUBTYPE",
    family: "OPERATIONAL",
    sourceDomain: null,
    produces: ["e2ee_welcome"],
    writesMessages: false,
    note:
      "The E2EE thread bootstrap, sending the Welcome through the same API. The " +
      "server cannot read its body, which is the point of the thread.",
  },
];

/**
 * Families that may NEVER be produced without a policy call.
 *
 * PRIVATE_SOURCE is empty in the registry today, and that is the finding, not
 * an omission: no Telegraph producer shares a private canonical object. The
 * list exists so that the first one cannot.
 */
export const FAMILIES_REQUIRING_POLICY: readonly ShareObjectFamily[] = ["PRIVATE_SOURCE"];

/**
 * Domains whose canonical objects are private by default.
 *
 * WHY THIS EXISTS, stated plainly: the registry above is a declaration, and a
 * declaration can be wrong. A future Memory card declared `PUBLIC` would satisfy
 * the "every producer is registered" rule and skip the policy entirely — the
 * guard cannot read intent. So intent is not what it checks. A producer whose
 * `sourceDomain` is one of these may only be declared PRIVATE_SOURCE, and
 * `src/scripts/checkTelegraphShareProducers.ts` fails on any other family for
 * them. That converts "someone must remember to classify this correctly" into
 * "the only classification CI accepts is the one that requires a grant".
 *
 * It is a narrowing, not a closure: a domain not on this list can still be
 * misclassified, and adding a domain here is the remedy. The list is exactly
 * the set of domains whose spec text names private canonical content.
 */
export const PRIVATE_BY_DEFAULT_DOMAINS: readonly string[] = [
  "memories",
  "memory_notes",
  "safe_return",
  "location",
  "safety",
  "private_trips",
];
