/**
 * Telegraph §30A.16 — client capability negotiation, the CLIENT half
 * (census-telegraph T431).
 *
 * Spec §30A.16: "Unknown future message types render a safe generic fallback on
 * older clients rather than crashing or silently disappearing. Use client
 * capability negotiation when an interaction requires a minimum supported
 * schema or action version."
 *
 * The server half (artifacts/api-server/src/services/telegraph/structuredSchemas.ts)
 * reads two headers on the negotiated reads — GET /threads/:id/messages and
 * POST /threads/:id/share-projections:
 *
 *   x-telegraph-client-schemas   `<family>.v<n>,…`  the schemas this client RENDERS
 *   x-telegraph-client-actions   `<ACTION>.v<n>,…`  the §8.1 actions it PERFORMS
 *
 * A client that sends neither is served the frozen baseline (every schema that
 * existed when negotiation shipped, every action). A header that is present is
 * taken literally: a structured row whose schema the client did not declare —
 * or an ACTION whose action it did not — comes back as a plain TEXT row with a
 * fixed sentence, instead of a payload the client would print or a button it
 * could not honour. The server consults neither header while
 * `telegraph_structured_schemas_enabled` is off (seeded FALSE), so sending them
 * changes nothing until it is turned on.
 *
 * ── DECLARED FROM THE RENDERERS, NEVER "EVERYTHING" ─────────────────────────
 * A header that claims more than the client draws is worse than none: the
 * baseline at least degrades the day a v2 ships. So every token here is DERIVED:
 *
 *   SCHEMAS  per surface, from the stored `msgType`s that surface's dispatch
 *            draws as themselves —
 *              conversation (app/messages/[id].tsx): `rendersTypedKind`'s list
 *                (kinds/renderedKinds.ts) and the PORTAVA_OBJECT card;
 *              group chat (components/GroupChatScreen.tsx): the PORTAVA_OBJECT
 *                card only — every other structured kind falls to its text
 *                bubble there.
 *            A schema is declared when its stored type is on that list, at the
 *            one version the client's parsers accept (`envelopeVersion: '1'`,
 *            `shareProjectionVersion: '1'`). No §9 coordination kind is drawn
 *            in either stream (they are unknown types to the bubble,
 *            kinds/unsupportedPayload.ts), so none is declared: the server then
 *            sends its own sentence ("Posted a status update") rather than the
 *            client's generic "can't be shown".
 *   ACTIONS  from the controls that perform them. In the message stream no
 *            ACTION is performable: TypedMessageRenderer is mounted without
 *            `onPressAction` and draws the proposal as unconfirmable, so the
 *            stream declares none (`none` — present, so taken literally, and
 *            parsing to nothing). A shared card performs exactly what
 *            `offeredCardActions` turns into a control (legacyCardView.ts); each
 *            §8.1 action is probed through it.
 *
 * ── THE MIRROR ──────────────────────────────────────────────────────────────
 * `CLIENT_SCHEMA_MIRROR` is the client's copy of the server registry: which
 * stored kind (and, for shares, which object types) each schema id names. It
 * decides nothing about rendering; it only lets a rendered TYPE be spelled as a
 * schema id. The api-server suite telegraphClientNegotiation.test.ts imports
 * this file and fails if the mirror and `STRUCTURED_SCHEMAS` disagree on any id,
 * kind, carrier, version or object type.
 *
 * ── WRITES ──────────────────────────────────────────────────────────────────
 * POST /threads/:id/coordination takes an optional `schema`; with the flag on
 * the server refuses one that is not exactly the id it writes for the kind.
 * `coordinationSchemaFor` answers the mirror's id for a coordination kind this
 * client composes, and nothing for any other kind — never a guess.
 *
 * Pure: imports three pure modules and nothing else, so the api-server's
 * cross-tree test can load it under node.
 */
import { TYPED_RENDERED_MSG_TYPES } from '../kinds/renderedKinds.ts';
import { offeredCardActions } from '../sharing/legacyCardView.ts';
import type { TelegraphAction } from '../sharedContext/types.ts';

