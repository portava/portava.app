/**
 * Telegraph §2.3 — TALK / PLAN / NOW as LAYERS, not labels.
 *
 * Spec §2.3, verbatim:
 *   TALK  "Normal conversation and expressive content."
 *   PLAN  "Plans, decisions, shared places, attendance, invitations and
 *          unresolved actions."
 *   NOW   "Active coordination: on the way, arrived, meet here, live location
 *          scope, safety and return."
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * census-telegraph T11: "ACTION and ANNOUNCEMENT give the stream a genuinely
 * different class of item with its own renderer and its own confirm/acknowledge
 * affordance, which is more than 'ordinary stream items'. It stays W because
 * there is still no LAYER: unresolved actions are interleaved with conversation
 * rather than separated, which is what §2.3 asks for."
 *
 * Re-derived before this file was written and still true then: a grep for
 * `semanticLayer` / `layerOf` / the literal `"TALK"` over both trees returned
 * nothing, and every §6.2 and §8 message was read back through the same
 * `GET /threads/:id/messages` page as ordinary conversation.
 *
 * ── WHAT MAKES THIS A LAYER RATHER THAN A TAG ───────────────────────────────
 * A layer that merely stamped each message with a name and left it in the
 * stream would be exactly the interleaving the row objects to. The property
 * enforced here instead is SEPARATION and RETURN:
 *
 *   1. A message in the PLAN or NOW layer is REMOVED from `talk`. The three
 *      collections partition the thread: `assertPartition` is a real check and
 *      the route asserts it on every response.
 *   2. A PLAN item is in the layer only while it is UNRESOLVED. The moment it
 *      resolves — a decision reaches a result, a commitment is completed, an
 *      action is answered, an announcement is acknowledged BY THIS VIEWER — it
 *      leaves the layer and re-enters the conversation, where it belongs as
 *      history.
 *
 * So the layer empties itself. That is the difference between "here are the
 * plan-shaped messages" and "here is what is still open", and §2.3's wording —
 * "unresolved actions" — is asking for the second one.
 *
 * ── WHY PLAN IS PER-VIEWER AND NOW IS NOT ───────────────────────────────────
 * An announcement that asked to be acknowledged is open for the people who
 * have not pressed the button and closed for the people who have. There is no
 * viewer-independent answer to "is this still waiting?", so `viewerId` is a
 * required input and the projection is honest about being per-person. A quick
 * state, by contrast, is a fact about the thread's live coordination and reads
 * the same for everybody.
 *
 * ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
 * It does not render anything. The layer is computed on the server so that the
 * separation cannot disagree between two clients, but the conversation screen
 * in `travel-buddy-standalone/` still draws one stream; closing that half is
 * client work this module makes possible and does not perform.
 */
import {
  parseCoordinationEnvelope,
  projectAcknowledgements,
  projectCommitment,
  projectDecision,
  type AnnouncementInputMessage,
  type DecisionInputMessage,
} from "./coordination.js";
import { parseKindEnvelope } from "./messageKinds.js";

// ── §2.3's three layers ──────────────────────────────────────────────────────

/** §2.3's table, in the spec's order. Index in this array IS the depth. */
export const SEMANTIC_LAYERS = ["TALK", "PLAN", "NOW"] as const;

export type SemanticLayer = (typeof SEMANTIC_LAYERS)[number];

export function isSemanticLayer(v: unknown): v is SemanticLayer {
  return typeof v === "string" && (SEMANTIC_LAYERS as readonly string[]).includes(v);
}

/** The raw `messages` columns this projection needs. Nothing else is read. */
export interface LayerInputRow {
  id: string;
  sender_id: string;
  created_at: string;
  msg_type?: string | null;
  subtype?: string | null;
  body?: string | null;
}

/**
 * Why a message is in the PLAN layer. Never null for a PLAN item — a layer
 * that could not say why something is in it is a badge, and the census's
 * standing complaint about badges is that people learn to ignore them.
 */
