/**
 * §32 / §34 — the OFFLINE LOCAL SURFACE: the tier that answers a field from a
 * SHIPPED artifact when the authority is unreachable.
 *
 * ── THE GAP THIS FILLS, STATED PRECISELY ─────────────────────────────────────
 *
 * G340 made `offlinePolicy` real: when a suggest request comes back
 * `unavailable`, `useInputAssistance` asks `offlineSurfaceAllowed` whether this
 * field HAS an offline surface, and drops its retained rows when it does not.
 * That gate licenses three surfaces — `static_dictionary`, `cached_local`,
 * `recent_only` — and until this module, TWO OF THE THREE had nothing behind
 * them. `contexts/fieldInventory.ts` said so in as many words: the country
 * picker's policy is `static_dictionary` "and the client ships no country
 * list, so an offline country picker would return nothing — but nothing can
 * reach it to find out." The gate was real and the substrate was missing.
 *
 * This is the substrate side. The artifacts are in `../data/` — countries,
 * languages, interests, and a compact city index derived from the city
 * centroids the app already ships. Each one states its own bound in its header.
 *
 * ── WHAT A LOCAL ROW MAY CLAIM, AND WHAT IT MAY NOT ──────────────────────────
 *
 * G13's rule is that offline must degrade gracefully and must NEVER present
 * stale data as live. The strongest form of that rule, applied here, is that a
 * local row must not present itself as a SERVER row at all:
 *
 *   - `source: 'local'`. Not `canonical`. A consumer can tell the two apart in
 *     the projected result without inspecting anything else.
 *   - NO `action`, NO `entityId`, NO `destination`, NO `canonicalUri`, NO
 *     `structuredValue`. Those are RESOLUTIONS, and the server is what resolves
 *     (§30/§42). A client that attached `open_entity` to a name out of a
 *     shipped list would be asserting an identity nobody gave it, and the row
 *     could route somewhere the server never said it did. What the row does
 *     carry is `replacementText` — the app's own display spelling — so
 *     accepting it fills the field, which is what an offline picker is for.
 *   - NO `freshness`, ever. There is no live claim to make and no way to check
 *     one; §31's formatters are total and this module simply never sets the key.
 *   - NO `confidence`. §19's disambiguation tiers are computed from the
 *     server's match tiers. A locally invented number entering that ladder
 *     would let a shipped string auto-replace what a user typed.
 *
 * ── THE GATES, ALL THREE, AND WHY EACH IS HERE RATHER THAN ONLY IN THE HOOK ──
 *
 * 1. `offlineSurfaceAllowed(policy.offlinePolicy)` — the authority's licence.
 *    The hook checks it too; this checks it again because a second caller of
 *    this module must not be able to acquire rows the authority declined by
 *    forgetting a line. Fail-closed on a value this build cannot name.
 * 2. `isCacheablePrivacyClass(policy.privacyClass)` — the same predicate the
 *    shared cache and `localZeroState` use. These rows are a public shipped
 *    corpus and carry no viewer scope of their own, but the RETAINED rows that
 *    pass through here are whatever the field last held, and a viewer-scoped
 *    field may not re-publish those around §29's eligibility gate. One
 *    predicate, so the three call sites cannot drift.
 * 3. `allowedSuggestionTypes` — the authority also says what KINDS of row a
 *    field may show. A picker that is not licensed for `completion` does not
 *    get the raw-query rung, and a field licensed for no `entity` rows gets no
 *    dictionary. `display_name` declares an empty list, `maxSuggestions: 0` and
 *    `offlinePolicy: 'unavailable'` — it is refused three times over, which is
 *    the point: it stays manual.
 *
 * Pure module (no React, no network, no RN) — unit-testable under node:test.
 */
