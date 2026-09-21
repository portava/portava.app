/**
 * Global Input Intelligence — suggestion cache (spec §33 stale-while-revalidate,
 * §49 "stale cache refresh").
 *
 * A small TTL + LRU cache of suggestion lists keyed by (fieldId, normalized
 * query, coarse coords). Generalizes the 60s/60-entry LRU baked into
 * `useSearchSuggestions` so every field shares one cache implementation with
 * the same hard-won properties:
 *   - backspacing over a word re-renders instantly with zero network,
 *   - a tiny GPS drift never busts the key (coords rounded to ~1km),
 *   - the cache never returns entries past their TTL (no stale-as-fresh).
 *
 * Pure module (no React, no network, no RN) — unit-tested under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { PrivacyClass } from '../types/inputContext.ts';

/**
 * §29/§32 — the privacy classes whose suggestions must NOT be held in the
 * process-wide cache.
 *
 * `privacyClass` was declared on every one of the 29 contexts and READ BY
 * NOTHING: sensitive on `hidden_gem_location`, viewer-scoped on
 * `telegraph_recipient` and `compass_prompt`, `private_message` on the
 * message body. No production path branched on it, and deleting the field
 * would have changed no behaviour. This is its first reader.
 *
 * The member names below are the SERVER's, since 2026-09-21: the client used to
 * declare its own four-member taxonomy and this set named two members the
 * server had never heard of, so the authority's classification could not reach
 * this gate. See `types/inputContext.ts` for the unification, and
 * `test/inputPolicyContractParity.test.ts` for what now pins it.
 *
 * What it changes, concretely. `sharedSuggestionCache` is ONE process-global
 * map keyed by (fieldId, typed text, coarse coords), living for the life of the
 * app process and holding whole suggestion lists. For `telegraph_recipient`
 * that list is PEOPLE — who the viewer is eligible to message — retained under
 * the raw prefix they typed, minutes after the sheet closed, and served back
 * without a round trip that could re-check eligibility. `public` fields
 * (a city, a country, a place) carry none of that: the same list is the same
 * for everyone, which is exactly why the cache is safe there and only there.
 *
 * A refused field is not degraded, only slower: it re-requests, and the gateway
 * re-runs the block/age gate on every keystroke — which is the behaviour a
 * viewer-scoped list should have had all along.
 */
// ── ALLOWLIST, NOT DENYLIST — changed 2026-09-21, and this is the reason ─────
//
// This gate was a DENYLIST of four private classes, with a doc comment
// promising it was "fail-CLOSED on an unknown or missing class". Those two
// statements disagreed, and the code was the weaker one: it failed closed on
// `null`/`undefined` only. Any string that was not one of the four listed
// classes — including one this build has never heard of — came back
// CACHEABLE.
//
// THAT IS A REACHABLE RUNTIME PATH, not a hypothetical. `privacyClass` arrives
// in the SERVER's field policy, and §48 exists precisely because client and
// server versions skew: a server that classifies a new field as, say,
// `crew_scoped` would hand this build a class it cannot recognise, and the
// denylist would answer "cacheable" — retaining a viewer-scoped list in a
// process-global map keyed by typed text, served back without a round trip
// that could re-check eligibility. The newer and more careful the server, the
// worse the failure. It was found by a test fixture that used `'personal'`, a
// string that has never been a member of this union; the fixture was wrong and
// the answer it got was worse.
//
// The allowlist inverts it: `public` is cacheable and NOTHING else is. That is
// what the paragraph above already said in prose — "the same list is the same
// for everyone, which is exactly why the cache is safe there AND ONLY THERE" —
// so this is the code catching up with its own stated contract. A new private
// class added server-side is now refused by default rather than admitted by
// default, and adding a genuinely public class is a deliberate edit here.
//
// The cost asymmetry is unchanged and still decides the direction: being wrong
// this way costs one extra request; being wrong the other way retains a list
// of people.
const CACHEABLE_PRIVACY_CLASSES: ReadonlySet<PrivacyClass> = new Set<PrivacyClass>(['public']);

/**
 * True when a field's suggestions may be held in the shared cache.
 *
 * Fail-CLOSED on an unknown, unrecognised or missing class. `privacyClass` is
 * typed, but it crosses the wire from the server, so the runtime check cannot
 * rely on the type: an unrecognised string is refused, not admitted.
 */
