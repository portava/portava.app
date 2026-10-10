/**
 * Telegraph §30A.9 — forwarding provenance and content capabilities
 * (census-telegraph T406, T407; revocation latency T353).
 *
 * Spec §30A.9, verbatim:
 *   "Track whether a message derivative is FORWARDED, RESHARED_FROM_SOURCE, or
 *    COPIED_ATTACHMENT without exposing private conversation lineage to
 *    recipients. Content capabilities may specify ALLOW, NO_FORWARD,
 *    SOURCE_POLICY, or EXPIRES_WITH_SOURCE."
 *
 * ── WHERE THE LINEAGE LIVES, AND WHO CAN READ IT ────────────────────────────
 * `public.message_forwards` (migration 3665) links a derivative to its source
 * message. It is service-role only: RLS on, no policy, every client grant
 * revoked. The derivative is an ordinary row in the TARGET thread whose sender
 * is the forwarder, whose `created_at` is the forward's own time and whose body
 * is the copied text (or a fresh object reference). It carries no source thread,
 * no source author, no source time and no reply linkage. The only thing the new
 * audience is ever told is the provenance WORD (`FORWARDED`), on the thread read
 * — see `platformReadDecorations.ts`.
 *
 * ── THE FOUR CAPABILITIES, AS THIS TREE ENFORCES THEM ───────────────────────
 *   ALLOW               any member who can see the message may forward it.
 *   NO_FORWARD          nobody may — the author included (a derivative of a
 *                       NO_FORWARD message cannot exist).
 *   SOURCE_POLICY       the content's SOURCE decides. For a shared Portava
 *                       object the source is the object, so a reshare is
 *                       allowed exactly when the forwarder can open the object
 *                       now (`getCurrentState`), and each recipient re-resolves
 *                       it under their own authorization. For a person's own
 *                       words the source is that person: only the author may
 *                       forward them. THIS IS THE DEFAULT for a message with no
 *                       stated capability (PROPOSED RULING P-TPLAT-1 — the
 *                       privacy-preserving default; the owner may choose ALLOW).
 *   EXPIRES_WITH_SOURCE as ALLOW, and every derivative is tombstoned in the SAME
 *                       transaction that deletes or unsends its source
 *                       (3665's `telegraph_forward_expire_with_source` trigger).
 *
 * A derivative INHERITS the capability it was made under, so a copy of an
 * EXPIRES_WITH_SOURCE message is itself one, and a forward of that copy expires
 * with the chain. The author of a derivative is the forwarder, so the author's
 * own capability setter refuses a derivative (`setCapabilityDecision`): a
 * forwarder cannot loosen what they were given.
 *
 * ── WHAT IS NOT FORWARDABLE, AND WHY ────────────────────────────────────────
 *   LOCATION, SAFETY        audience-scoped by construction (§29: no location
 *                           without purpose/AUDIENCE/precision/expiry); a
 *                           forward changes the audience.
 *   VOICE                   a person's voice is an audio object in our storage —
 *                           copying it is COPIED_ATTACHMENT (below).
 *   IMAGE / VIDEO / media   COPIED_ATTACHMENT. The vocabulary carries it; the
 *                           write refuses it: a copy that preserved the source's
 *                           storage path would name the source author's uid in
 *                           the URL (the path convention is `<owner uid>/…`),
 *                           and a real copy needs a server-side object copy plus
 *                           an EXIF policy (§30.8). OWNER DECISION.
 *   everything else         coordination, actions, announcements, system
 *                           notices, legacy cards: they are about THIS thread.
 */
import { buildPortavaObjectBody, parsePortavaObjectBody } from "./shareables.js";
import type { TelegraphObjectType } from "./vocabulary.js";

export const FORWARDING_FLAG = "telegraph_forwarding_enabled";

export const FORWARD_PROVENANCES = ["FORWARDED", "RESHARED_FROM_SOURCE", "COPIED_ATTACHMENT"] as const;
export type ForwardProvenance = (typeof FORWARD_PROVENANCES)[number];

export const CONTENT_CAPABILITIES = ["ALLOW", "NO_FORWARD", "SOURCE_POLICY", "EXPIRES_WITH_SOURCE"] as const;
export type ContentCapability = (typeof CONTENT_CAPABILITIES)[number];

/** P-TPLAT-1: a message nobody set a capability on follows its source. */
export const DEFAULT_CONTENT_CAPABILITY: ContentCapability = "SOURCE_POLICY";

export function isContentCapability(v: unknown): v is ContentCapability {
  return typeof v === "string" && (CONTENT_CAPABILITIES as readonly string[]).includes(v);
}

/** The source row, as the forward decision needs it. */
export interface ForwardSource {
  id: string;
  thread_id: string;
  sender_id: string;
  body: string | null;
  msg_type: string | null;
  subtype: string | null;
  media_url?: string | null;
  deleted_at?: string | null;
  unsent_at?: string | null;
}

/**
 * The capability in force on a message: the author's stated one, else the one
 * its derivative row inherited, else the default.
 */
export function effectiveCapability(
  explicit: string | null | undefined,
  inherited: string | null | undefined,
): ContentCapability {
  if (isContentCapability(explicit)) return explicit;
  if (isContentCapability(inherited)) return inherited;
  return DEFAULT_CONTENT_CAPABILITY;
}

