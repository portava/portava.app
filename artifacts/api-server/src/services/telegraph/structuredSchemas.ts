/**
 * Telegraph §30A.16 — versioned structured-message schemas, and client
 * capability negotiation (census-telegraph T429, T431).
 *
 * Spec §30A.16, verbatim:
 *   "Maintain versioned structured-message schemas such as place.share.v1,
 *    event.share.v1, trip.share.v1, memory_note.v1, location.scope.v1, and
 *    coordination.status.v1. Unknown future message types render a safe
 *    generic fallback on older clients rather than crashing or silently
 *    disappearing. Use client capability negotiation when an interaction
 *    requires a minimum supported schema or action version."
 *
 * ── WHAT EXISTED, AND WHAT THIS ADDS ────────────────────────────────────────
 * Every structured body this tree writes already carries an `envelopeVersion`
 * (§6.2 kinds, `messageKinds.ts`), a `COORDINATION_ENVELOPE_VERSION`
 * (`coordination.ts`) or a `shareProjectionVersion` (`shareables.ts`). Those are
 * three per-carrier integers; none of them is a NAMED schema, nothing maps a
 * stored row to one, and no reader could say "this client cannot render
 * location.scope.v2". This module is the registry: one id per (family, version),
 * the zod schema that validates it, and the safe fallback text a client that
 * cannot render it gets INSTEAD of the payload.
 *
 * ── THE REGISTRY IS ADDITIVE TO THE THREE CARRIERS, NEVER A FOURTH WRITER ───
 * The payload validators are the carriers' own (`parseKindEnvelope`,
 * `parseCoordinationEnvelope`, `parsePortavaObjectBody`), so a schema here and
 * the code that writes it cannot disagree about what v1 is.
 *
 * ── NEGOTIATION ─────────────────────────────────────────────────────────────
 * A client declares the schema families it renders, and the highest version of
 * each, in `x-telegraph-client-schemas` (`place.share.v1,location.scope.v1`),
 * and the §8.1 actions it can perform in `x-telegraph-client-actions`
 * (`ADD_TO_TRIP.v1,VOTE.v1`). A client that sends no header is a client written
 * before negotiation existed, and it is served the BASELINE — the families that
 * existed when negotiation shipped, frozen below — so turning the flag on
 * changes nothing for it today and degrades it, rather than crashing it, the
 * day a v2 ships. A header that is present but unparseable declares NOTHING:
 * the safe direction is the fallback, never the payload.
 *
 * THE FALLBACK CARRIES NO PAYLOAD. A client that cannot render
 * `location.scope.v1` is exactly the client that would print its JSON — and
 * that JSON can hold exact coordinates whose precision controls the client does
 * not understand. So the fallback is a fixed sentence from this file, never a
 * field of the message.
 */
import { kindOfMsgType } from "./vocabulary.js";
import { isEnvelopeKind, parseKindEnvelope } from "./messageKinds.js";
import { COORDINATION_KINDS, parseCoordinationEnvelope } from "./coordination.js";
import { parsePortavaObjectBody } from "./shareables.js";
import { TELEGRAPH_ACTIONS, type TelegraphAction, type TelegraphObjectType } from "./vocabulary.js";

export const STRUCTURED_SCHEMAS_FLAG = "telegraph_structured_schemas_enabled";

export const CLIENT_SCHEMAS_HEADER = "x-telegraph-client-schemas";
export const CLIENT_ACTIONS_HEADER = "x-telegraph-client-actions";

/** Which stored carrier a schema rides in. */
export type SchemaCarrier = "envelope" | "coordination" | "portava_object";

export interface StructuredSchema {
  /** `<family>.v<version>`, e.g. `place.share.v1`. */
  id: string;
  family: string;
  version: number;
  carrier: SchemaCarrier;
  /** The `msg_type` kind (upper case) this schema is stored under. */
  kind: string;
  /** PORTAVA_OBJECT only: the object types that belong to this family. */
  objectTypes?: readonly TelegraphObjectType[];
  /** What a client that cannot render this schema is shown. Never a payload field. */
  fallbackLabel: string;
}