import type {
  AssistanceType,
  EntityType,
  InputContext,
  OfflineInputPolicy,
  PrivacyClass,
} from '../types/inputContext.ts';
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { LocalDictionaryEntry } from '../data/types.ts';
import { COUNTRY_DICTIONARY } from '../data/countries.ts';
import { CITY_INDEX } from '../data/cities.ts';
import { LANGUAGE_DICTIONARY } from '../data/languages.ts';
import { INTEREST_DICTIONARY } from '../data/interests.ts';
import { SERVER_REWRITTEN_TOKENS } from '../data/serverRewrittenTokens.ts';
import { offlineSurfaceAllowed } from '../contexts/policyFallback.ts';
import { inputPolicyVersion } from '../contexts/inputContexts.ts';
import { isCacheablePrivacyClass } from './suggestionCache.ts';
import { foldForMatch } from './queryNormalization.ts';
import { capSuggestions } from './suggestionRanking.ts';

/** The policy facts this module needs. A subset, so tests need no registry. */
export interface LocalDictionaryPolicy {
  context: InputContext;
  offlinePolicy?: OfflineInputPolicy | null;
  privacyClass?: PrivacyClass | null;
  entityTypes?: EntityType[];
  allowedSuggestionTypes?: AssistanceType[];
  maxSuggestions: number;
}

/** One shipped artifact, and the entity class it is a dictionary OF. */
export interface LocalDictionarySource {
  source: readonly LocalDictionaryEntry[];
  entityType: EntityType;
}

/**
 * The artifact that answers each entity class. Only four classes have one, and
 * that is not an accident of effort:
 *
 *   - `country`, `language`, `interest` are CLOSED and genuinely static. Their
 *     membership does not depend on who is asking or on anything in a database.
 *   - `city` is open but has a defensible compact bound (see `data/cities.ts`).
 *
 * Every other class — place, user, trip, event, hidden_gem, buddy, post — is
 * either viewer-scoped, authored by users, or both. A shipped list of them
 * cannot exist, and a CACHED one is a different build (census G200/G201) whose
 * eligible contexts the authority currently marks `server_required` anyway.
 */
const DICTIONARY_BY_ENTITY: Partial<Record<EntityType, readonly LocalDictionaryEntry[]>> = {
  country: COUNTRY_DICTIONARY,
  city: CITY_INDEX,
  language: LANGUAGE_DICTIONARY,
  interest: INTEREST_DICTIONARY,
};

/**
 * Which entity classes each licensed offline surface may be answered from.
 *
 * `static_dictionary` is the narrower of the two on purpose: a city list is
 * bounded by what this product happens to name, so it is a CACHE-shaped answer
 * rather than a closed vocabulary, and the authority's own word for that is
 * `cached_local`. `recent_only` maps to NOTHING here — that surface is the
 * user's own accepted rows (`localZeroState.ts`), and a shipped dictionary is
 * not a recent.
 *
 * ── THIS MAP IS ITSELF A GATE, AND A TEST SAYS SO ────────────────────────────
 *
 * It is keyed ONLY by the three surfaces `offlineSurfaceAllowed` licenses, so a
 * lookup for `server_required` or `unavailable` — or for a surface a newer
 * server invents that this build cannot name — comes back `undefined` and the
 * field is answered from nothing. That is the same fail-closed answer the
 * licence check gives, which is why `localDictionaryFor` does NOT also call it:
 * a second check that cannot change any outcome is a comment pretending to be
 * code, and mutating it away proved exactly that — every test stayed green.
 *
 * What holds the coupling instead is an assertion, not a second `if`:
 * `__tests__/localDictionary.test.ts` pins this map's key set to be exactly the
 * surfaces the authority licenses, so adding `server_required: …` here reddens
 * both that test and the `server_required` behaviour case.
 */
export const SURFACE_ENTITY_CLASSES: Readonly<Record<string, ReadonlySet<EntityType>>> = {
  static_dictionary: new Set<EntityType>(['country', 'language', 'interest']),
  cached_local: new Set<EntityType>(['city', 'country', 'language', 'interest']),
  recent_only: new Set<EntityType>(),
};

/**
 * The dictionaries this field may be answered from, in the authority's own
 * `entityTypes` order. Empty for every field the authority has not licensed.
 *
 * Exported so a test can assert the CHOICE without going through the rows, and
 * so the choice is provably made from the policy rather than from a hard-coded
 * field name.
 */
