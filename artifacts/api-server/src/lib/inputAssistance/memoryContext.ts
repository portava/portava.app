/**
 * Global Input Intelligence — MEMORY CONTEXT for the Compass prompt (spec §6
 * `allowMemoryContext`, §16/§56; census G25), built to the owner's decision
 * OD-INPUT-3 (docs/ops/owner-decisions-20261004.md):
 *
 *   "Compass memory: Don't use it for input assistance by default. Add it only
 *    through a separate, clear opt-in with a way to inspect and revoke it."
 *
 * WHAT G25 SAID WAS MISSING. `allowMemoryContext` was declared, defaulted, set
 * true on exactly one context (`compass_prompt`) and read by nothing: there was
 * no memory lane for the member to gate. This module is that lane, and the
 * member is now the FIRST of three gates, checked before anything is read.
 *
 * THE THREE GATES, in the order they are checked — each one a reason to read
 * NOTHING, so a field, a deployment and a person can each say no on their own:
 *   1. the field's POLICY: `allowMemoryContext` (only `compass_prompt` sets it);
 *   2. the FLAG `input_memory_context_enabled` (migration 4122, seeded FALSE);
 *   3. the person's OPT-IN, `input_memory_context_consent` (4122) — separate
 *      from every other consent, off by default, server-stamped.
 * Only then is the person's own CompassMemoryProjection read, through the
 * memory layer's retrieval service (`services/memoryRetrieval/searchMemories`):
 * PRIVATE_PERSONAL namespace, owner === viewer, the projection Compass is
 * authorized for ("minimal authorized retrieval facts" — place and city ids,
 * no prose). This module never touches a memory table directly.
 *
 * INSPECT AND REVOKE. `inspectMemoryContext` returns exactly the facts the
 * starters would be built from — the same read, the same gates — so what the
 * person sees in Settings is what Compass would use. Revoking is withdrawing the
 * opt-in; from that moment gate 3 refuses and nothing is read. Nothing is
 * stored by this lane, so there is nothing of it to delete.
 *
 * WHAT IT PRODUCES. At most MAX_MEMORY_STARTERS extra Compass starter chips,
 * each naming a city from the person's own memories ("Plan another trip to
 * Hội An"), labelled as coming from their memories. They are ai_suggestion rows
 * with a replace_text action, exactly like the curated starters, so nothing is
 * inserted without a tap (§22) and the Compass screen renders them unchanged.
 * Historical, not current: the projection's own note travels as the reason's
 * qualifier — a memory says the person went somewhere, not what it is like now.
 *
 * FAILURE HONESTY. A failed consent read is "unreadable" (no memory is used, and
 * the routes answer 503). A failed or refused memory read produces NO memory
 * starters and is logged with its reason; the curated starters are unaffected.
 * That is the behaviour of a person who has not opted in, never an invented one.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { isFlagEnabled } from '../featureFlags';
import { logger } from '../logger';
import { searchMemories, type SearchMemoriesInput, type SearchResult } from '../../services/memoryRetrieval/searchMemories';
import type { ClientLike } from '../../services/memoryProjections/derivativeRegistry';
import {
  hasValidInputConsent,
  readInputConsent,
  writeInputConsent,
  type InputConsentRead,
  type InputConsentState,
} from './inputConsent';
import type { InputContext, InputFieldPolicy, InputSuggestion } from './types';

export const INPUT_MEMORY_CONTEXT_FLAG = 'input_memory_context_enabled';

/**
 * The disclosure a grant is recorded under (the client mirrors the words —
 * services/memoryContext.ts — and sends this version with a grant). ENGINEERING
 * DRAFT of OD-INPUT-3; the owner approves it before the flag is turned on.
 */
export const INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION = 'input_memory_context_v1';

/** At most this many memory-informed starters per serve. */
export const MAX_MEMORY_STARTERS = 2;
/** At most this many memory facts are read per serve / inspection. */
export const MEMORY_FACT_SCAN = 20;

// ── Gates ─────────────────────────────────────────────────────────────────────

export async function memoryContextOffered(db: SupabaseClient): Promise<boolean> {
  return isFlagEnabled(db, INPUT_MEMORY_CONTEXT_FLAG);
}

export function readMemoryContextConsent(db: SupabaseClient, userId: string): Promise<InputConsentRead> {
  return readInputConsent(db, 'input_memory_context_consent', userId);
}

export function writeMemoryContextConsent(db: SupabaseClient, userId: string, enabled: boolean, now?: Date) {
  return writeInputConsent(db, 'input_memory_context_consent', INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION, userId, enabled, now);
}

export function displayedMemoryDisclosureMatches(seen: unknown): boolean {
  return seen === INPUT_MEMORY_CONTEXT_DISCLOSURE_VERSION;
}

export type MemoryGate = 'policy' | 'flag' | 'consent' | 'consent_unreadable' | 'open';

/** Which gate stops this read — or `open`. Checked in order; the first "no" wins. */
export async function memoryContextGate(
  db: SupabaseClient,
  policy: Pick<InputFieldPolicy, 'allowMemoryContext'> | null,
  userId: string,
): Promise<MemoryGate> {
  if (!policy || policy.allowMemoryContext !== true) return 'policy';
  if (!userId) return 'consent';
  if (!(await memoryContextOffered(db))) return 'flag';
  const read = await readMemoryContextConsent(db, userId);
  if (!read.ok) return 'consent_unreadable';
  return hasValidInputConsent(read.state) ? 'open' : 'consent';
}

// ── The read ──────────────────────────────────────────────────────────────────

export interface CompassMemoryFact {
  memoryId: string;
  city: string;
  country: string | null;
  /** canonical_locations id when the memory carried one. */
  cityId: string | null;
  occurredAt: string | null;
}