/** §30A.16's three named share families, partitioned over the shareable object types. */
const PLACE_OBJECTS: readonly TelegraphObjectType[] = ["PLACE", "HIDDEN_GEM", "MAP_PIN", "NEIGHBORHOOD", "MEETUP_POINT"];
const EVENT_OBJECTS: readonly TelegraphObjectType[] = ["EVENT", "MEETUP"];
const TRIP_OBJECTS: readonly TelegraphObjectType[] = ["TRIP", "TRIP_STAGE", "PLAN", "ROUTE"];

function s(
  family: string,
  version: number,
  carrier: SchemaCarrier,
  kind: string,
  fallbackLabel: string,
  objectTypes?: readonly TelegraphObjectType[],
): StructuredSchema {
  return { id: `${family}.v${version}`, family, version, carrier, kind, fallbackLabel, ...(objectTypes ? { objectTypes } : {}) };
}

/**
 * The registry. The six ids §30A.16 names are here verbatim; every other
 * structured kind this tree stores is registered too, because a kind with no
 * schema id is a kind negotiation cannot reason about.
 */
export const STRUCTURED_SCHEMAS: readonly StructuredSchema[] = [
  // §30A.16's six, verbatim.
  s("place.share", 1, "portava_object", "PORTAVA_OBJECT", "Shared a place", PLACE_OBJECTS),
  s("event.share", 1, "portava_object", "PORTAVA_OBJECT", "Shared an event", EVENT_OBJECTS),
  s("trip.share", 1, "portava_object", "PORTAVA_OBJECT", "Shared a trip", TRIP_OBJECTS),
  s("memory_note", 1, "envelope", "MEMORY_NOTE", "Shared a memory note"),
  s("location.scope", 1, "envelope", "LOCATION", "Shared a location"),
  s("coordination.status", 1, "coordination", "COORDINATION", "Posted a status update"),
  // Every other PORTAVA_OBJECT family (posts, profiles, bookings, media, …).
  s("object.share", 1, "portava_object", "PORTAVA_OBJECT", "Shared something from Portava"),
  // The rest of §6.2's envelope kinds.
  s("media_album", 1, "envelope", "MEDIA_ALBUM", "Shared photos"),
  s("gif", 1, "envelope", "GIF", "Sent a GIF"),
  s("voice", 1, "envelope", "VOICE", "Sent a voice message"),
  s("action", 1, "envelope", "ACTION", "Proposed an action"),
  s("announcement", 1, "envelope", "ANNOUNCEMENT", "Posted an announcement"),
  s("safety", 1, "envelope", "SAFETY", "Sent a safety message"),
  // The coordination kinds other than the quick state.
  s("coordination.decision", 1, "coordination", "DECISION", "Posted a decision"),
  s("coordination.vote", 1, "coordination", "VOTE", "Started a vote"),
  s("coordination.rendezvous", 1, "coordination", "RENDEZVOUS", "Proposed a meeting point"),
  s("coordination.commitment", 1, "coordination", "COMMITMENT", "Asked for a commitment"),
  s("coordination.commitment_response", 1, "coordination", "COMMITMENT_RESPONSE", "Answered a commitment"),
  s("coordination.action_proposal", 1, "coordination", "ACTION_PROPOSAL", "Proposed an action"),
  s("coordination.action_response", 1, "coordination", "ACTION_RESPONSE", "Answered a proposal"),
  s("coordination.acknowledgement", 1, "coordination", "ACKNOWLEDGEMENT", "Acknowledged an announcement"),
  s("coordination.session", 1, "coordination", "COORDINATION_SESSION", "Started a coordination session"),
  s("coordination.transition", 1, "coordination", "COORDINATION_TRANSITION", "Updated a coordination session"),
];

/** Shown for a schema this server does not know — a future one written by a newer build. */
export const UNKNOWN_SCHEMA_FALLBACK = "Sent something this version of the app can't show yet";

/**
 * SAFETY's fallback keeps its class. A client that cannot render safety.v1 must
 * still be told that somebody NEEDS HELP — degrading that to "sent a safety
 * message" would hide the one fact the message exists to carry. The class is the
 * stored `subtype`, a closed enum, never the sender's free text.
 */
export const SAFETY_FALLBACK_BY_CLASS: Readonly<Record<string, string>> = {
  check_in: "Safety check-in",
  heads_up: "Safety heads-up",
  need_help: "Needs help — open the latest app to see details",
  all_clear: "Safety: all clear",
};