export function localDictionaryFor(
  policy: LocalDictionaryPolicy | null | undefined,
): LocalDictionarySource[] {
  if (!policy) return [];
  // ── RESTORED 2026-09-21. THE MAP LOOKUP DOES NOT FAIL CLOSED. ──────────────
  //
  // This line was deleted on the argument that `SURFACE_ENTITY_CLASSES` is
  // keyed only by the licensed surfaces, so the lookup below already answers
  // `undefined` for anything else — and that a mutation removing it left every
  // test green, which made it "a check that cannot change an outcome".
  //
  // THE MUTATION WAS RIGHT THAT NO TEST NOTICED AND WRONG THAT NOTHING COULD.
  // `SURFACE_ENTITY_CLASSES` is an object literal, so it inherits from
  // `Object.prototype`, and the lookup is a bare `[key]`. Measured:
  //
  //   SURFACE_ENTITY_CLASSES['server_required']  -> undefined   (fails closed)
  //   SURFACE_ENTITY_CLASSES['constructor']      -> Function     (TRUTHY)
  //   SURFACE_ENTITY_CLASSES['toString']         -> Function     (TRUTHY)
  //   SURFACE_ENTITY_CLASSES['__proto__']        -> Object       (TRUTHY)
  //   SURFACE_ENTITY_CLASSES['hasOwnProperty']   -> Function     (TRUTHY)
  //
  // For those four the guard clause below is skipped and `classes.has(...)`
  // throws, because a function has no `.has`. `offlineSurfaceAllowed` is three
  // `===` comparisons against string literals and answers false for every one
  // of them. So the two are NOT equivalent, and the one that was removed is the
  // one that fails closed on the whole input space rather than on the part a
  // test happened to enumerate.
  //
  // `localDictionaryFor` is a PUBLIC EXPORT (`../index.ts`), so "no current
  // caller passes that" is not a property this module may rely on. The union is
  // erased at build time and the header of `policyFallback.ts` already states
  // the rule this module has to live by: the payload is produced by a DIFFERENT
  // BUILD than this one.
  if (!offlineSurfaceAllowed(policy.offlinePolicy)) return [];
  if (!isCacheablePrivacyClass(policy.privacyClass)) return [];
  if (!allows(policy, 'entity')) return [];
  const classes = SURFACE_ENTITY_CLASSES[policy.offlinePolicy as string];
  if (!classes) return [];
  const out: LocalDictionarySource[] = [];
  for (const entityType of policy.entityTypes ?? []) {
    if (!classes.has(entityType)) continue;
    const source = DICTIONARY_BY_ENTITY[entityType];
    if (source) out.push({ source, entityType });
  }
  return out;
}

function allows(policy: LocalDictionaryPolicy, type: AssistanceType): boolean {
  // Absent means "the authority said nothing", which is not a licence. The
  // served policy always carries the list (`sanitizeServedPolicy` narrows it to
  // known members and produces `[]` for junk), so an absent list here means a
  // caller built a partial policy — fail closed, as everywhere else.
  return (policy.allowedSuggestionTypes ?? []).includes(type);
}

/**
 * Match ranks, strongest first. An EXACT match beats a PREFIX match beats a
 * mid-string one — the same ordering the server's own `matchTier` uses, so the
 * offline answer is shaped like the online one rather than like a filter.
 *
 * An exact ALIAS outranks a label PREFIX deliberately: typing "uk" should offer
 * the United Kingdom before Ukraine, and the opposite ordering is what a naive
 * `startsWith` scan produces.
 */
const RANK_EXACT_LABEL = 0;
const RANK_EXACT_ALIAS = 1;
const RANK_PREFIX_LABEL = 2;
const RANK_PREFIX_ALIAS = 3;
const RANK_CONTAINS = 4;
const RANK_NONE = 99;

function rankEntry(entry: LocalDictionaryEntry, q: string): number {
  const label = foldForMatch(entry.label);
  if (label === q) return RANK_EXACT_LABEL;
  const aliases = (entry.aliases ?? []).map(foldForMatch);
  if (aliases.some((a) => a === q)) return RANK_EXACT_ALIAS;
  if (label.startsWith(q)) return RANK_PREFIX_LABEL;
  if (aliases.some((a) => a.startsWith(q))) return RANK_PREFIX_ALIAS;
  if (label.includes(q)) return RANK_CONTAINS;
  return RANK_NONE;
}

