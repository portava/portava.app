/**
 * §34 "prefer local: immediate zero-state" — the client half.
 *
 * WHAT WAS WRONG. §34 lists five things the client should resolve locally, and
 * "immediate zero-state" is the one a user notices. It was the exact inverse:
 * opening a picker with an empty field produced a SERVER ROUND TRIP
 * (`gateway.ts` `zeroCharGeoDefaults` / the §35 recents branch) and nothing
 * else, so a cold or offline open of a city picker showed an empty panel — even
 * when the user had picked a city in that same field, in that same session,
 * seconds earlier. The client already had the material: `suggestionHistory.ts`
 * holds an in-memory per-context ring buffer of explicit accepts. It was
 * exported from `index.ts` and READ BY NOTHING, and `recordSelection` was called
 * from nowhere in the app, so the buffer was always empty as well as unread.
 *
 * This module is that tier, and `SmartInput` is its writer. It also gives
 * `suggestionHistory.recordSelection` its FIRST caller in the app.
 *
 * ── THE PRIVACY GATE IS THE POINT, NOT A DETAIL ──────────────────────────────
 *
 * A zero-state served from device memory is a list re-shown WITHOUT the server
 * re-running §29's eligibility gate. For a public field (a city, a country) the
 * answer is the same for everyone and cannot go stale in a way that harms
 * anyone. For `telegraph_recipient` (`privacyClass: 'viewer_scoped'`) the rows are
 * PEOPLE the viewer was eligible to message at the time — re-offering them from
 * memory would re-publish a viewer-scoped list around the gate, which is
 * precisely what `isCacheablePrivacyClass` already refuses for the shared SWR
 * cache. So this reuses that same predicate, on BOTH sides: a non-cacheable
 * field is never recorded and never read back. Recording is gated too rather
 * than only reading, because a row that was never retained cannot leak from a
 * later bug.
 *
 * Fail-CLOSED on an unresolvable policy, for the same reason the cache is: the
 * cost of being wrong here is one server request, and the cost of being wrong
 * the other way is a retained list of people.
 *
 * ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
 *
 * It is NOT persistence. The store is in-memory and dies with the process, so a
 * cold APP START still has nothing local — that is §32's device-local recents
 * (census G199), which needs a storage backend and is not built here. What this
 * closes is the within-session case: the second and later opens of a field are
 * answered on-device, immediately, and survive the network dying.
 *
 * It is NOT re-ranking. The rows are replayed in recency order exactly as the
 * server projected them (§42) — nothing is re-scored, and no row the server did
 * not produce is ever invented.
 *
 * Pure module (no React, no network, no RN) — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { InputContext, PrivacyClass } from '../types/inputContext.ts';
import { recordSelection } from './suggestionHistory.ts';
import { isCacheablePrivacyClass } from './suggestionCache.ts';

/**
 * The accepted ROWS, most-recent first per context. Capped like
 * `suggestionHistory`'s own buffer and for the same reason.
 *
 * WHY A SECOND BUFFER AND NOT A FIELD ON THE FIRST. `suggestionHistory`'s
 * `RecentSelection` is `{ value, label, at }` — the shape §35's SERVER write
 * needs. This tier needs the PROJECTION the server returned, because the
 * alternative — rebuilding a row out of `value` and `label` — would have to
 * invent an `action`, and a zero-state row whose action the client made up is a
 * dead row (§13) or, worse, one that resolves somewhere the server never said
 * it did. So the row is what is retained, and `recordSelection` below is still
 * called so the existing buffer — which had NO writer in the app at all — is
 * populated by the same explicit accept. When §32's persistent store lands
 * (census G199) this map is what it replaces.
 */
const rowStore = new Map<InputContext, InputSuggestion[]>();
const MAX_PER_CONTEXT = 10;

/** Identity for dedupe: the canonical entity when there is one, else the row. */
function rowKey(s: InputSuggestion): string {
  if (s.entityType && s.entityId) return `${s.entityType}:${s.entityId}`;
  return `id:${s.id}`;
}

/** Drop every retained row. Tests + privacy controls. */
export function clearLocalZeroState(context?: InputContext): void {
  if (context) rowStore.delete(context);
  else rowStore.clear();
}

/**
 * The assistance types a recorded accept may be replayed as.
 *
 * The same reasoning as `narrowToQuery`'s `LOCALLY_REUSABLE_TYPES`: only a row
 * that stands for a THING can be re-offered later. A `completion` carries the
 * text of a search that was submitted once and would submit it again; a
 * `correction` / `validation` judged a string; an `action` was resolved from a
 * parse; an `ai_suggestion` was written for a prompt. None of those is an answer
 * to an EMPTY field, so none of them is replayed into one.
 */
const REPLAYABLE_TYPES: ReadonlySet<InputSuggestion['type']> = new Set([
  'entity',
  'recent',
  'personalized',
  'structured_value',
]);

/** The policy facts this module needs. A subset, so tests need no registry. */
export interface LocalZeroStatePolicy {
  context: InputContext;
  privacyClass?: PrivacyClass | null;
  maxSuggestions: number;
}

/**
 * True when this field's accepts may be retained on-device at all.
 * Exported so the two call sites (record, read) cannot drift apart.
 */
export function mayRetainLocally(policy: LocalZeroStatePolicy | null | undefined): boolean {
  if (!policy) return false;
  return isCacheablePrivacyClass(policy.privacyClass);
}

/**
 * Record an EXPLICIT accept for local replay (§35 — explicit only, never a
 * view, hover or keystroke). No-op for a field whose privacy class forbids
 * retention, and no-op for a row that could never be replayed anyway.
 */
export function recordLocalSelection(
  policy: LocalZeroStatePolicy | null | undefined,
  s: InputSuggestion,
): void {
  if (!mayRetainLocally(policy)) return;
  if (!REPLAYABLE_TYPES.has(s.type)) return;
  const context = (policy as LocalZeroStatePolicy).context;
  const label = (s.label ?? '').trim();
  if (!label) return;
  const key = rowKey(s);
  const list = (rowStore.get(context) ?? []).filter((r) => rowKey(r) !== key);
  list.unshift(s);
  rowStore.set(context, list.slice(0, MAX_PER_CONTEXT));
  // The §35 buffer's first writer. Same explicit accept, same context, same
  // dedupe-and-promote semantics — kept in step so a later persistent store can
  // take this tier over rather than fork from it.
  recordSelection(context, { value: s.entityId ?? s.replacementText ?? s.id, label });
}

/**
 * The local zero-state for an EMPTY field: this session's accepts for the
 * field's context, most recent first, re-labelled as `recent` rows.
 *
 * Returns `[]` — never a partial or invented row — when the field may not
 * retain locally or when nothing has been accepted in this session.
 */
export function localZeroState(
  policy: LocalZeroStatePolicy | null | undefined,
): InputSuggestion[] {
  if (!mayRetainLocally(policy)) return [];
  const p = policy as LocalZeroStatePolicy;
  const max = Math.max(0, p.maxSuggestions);
  if (max === 0) return [];
  const out: InputSuggestion[] = [];
  for (const s of rowStore.get(p.context) ?? []) {
    if (!REPLAYABLE_TYPES.has(s.type)) continue;
    // `recent` is the honest type for a row served out of selection memory: it
    // is what the SERVER's own recents branch projects, so the overlay's
    // grouping and the §9 type order treat both identically.
    out.push(s.type === 'recent' ? s : { ...s, type: 'recent' });
    if (out.length >= max) break;
  }
  return out;
}
