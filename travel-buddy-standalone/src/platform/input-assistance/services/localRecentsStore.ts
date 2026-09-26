/**
 * §32 G199 / §34 G213 — the DEVICE-LOCAL recents blob: its shape, its
 * validation, and the port that reads and writes it.
 *
 * ── WHY A SEPARATE FILE, AND WHY IT HAS NO STORAGE IMPORT ────────────────────
 *
 * `suggestionHistory.ts`' own header has said since Phase 1 that the
 * AsyncStorage-backed store is "a LATER PHASE", and that the module is kept
 * "dependency-free (no AsyncStorage/supabase import) so it is safe to import
 * anywhere, including node:test". That property is worth keeping, so the
 * backend is a PORT: two `Promise`-returning methods, injected. The RN binding
 * lives in `installLocalRecents.ts`, the same seam split the telemetry and
 * policy-sync installers already use, and every decision that matters is
 * provable here with a Map.
 *
 * ── DECODE IS A GATE, NOT A PARSE ────────────────────────────────────────────
 *
 * Everything this file reads was written by an earlier BUILD of this app, under
 * an earlier POLICY, possibly weeks ago, into storage that is not a trust
 * boundary the client controls. So `decodeLocalRecents` refuses rather than
 * repairs, on every axis:
 *
 *   - a payload whose envelope version this build does not know: refused whole;
 *   - a `savedAt` older than `LOCAL_RECENTS_MAX_AGE_MS`, or in the FUTURE
 *     (a clock that moved is not a licence to keep rows forever): refused whole;
 *   - a context key that is not a member of `INPUT_CONTEXTS`: dropped;
 *   - a row whose `type` is not replayable, whose `source` is not a member of
 *     the union, whose label is empty, or whose `action.type` this build cannot
 *     name: dropped. Not stripped of the offending key and kept — a row that
 *     behaves differently from the one that was stored is a row nobody
 *     reviewed, and §13 would rather have no row than a changed one.
 *
 * WHAT DECODE DELIBERATELY DOES NOT DO: check the field's privacy class. It
 * cannot — the policy is per-viewer, fetched, and may not have arrived when
 * hydration runs. That check belongs at the READ, against the live policy, and
 * that is where `localZeroState` applies it. A blob restored for a field the
 * authority has since reclassified is therefore held and never served.
 *
 * Pure module (no React, no network, no RN) — unit-testable under node:test.
 */
import type { InputSuggestion } from '../types/inputSuggestion.ts';
import type { InputContext } from '../types/inputContext.ts';
import type { SuggestionActionType } from '../types/suggestionAction.ts';
import { INPUT_CONTEXTS } from '../types/inputContext.ts';

/**
 * The minimal storage contract. A strict subset of AsyncStorage's, so the RN
 * module satisfies it structurally and nothing here knows that it exists.
 */
export interface LocalRecentsStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** Versioned in the key as well as the envelope: a future shape gets a new key
 *  rather than colliding with this one on a downgrade. */
export const LOCAL_RECENTS_STORAGE_KEY = 'portava.input-assistance.recents.v1';

const ENVELOPE_VERSION = 1;

/**
 * How long a device-local memory may live without being rewritten. 30 days.
 *
 * NOT arbitrary decoration. These rows are the server's projections of entities
 * as they were when the user picked them, and §2's rule is that cached
 * historical state is the second-weakest rung of the precedence chain. A row
 * that has sat unused for a month is one whose entity may not exist any more,
 * and offering it is closer to presenting stale data than to degrading
 * gracefully. The blob is rewritten on every accept, so an actively used field
 * never expires; a field nobody has touched in a month starts clean.
 */
export const LOCAL_RECENTS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Cap per context, matching the in-memory ring buffer's own cap. */
export const LOCAL_RECENTS_MAX_PER_CONTEXT = 10;

const KNOWN_CONTEXTS: ReadonlySet<string> = new Set(INPUT_CONTEXTS);

/** The assistance types a stored row may carry. The same set the in-session
 *  tier replays, for the same reason (see `localZeroState.ts`). */