/**
 * Order a shipped dictionary against a typed query.
 *
 * THIS IS NOT RE-RANKING SERVER OUTPUT. §42 reserves ranking to the server and
 * `suggestionRanking.ts` says in its own header that the client does not
 * re-rank — that rule is about rows the SERVER returned, and it is not bent
 * here: retained server rows are never sorted by this function. These rows have
 * no server order to preserve, because the server never produced them, so some
 * order has to be chosen and it is chosen deterministically: match rank, then
 * shorter label (the shortest name that starts with what you typed is the
 * likeliest intent — "India" before "Indonesia"), then the artifact's own
 * order.
 */
function matchDictionary(
  entries: readonly LocalDictionaryEntry[],
  query: string,
  limit: number,
): LocalDictionaryEntry[] {
  if (limit <= 0) return [];
  const q = foldForMatch(query);
  // An EMPTY field gets the head of the artifact rather than nothing: offline,
  // a picker with no rows at all is the failure §32 is about. It is the head in
  // the artifact's own order — never a "popular" or "nearby" claim, which would
  // be a ranking this client cannot make.
  if (!q) return entries.slice(0, limit);
  const scored: Array<{ entry: LocalDictionaryEntry; rank: number; at: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const rank = rankEntry(entries[i]!, q);
    if (rank === RANK_NONE) continue;
    scored.push({ entry: entries[i]!, rank, at: i });
  }
  scored.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.entry.label.length !== b.entry.label.length) {
      return a.entry.label.length - b.entry.label.length;
    }
    return a.at - b.at;
  });
  return scored.slice(0, limit).map((s) => s.entry);
}

/** Build the local row for one dictionary entry. See the header for the omissions. */
function dictionaryRow(
  entry: LocalDictionaryEntry,
  entityType: EntityType,
  context: InputContext,
): InputSuggestion {
  return {
    // `local:` prefixed so it can never collide with a server row id, which is
    // always `${context}:${type}:${id}`.
    id: `local:${context}:${entityType}:${entry.code ?? entry.label}`,
    type: 'entity',
    context,
    label: entry.label,
    // The app's own display spelling goes into the field — never the folded
    // match key and never what the user typed (§10).
    replacementText: entry.label,
    entityType,
    source: 'local',
    policyVersion: inputPolicyVersion(),
  };
}

/**
 * §13/§32 — the raw-query rung: "search for what I typed".
 *
 * Mirrors the SERVER's own `buildQueryCompletion` field for field, including
 * its `source: 'local'` — that row is the server admitting the same thing this
 * one does, that nothing was resolved and the raw text is preserved (§2).
 * Offered only to a field the authority licenses `completion` for.
 */
function rawQueryRow(context: InputContext, query: string): InputSuggestion {
  return {
    id: `local:${context}:completion:${query}`,
    type: 'completion',
    context,
    label: `Search "${query}"`,
    replacementText: query,
    action: { type: 'submit_search', query },
    source: 'local',
    policyVersion: inputPolicyVersion(),
  };
}

/**
 * The whole offline answer for a field: what was RETAINED, then what the
 * shipped artifacts match, then the raw query.
 *
 * That order is §41's ladder read from the bottom. `retained` is whatever the
 * hook already had on screen — a narrowed cache hit or the session's accepted
 * rows, both of them rows the SERVER projected — so it outranks anything
 * shipped, and a dictionary row is never allowed to displace it or to appear
 * beside it for the same name. The raw query is last because it resolves
 * nothing and exists so the field is never empty when the user has typed.
 *
 * Returns `[]` — never a partial or invented row — for a field the authority
 * has not licensed an offline surface for, whatever was retained.
 */
