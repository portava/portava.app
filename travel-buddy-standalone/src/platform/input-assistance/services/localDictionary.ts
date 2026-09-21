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
  if (!isCacheablePrivacyClass(policy.privacyClass)) return [];
  if (!allows(policy, 'entity')) return [];
  // The licence check lives in the map lookup, not in a separate `if` — see the
  // `SURFACE_ENTITY_CLASSES` header for why a second one was removed rather
  // than kept.
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
