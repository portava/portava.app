/**
 * Global Input Intelligence §48 — Versioning and Compatibility.
 *
 * TWO CENSUS ROWS LIVE HERE, and they are the same mechanism seen twice.
 *
 * G341 "Version the suggestion response schema" was BUILT-BUT-WRONG: *"the
 * response carries `policyVersion` only. There is no independent schema
 * version, so a policy bump and a shape bump are indistinguishable to a
 * client."* They are different events with different consequences — a policy
 * bump changes what a field is ALLOWED to do and every client can still parse
 * the answer; a shape bump changes what the answer IS. `POLICY_VERSION` cannot
 * carry both, because a client that refused every policy bump would black out
 * assistance on every registry tweak, and a client that refused none would
 * render a shape it does not understand.
 *
 * G343 "Feature-capability handshake for suggestion types unsupported by older
 * clients" was NOT-BUILT: *"the request carries no client capability list and
 * the response carries no capability declaration. What exists instead is silent
 * client-side dropping (`search/smartActions.ts`, the grouped-row bridge),
 * which is graceful degradation, not negotiation — the server keeps spending
 * work on rows it will never see used."*
 *
 * THE ONE RULE EVERY FUNCTION HERE OBEYS: a capability declaration may only
 * NARROW. A client cannot ask for a suggestion type its field policy forbids,
 * cannot ask for an entity class the policy excludes, and cannot turn a gate
 * off by claiming to support something. `negotiateSuggestionTypes` is an
 * INTERSECTION, never a union, and `inputAssistanceCompatibility.test.ts`
 * asserts that a client claiming `ai_suggestion` on a field whose policy
 * forbids it gets nothing. §48 is a compatibility mechanism, not an authority
 * mechanism; the authority stays in §6's policy.
 *
 * AND THE SECOND RULE: silence is today's client. A request with no `client`
 * block is served exactly as it was before this file existed — same types, same
 * rows. That is what "preserve backward compatibility for active mobile
 * versions" (G342) means in practice, and it is why every parse here degrades
 * to `null` rather than to an empty capability set: an empty set would mean
 * "this client renders nothing".
 */
import type { AssistanceType, InputSuggestion, SuggestionAction } from './types';

/**
 * §48 — the version of the RESPONSE SHAPE, independent of `POLICY_VERSION`.
 *
 * MAJOR only, and deliberately so. §48 also requires that backward
 * compatibility be preserved for active mobile versions, and every field added
 * to this contract since Phase 1 has been optional and additive — an older
 * client parses a newer response because the fields it does not know about are
 * fields it does not read. An additive change therefore must NOT bump this.
 *
 * Bump it only for a change an older client cannot survive: a field removed, a
 * field's type changed, a field's meaning changed, or a required field added.
 * A client whose own major is lower than this one stops rendering (see
 * `isSchemaCompatible` on the client side) rather than half-reading a shape it
 * does not know.
 */
export const SUGGESTION_SCHEMA_VERSION = 1;

/** Every `AssistanceType`, as a set, for membership tests. */
const ALL_ASSISTANCE_TYPES: ReadonlySet<AssistanceType> = new Set<AssistanceType>([
  'entity',
  'completion',
  'recent',
  'personalized',
  'structured_value',
  'action',
  'correction',
  'validation',
  'disambiguation',
  'ai_suggestion',
]);

/** Every `SuggestionAction['type']`, as a set. */
const ALL_ACTION_TYPES: ReadonlySet<SuggestionAction['type']> = new Set<SuggestionAction['type']>([
  'open_entity',
  'replace_text',
  'set_structured_value',
  'submit_search',
  'add_to_trip',
  'share_entity',
  'drop_pin',
  'open_compass',
]);

/**
 * What a client says it can do. Every member is OPTIONAL and an omitted member
 * means "do not narrow on this dimension" — never "I support nothing".
 */
export interface ClientCapabilities {
  /** The client's own `SUGGESTION_SCHEMA_VERSION`. */
  schemaVersion: number;
  /** Suggestion types the client can RENDER, or null when it did not say. */
  suggestionTypes: AssistanceType[] | null;
  /** Action types the client can RESOLVE, or null when it did not say. */
  actionTypes: SuggestionAction['type'][] | null;
}