export function offlineLocalRows(
  policy: LocalDictionaryPolicy | null | undefined,
  query: string,
  retained: readonly InputSuggestion[],
): InputSuggestion[] {
  if (!policy) return [];
  // Gate 1 — the authority's licence. Fail-closed on an unnameable value.
  if (!offlineSurfaceAllowed(policy.offlinePolicy)) return [];
  // Gate 2 — §29. A viewer-scoped field re-publishes nothing without a round
  // trip that can re-check eligibility, INCLUDING what it was already holding.
  if (!isCacheablePrivacyClass(policy.privacyClass)) return [];

  const max = Math.max(0, policy.maxSuggestions);
  if (max === 0) return [];

  const rows: InputSuggestion[] = [...retained];
  const seen = new Set(rows.map((r) => foldForMatch(r.label)));

  for (const { source, entityType } of localDictionaryFor(policy)) {
    for (const entry of matchDictionary(source, query, max)) {
      const key = foldForMatch(entry.label);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(dictionaryRow(entry, entityType, policy.context));
    }
  }

  const trimmed = query.trim();
  if (trimmed.length > 0 && allows(policy, 'completion')) {
    rows.push(rawQueryRow(policy.context, trimmed));
  }

  return capSuggestions(rows, max);
}

// ── §34 local SUFFICIENCY (census G224 / G212; lead ruling PR-D2-5) ──────────
//
// The ruling (lead, 2026-10-07): `language` and `interest` may answer from the
// shipped list with NO request, ONLY while the shipped list is byte-for-byte what
// the server returns for every viewer; the privacy check admits exactly these
// two fields on this path and nothing else. So this path is NOT the offline
// fallback above (`offlineLocalRows`, whose privacy gate is unchanged and still
// refuses both, being viewer_scoped). It is a second, narrow answerer that
// reproduces the SERVER's own algorithm for these two static lists
// (`lib/inputAssistance/searchCandidates.ts#searchStatic` → `rankByMatchTier` →
// the projector), row for row. `artifacts/api-server/src/test/inputLocalSufficiencyParity.test.ts`
// runs the real gateway and this function side by side over a sweep of queries
// and fails on any difference, and fails if the server's answer varies by viewer.
//
// Whenever it cannot be sure it would answer exactly as the server does, it
// returns `[]` and the request goes out as before:
//   - fewer than two characters (the gateway dispatches entities only at ≥ 2);
//   - anything but ASCII letters in single-spaced words (the server normalizes
//     diacritics, scripts and emoji; this does not try to);
//   - a word the server's alias table rewrites (`data/serverRewrittenTokens.ts`);
//   - no hit (the server may still find one through its typo corrector).

/** The ONLY contexts this path may ever answer (lead ruling PR-D2-5). */
export const LOCALLY_SUFFICIENT_CONTEXTS: ReadonlySet<InputContext> = new Set<InputContext>(['language', 'interest']);

/** The descriptor facts the sufficiency gate needs. A subset, so tests need no store. */
export interface LocalSufficiencyFacts {
  context?: InputContext | null;
  localSufficient?: boolean | null;
  offlinePolicy?: OfflineInputPolicy | null;
  privacyClass?: PrivacyClass | null;
  allowPersonalization?: boolean | null;
  allowLiveContext?: boolean | null;
  allowMemoryContext?: boolean | null;
  allowAI?: boolean | null;
  authoritative?: boolean | null;
}

/**
 * True when this field may answer a typed query with NO request.
 *
 * The SERVER grants it (`policyRegistry.ts#sanctionLocalSufficiency`); the client
 * re-checks every condition and refuses on any doubt:
 *   - a literal `true` grant from an AUTHORITATIVE table;
 *   - one of the two allowlisted contexts — and nothing else, whatever a server
 *     says;
 *   - a `static_dictionary` surface;
 *   - a privacy class of `public` or `viewer_scoped` (never owner_only,
 *     sensitive_location or private_message);
 *   - nothing personalised, live, memory-based or AI.
 */
export function localAnswerSuffices(d: LocalSufficiencyFacts | null | undefined): boolean {
  if (!d) return false;
  return (
    d.localSufficient === true &&
    d.authoritative === true &&
    !!d.context && LOCALLY_SUFFICIENT_CONTEXTS.has(d.context) &&
    d.offlinePolicy === 'static_dictionary' &&
    (d.privacyClass === 'public' || d.privacyClass === 'viewer_scoped') &&
    d.allowPersonalization !== true &&
    d.allowLiveContext !== true &&
    d.allowMemoryContext !== true &&
    d.allowAI !== true
  );
}