export const CLIENT_SCHEMAS_HEADER = 'x-telegraph-client-schemas';
export const CLIENT_ACTIONS_HEADER = 'x-telegraph-client-actions';

export type SchemaCarrier = 'envelope' | 'coordination' | 'portava_object';

export interface MirroredSchema {
  id: string;
  family: string;
  version: number;
  carrier: SchemaCarrier;
  /** The stored kind (upper case). PORTAVA_OBJECT for the share families. */
  kind: string;
  /** Share families only: the object types the family covers (server: `objectTypes`). */
  objectTypes?: readonly string[];
}

const m = (family: string, version: number, carrier: SchemaCarrier, kind: string, objectTypes?: readonly string[]): MirroredSchema =>
  ({ id: `${family}.v${version}`, family, version, carrier, kind, ...(objectTypes ? { objectTypes } : {}) });

/** The server registry, mirrored (pinned by the api-server's telegraphClientNegotiation.test.ts). */
export const CLIENT_SCHEMA_MIRROR: readonly MirroredSchema[] = [
  m('place.share', 1, 'portava_object', 'PORTAVA_OBJECT', ['PLACE', 'HIDDEN_GEM', 'MAP_PIN', 'NEIGHBORHOOD', 'MEETUP_POINT']),
  m('event.share', 1, 'portava_object', 'PORTAVA_OBJECT', ['EVENT', 'MEETUP']),
  m('trip.share', 1, 'portava_object', 'PORTAVA_OBJECT', ['TRIP', 'TRIP_STAGE', 'PLAN', 'ROUTE']),
  m('memory_note', 1, 'envelope', 'MEMORY_NOTE'),
  m('location.scope', 1, 'envelope', 'LOCATION'),
  m('coordination.status', 1, 'coordination', 'COORDINATION'),
  m('object.share', 1, 'portava_object', 'PORTAVA_OBJECT'),
  m('media_album', 1, 'envelope', 'MEDIA_ALBUM'),
  m('gif', 1, 'envelope', 'GIF'),
  m('voice', 1, 'envelope', 'VOICE'),
  m('action', 1, 'envelope', 'ACTION'),
  m('announcement', 1, 'envelope', 'ANNOUNCEMENT'),
  m('safety', 1, 'envelope', 'SAFETY'),
  m('coordination.decision', 1, 'coordination', 'DECISION'),
  m('coordination.vote', 1, 'coordination', 'VOTE'),
  m('coordination.rendezvous', 1, 'coordination', 'RENDEZVOUS'),
  m('coordination.commitment', 1, 'coordination', 'COMMITMENT'),
  m('coordination.commitment_response', 1, 'coordination', 'COMMITMENT_RESPONSE'),
  m('coordination.action_proposal', 1, 'coordination', 'ACTION_PROPOSAL'),
  m('coordination.action_response', 1, 'coordination', 'ACTION_RESPONSE'),
  m('coordination.acknowledgement', 1, 'coordination', 'ACKNOWLEDGEMENT'),
  m('coordination.session', 1, 'coordination', 'COORDINATION_SESSION'),
  m('coordination.transition', 1, 'coordination', 'COORDINATION_TRANSITION'),
];

/** §8.1's actions (server: `TELEGRAPH_ACTIONS`, vocabulary.ts), in its order. */
export const CLIENT_ACTION_VOCABULARY: readonly TelegraphAction[] = [
  'ADD_TO_TRIP', 'CREATE_PLAN', 'JOIN_PLAN', 'LEAVE_PLAN', 'MEET_HERE', 'SHARE_PLACE', 'SHARE_ROUTE',
  'VOTE', 'SHARE_AVAILABILITY', 'SHARE_LOCATION', 'SPLIT_RIDE', 'CHECK_IN_SAFE', 'RETURN_TO_GROUP', 'DO_THIS_NOW',
];