const REPLAYABLE_TYPES: ReadonlySet<string> = new Set([
  'entity',
  'recent',
  'personalized',
  'structured_value',
]);

/** `InputSuggestion['source']`, as a runtime set. A value outside it came from
 *  a build this one is not, so the row is not one this build can vouch for. */
const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  'canonical', 'recent', 'memory', 'live_intelligence', 'provider', 'local', 'ai',
]);

/**
 * `SuggestionAction['type']`, as a runtime set — the union in
 * `types/suggestionAction.ts`, member for member. Typed against it below so a
 * new member added there and forgotten here is a COMPILE error rather than a
 * stored row that silently stops being restorable.
 */
const KNOWN_ACTION_TYPES: ReadonlySet<SuggestionActionType> = new Set<SuggestionActionType>([
  'open_entity', 'replace_text', 'set_structured_value', 'submit_search',
  'add_to_trip', 'share_entity', 'drop_pin', 'open_compass',
]);

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** True when a decoded object is a row this build is willing to replay. */
function isRestorableRow(v: unknown, context: InputContext): v is InputSuggestion {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (!isStr(r.id) || r.id.length === 0) return false;
  if (!isStr(r.label) || r.label.trim().length === 0) return false;
  if (!isStr(r.type) || !REPLAYABLE_TYPES.has(r.type)) return false;
  if (!isStr(r.source) || !KNOWN_SOURCES.has(r.source)) return false;
  if (!isStr(r.policyVersion)) return false;
  // The row must belong to the context it was filed under. A row filed
  // elsewhere would be replayed into a field it was never offered in.
  if (r.context !== context) return false;
  if (r.action !== undefined) {
    if (r.action === null || typeof r.action !== 'object') return false;
    const a = r.action as Record<string, unknown>;
    if (!isStr(a.type) || !KNOWN_ACTION_TYPES.has(a.type as SuggestionActionType)) return false;
  }
  // A live claim is never restored. It was true at write time and cannot be
  // true now, and §31's whole rule is that a live label is never replayed.
  if (r.freshness !== undefined) return false;
  return true;
}

/** Serialise a snapshot. `savedAt` is the caller's clock, injected for tests. */
export function encodeLocalRecents(
  snapshot: ReadonlyMap<InputContext, readonly InputSuggestion[]>,
  savedAt: number,
): string {
  const contexts: Record<string, InputSuggestion[]> = {};
  for (const [context, rows] of snapshot) {
    if (rows.length === 0) continue;
    contexts[context] = rows.slice(0, LOCAL_RECENTS_MAX_PER_CONTEXT).map((row) => {
      // `freshness` is dropped on the way OUT as well as refused on the way in,
      // so a blob written by this build can never carry one.
      const { freshness: _dropped, ...rest } = row;
      return rest as InputSuggestion;
    });
  }
  return JSON.stringify({ v: ENVELOPE_VERSION, savedAt, contexts });
}

/**
 * Parse and VALIDATE a stored blob. Returns an empty map for anything it will
 * not vouch for, and never throws.
 */
export function decodeLocalRecents(
  raw: string | null | undefined,
  now: number,
): Map<InputContext, InputSuggestion[]> {
  const out = new Map<InputContext, InputSuggestion[]>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const env = parsed as Record<string, unknown>;
  if (env.v !== ENVELOPE_VERSION) return out;
  if (typeof env.savedAt !== 'number' || !Number.isFinite(env.savedAt)) return out;
  const age = now - env.savedAt;
  if (age < 0 || age > LOCAL_RECENTS_MAX_AGE_MS) return out;
  if (env.contexts === null || typeof env.contexts !== 'object') return out;

  for (const [key, value] of Object.entries(env.contexts as Record<string, unknown>)) {
    if (!KNOWN_CONTEXTS.has(key)) continue;
    if (!Array.isArray(value)) continue;
    const context = key as InputContext;
    const rows = value
      .filter((row): row is InputSuggestion => isRestorableRow(row, context))
      .slice(0, LOCAL_RECENTS_MAX_PER_CONTEXT);
    if (rows.length > 0) out.set(context, rows);
  }
  return out;
}