export type ForwardRefusal =
  | "source_unavailable"
  | "forward_restricted"
  | "kind_not_forwardable"
  | "attachment_copy_unsupported"
  | "e2ee_source";

export type ForwardDecision =
  | {
      ok: true;
      provenance: Exclude<ForwardProvenance, "COPIED_ATTACHMENT">;
      /** The capability the derivative inherits. Never NO_FORWARD. */
      capability: Exclude<ContentCapability, "NO_FORWARD">;
      body: string;
      msgType: string;
      subtype: string | null;
    }
  | { ok: false; code: ForwardRefusal; message: string };

/** One sentence per refusal. None of them names the source thread or its people. */
export const FORWARD_REFUSAL_MESSAGES: Readonly<Record<ForwardRefusal, string>> = {
  source_unavailable: "That message is no longer available.",
  forward_restricted: "This message can't be forwarded.",
  kind_not_forwardable: "This kind of message can't be forwarded.",
  attachment_copy_unsupported: "Photos and videos can't be forwarded yet.",
  e2ee_source: "Messages from an end-to-end encrypted conversation can't be forwarded.",
};

function refuse(code: ForwardRefusal): ForwardDecision {
  return { ok: false, code, message: FORWARD_REFUSAL_MESSAGES[code] };
}

const MEDIA_MSG_TYPES = new Set(["media", "image", "video", "voice", "media_album", "gif"]);

/** What a source row is, for forwarding purposes. */
export function forwardShapeOf(source: ForwardSource): "text" | "object" | "attachment" | "other" {
  const mt = (source.msg_type ?? "text").toLowerCase();
  if (source.media_url || MEDIA_MSG_TYPES.has(mt)) return "attachment";
  if (mt === "portava_object") return parsePortavaObjectBody(source.body) ? "object" : "other";
  if (mt === "text") {
    // A text row whose subtype marks it as a card is a legacy structured message, not words.
    if (source.subtype && source.subtype !== "") return "other";
    return typeof source.body === "string" && source.body.trim().length > 0 ? "text" : "other";
  }
  return "other";
}

/**
 * The whole forward rule, over facts the caller has already read. Pure, so every
 * branch is asserted without a database; 3665's `telegraph_record_forward`
 * re-checks liveness and the capability under a row lock, so a race between this
 * decision and an unsend or a capability change cannot leave an unexpiring copy.
 */
export function decideForward(input: {
  source: ForwardSource;
  forwarderId: string;
  sourceIsE2ee: boolean;
  explicitCapability: string | null;
  inheritedCapability: string | null;
  /** PORTAVA_OBJECT only: can the FORWARDER open the referenced object right now? */
  objectAvailableToForwarder?: boolean;
}): ForwardDecision {
  const { source } = input;
  if (source.deleted_at || source.unsent_at) return refuse("source_unavailable");
  if (input.sourceIsE2ee) return refuse("e2ee_source");

  const capability = effectiveCapability(input.explicitCapability, input.inheritedCapability);
  if (capability === "NO_FORWARD") return refuse("forward_restricted");

  const shape = forwardShapeOf(source);
  if (shape === "attachment") return refuse("attachment_copy_unsupported");
  if (shape === "other") return refuse("kind_not_forwardable");

  if (shape === "object") {
    const ref = parsePortavaObjectBody(source.body)!;
    // Whatever the capability, nobody re-shares what they cannot open (§5.3, at the send end).
    if (input.objectAvailableToForwarder !== true) return refuse("source_unavailable");
    // The author's caption is the author's words — a reshare carries the object, not them.
    const body = buildPortavaObjectBody(ref.objectType as TelegraphObjectType, ref.objectId, null);
    return {
      ok: true,
      provenance: "RESHARED_FROM_SOURCE",
      capability,
      body: JSON.stringify(body),
      msgType: "portava_object",
      subtype: ref.objectType.toLowerCase(),
    };
  }

  // shape === "text": a person's words.
  if (capability === "SOURCE_POLICY" && input.forwarderId !== source.sender_id) {
    return refuse("forward_restricted");
  }
  return {
    ok: true,
    provenance: "FORWARDED",
    capability,
    body: source.body as string,
    msgType: "text",
    subtype: null,
  };
}

/** Who may set a message's capability: its author, on a live message that is not itself a derivative. */
export function setCapabilityDecision(input: {
  message: { sender_id: string; deleted_at?: string | null; unsent_at?: string | null } | null;
  callerId: string;
  isDerivative: boolean;
}): { ok: true } | { ok: false; code: "not_found" | "forbidden"; message: string } {
  if (!input.message || input.message.deleted_at || input.message.unsent_at) {
    return { ok: false, code: "not_found", message: "That message is no longer available." };
  }
  if (input.message.sender_id !== input.callerId) {
    return { ok: false, code: "forbidden", message: "Only the author of a message can set how it may be forwarded." };
  }
  if (input.isDerivative) {
    return {
      ok: false,
      code: "forbidden",
      message: "A forwarded message keeps the forwarding rule it was shared under.",
    };
  }
  return { ok: true };
}

/** `telegraph_record_forward`'s outcomes (3665), mapped to what a caller is told. */
export const RECORD_FORWARD_OUTCOMES = ["forwarded", "source_gone", "restricted", "capability_changed"] as const;