/** The one version of each carrier this client's parsers accept (kindsApi.parseKindEnvelope, shareApi.parsePortavaObjectBody). */
export const CLIENT_PARSED_VERSION: Readonly<Record<SchemaCarrier, number>> = { envelope: 1, coordination: 1, portava_object: 1 };

/** The surfaces that read a thread page, and the stored types each draws as itself. */
export type TelegraphReadSurface = 'conversation' | 'group_chat';

const OBJECT_REFERENCE_MSG_TYPE = 'portava_object';

export const SURFACE_STRUCTURED_MSG_TYPES: Readonly<Record<TelegraphReadSurface, readonly string[]>> = {
  conversation: [...TYPED_RENDERED_MSG_TYPES, OBJECT_REFERENCE_MSG_TYPE],
  group_chat: [OBJECT_REFERENCE_MSG_TYPE],
};

/** The stored `msg_type` a schema's rows carry. */
export function storedMsgTypeOf(s: MirroredSchema): string {
  return s.carrier === 'portava_object' ? OBJECT_REFERENCE_MSG_TYPE : s.kind.toLowerCase();
}

/** `<family>.v<n>` for every schema the surface draws, in the mirror's order. */
export function declaredSchemaTokens(drawn: readonly string[]): string[] {
  return CLIENT_SCHEMA_MIRROR
    .filter((s) => drawn.includes(storedMsgTypeOf(s)) && s.version === CLIENT_PARSED_VERSION[s.carrier])
    .map((s) => s.id);
}

/** §8.1 actions a shared card turns into a control: offering the action alone changes what the card draws. */
export function cardPerformedActions(): TelegraphAction[] {
  const none = offeredCardActions('live', []);
  return CLIENT_ACTION_VOCABULARY.filter((a) => {
    const one = offeredCardActions('live', [a]);
    return (Object.keys(one) as Array<keyof typeof one>).some((k) => one[k] !== none[k]);
  });
}

/** No ACTION is performable in either message stream (see the header). */
export function streamPerformedActions(): TelegraphAction[] {
  return [];
}

/** Present-but-empty is spelled `none`: a value every HTTP stack keeps, and one the server parses to nothing. */
const tokenList = (tokens: readonly string[]) => (tokens.length > 0 ? tokens.join(',') : 'none');
const actionTokens = (actions: readonly TelegraphAction[]) => actions.map((a) => `${a}.v1`);

/** The headers for a thread page read (GET /threads/:id/messages) drawn on `surface`. */
export function telegraphReadHeaders(surface: TelegraphReadSurface): Record<string, string> {
  return {
    [CLIENT_SCHEMAS_HEADER]: tokenList(declaredSchemaTokens(SURFACE_STRUCTURED_MSG_TYPES[surface])),
    [CLIENT_ACTIONS_HEADER]: tokenList(actionTokens(streamPerformedActions())),
  };
}

/** The headers for POST /threads/:id/share-projections: what a shared card draws and performs. */
export function shareProjectionHeaders(): Record<string, string> {
  return {
    [CLIENT_SCHEMAS_HEADER]: tokenList(declaredSchemaTokens([OBJECT_REFERENCE_MSG_TYPE])),
    [CLIENT_ACTIONS_HEADER]: tokenList(actionTokens(cardPerformedActions())),
  };
}

/** The schema id a coordination post names: the mirror's id for that kind, or nothing for a kind it does not know. */
export function coordinationSchemaFor(kind: string): string | undefined {
  const s = CLIENT_SCHEMA_MIRROR.find((x) => x.carrier === 'coordination' && x.kind === kind && x.version === CLIENT_PARSED_VERSION.coordination);
  return s?.id;
}

/** `{ kind, payload }` → `{ kind, payload, schema? }` — the field only when the client knows the kind's schema. */
export function withCoordinationSchema<T extends { kind: string; payload: unknown }>(body: T): T & { schema?: string } {
  const schema = coordinationSchemaFor(body.kind);
  return schema ? { ...body, schema } : body;
}