export function isCacheablePrivacyClass(privacyClass: PrivacyClass | null | undefined): boolean {
  if (privacyClass == null) return false;
  return CACHEABLE_PRIVACY_CLASSES.has(privacyClass);
}

export interface SuggestionCacheOptions {
  /** Entry lifetime in ms. Default 60_000 (matches legacy search cache). */
  ttlMs?: number;
  /** Max entries before LRU eviction. Default 60. */
  max?: number;
}

interface CacheEntry {
  suggestions: InputSuggestion[];
  ts: number;
}

export class SuggestionCache {
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly map = new Map<string, CacheEntry>();
  /** Injectable clock for deterministic tests. */
  private readonly now: () => number;

  constructor(opts: SuggestionCacheOptions = {}, now: () => number = Date.now) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.max = opts.max ?? 60;
    this.now = now;
  }

  /**
   * Build a stable cache key. Query is trimmed + lowercased; coords are rounded
   * to 2 decimal places (~1km) so GPS jitter doesn't fragment the cache.
   */
  static key(fieldId: string, query: string, lat?: number | null, lng?: number | null): string {
    const q = query.trim().toLowerCase();
    const latKey = lat != null ? Math.round(lat * 100) / 100 : '';
    const lngKey = lng != null ? Math.round(lng * 100) / 100 : '';
    return `${fieldId}|${q}|${latKey}|${lngKey}`;
  }

  /**
   * Read a fresh entry, or `null` when missing/expired. A hit refreshes the
   * LRU recency of the entry (Map preserves insertion order → delete+set moves
   * it to the most-recent position).
   */
  get(key: string): InputSuggestion[] | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (this.now() - entry.ts >= this.ttlMs) {
      this.map.delete(key);
      return null;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.suggestions;
  }

  /** Store a suggestion list, evicting the oldest entries past `max`. */
  set(key: string, suggestions: InputSuggestion[]): void {
    this.map.set(key, { suggestions, ts: this.now() });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest == null) break;
      this.map.delete(oldest);
    }
  }

  /** True when a fresh (unexpired) entry exists for the key. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /**
   * §33 tier 1 / §34 "prefer local: cached city prefix matching" — the entry for
   * the LONGEST cached query that is a strict prefix of `query`, or null.
   *
   * WHY THIS EXISTS. Until it did, the cache was keyed by the WHOLE query
   * string, so it only ever answered a query the user had typed before,
   * character for character. Typing forward — "ba" → "ban" → "bang" — missed on
   * every keystroke even though the answer for "ba" was sitting in the map, and
   * §33's middle tier ("1 char → local/cache prefix match") had no substrate at
   * all: a cache miss went straight to the network. The empty prefix is included
   * deliberately, because a field's zero-state entry is cached under `''` and is
   * exactly the local list a 1-character query should be narrowed out of.
   *
   * The search is by CONSTRUCTED KEY, never by parsing keys back apart: the
   * fieldId segment can itself contain the `|` separator (the §22 AI variant
   * appends a JSON blob), so splitting a key is not safe. At most
   * `query.length` map lookups, each O(1), longest prefix first — so the most
   * specific cached answer wins and the scan stops there.
   *
   * The rows this returns were the server's answer for a SHORTER query and are
   * therefore a superset, never a subset: they must be narrowed to the typed
   * text before being shown. `narrowToQuery` (suggestionRanking.ts) is that
   * step, and this method deliberately does not do it — a cache should not know
   * how a suggestion row matches.
   */
  longestPrefix(
    fieldId: string,
    query: string,
    lat?: number | null,
    lng?: number | null,
  ): { query: string; suggestions: InputSuggestion[] } | null {
    const q = query.trim().toLowerCase();
    // Strictly shorter than `q` — the exact key is the caller's own SWR hit.
    for (let n = q.length - 1; n >= 0; n--) {
      const prefix = q.slice(0, n);
      const hit = this.get(SuggestionCache.key(fieldId, prefix, lat, lng));
      if (hit) return { query: prefix, suggestions: hit };
    }
    return null;
  }

  clear(): void {
    this.map.clear();
  }

  /** Current live entry count (excludes nothing — call after gets to prune). */
  get size(): number {
    return this.map.size;
  }
}

/**
 * Process-wide shared cache instance. Fields share it so returning to a
 * previously-typed query is instant across screens. Tests construct their own
 * `new SuggestionCache(...)` with an injected clock instead of touching this.
 */
export const sharedSuggestionCache = new SuggestionCache();
