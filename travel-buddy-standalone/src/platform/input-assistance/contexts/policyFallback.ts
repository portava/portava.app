/**
 * Global Input Intelligence §48 / G340 — the ONE local policy this client keeps,
 * and the narrowing every served value passes through.
 *
 * WHAT THIS REPLACES. Until 2026-09-21 this client carried
 * `INPUT_CONTEXT_REGISTRY`: a full 29-context table, re-declaring the server's
 * policy for every field. That table was a SECOND SOURCE OF TRUTH, and it had
 * drifted — `offlinePolicy` on 26 contexts, `allowPersonalization` on 14,
 * `privacyClass` on 14, `allowedSuggestionTypes` on 26. §48's promise is one
 * contract, versioned server-side, so a policy change ships without a client
 * release; a local copy of the answer is the thing that breaks that promise.
 *
 * The table is gone. `GET /input-assistance/policies` is the authority, and
 * what remains here is a single deliberately USELESS policy plus the sanitizers
 * that keep a served value from being worse than it.
 *
 * ── THE DIRECTION OF SAFETY ──────────────────────────────────────────────────
 *
 * Every function in this file narrows and none widens. That is the whole
 * design rule, and it is what makes "we could not reach the server" safe:
 *
 *   • no policy yet (cold start), expired, wrong account, server unreachable,
 *     malformed payload  ⇒  CONSERVATIVE_POLICY
 *   • a value this build cannot name (a newer server, a hostile or corrupted
 *     response)           ⇒  narrowed to the strictest member of its union
 *   • a list containing members this build cannot name
 *                         ⇒  those members DROPPED, never the list accepted
 *
 * `CONSERVATIVE_POLICY` grants nothing. It is not "sensible defaults" — there
 * are no safe defaults for a policy whose job is to decide what may be searched,
 * cached, personalised and logged. Its `mode` is `no_assistance`, which the
 * gateway short-circuits on before issuing any read; its `minChars` is
 * unreachable so no typed text triggers a request even if a caller ignores the
 * mode; its `privacyClass` is `private_message`, the strictest member, which
 * makes the field uncacheable (`suggestionCache.ts#CACHEABLE_PRIVACY_CLASSES`
 * admits `public` and nothing else) and gives it the metadata-only telemetry
 * vocabulary; and its `offlinePolicy` is `unavailable`, so it has no offline
 * surface either.
 *
 * The cost asymmetry decides every judgement call here, exactly as it does in
 * `suggestionCache.ts`: being wrong this way costs a field its suggestions for
 * one request; being wrong the other way searches, caches, personalises or logs
 * something the authority never permitted.
 */
import type {
  AssistanceType,
  EntityType,
  InputContext,
  OfflineInputPolicy,
  PrivacyClass,
} from '../types/inputContext.ts';
import type { InputAssistanceMode } from '../types/fieldPolicy.ts';

/**
 * The shape the authority serves per context (`routes/inputAssistance.ts`
 * `GET /input-assistance/policies`). This is the CONTRACT, not a policy: it
 * names what may arrive, and every member is re-checked at runtime because it
 * crosses the wire.
 */
export interface ServedContextPolicy {
  context: InputContext;
  mode: InputAssistanceMode;
  allowedSuggestionTypes: AssistanceType[];
  entityTypes: EntityType[];
  allowPersonalization: boolean;
  allowLiveContext: boolean;
  allowMemoryContext: boolean;
  allowAI: boolean;
  minChars: number;
  maxSuggestions: number;
  debounceMs: number;
  offlinePolicy: OfflineInputPolicy;
  privacyClass: PrivacyClass;
  zeroStateAssistance: boolean;
}

// ── The known vocabularies ───────────────────────────────────────────────────
//
// Runtime sets, not type assertions. The unions in `types/inputContext.ts` are
// erased at build time and the payload is attacker-reachable in the sense that
// matters here: it is produced by a DIFFERENT BUILD than this one. A server
// newer than this client will name members this client has never heard of, and
// that is the normal case §48 exists for, not an exotic one.

const KNOWN_MODES: ReadonlySet<string> = new Set<InputAssistanceMode>([
  'no_assistance',
  'canonical_picker',
  'search',
  'free_text_assisted',
  'action_assisted',
  'ai_assisted',
]);