export type CompassMemoryRead =
  | { ok: true; facts: CompassMemoryFact[] }
  | { ok: false; reason: string };

export type MemorySearch = (client: ClientLike, input: SearchMemoriesInput) => Promise<SearchResult>;

/**
 * The person's own Compass-authorized memory facts, one per city, newest first.
 * CALL ONLY BEHIND `memoryContextGate(...) === 'open'` — the gate is not
 * repeated here so that a test can prove the CALLERS check it.
 */
export async function readCompassMemoryFacts(
  db: SupabaseClient,
  userId: string,
  opts: { query?: string | null; search?: MemorySearch; now?: Date } = {},
): Promise<CompassMemoryRead> {
  const search = opts.search ?? searchMemories;
  let result: SearchResult;
  try {
    result = await search(db as unknown as ClientLike, {
      ownerId: userId,
      viewerId: userId,
      namespace: 'PRIVATE_PERSONAL',
      authorizedProjection: 'CompassMemoryProjection',
      semanticQuery: opts.query && opts.query.trim() ? opts.query.trim() : null,
      limit: MEMORY_FACT_SCAN,
      now: opts.now,
    });
  } catch {
    return { ok: false, reason: 'threw' };
  }
  if (!result.ok) return { ok: false, reason: result.reason };
  const seen = new Set<string>();
  const facts: CompassMemoryFact[] = [];
  for (const hit of result.value.hits) {
    const row = hit.row as Record<string, unknown>;
    const city = typeof row.location_city === 'string' ? row.location_city.trim() : '';
    if (!city) continue;
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      memoryId: typeof row.memory_id === 'string' ? row.memory_id : hit.memory_id,
      city,
      country: typeof row.location_country === 'string' && row.location_country.trim() ? row.location_country.trim() : null,
      cityId: typeof row.canonical_location_id === 'string' && row.canonical_location_id ? row.canonical_location_id : null,
      occurredAt: typeof row.occurred_at === 'string' ? row.occurred_at : null,
    });
  }
  return { ok: true, facts };
}

/** Starter chips from memory facts. Explainable (§42), tap-to-insert (§22). */
export function projectMemoryStarters(
  facts: readonly CompassMemoryFact[],
  context: InputContext,
  policyVersion: string,
  max: number = MAX_MEMORY_STARTERS,
): InputSuggestion[] {
  return facts.slice(0, Math.max(0, max)).map((f): InputSuggestion => {
    const text = `Plan another trip to ${f.city}${f.country ? `, ${f.country}` : ''}`;
    return {
      id: `${context}:memory:${f.cityId ?? f.city.toLowerCase()}`,
      type: 'ai_suggestion',
      context,
      label: `Another trip to ${f.city}`,
      replacementText: text,
      action: { type: 'replace_text', text },
      structuredValue: { starterId: `memory:${f.cityId ?? f.city.toLowerCase()}`, city: f.city, cityId: f.cityId },
      confidence: 0.5,
      source: 'memory',
      // Says WHERE it came from and that it is the person's own setting, and
      // that a memory is history, not a statement about the place today.
      reason: 'From your memories — a past trip, not current information',
      policyVersion,
    };
  });
}

/**
 * The gateway's one call. Reads NOTHING unless all three gates are open; any
 * failure yields no memory starters (logged), never an invented one.
 */
export async function buildMemoryContextStarters(
  db: SupabaseClient,
  p: { policy: InputFieldPolicy; userId: string; context: InputContext; query: string; policyVersion: string; search?: MemorySearch },
): Promise<InputSuggestion[]> {
  try {
    const gate = await memoryContextGate(db, p.policy, p.userId);
    if (gate !== 'open') {
      if (gate === 'consent_unreadable') logger.warn({ context: p.context }, 'memory context: consent unreadable; no memory used');
      return [];
    }
    const read = await readCompassMemoryFacts(db, p.userId, { query: p.query, search: p.search });
    if (!read.ok) {
      logger.warn({ context: p.context, reason: read.reason }, 'memory context: memory read refused; no memory starters');
      return [];
    }
    return projectMemoryStarters(read.facts, p.context, p.policyVersion);
  } catch (err) {
    logger.warn({ err, context: p.context }, 'memory context threw; no memory starters');
    return [];
  }
}

// ── Inspect ───────────────────────────────────────────────────────────────────

export type MemoryInspection =
  | { ok: true; available: boolean; consent: InputConsentState | null; facts: CompassMemoryFact[] | null; factsUnavailable: string | null }
  | { ok: false };

/**
 * What Settings shows: is it offered, the person's own consent, and — ONLY when
 * the opt-in is on — exactly the facts Compass would use. With the opt-in off
 * nothing is read, and the answer says so (`facts: null`). A memory read that
 * fails while the opt-in is on is reported (`factsUnavailable`), not shown as
 * "you have no memories".
 */
export async function inspectMemoryContext(
  db: SupabaseClient,
  userId: string,
  opts: { search?: MemorySearch } = {},
): Promise<MemoryInspection> {
  const available = await memoryContextOffered(db);
  const consent = await readMemoryContextConsent(db, userId);
  if (!consent.ok) return { ok: false };
  if (!available || !hasValidInputConsent(consent.state)) {
    return { ok: true, available, consent: consent.state, facts: null, factsUnavailable: null };
  }
  const read = await readCompassMemoryFacts(db, userId, { search: opts.search });
  return read.ok
    ? { ok: true, available, consent: consent.state, facts: read.facts.slice(0, MEMORY_FACT_SCAN), factsUnavailable: null }
    : { ok: true, available, consent: consent.state, facts: null, factsUnavailable: read.reason };
}