/** The server's search type, entity class and route for each sufficient context. */
const SUFFICIENT_SOURCES: Readonly<Record<string, { list: readonly LocalDictionaryEntry[]; searchType: string; entityType: EntityType; route: string }>> = {
  language: { list: LANGUAGE_DICTIONARY, searchType: 'languages', entityType: 'language', route: '/language' },
  interest: { list: INTEREST_DICTIONARY, searchType: 'interests', entityType: 'interest', route: '/interest' },
};

/**
 * The server's `maxSuggestions` for the two sufficient contexts (its registry
 * default, `policyRegistry.ts#policy`). Both sides slice substring hits to a
 * per-type limit derived from it BEFORE ranking, so the answers are equal only
 * while the device asks for exactly this many (verifier D1, 2026-10-07): with a
 * smaller device cap a higher-tier hit beyond the device's slice would be lost.
 * Any other cap asks the server. The parity suite pins this to the server.
 */
export const SERVER_STATIC_MAX = 8;

/** ASCII letters in single-spaced words: the inputs the server's normalizer leaves alone but for case. */
const SERVER_IDENTICAL_QUERY = /^[A-Za-z]+(?: [A-Za-z]+)*$/;

/** The server's `matchTier` (title only — these rows carry no subtitle). */
function serverMatchTier(title: string, lq: string): number {
  const t = title.toLowerCase().trim();
  if (t === lq) return 3;
  if (t.startsWith(lq)) return 2;
  if (t.includes(lq)) return 1;
  return 0;
}

/** The server projector's confidence for a tier (`projection.ts#tierConfidence`). */
function serverTierConfidence(tier: number): number {
  return tier === 3 ? 0.99 : tier === 2 ? 0.85 : tier === 1 ? 0.6 : 0.4;
}

/**
 * The no-round-trip answer for a SUFFICIENT field, or `[]` to ask the server.
 * Row for row what the gateway serves for the same text (see the header); the
 * one deliberate difference is `source: 'local'`, which tells telemetry and the
 * reader where the row was produced.
 */
export function sufficientLocalRows(
  policy: LocalDictionaryPolicy | null | undefined,
  facts: LocalSufficiencyFacts | null | undefined,
  query: string,
): InputSuggestion[] {
  if (!policy || !localAnswerSuffices(facts)) return [];
  const src = SUFFICIENT_SOURCES[policy.context];
  if (!src) return [];
  const raw = query.trim();
  if (raw.length < 2 || !SERVER_IDENTICAL_QUERY.test(raw)) return [];
  const lq = raw.toLowerCase();
  if (lq.split(' ').some((w) => SERVER_REWRITTEN_TOKENS.has(w))) return []; // the server searches a rewritten query
  // Only at the server's own cap (see SERVER_STATIC_MAX); any other asks the server.
  if (policy.maxSuggestions !== SERVER_STATIC_MAX) return [];
  const max = SERVER_STATIC_MAX;
  // searchStatic: filter by substring, slice to the per-type fetch limit, THEN
  // rank (a stable sort by tier) — the order matters and is the server's.
  const perType = Math.max(2, Math.ceil(SERVER_STATIC_MAX / 1));
  const hits = src.list
    .map((e) => e.label)
    .filter((label) => label.toLowerCase().includes(lq))
    .slice(0, perType)
    .map((label, at) => ({ label, tier: serverMatchTier(label, lq), at }))
    .sort((a, b) => b.tier - a.tier || a.at - b.at);
  if (hits.length === 0) return [];
  return hits.slice(0, max).map(({ label, tier }) => {
    const slug = label.toLowerCase();
    const entityId = `${src.searchType}:${slug.replace(/\s+/g, '-')}`;
    const route = `${src.route}/${encodeURIComponent(slug)}`;
    return {
      id: `${policy.context}:${src.searchType}:${entityId}`,
      type: 'entity',
      context: policy.context,
      label,
      entityType: src.entityType,
      entityId,
      action: { type: 'open_entity', entityType: src.entityType, entityId },
      confidence: serverTierConfidence(tier),
      source: 'local',
      policyVersion: inputPolicyVersion(),
      destination: { route, entityType: src.entityType, entityId },
      canonicalUri: `portava:${route}`,
    } as InputSuggestion;
  });
}