const BY_ID = new Map(STRUCTURED_SCHEMAS.map((x) => [x.id, x]));

export function schemaById(id: string): StructuredSchema | null {
  return BY_ID.get(id) ?? null;
}

/** The registered schema for a non-PORTAVA_OBJECT kind. */
export function schemaForKind(kind: string): StructuredSchema | null {
  return STRUCTURED_SCHEMAS.find((x) => x.kind === kind && x.carrier !== "portava_object") ?? null;
}

/** The registered schema for a shared object type. Every shareable type has exactly one. */
export function schemaForObjectType(objectType: string): StructuredSchema {
  const specific = STRUCTURED_SCHEMAS.find(
    (x) => x.carrier === "portava_object" && x.objectTypes?.includes(objectType as TelegraphObjectType),
  );
  return specific ?? BY_ID.get("object.share.v1")!;
}

/**
 * The families a client that declares nothing renders: exactly the registry as
 * it stood when negotiation shipped. FROZEN, deliberately a literal and not
 * `STRUCTURED_SCHEMAS.map(...)`: a v2 added to the registry later must NOT
 * silently join the baseline, or the client written before it — the one that
 * cannot render it — would be sent it.
 */
export const BASELINE_CLIENT_SCHEMAS: Readonly<Record<string, number>> = {
  "place.share": 1, "event.share": 1, "trip.share": 1, "memory_note": 1, "location.scope": 1,
  "coordination.status": 1, "object.share": 1, "media_album": 1, "gif": 1, "voice": 1, "action": 1,
  "announcement": 1, "safety": 1, "coordination.decision": 1, "coordination.vote": 1,
  "coordination.rendezvous": 1, "coordination.commitment": 1, "coordination.commitment_response": 1,
  "coordination.action_proposal": 1, "coordination.action_response": 1, "coordination.acknowledgement": 1,
  "coordination.session": 1, "coordination.transition": 1,
};

/**
 * The minimum client version of each §8.1 action. All 1 today; an action whose
 * semantics change gets its number raised here, and every client that declared
 * a lower one stops being offered it.
 */
export const ACTION_MIN_VERSIONS: Readonly<Record<TelegraphAction, number>> = Object.fromEntries(
  TELEGRAPH_ACTIONS.map((a) => [a, 1]),
) as Record<TelegraphAction, number>;

const SCHEMA_TOKEN = /^([a-z][a-z_]*(?:\.[a-z][a-z_]*)*)\.v([1-9][0-9]{0,3})$/;
const ACTION_TOKEN = /^([A-Z][A-Z_]*)\.v([1-9][0-9]{0,3})$/;
const MAX_DECLARED = 64;

export interface ClientCapabilities {
  /** family → highest version the client renders. */
  schemas: Readonly<Record<string, number>>;
  /** action → highest version the client performs. */
  actions: Readonly<Record<string, number>>;
  /** True when the client sent the header; false = baseline. */
  declaredSchemas: boolean;
  declaredActions: boolean;
}

function parseTokens(raw: unknown, re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== "string") return out;
  const tokens = raw.split(",").map((t) => t.trim()).filter((t) => t.length > 0).slice(0, MAX_DECLARED);
  for (const t of tokens) {
    const m = re.exec(t);
    if (!m) continue;
    const v = Number(m[2]);
    out[m[1]!] = Math.max(out[m[1]!] ?? 0, v);
  }
  return out;
}

/** Read the two negotiation headers. An absent header is the baseline; a present one is taken literally. */
export function parseClientCapabilities(headers: Record<string, unknown> | undefined | null): ClientCapabilities {
  const h = headers ?? {};
  const rawSchemas = h[CLIENT_SCHEMAS_HEADER];
  const rawActions = h[CLIENT_ACTIONS_HEADER];
  const declaredSchemas = typeof rawSchemas === "string";
  const declaredActions = typeof rawActions === "string";
  return {
    schemas: declaredSchemas ? parseTokens(rawSchemas, SCHEMA_TOKEN) : BASELINE_CLIENT_SCHEMAS,
    actions: declaredActions
      ? parseTokens(rawActions, ACTION_TOKEN)
      : (ACTION_MIN_VERSIONS as Readonly<Record<string, number>>),
    declaredSchemas,
    declaredActions,
  };
}