const KNOWN_ASSISTANCE_TYPES: ReadonlySet<string> = new Set<AssistanceType>([
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

const KNOWN_ENTITY_TYPES: ReadonlySet<string> = new Set<EntityType>([
  'city',
  'country',
  'neighborhood',
  'place',
  'hidden_gem',
  'user',
  'trip',
  'event',
  'plan',
  'buddy',
  'hashtag',
  'language',
  'interest',
  'activity',
  'circle',
  'post',
  'stamp',
  'vibe',
]);

const KNOWN_OFFLINE_POLICIES: ReadonlySet<string> = new Set<OfflineInputPolicy>([
  'static_dictionary',
  'cached_local',
  'recent_only',
  'server_required',
  'unavailable',
]);

const KNOWN_PRIVACY_CLASSES: ReadonlySet<string> = new Set<PrivacyClass>([
  'public',
  'viewer_scoped',
  'owner_only',
  'sensitive_location',
  'private_message',
]);

/**
 * §33's recommended debounce band is 100–150ms. Used only to replace a served
 * value that is not a usable number — never to override one that is.
 */
export const FALLBACK_DEBOUNCE_MS = 120;

/**
 * A `minChars` no typed text can reach. Deliberately not `Infinity`: this value
 * is compared against `text.trim().length` and is also JSON-round-tripped in
 * tests, and `Infinity` does not survive `JSON.stringify` (it becomes `null`),
 * which would turn an unreachable threshold into a reachable one.
 */
export const UNREACHABLE_MIN_CHARS = Number.MAX_SAFE_INTEGER;

/**
 * The single local policy this client still carries.
 *
 * Returned whenever the authority has not been heard from, is stale, belongs to
 * a different account, or sent something unusable. Frozen so a caller cannot
 * turn the fallback into a permission by mutating it in place — a real hazard,
 * since this object is shared by every unresolved context in the process.
 */
export const CONSERVATIVE_POLICY: Readonly<Omit<ServedContextPolicy, 'context'>> = Object.freeze({
  mode: 'no_assistance' as InputAssistanceMode,
  allowedSuggestionTypes: Object.freeze([]) as unknown as AssistanceType[],
  entityTypes: Object.freeze([]) as unknown as EntityType[],
  allowPersonalization: false,
  allowLiveContext: false,
  allowMemoryContext: false,
  allowAI: false,
  minChars: UNREACHABLE_MIN_CHARS,
  maxSuggestions: 0,
  debounceMs: FALLBACK_DEBOUNCE_MS,
  offlinePolicy: 'unavailable' as OfflineInputPolicy,
  privacyClass: 'private_message' as PrivacyClass,
  zeroStateAssistance: false,
});

/** The conservative policy as a full record for one context. */
export function conservativePolicyFor(context: InputContext): ServedContextPolicy {
  return {
    ...CONSERVATIVE_POLICY,
    context,
    // Fresh arrays: `CONSERVATIVE_POLICY`'s are frozen and shared, and callers
    // legitimately treat a policy's lists as their own to slice or sort.
    allowedSuggestionTypes: [],
    entityTypes: [],
  };
}

// ── Narrowing helpers ────────────────────────────────────────────────────────

function boolOrFalse(v: unknown): boolean {
  // Only a literal `true` grants. `'true'`, `1` and `'yes'` do NOT — a
  // permission must be stated in the type the contract declares, or a sloppy
  // serializer upstream becomes a grant.
  return v === true;
}

/** A finite, non-negative integer, or the conservative substitute. */
function intOr(v: unknown, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

function stringMemberOr<T extends string>(v: unknown, known: ReadonlySet<string>, fallback: T): T {
  return typeof v === 'string' && known.has(v) ? (v as T) : fallback;
}

/** Keep only the members this build can name. Unknown members are DROPPED. */
function knownMembers<T extends string>(v: unknown, known: ReadonlySet<string>): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    if (typeof x === 'string' && known.has(x) && !out.includes(x as T)) out.push(x as T);
  }
  return out;
}

/**
 * Narrow one served context policy to something this build can act on.
 *
 * Never throws and never widens. A field this build cannot name becomes the
 * strictest member of its union; a list keeps only recognised members; a
 * missing or malformed field becomes the conservative value.
 *
 * ONE COUPLING IS DELIBERATE AND WORTH READING. When the served `mode` is not a
 * mode this build recognises, the result is not merely `mode: 'no_assistance'`
 * — the WHOLE policy collapses to the conservative one. A mode is the gate that
 * decides whether the field is assisted at all, so an unrecognised mode means
 * this build cannot know what the authority intended; keeping its `minChars`,
 * its `privacyClass` and its `allowPersonalization` while discarding only the
 * mode would be acting on half an instruction.
 */
export function sanitizeServedPolicy(context: InputContext, raw: unknown): ServedContextPolicy {
  if (raw === null || typeof raw !== 'object') return conservativePolicyFor(context);
  const r = raw as Record<string, unknown>;

  if (typeof r.mode !== 'string' || !KNOWN_MODES.has(r.mode)) {
    return conservativePolicyFor(context);
  }

  return {
    context,
    mode: r.mode as InputAssistanceMode,
    allowedSuggestionTypes: knownMembers<AssistanceType>(
      r.allowedSuggestionTypes,
      KNOWN_ASSISTANCE_TYPES,
    ),
    entityTypes: knownMembers<EntityType>(r.entityTypes, KNOWN_ENTITY_TYPES),
    allowPersonalization: boolOrFalse(r.allowPersonalization),
    allowLiveContext: boolOrFalse(r.allowLiveContext),
    allowMemoryContext: boolOrFalse(r.allowMemoryContext),
    allowAI: boolOrFalse(r.allowAI),
    // A missing/garbage `minChars` must NOT become 0 — 0 means "assist from the
    // first keystroke", the most permissive value in the field's range.
    minChars: intOr(r.minChars, UNREACHABLE_MIN_CHARS),
    maxSuggestions: intOr(r.maxSuggestions, 0),
    debounceMs: intOr(r.debounceMs, FALLBACK_DEBOUNCE_MS),
    offlinePolicy: stringMemberOr<OfflineInputPolicy>(
      r.offlinePolicy,
      KNOWN_OFFLINE_POLICIES,
      'unavailable',
    ),
    privacyClass: stringMemberOr<PrivacyClass>(
      r.privacyClass,
      KNOWN_PRIVACY_CLASSES,
      'private_message',
    ),
    zeroStateAssistance: boolOrFalse(r.zeroStateAssistance),
  };
}

/**
 * True when a field with this offline policy may show anything at all while the
 * authority is unreachable.
 *
 * This is the predicate `useInputAssistance` consults when a request comes back
 * `unavailable`. `server_required` and `unavailable` mean the field HAS no
 * offline surface, so retaining a cached or locally-derived list for it would
 * be presenting assistance the authority declined to license.
 *
 * Fail-CLOSED on an unrecognised value, like every other check here.
 */
export function offlineSurfaceAllowed(offlinePolicy: OfflineInputPolicy | null | undefined): boolean {
  if (offlinePolicy == null) return false;
  return (
    offlinePolicy === 'static_dictionary' ||
    offlinePolicy === 'cached_local' ||
    offlinePolicy === 'recent_only'
  );
}