/** Bounded — a capability list is a fixed vocabulary, not free text. */
const MAX_DECLARED = 32;

/**
 * Parse the request's `client` block.
 *
 * Returns `null` for anything that is not a capability declaration, which is
 * the "serve it the way you always did" path. An unknown NAME inside a
 * well-formed list is dropped rather than failing the request: a newer client
 * naming a type this server has never heard of is exactly the situation a
 * handshake exists for, and refusing the whole request would make the newer
 * client worse off than a silent one.
 */
export function parseClientCapabilities(raw: unknown): ClientCapabilities | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const rawVersion = o.schemaVersion;
  const schemaVersion =
    typeof rawVersion === 'number' && Number.isFinite(rawVersion) && rawVersion > 0
      ? Math.floor(rawVersion)
      : SUGGESTION_SCHEMA_VERSION;

  const list = <T extends string>(value: unknown, known: ReadonlySet<T>): T[] | null => {
    if (!Array.isArray(value)) return null;
    const out: T[] = [];
    for (const item of value.slice(0, MAX_DECLARED)) {
      if (typeof item === 'string' && known.has(item as T) && !out.includes(item as T)) {
        out.push(item as T);
      }
    }
    // A declared-but-entirely-unrecognised list is NOT "supports nothing": it is
    // a client speaking a vocabulary this server does not have. Narrowing to []
    // there would blank the field for the newest clients first.
    return out.length > 0 ? out : null;
  };

  return {
    schemaVersion,
    suggestionTypes: list<AssistanceType>(o.suggestionTypes, ALL_ASSISTANCE_TYPES),
    actionTypes: list<SuggestionAction['type']>(o.actionTypes, ALL_ACTION_TYPES),
  };
}

/**
 * §48 — the suggestion types this serve may produce: the field policy's own
 * allowance, INTERSECTED with what the client said it can render.
 *
 * Intersection, and the order of the operands is the policy's: the result is a
 * subset of `policyAllowed` by construction, so no declaration can widen a
 * field's allowance. A client that declares nothing gets the policy's list
 * unchanged.
 */
export function negotiateSuggestionTypes(
  policyAllowed: readonly AssistanceType[],
  client: ClientCapabilities | null,
): AssistanceType[] {
  const declared = client?.suggestionTypes;
  if (!declared) return [...policyAllowed];
  const wanted = new Set(declared);
  return policyAllowed.filter((t) => wanted.has(t));
}

/**
 * §48 — drop the rows whose ACTION the client has told us it cannot resolve.
 *
 * This is the half census G343 points at directly. `search/smartActions.ts`
 * keeps a `DISPATCHABLE_ACTION_TYPES` set of exactly one member and drops
 * everything else — *"`share_entity`, `drop_pin`, `open_compass` have no
 * dispatch target in the global search bar today"* — and the grouped-row bridge
 * drops the same rows again. The rows are built, ranked, projected, serialised
 * and sent anyway. Told what the surface can resolve, the serve stops building
 * them.
 *
 * A row with NO action is never dropped: it is an entity or a completion, and
 * "which actions can you dispatch" says nothing about it.
 */
export function dropUnresolvableActionRows(
  rows: InputSuggestion[],
  client: ClientCapabilities | null,
): { rows: InputSuggestion[]; dropped: number } {
  const declared = client?.actionTypes;
  if (!declared) return { rows, dropped: 0 };
  const resolvable = new Set(declared);
  const kept = rows.filter((r) => !r.action || resolvable.has(r.action.type));
  return { rows: kept, dropped: rows.length - kept.length };
}

/**
 * The declaration half of the handshake — what the serve actually honoured.
 *
 * A handshake in one direction is a filter. The client learns which of its
 * declared types survived its own field's policy, which is the difference
 * between "the server sent me no AI rows" and "this field is not allowed to
 * produce AI rows"; only the second is worth changing the UI for.
 */
export interface NegotiatedCapabilities {
  schemaVersion: number;
  suggestionTypes: AssistanceType[];
  /** Rows built and then withheld because the client cannot resolve them. */
  withheldForClient: number;
}