export function clientRendersSchema(caps: ClientCapabilities, schema: StructuredSchema): boolean {
  const v = caps.schemas[schema.family];
  return typeof v === "number" && v >= schema.version;
}

export function clientPerformsAction(caps: ClientCapabilities, action: string): boolean {
  const min = (ACTION_MIN_VERSIONS as Record<string, number>)[action];
  if (typeof min !== "number") return false; // not a §8.1 action: never offered
  const v = caps.actions[action];
  return typeof v === "number" && v >= min;
}

// ── reading a stored row ─────────────────────────────────────────────────────

export type StoredSchemaResult =
  /** Not a structured carrier at all (TEXT, SYSTEM, media, legacy cards). Never negotiated. */
  | { structured: false }
  | {
      structured: true;
      /** The registered schema, or null when the row names one this server does not know. */
      schema: StructuredSchema | null;
      /** The id the row declares or implies. */
      schemaId: string;
      /** The payload validated against its schema. A malformed body is NOT valid and is never served raw. */
      valid: boolean;
      /** ACTION / ACTION_PROPOSAL only: the §8.1 action the interaction requires. */
      requiredAction: string | null;
    };

const COORDINATION_SET = new Set<string>(COORDINATION_KINDS);

function jsonOf(body: unknown): any {
  if (typeof body !== "string" || body.length === 0) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Which schema a stored row is, and whether its payload validates.
 *
 * Only the three structured carriers are classified. Legacy `msg_type`s
 * (`card`, `booking_card`, `media`, `system`, …) are deliberately NOT treated as
 * "unknown future kinds": they are today's renderers' own, and degrading them
 * would be a regression dressed as a safety feature.
 */
export function storedSchemaOf(row: { msg_type?: string | null; subtype?: string | null; body?: string | null }): StoredSchemaResult {
  const msgType = typeof row.msg_type === "string" ? row.msg_type : "";
  const upper = msgType.toUpperCase();

  if (upper === "PORTAVA_OBJECT") {
    const parsed = jsonOf(row.body);
    const declared = typeof parsed?.schema === "string" ? parsed.schema : null;
    const ref = parsePortavaObjectBody(row.body);
    const implied = ref ? schemaForObjectType(ref.objectType) : null;
    if (declared && !schemaById(declared)) {
      return { structured: true, schema: null, schemaId: declared, valid: false, requiredAction: null };
    }
    const schema = declared ? schemaById(declared)! : implied;
    if (!schema) {
      return { structured: true, schema: null, schemaId: "object.share.unknown", valid: false, requiredAction: null };
    }
    // A declared id must agree with the object it carries: a place.share.v1 label on a TRIP is a lie.
    const agrees = !!ref && !!implied && implied.id === schema.id;
    return { structured: true, schema, schemaId: schema.id, valid: agrees, requiredAction: null };
  }

  const kind = kindOfMsgType(msgType);
  if (isEnvelopeKind(kind) && kind === upper) {
    const parsed = jsonOf(row.body);
    const declared = typeof parsed?.schema === "string" ? parsed.schema : null;
    const registered = schemaForKind(kind);
    if (declared && !schemaById(declared)) {
      return { structured: true, schema: null, schemaId: declared, valid: false, requiredAction: null };
    }
    const schema = declared ? schemaById(declared)! : registered;
    if (!schema || schema.kind !== kind) {
      return { structured: true, schema: null, schemaId: declared ?? `${kind.toLowerCase()}.unknown`, valid: false, requiredAction: null };
    }
    const env = parseKindEnvelope(msgType, row.body ?? null);
    const action = kind === "ACTION" && env ? String((env.payload as any)?.action ?? "") : null;
    return { structured: true, schema, schemaId: schema.id, valid: env !== null, requiredAction: action };
  }

  if (COORDINATION_SET.has(upper)) {
    const parsed = jsonOf(row.body);
    const declared = typeof parsed?.schema === "string" ? parsed.schema : null;
    const registered = schemaForKind(upper);
    if (declared && !schemaById(declared)) {
      return { structured: true, schema: null, schemaId: declared, valid: false, requiredAction: null };
    }
    const schema = declared ? schemaById(declared)! : registered;
    if (!schema || schema.kind !== upper) {
      return { structured: true, schema: null, schemaId: declared ?? `${msgType}.unknown`, valid: false, requiredAction: null };
    }
    const env = parseCoordinationEnvelope(msgType, row.body ?? null);
    const action = upper === "ACTION_PROPOSAL" && env ? String(env.payload?.action ?? "") : null;
    return { structured: true, schema, schemaId: schema.id, valid: env !== null, requiredAction: action };
  }

  return { structured: false };
}

export type NegotiatedRender =
  | { fallback: false; schemaId: string | null }
  | {
      fallback: true;
      schemaId: string;
      reason: "unknown_schema" | "client_unsupported_schema" | "client_unsupported_action" | "invalid_payload";
      label: string;
    };

/** Decide, for ONE stored row and ONE client, whether it is served as itself or as the fallback. */
export function negotiateRender(
  row: { msg_type?: string | null; subtype?: string | null; body?: string | null; deleted_at?: string | null },
  caps: ClientCapabilities,
): NegotiatedRender {
  if (row.deleted_at) return { fallback: false, schemaId: null }; // a tombstone carries nothing to degrade
  const st = storedSchemaOf(row);
  if (!st.structured) return { fallback: false, schemaId: null };
  const labelFor = (schema: StructuredSchema | null) => {
    if (!schema) return UNKNOWN_SCHEMA_FALLBACK;
    if (schema.kind === "SAFETY" && typeof row.subtype === "string" && SAFETY_FALLBACK_BY_CLASS[row.subtype]) {
      return SAFETY_FALLBACK_BY_CLASS[row.subtype]!;
    }
    return schema.fallbackLabel;
  };
  if (!st.schema) {
    return { fallback: true, schemaId: st.schemaId, reason: "unknown_schema", label: UNKNOWN_SCHEMA_FALLBACK };
  }
  if (!st.valid) {
    return { fallback: true, schemaId: st.schemaId, reason: "invalid_payload", label: labelFor(st.schema) };
  }
  if (!clientRendersSchema(caps, st.schema)) {
    return { fallback: true, schemaId: st.schemaId, reason: "client_unsupported_schema", label: labelFor(st.schema) };
  }
  if (st.requiredAction !== null && !clientPerformsAction(caps, st.requiredAction)) {
    return { fallback: true, schemaId: st.schemaId, reason: "client_unsupported_action", label: labelFor(st.schema) };
  }
  return { fallback: false, schemaId: st.schemaId };
}

// ── writing ──────────────────────────────────────────────────────────────────

export type SchemaStampResult =
  | { ok: true; schemaId: string }
  | { ok: false; error: string; supported: string[] };

/**
 * The schema a WRITE stamps, given the kind (or object type) being written and
 * the id the client asked for, if any. A client that names a schema must name
 * the one this server writes for that kind — a version it does not know, or a
 * family that does not match the kind, is refused rather than silently written
 * as something else.
 */
export function schemaToStamp(
  target: { kind: string; objectType?: string | null },
  requested: unknown,
): SchemaStampResult {
  const schema =
    target.kind === "PORTAVA_OBJECT" && target.objectType
      ? schemaForObjectType(target.objectType)
      : schemaForKind(target.kind);
  if (!schema) return { ok: false, error: `No structured schema is registered for ${target.kind}`, supported: [] };
  if (requested === undefined || requested === null) return { ok: true, schemaId: schema.id };
  if (typeof requested !== "string" || requested !== schema.id) {
    const known = typeof requested === "string" && schemaById(requested) !== null;
    return {
      ok: false,
      error: known
        ? `schema ${String(requested)} does not describe a ${target.kind}${target.objectType ? ` (${target.objectType})` : ""}; this server writes ${schema.id}`
        : `Unsupported schema ${String(requested).slice(0, 80)}; this server writes ${schema.id}`,
      supported: [schema.id],
    };
  }
  return { ok: true, schemaId: schema.id };
}

/** The public registry, as the discovery endpoint serves it. */
export function registryForClients(): Array<{ id: string; family: string; version: number; kind: string; fallbackLabel: string; objectTypes?: readonly string[] }> {
  return STRUCTURED_SCHEMAS.map((x) => ({
    id: x.id,
    family: x.family,
    version: x.version,
    kind: x.kind,
    fallbackLabel: x.fallbackLabel,
    ...(x.objectTypes ? { objectTypes: x.objectTypes } : {}),
  }));
}