export type PlanOpenReason =
  /** §8 ConversationDecision with no result yet. */
  | "decision_open"
  /** §8 ConversationCommitment nobody has completed. */
  | "commitment_open"
  /** §6.2 ANNOUNCEMENT that asked for an acknowledgement this viewer has not given. */
  | "acknowledgement_pending"
  /** §8.1 action proposal (or §6.2 ACTION) nobody has confirmed or declined. */
  | "action_unanswered";

/**
 * Why a message is in the NOW layer — §2.3's own list, one value per clause,
 * so a reader of the response can tell "arrived" from "safety".
 */
export type NowReason =
  /** §9.1 "on the way, arrived …" — a declared quick state. */
  | "declared_status"
  /** §8 Rendezvous — "meet here". */
  | "rendezvous"
  /** §2.3 "live location scope". */
  | "location_scope"
  /** §2.3 "safety". */
  | "safety";

export interface LayerItem {
  messageId: string;
  senderId: string;
  createdAt: string;
  layer: Exclude<SemanticLayer, "TALK">;
  /** The message kind that put it in this layer. */
  kind: string;
  title: string | null;
  openReason: PlanOpenReason | null;
  nowReason: NowReason | null;
}

export interface SemanticLayerProjection {
  threadId: string;
  viewerId: string;
  generatedAt: string;
  layers: readonly SemanticLayer[];
  /** §2.3 PLAN — UNRESOLVED items only, oldest first (the oldest is the most overdue). */
  plan: LayerItem[];
  /** §2.3 NOW — active coordination, newest first. */
  now: LayerItem[];
  /** §2.3 TALK — the ordinary stream, newest first. Message ids only. */
  talk: string[];
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * The §8.1 actions §2.3 puts in NOW rather than PLAN.
 *
 * §2.3's NOW row names "meet here", "live location scope" and "return"
 * explicitly. A proposal to meet somewhere right now is active coordination;
 * a proposal to split a ride tomorrow is a plan. The split is the spec's, not
 * this module's invention, which is why the list is exactly the three clauses
 * §2.3 spells out and not "the ones that felt urgent".
 */
export const NOW_ACTIONS: readonly string[] = ["MEET_HERE", "SHARE_LOCATION", "RETURN_TO_GROUP"];

/**
 * Which §2.3 layer a message belongs to, from its kind alone.
 *
 * This answers "what CLASS of thing is this", not "is it still open" —
 * openness is per-viewer and is decided by `projectSemanticLayers`. Keeping the
 * two apart is what lets the classifier be a pure function of one row.
 */
export function layerOfMessage(row: LayerInputRow): SemanticLayer {
  const coordination = parseCoordinationEnvelope(row.msg_type, row.body ?? null);
  if (coordination) {
    switch (coordination.kind) {
      case "COORDINATION":
        return "NOW";
      case "RENDEZVOUS":
        return "NOW";
      case "ACTION_PROPOSAL":
        return NOW_ACTIONS.includes(String(coordination.payload?.action)) ? "NOW" : "PLAN";
      case "DECISION":
      case "VOTE":
      case "COMMITMENT":
      case "COMMITMENT_RESPONSE":
      case "ACTION_RESPONSE":
        return "PLAN";
      case "ACKNOWLEDGEMENT":
        // An acknowledgement is an ANSWER to a PLAN item, not a plan item. It
        // stays in the conversation; what it changes is whether the thing it
        // answers is still open.
        return "TALK";
      default:
        return "TALK";
    }
  }

  const envelope = parseKindEnvelope(row.msg_type, row.body ?? null);
  if (envelope) {
    switch (envelope.kind) {
      case "SAFETY":
        return "NOW";
      case "LOCATION":
        return "NOW";
      case "ACTION":
        return NOW_ACTIONS.includes(String((envelope.payload as any)?.action)) ? "NOW" : "PLAN";
      case "ANNOUNCEMENT":
        return "PLAN";
      default:
        return "TALK";
    }
  }

  return "TALK";
}

function ms(v: string | null | undefined): number {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function titleOf(payload: any): string | null {
  for (const k of ["title", "question", "what", "checkpoint", "label"]) {
    if (typeof payload?.[k] === "string" && payload[k].length > 0) return payload[k];
  }
  return null;
}

// ── the projection ───────────────────────────────────────────────────────────

export interface LayerProjectionInput {
  threadId: string;
  viewerId: string;
  rows: LayerInputRow[];
  nowMs: number;
  now?: Date;
}

/**
 * Split one thread's rows into §2.3's three layers for one viewer.
 *
 * The rows must already be membership-gated, §14.3-bounded and
 * tombstone-excluded by the caller: this is a pure function and has no client,
 * which is what makes the layering rules testable without a database.
 */
export function projectSemanticLayers(input: LayerProjectionInput): SemanticLayerProjection {
  const { threadId, viewerId, rows, nowMs } = input;
  const generatedAt = (input.now ?? new Date(nowMs)).toISOString();

  // Parse once. Every branch below reads from these, so a body is never parsed
  // twice and a row can never be classified two different ways.
  const parsed = rows.map((r) => ({
    row: r,
    coordination: parseCoordinationEnvelope(r.msg_type, r.body ?? null),
    envelope: parseKindEnvelope(r.msg_type, r.body ?? null),
  }));

  const byKind = (kind: string) => parsed.filter((p) => p.coordination?.kind === kind);

  const asInput = (p: (typeof parsed)[number]): DecisionInputMessage => ({
    id: p.row.id,
    sender_id: p.row.sender_id,
    created_at: p.row.created_at,
    payload: p.coordination?.payload,
  });

  const voteRows = byKind("VOTE").map(asInput);
  const responseRows = byKind("COMMITMENT_RESPONSE").map(asInput);
  const acknowledgementRows = byKind("ACKNOWLEDGEMENT").map(asInput);

  // §8.1 action proposals: answered or not. An ACTION_RESPONSE by ANYONE in
  // the thread closes the proposal — a proposal is a question put to the
  // conversation, and one answer is an answer.
  const answeredActionIds = new Set<string>();
  for (const p of byKind("ACTION_RESPONSE")) {
    const target = p.coordination?.payload?.actionMessageId;
    if (typeof target === "string" && target.length > 0) answeredActionIds.add(target);
  }

  // §19 acknowledgements, per announcement, so "is it still waiting on THIS
  // viewer" is answered by the same projection the announcements route uses
  // rather than by a second rule that could drift from it.
  const announcementInputs: AnnouncementInputMessage[] = parsed
    .filter((p) => p.envelope?.kind === "ANNOUNCEMENT")
    .map((p) => ({
      id: p.row.id,
      sender_id: p.row.sender_id,
      created_at: p.row.created_at,
      title: typeof (p.envelope!.payload as any)?.title === "string" ? (p.envelope!.payload as any).title : "",
      requiresAcknowledgement: (p.envelope!.payload as any)?.requiresAcknowledgement === true,
    }));
  const acknowledgedByViewer = new Set(
    projectAcknowledgements(announcementInputs, acknowledgementRows)
      .filter((a) => a.acknowledgedBy.some((x) => x.userId === viewerId))
      .map((a) => a.messageId),
  );

  const plan: LayerItem[] = [];
  const now: LayerItem[] = [];
  const talk: string[] = [];

  for (const p of parsed) {
    const layer = layerOfMessage(p.row);
    const payload: any = p.coordination?.payload ?? p.envelope?.payload ?? null;
    const kind = p.coordination?.kind ?? p.envelope?.kind ?? "TEXT";

    if (layer === "NOW") {
      now.push({
        messageId: p.row.id,
        senderId: p.row.sender_id,
        createdAt: p.row.created_at,
        layer: "NOW",
        kind,
        title: titleOf(payload),
        openReason: null,
        nowReason: nowReasonFor(kind, p.envelope?.kind ?? null),
      });
      continue;
    }

    if (layer === "PLAN") {
      const openReason = planOpenReason({
        kind,
        id: p.row.id,
        senderId: p.row.sender_id,
        payload,
        viewerId,
        nowMs,
        decisionInput: asInput(p),
        voteRows,
        responseRows,
        answeredActionIds,
        acknowledgedByViewer,
      });
      if (openReason === null) {
        // Resolved. It re-enters the conversation — this is the line that
        // makes the PLAN layer empty itself.
        talk.push(p.row.id);
        continue;
      }
      plan.push({
        messageId: p.row.id,
        senderId: p.row.sender_id,
        createdAt: p.row.created_at,
        layer: "PLAN",
        kind,
        title: titleOf(payload),
        openReason,
        nowReason: null,
      });
      continue;
    }

    talk.push(p.row.id);
  }

  plan.sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  now.sort((a, b) => ms(b.createdAt) - ms(a.createdAt));

  return {
    threadId,
    viewerId,
    generatedAt,
    layers: SEMANTIC_LAYERS,
    plan,
    now,
    talk,
  };
}

function nowReasonFor(kind: string, envelopeKind: string | null): NowReason {
  if (kind === "COORDINATION") return "declared_status";
  if (kind === "RENDEZVOUS") return "rendezvous";
  if (envelopeKind === "SAFETY") return "safety";
  if (envelopeKind === "LOCATION") return "location_scope";
  // An ACTION whose action is MEET_HERE / SHARE_LOCATION / RETURN_TO_GROUP.
  return "rendezvous";
}

interface OpenReasonInput {
  kind: string;
  id: string;
  senderId: string;
  payload: any;
  viewerId: string;
  nowMs: number;
  decisionInput: DecisionInputMessage;
  voteRows: DecisionInputMessage[];
  responseRows: DecisionInputMessage[];
  answeredActionIds: Set<string>;
  acknowledgedByViewer: Set<string>;
}

/**
 * `null` means RESOLVED — the item leaves the PLAN layer.
 *
 * Every branch is a real resolution mechanic that exists on this tree today.
 * There is deliberately no "it is old, call it resolved" branch: a decision
 * nobody answered is still a decision nobody answered, and ageing it out of
 * the layer would be the layer lying to make itself look tidy.
 */
function planOpenReason(i: OpenReasonInput): PlanOpenReason | null {
  switch (i.kind) {
    case "DECISION": {
      const projected = projectDecision(i.decisionInput, i.voteRows, i.nowMs);
      // An unparseable decision payload cannot be shown as open — there is
      // nothing to answer — so it falls back into the conversation.
      if (!projected) return null;
      return projected.resolved ? null : "decision_open";
    }
    case "VOTE":
    case "COMMITMENT_RESPONSE":
    case "ACTION_RESPONSE":
      // An answer is not an open item. It belongs with the conversation that
      // produced it.
      return null;
    case "COMMITMENT": {
      const projected = projectCommitment(i.decisionInput, i.responseRows, i.nowMs);
      if (!projected) return null;
      return projected.completedBy === null ? "commitment_open" : null;
    }
    case "ANNOUNCEMENT": {
      if (i.payload?.requiresAcknowledgement !== true) return null;
      // The announcer is not outstanding on their own notice (§19).
      if (i.senderId === i.viewerId) return null;
      return i.acknowledgedByViewer.has(i.id) ? null : "acknowledgement_pending";
    }
    case "ACTION_PROPOSAL":
    case "ACTION":
      return i.answeredActionIds.has(i.id) ? null : "action_unanswered";
    default:
      return null;
  }
}

/**
 * §2.3's separation, as a checkable property rather than a claim.
 *
 * Returns the ids that appear in more than one layer. A non-empty result is a
 * bug in this module, and the route asserts it is empty on every response so
 * the invariant is enforced where it is served, not only where it is tested.
 */
export function partitionViolations(p: SemanticLayerProjection): string[] {
  const seen = new Map<string, number>();
  for (const id of [...p.plan.map((i) => i.messageId), ...p.now.map((i) => i.messageId), ...p.talk]) {
    seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
}
